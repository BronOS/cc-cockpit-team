'use strict'
// Team records and caller resolution (docs/design.md §1, §2).
//
// A team is one room of this plugin in this window. Rooms holds the membership, messages, docs and log, and
// main enforces every rule there; this module keeps only the plugin's own record per team (marks, questions,
// metrics, ...) in `ctx.storage` (per project, one key per team so a busy team's record cannot crowd the others
// out of the 1 MiB value limit) and answers "which team is this caller in, and is it the coordinator?".
//
// Identity comes from two places only: `CliCall.tabId` (set by main from the caller's session token, never
// from the caller's arguments) and `ctx.rooms.members` (main's membership, with the coordinator flag). Nothing
// a caller passes (a room id, a member name, a "--coordinator" flag) is ever used to decide who it is.

const KEY_PREFIX = 'team:'

// One text for every caller that is not a member of one of this plugin's live rooms: a shell tab (no tabId),
// an unknown tab id, a tab of another window, a tab in another plugin's room, a member of an ended team. A
// distinct answer per case would tell a caller about rooms it is not in.
const NOT_IN_TEAM = 'this tab is not in a team: a coordinator can invite it with `ccc team invite` (or start a team with `ccc team start`)'
const NOT_COORDINATOR = "only the team's coordinator can do that"

class TeamError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TeamError'
    this.code = code
  }
}

// Rooms' member-name rule (cc-cockpit src/shared/room-names.ts, ROOM_NAME and checkRoomName's texts), one copy for
// every module: `start` and `hire` check it before anything is written, the metrics count only names that pass it,
// the export builds `members/<name>/` folders from it.
const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/
const RESERVED_NAMES = new Set(['all', 'plugin', 'person', 'user', 'system'])
const isMemberName = (x) => typeof x === 'string' && NAME_RE.test(x) && !RESERVED_NAMES.has(x)
/** Refuse a name Rooms would refuse, in Rooms' own words. */
function checkName(name) {
  if (RESERVED_NAMES.has(name)) throw new TeamError('name', `name "${name}" is reserved`)
  if (!NAME_RE.test(name)) throw new TeamError('name', 'name must be a lower-case letter then up to 30 of a-z, 0-9 and -')
}

/** Rooms' refusal for a room that is gone (deleted, or never this plugin's): matched on its text, the only signal. */
const isNoRoom = (err) => Boolean(err && typeof err.message === 'string' && err.message.includes('no such room'))

/** A fresh record for a room (design §1); the fields later tasks fill start empty. */
function newRecord(room) {
  const rec = {
    roomId: room.id,
    title: room.title,
    createdAt: room.createdAt,
    marks: [],
    questions: [],
    metrics: { members: {}, logSeq: 0 },
  }
  if (room.endedAt !== undefined) rec.endedAt = room.endedAt
  return rec
}

/**
 * A stored value read back as a record, or null when it is not one. Storage is ours, but a value written by an
 * older version (or a hand edit) must not crash every command: a record we cannot read is dropped like one whose
 * room is gone, and the missing array/object fields are filled rather than trusted.
 */
function readRecord(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.roomId !== 'string' || KEY_PREFIX + value.roomId !== key) return null
  const rec = { ...value }
  if (typeof rec.title !== 'string') rec.title = ''
  // JSON has no undefined: a stored `endedAt: null` (or any non-number) would pass `!== undefined` and read as an
  // ended team for good. reconcile repairs title, createdAt and endedAt from Rooms.
  if (!Number.isFinite(rec.createdAt)) rec.createdAt = 0
  if (!Number.isFinite(rec.endedAt)) delete rec.endedAt
  if (!Array.isArray(rec.marks)) rec.marks = []
  if (!Array.isArray(rec.questions)) rec.questions = []
  // Entries too: every reader of a question reads its fields (`q.from`, `q.answeredAt`) without a guard.
  rec.marks = rec.marks.filter((x) => x && typeof x === 'object' && !Array.isArray(x))
  rec.questions = rec.questions.filter((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.text === 'string')
  if (!rec.metrics || typeof rec.metrics !== 'object' || Array.isArray(rec.metrics)) rec.metrics = {}
  if (!rec.metrics.members || typeof rec.metrics.members !== 'object' || Array.isArray(rec.metrics.members)) rec.metrics.members = {}
  if (!Number.isInteger(rec.metrics.logSeq) || rec.metrics.logSeq < 0) rec.metrics.logSeq = 0
  return rec
}

