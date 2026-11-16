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

/**
 * Per-name locks of the teams (`roomId/name`), in memory only. A name is reusable after a fire, so anything that
 * checks who holds a name and then acts on it across awaits must hold the name: a hire (two hires would race on the
 * kickoff doc), a fire, a reply (members check, then send: a fire and rehire in between sent the answer to the new
 * member), an ask (members check, then the save: a fire in between left a question whose asker can take no answer,
 * round 9) and a coordinator's mark (members check, then the save: a mark stamped by a member fired meanwhile). The
 * kinds that only need the member to stay (`reply`, `ask`, `mark`) may run together, any mix of them; a hire or a fire
 * is alone. The host builds one instance for questions, hiring and the commands' marks, so the CLI and the panel
 * share it. Only the plugin's own paths take it: a member removed from core's room view, or a tab joining by an
 * invite code, does not go through here.
 *
 * Lock order, everywhere: the export guard (`teams.guard.change`) first, then the name lock inside it, never the
 * other way round. A held lock refuses rather than waits, so a wrong order would not deadlock, but one order keeps
 * every refusal's text the same for the same race.
 */
const LOCK_TEXT = {
  hire: (name, same) => `${name} is ${same ? 'already ' : ''}being hired`,
  fire: (name, same) => `${name} is ${same ? 'already ' : ''}being fired`,
  reply: (name) => `an answer to ${name} is being sent`,
  ask: (name) => `${name} is asking a question`,
  mark: (name) => `${name} is setting a mark`,
}
const SHARED_LOCKS = new Set(['reply', 'ask', 'mark'])

function createNameLocks() {
  const held = new Map() // `roomId/name` -> Map(kind -> count)
  return {
    /** Run `fn` holding `name` in the room for `kind` (hire, fire, reply, ask, mark), or refuse while it conflicts. */
    async hold(roomId, name, kind, fn) {
      if (!Object.hasOwn(LOCK_TEXT, kind)) throw new TypeError(`unknown name lock kind: ${kind}`)
      const key = `${roomId}/${name}`
      // No await between the check and the set, so the map is the lock.
      const kinds = held.get(key)
      if (kinds) {
        const shared = SHARED_LOCKS.has(kind) && [...kinds.keys()].every((k) => SHARED_LOCKS.has(k))
        if (!shared) {
          // Name the holder: the same kind's own text ("already being hired"), else the first one holding it.
          const by = kinds.has(kind) ? kind : kinds.keys().next().value
          const text = LOCK_TEXT[by](name, by === kind)
          throw new TeamError(`${by}-pending`, by === kind ? text : `${text}: try again in a moment`)
        }
      }
      const now = kinds || new Map()
      now.set(kind, (now.get(kind) || 0) + 1)
      held.set(key, now)
      try {
        return await fn()
      } finally {
        const n = now.get(kind) - 1
        if (n > 0) now.set(kind, n)
        else now.delete(kind)
        if (now.size === 0) held.delete(key)
      }
    },
  }
}

/**
 * The export guard of the teams (in memory only; one per `createTeams`, so every module of the host shares it as
 * `teams.guard`). An End reads the team in several steps (the metrics catch-up, the snapshot of the stats, the log
 * cursor and the record, the export, `rooms.end`), each a moment apart: every change of the plugin's own to the team
 * (a reply, a Done, an ask, a mark, a hire, a fire, an invite, the panel's activity count) landing between two of them
 * made an export whose files disagreed (a question answered with its answer in no file, a mark after the cursor). So
 * those changes run under `change`, and an End holds the team with `exclusive` from its start to its finish (success or
 * failure): a change starting then is refused (`EXPORTING`), and the End waits for the changes already running
 * (`settled`) before it reads anything. What members send through Rooms itself is not the plugin's to hold: those
 * entries are covered by the one log cursor of the export (lib/export.js).
 *
 * THE RULE for every change (eight review rounds found its breaches one at a time): a change checks ALL its
 * preconditions inside `change` (and inside the name lock when it takes one), after its last await and right before
 * its write: the team is live and still this record (`live`, after `refresh`, so a room ended from core's room view
 * counts), the member it acts for or on is (or is not) in main's member list as read inside, the question is open.
 * A check made before an await (the command's `requireMember`, the panel's `teamOf`, a member list the caller read)
 * is a fast path for a quick refusal only, never the decision: an End can finish, a hire or a fire can land, while a
 * change waits on a host call, and the hold of an End that already finished protects nothing.
 */