/**
 * The team store of one plugin host (one window, one project). Records live in memory once loaded, with
 * `ctx.storage` written through on every `save`: the host is storage's one writer, so the memory copy is the
 * truth and two modules editing one team (a command and the metrics) see each other's changes at once.
 */
function createTeams(ctx) {
  /** roomId -> record */
  const records = new Map()
  let loading = null

  const keyOf = (roomId) => KEY_PREFIX + roomId

  // Told after every write and removal (the panel pushes its state again, throttled): a question asked through
  // `ccc team ask`, a metrics save, an end. A listener's throw is logged, never a failed write.
  const listeners = new Set()
  function changed(roomId) {
    for (const fn of [...listeners]) {
      try {
        fn(roomId)
      } catch (err) {
        ctx.log.warn(`team records: change listener: ${err && err.message}`)
      }
    }
  }

  async function persist(rec) {
    await ctx.storage.set(keyOf(rec.roomId), rec)
    changed(rec.roomId)
  }

  // reconcile, add and remove run one at a time: a reconcile adopts from a `rooms.list` answer that can be stale by
  // the time its loop runs, so a delete (or an add) that slipped in between would be undone by it (a ghost record of a
  // deleted room, or a record replaced under a caller's hands). The queue goes on after a rejection.
  let queue = Promise.resolve()
  function serial(fn) {
    const run = queue.then(fn)
    queue = run.catch(() => {})
    return run
  }

  const warn = (what, err) => ctx.log.warn(`team records: ${what}: ${err && err.message}`)

  /**
   * Bring the records in line with Rooms: a record whose room no longer exists is dropped (deleted outside the
   * plugin, or its storage outlived the room), an ended room marks its record ended, and a room of ours with no
   * record (storage lost or cleared) gets a fresh one: every room of this plugin is a team. The write comes before
   * the change in memory, and a storage failure on one record (the real store's size limits) is logged and left for
   * the next reconcile: it must not fail a command of another team, and memory must not look done when it is not.
   */
  function reconcile() {
    return serial(async () => {
      const rooms = await ctx.rooms.list()
      const byId = new Map(rooms.map((r) => [r.id, r]))
      for (const id of [...records.keys()]) {
        if (byId.has(id)) continue
        try {
          await ctx.storage.delete(keyOf(id))
          records.delete(id)
          changed(id)
        } catch (err) {
          warn(`drop ${id}`, err)
        }
      }
      for (const room of rooms) {
        const rec = records.get(room.id)
        try {
          if (!rec) {
            const fresh = newRecord(room)
            await persist(fresh)
            records.set(room.id, fresh)
            continue
          }
          const fix = {}
          if (rec.title !== room.title) fix.title = room.title
          if (rec.createdAt !== room.createdAt) fix.createdAt = room.createdAt
          if (room.endedAt !== undefined && rec.endedAt === undefined) fix.endedAt = room.endedAt
          if (Object.keys(fix).length === 0) continue
          await persist({ ...rec, ...fix })
          Object.assign(rec, fix)
        } catch (err) {
          warn(`sync ${room.id}`, err)
        }
      }
    })
  }

  async function loadOnce() {
    for (const key of await ctx.storage.keys()) {
      if (!key.startsWith(KEY_PREFIX)) continue
      const rec = readRecord(key, await ctx.storage.get(key))
      if (rec) records.set(rec.roomId, rec)
      else await ctx.storage.delete(key)
    }
    await reconcile()
  }

  /** Load the records once (later calls share the first load); a failed load is retried by the next call. */
  function load() {
    if (!loading) {
      loading = loadOnce().catch((err) => {
        loading = null
        throw err
      })
    }
    return loading
  }

  /** Load, then reconcile with Rooms again: a room can end or vanish between two commands. */
  async function refresh() {
    if (!loading) return load()
    await loading
    await reconcile()
  }

  const api = {
    load,
    refresh,

    /** Every record, live and ended, oldest first. */
    async list() {
      await load()
      return [...records.values()].sort((a, b) => a.createdAt - b.createdAt)
    },

    async get(roomId) {
      await load()
      return records.get(roomId)
    },

    /**
     * The record of a room just created by `ctx.rooms.create` (start, the panel's New team). `create` answers
     * `{ id }` only, so a room without a title and createdAt is looked up in `rooms.list`; a room that already has
     * a record (a reconcile adopted it first) answers that record, never a second object.
     */
    async add(room) {
      await load()
      return serial(async () => {
        const existing = records.get(room.id)
        if (existing) return existing
        let info = room
        if (typeof room.title !== 'string' || !Number.isFinite(room.createdAt)) {
          info = (await ctx.rooms.list()).find((r) => r.id === room.id)
          if (!info) throw new Error(`teams.add: no such room ${room.id}`)
        }
        const rec = newRecord(info)
        await persist(rec)
        records.set(rec.roomId, rec)
        return rec
      })
    },

    /** Write a record changed in place (it must be the one `get`/`list`/`teamOfTab` returned). */
    async save(rec) {
      await load()
      if (records.get(rec.roomId) !== rec) throw new Error(`teams.save: no record for room ${rec.roomId}`)
      await persist(rec)
    },

    /** Forget a team's record (after `ctx.rooms.delete`). */
    async remove(roomId) {
      await load()
      return serial(async () => {
        await ctx.storage.delete(keyOf(roomId))
        records.delete(roomId)
        changed(roomId)
      })
    },

    /** Hear every record write and removal (the room id); returns the disposer. */
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    /**
     * The team whose room has `tabId` as a member, with that member and the room's member list, or null. Only
     * this plugin's live rooms are asked (`ctx.rooms` sees no other plugin's room and no other window's), so a
     * tab in another plugin's room, a foreign id and an unknown one all come back null alike.
     */
    async teamOfTab(tabId) {
      if (typeof tabId !== 'string' || tabId === '') return null
      await refresh()
      for (const rec of records.values()) {
        if (rec.endedAt !== undefined) continue
        let members
        try {
          members = await ctx.rooms.members(rec.roomId)
        } catch (err) {
          // The room went between the list and this call: not the caller's team any more. Any other failure
          // (an RPC error or timeout) is not "not a member": a real coordinator must get an error to retry.
          if (isNoRoom(err)) continue
          throw err
        }
        const member = members.find((m) => m.tabId === tabId)
        if (member) return { team: rec, member, members }
      }
      return null
    },

    /** `teamOfTab(call.tabId)`, refusing with the one not-in-a-team text. */
    async requireMember(call) {
      const found = await api.teamOfTab(call && call.tabId)
      if (!found) throw new TeamError('not-in-team', NOT_IN_TEAM)
      return found
    },

    /** As `requireMember`, and the member must be a coordinator in main's member list. */
    async requireCoordinator(call) {
      const found = await api.requireMember(call)
      if (!found.member.coordinator) throw new TeamError('not-coordinator', NOT_COORDINATOR)
      return found
    },
  }
  return api
}

module.exports = { createTeams, TeamError, NOT_IN_TEAM, NOT_COORDINATOR, KEY_PREFIX, NAME_RE, isMemberName, checkName, isNoRoom }