const EXPORTING = 'the team is being exported and ended: try again in a moment'
const TEAM_ENDED = 'the team has ended'
/**
 * A team being set up (`ccc team start`, the panel's New team: from `rooms.create` to the coordinator's invite or the
 * lead's open, or to the cleanup of a start that failed) takes no change from anyone else: a panel Hire of `lead`
 * landing before start's invite made that invite fail, and the failed start's cleanup then deleted the room with the
 * hired member in it, docs and log (round 10). The setup itself passes its own token to `change`.
 */
const STARTING = 'the team is still being set up: try again in a moment'

/**
 * `refresh` (async) brings the records in line with Rooms and `recordOf` (sync) answers the record in memory: the
 * teams pass their own (createTeams). A guard built alone (tests of one module) has neither: `refresh` does nothing and
 * `live` checks nothing.
 */
function createTeamGuard({ refresh, recordOf } = {}) {
  const running = new Map() // roomId -> number of changes in flight
  const waiters = new Map() // roomId -> resolvers of `settled`
  const held = new Set() // roomIds being exported and ended
  const starting = new Map() // roomId -> the token of the setup holding it
  function release(roomId) {
    const n = running.get(roomId) - 1
    if (n > 0) {
      running.set(roomId, n)
      return
    }
    running.delete(roomId)
    const ws = waiters.get(roomId) || []
    waiters.delete(roomId)
    for (const w of ws) w()
  }
  return {
    /** Whether the team is being exported and ended now. */
    exporting: (roomId) => held.has(roomId),

    /** Whether the team is still being set up (`setup`). */
    starting: (roomId) => starting.has(roomId),

    /**
     * Hold a room just created (call it right after `rooms.create` answers, with no await in between) until `fn`
     * settles: its set-up and, when that fails, its cleanup. Every `change` of it is refused (`STARTING`) but the
     * setup's own, which passes the token `fn` gets; an End is refused too.
     */
    async setup(roomId, fn) {
      // No await before the set: the map is the lock. A room id is fresh from `rooms.create` (never reused), so
      // nothing of the plugin's can hold it yet; never a throw here, which would skip the caller's cleanup.
      const token = Object.freeze({ roomId })
      starting.set(roomId, token)
      try {
        return await fn(token)
      } finally {
        starting.delete(roomId)
      }
    },

    /** The records brought in line with Rooms (an await: call `live` after it, never before). */
    refresh: async () => {
      if (refresh) await refresh()
    },

    /**
     * The team's record, refused when it is gone, is not `rec` (when given: the record the change read earlier) or
     * has ended. Synchronous on purpose: called after the change's last await, right before its write (THE RULE).
     */
    live(roomId, rec) {
      if (!recordOf) return rec
      const now = recordOf(roomId)
      if (!now || (rec !== undefined && now !== rec)) throw new TeamError('no-team', 'no such team')
      if (now.endedAt !== undefined) throw new TeamError('ended', TEAM_ENDED)
      return now
    },

    /**
     * Run a change of the plugin's own to the team, or refuse it while the team is being exported and ended, or set up
     * by anyone but the setup whose `token` (`setup`) this call passes.
     */
    async change(roomId, fn, token) {
      // No await between the check and the count, so the two maps are the lock. This entry check only refuses a
      // change while an End holds the team; one that finished meanwhile is caught by the change's own `live` (THE RULE).
      if (held.has(roomId)) throw new TeamError('exporting', EXPORTING)
      if (starting.has(roomId) && starting.get(roomId) !== token) throw new TeamError('starting', STARTING)
      running.set(roomId, (running.get(roomId) || 0) + 1)
      try {
        return await fn()
      } finally {
        release(roomId)
      }
    },

    /**
     * Hold the team for an export and end: from here every `change` of it is refused, until `fn` settles. `fn` gets
     * `settled`, a function answering a promise of the end of the changes already running (they started before the
     * hold and must finish, or fail, before the End reads the team).
     */
    async exclusive(roomId, fn) {
      if (held.has(roomId)) throw new TeamError('busy', 'the team is already being ended')
      if (starting.has(roomId)) throw new TeamError('starting', STARTING)
      held.add(roomId)
      const settled = () =>
        running.has(roomId)
          ? new Promise((resolve) => {
              if (!waiters.has(roomId)) waiters.set(roomId, [])
              waiters.get(roomId).push(resolve)
            })
          : Promise.resolve()
      try {
        return await fn(settled)
      } finally {
        held.delete(roomId)
      }
    },
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

/**
 * Whether a room a start created is still as that start left it: its log holds only the `create`, the start's own
 * invite of `name` (one main made whose answer then failed), the plugin's reads and writes of `name`'s kickoff doc
 * (the panel's New team seeds it and puts it back after a failed open) and, when `ended`, one `end` (the cleanup's
 * own). Anything else (a join, a send, another doc, a pause, an invite of another name) is a change by someone the
 * setup's hold does not cover (core's room view), and the room is not the start's to delete. A log too long to read
 * in a few pages is never a fresh room's.
 */
async function untouchedStart(ctx, roomId, name, ended) {
  const doc = `members/${name}/kickoff.md`
  let ends = 0
  let since = 0
  for (let page = 0; page < 5; page++) {
    const { entries, more } = await ctx.rooms.log(roomId, { since })
    for (const e of entries) {
      if (!e || typeof e !== 'object') return false
      if (e.type === 'create') continue
      if (e.type === 'invite' && e.member === name) continue
      if ((e.type === 'doc-write' || e.type === 'doc-read' || e.type === 'doc-refused') && e.by === 'plugin' && e.path === doc) continue
      if (e.type === 'end' && ended && ++ends === 1) continue
      return false
    }
    const last = entries.length ? entries[entries.length - 1].seq : since
    if (!more || !Number.isInteger(last) || last <= since) return true
    since = last
  }
  return false
}

/**
 * The cleanup of a start that failed with `err` (`ccc team start`, the panel's New team), run inside its
 * `guard.setup` so no change of the plugin's lands in the room meanwhile: a room nobody can join (no invite, no lead)
 * would only hold one of the plugin's room slots, so it is ended and deleted, but only while it is still as the start
 * left it (`untouchedStart`, read before the end and again after it: an ended room changes no more, so the second
 * read is the decision). A room someone else changed is kept, and the error says so; a cleanup that fails is logged.
 * Answers the error to throw.
 */
async function abandonStart(ctx, teams, roomId, name, err) {
  let kept = false
  try {
    if (await untouchedStart(ctx, roomId, name, false)) {
      await ctx.rooms.end(roomId)
      if (await untouchedStart(ctx, roomId, name, true)) {
        await ctx.rooms.delete(roomId)
        await teams.remove(roomId)
      } else kept = true
    } else kept = true
  } catch (e) {
    ctx.log.warn(`team start: cleaning up room ${roomId}: ${e && e.message}`)
  }
  if (!kept) return err
  ctx.log.warn(`team start: room ${roomId} kept: it changed while the team was being set up`)
  return new TeamError((err && err.code) || 'start-failed', `${(err && err.message) || err}\n(the room was kept: something else joined or changed it while the team was being set up)`)
}

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

  // Records whose last write failed (the real store's size limits, a full disk) and keys whose delete failed: memory
  // is the truth (Rooms' state, the plugin's own changes), so a failed write never holds memory back; the next
  // reconcile writes them again.
  const unsaved = new Set() // roomIds
  const undeleted = new Set() // roomIds of records gone from memory whose key is still stored

  /** Write `rec` (the one in memory); a failure is left for the next reconcile and thrown. */
  async function persist(rec) {
    try {
      await ctx.storage.set(keyOf(rec.roomId), rec)
      if (records.get(rec.roomId) === rec) unsaved.delete(rec.roomId)
    } catch (err) {
      if (records.get(rec.roomId) === rec) unsaved.add(rec.roomId)
      throw err
    } finally {
      // Told either way: memory changed (the panel shows an ended team as ended even when storage refused it).
      changed(rec.roomId)
    }
  }

  /** Forget `roomId` in memory at once, then delete its key; a failed delete is retried by the next reconcile. */
  async function forget(roomId) {
    records.delete(roomId)
    unsaved.delete(roomId)
    changed(roomId)
    try {
      await ctx.storage.delete(keyOf(roomId))
      undeleted.delete(roomId)
    } catch (err) {
      undeleted.add(roomId)
      throw err
    }
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
   * record (storage lost or cleared) gets a fresh one: every room of this plugin is a team. Rooms is the authority on
   * these, so memory takes them first and the write follows: a storage failure (the real store's size limits) is
   * logged and the write retried by the next reconcile, never a team shown live after Rooms ended it (Delete refused
   * it for as long as storage stayed full), and never a failed command of another team.
   */
  function reconcile() {
    return serial(async () => {
      const rooms = await ctx.rooms.list()
      const byId = new Map(rooms.map((r) => [r.id, r]))
      for (const id of [...records.keys()]) {
        if (byId.has(id)) continue
        try {
          await forget(id)
        } catch (err) {
          warn(`drop ${id}`, err)
        }
      }
      for (const room of rooms) {
        let rec = records.get(room.id)
        if (!rec) {
          rec = newRecord(room)
          records.set(room.id, rec)
          unsaved.add(room.id)
          continue
        }
        const fix = {}
        if (rec.title !== room.title) fix.title = room.title
        if (rec.createdAt !== room.createdAt) fix.createdAt = room.createdAt
        // Rooms' time wins over a provisional one (an End whose refresh failed, `ended`).
        if (room.endedAt !== undefined && rec.endedAt !== room.endedAt) fix.endedAt = room.endedAt
        if (Object.keys(fix).length === 0) continue
        Object.assign(rec, fix)
        unsaved.add(room.id)
      }
      // Every record memory holds and storage does not (changed above, or a write that failed before).
      for (const id of [...unsaved]) {
        const rec = records.get(id)
        if (!rec) {
          unsaved.delete(id)
          continue
        }
        try {
          await persist(rec)
        } catch (err) {
          warn(`sync ${id}`, err)
        }
      }
      for (const id of [...undeleted]) {
        if (records.has(id)) {
          undeleted.delete(id)
          continue
        }
        try {
          await ctx.storage.delete(keyOf(id))
          undeleted.delete(id)
        } catch (err) {
          warn(`drop ${id}`, err)
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
    /** The export guard (createTeamGuard): shared by every module that changes or ends a team. */
    guard: createTeamGuard({ refresh: () => refresh(), recordOf: (roomId) => records.get(roomId) }),

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
        // Memory first, as reconcile: the room exists in Rooms whether or not the write goes through.
        const rec = newRecord(info)
        records.set(rec.roomId, rec)
        await persist(rec)
        return rec
      })
    },

    /**
     * Write a record changed in place (it must be the one `get`/`list`/`teamOfTab` returned). A failure is thrown (the
     * caller rolls back a change of its own) and the record, as memory then holds it, is written again by the next
     * reconcile.
     */
    async save(rec) {
      await load()
      if (records.get(rec.roomId) !== rec) throw new Error(`teams.save: no record for room ${rec.roomId}`)
      await persist(rec)
    },

    /**
     * Forget a team's record (after `ctx.rooms.delete`): gone from memory at once, as the room is from Rooms. A failed
     * key delete is logged and retried by the next reconcile (the room is gone: a stored key is only dropped again).
     */
    async remove(roomId) {
      await load()
      return serial(async () => {
        try {
          await forget(roomId)
        } catch (err) {
          warn(`remove ${roomId}`, err)
        }
      })
    },

    /**
     * Rooms ended the room (the End's `rooms.end` answered): the record ends in memory now, even when the refresh
     * that should bring Rooms' time fails or the write is refused. `at` is provisional; the next reconcile puts Rooms'
     * own endedAt in its place. A write failure is logged, never thrown: the end happened.
     */
    async ended(roomId, at) {
      await load()
      const rec = records.get(roomId)
      if (!rec || rec.endedAt !== undefined) return
      rec.endedAt = at
      try {
        await persist(rec)
      } catch (err) {
        warn(`end ${roomId}`, err)
      }
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

module.exports = { createTeams, createNameLocks, createTeamGuard, abandonStart, EXPORTING, STARTING, TEAM_ENDED, TeamError, NOT_IN_TEAM, NOT_COORDINATOR, KEY_PREFIX, NAME_RE, isMemberName, checkName, isNoRoom }
