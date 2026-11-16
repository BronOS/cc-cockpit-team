'use strict'
// Member metrics (docs/design.md §4): raw facts only, kept in each team's record under `metrics`.
//
// Two sources, both main's:
// - `ctx.sessions` (this window's Claude tabs): status, `costUsd`, `contextPercent`. Status changes are turned into
//   time working / waiting / idle; the time between two changes goes to the earlier status.
// - `ctx.rooms.log` (the room's events, with a `seq` cursor kept in the record): hired (join) and left (leave, with
//   why; the room's end), messages sent and received, doc reads and writes. Polled every 5 s while the team is live,
//   at once when a tab's `SessionInfo.room` or `held` changes, and never again once its room ended and its log was
//   read to the end (the last drain reads the end entry itself, over several polls for a long backlog).
//
// Which tab is which member comes from `ctx.rooms.members` (main's), refreshed on every poll: `SessionInfo.room`
// carries the room's title and the member's name but no room id, and two teams may share a title.
//
// Time is counted only while the host runs and the room is not paused: an open interval lives in memory (never
// stored), so an app quit, or a host that was not running, adds nothing, and a room the person (or the loop guard,
// or a restart) paused adds nothing either. Its elapsed time is moved into the stored totals on every status change
// and, for a long stretch with no change, by the poll once a minute, so a crash loses at most that minute.
//
// Writes are throttled: changes mark the team dirty, and one save per dirty team runs at most every SAVE_MS.

const { TeamError, isMemberName } = require('./teams.js')
const { badTextChar } = require('./kickoff.js')
const { totalsOf, statsOf, foldOut, ACTIONS_MAX } = require('./stats.js')

const POLL_SECONDS = 5
const SAVE_MS = 5000
/** A long unchanged stretch is moved into the stored totals this often (what a crash can lose at most). */
const CHECKPOINT_MS = 60_000
/** Rooms' page size for `log` (the most it answers at once). */
const LOG_PAGE = 1000
/** Pages read in one poll per team, so one huge backlog cannot hold the host; the next poll goes on from the cursor. */
const LOG_PAGES_PER_POLL = 20

/** A mark's label: one short line (it is a table cell in the export). Marks per team: a record is one 1 MiB value. */
const LABEL_MAX = 200
const MARKS_MAX = 200
/** The fixed ends of the spans (lib/stats.js `spansOf`): a mark named like one could not be told from it. */
const BOUNDARY_LABELS = new Set(['start', 'now', 'end'])

/**
 * SessionStatus (cc-cockpit src/sdk/types.ts: starting, idle, working, needs-permission, waiting, ended) to the
 * bucket its time counts in. A permission prompt is part of the turn (the member is mid-work, the person is the one
 * holding it), so it counts as working. `ended` (the process exited) and anything unknown count nowhere.
 */
function bucketOf(status) {
  switch (status) {
    case 'working':
    case 'needs-permission':
      return 'working'
    case 'waiting':
      return 'waiting'
    case 'idle':
    case 'starting':
      return 'idle'
    default:
      return null
  }
}

/** Rooms' leave `why` (removed, closed, left) in the design's words (§4: fired, tab closed, left). */
function leftWhy(why) {
  if (why === 'removed') return 'fired'
  if (why === 'closed') return 'tab closed'
  if (why === 'left') return 'left'
  return typeof why === 'string' && why !== '' ? why.slice(0, 40) : 'left'
}

/** A member's metrics in a record, made empty on first sight. Fields absent until seen ("unknown", not 0). */
function memberOf(rec, name) {
  const all = rec.metrics.members
  if (!Object.hasOwn(all, name) || !all[name] || typeof all[name] !== 'object') {
    all[name] = { workingMs: 0, waitingMs: 0, idleMs: 0, sent: 0, received: 0, docReads: 0, docWrites: 0 }
  }
  const m = all[name]
  for (const k of ['workingMs', 'waitingMs', 'idleMs', 'sent', 'received', 'docReads', 'docWrites']) {
    if (!Number.isFinite(m[k]) || m[k] < 0) m[k] = 0
  }
  return m
}

/**
 * Fold a status-line cost into a member's total. `costUsd` is the tab's session total so far; a member keeps its
 * name across tabs (a restart restores it in a new tab, a fired name can be hired again), so the raw value is
 * remembered with the tab it came from (`costTab`). Another tab is another process whose whole value is new: its
 * cost may already be past the old raw value when first seen (the host came up late, the old stint was cheap), so
 * a drop alone would lose the part below it. A plugin reload keeps the tab ids, so the same process is not counted
 * twice. With no tab known (an older record), a drop below the raw value is still read as a new process.
 * Returns true on a change.
 */
function addCost(m, raw, tabId) {
  if (!Number.isFinite(raw) || raw < 0) return false
  const prev = Number.isFinite(m.costRaw) ? m.costRaw : 0
  const newTab = typeof tabId === 'string' && typeof m.costTab === 'string' && m.costTab !== tabId
  const add = newTab ? raw : raw >= prev ? raw - prev : raw
  const before = m.costUsd
  const beforeTab = m.costTab
  m.costUsd = (Number.isFinite(m.costUsd) ? m.costUsd : 0) + add
  m.costRaw = raw
  if (typeof tabId === 'string') m.costTab = tabId
  return m.costUsd !== before || m.costTab !== beforeTab
}

/**
 * The metrics of one plugin host. `opts` is for tests: `now`, `setTimeout`, `clearTimeout`.
 * `start()` subscribes and polls; `stop()` unsubscribes and saves what is pending.
 */
function createMetrics(ctx, teams, opts = {}) {
  const now = opts.now || Date.now
  const setT = opts.setTimeout || setTimeout
  const clearT = opts.clearTimeout || clearTimeout

  /** roomId -> record (the teams module's own object, refreshed every poll). */
  const recs = new Map()
  /** tabId -> { roomId, name } for live teams' members, from `ctx.rooms.members`. */
  const tabs = new Map()
  /** roomId -> paused (RoomInfo.paused at the last poll). */
  const paused = new Map()
  /** `roomId\0name` -> { roomId, name, bucket, since }: the interval running now, in memory only. */
  const open = new Map()
  /** tabId -> `room|held` as last seen, to poll at once when it changes. */
  const seen = new Map()
  const dirty = new Set()
  let lastSessions = []
  let saveTimer = null
  let disposers = []
  let polling = null
  let flushing = null
  let again = false
  let stopped = false

  const warn = (what, err) => ctx.log.warn(`team metrics: ${what}: ${(err && err.message) || err}`)

  function markDirty(roomId) {
    dirty.add(roomId)
    if (saveTimer === null && !stopped) {
      saveTimer = setT(() => {
        saveTimer = null
        // Kept so stop() can wait for a throttled save that is already writing.
        const p = flush().catch((e) => warn('save', e))
        flushing = p
        p.finally(() => {
          if (flushing === p) flushing = null
        })
        return p
      }, SAVE_MS)
    }
  }

  /**
   * Move an interval's elapsed time into its member's total, up to `t`, and restart it there. `inSave`: the caller
   * is the save itself, which writes the team anyway (no new save is armed).
   */
  function credit(iv, t, inSave) {
    const elapsed = t - iv.since
    iv.since = t
    if (elapsed <= 0 || !iv.bucket || paused.get(iv.roomId)) return
    const rec = recs.get(iv.roomId)
    if (!rec) return
    memberOf(rec, iv.name)[iv.bucket + 'Ms'] += elapsed
    if (!inSave) markDirty(iv.roomId)
  }

  /** Close every open interval of a room (its end, a pause flip, its deletion). */
  function creditRoom(roomId, t, drop) {
    for (const [key, iv] of open) {
      if (iv.roomId !== roomId) continue
      credit(iv, t)
      if (drop) open.delete(key)
    }
  }

  /** Apply a sessions list: costs, context and status intervals of every known member tab. */
  function applySessions(list) {
    const t = now()
    const byTab = new Map(list.map((s) => [s.tabId, s]))
    const live = new Set()
    for (const [tabId, who] of tabs) {
      const rec = recs.get(who.roomId)
      if (!rec || rec.endedAt !== undefined) continue
      const s = byTab.get(tabId)
      // The tab's own `room` says it is out (fired, left, or the room ended) before the next poll refreshes `tabs`:
      // its interval closes now, so the time between a room's end and the poll that sees it is not counted.
      if (s && (!s.room || s.room.name !== who.name)) continue
      const m = memberOf(rec, who.name)
      if (s) {
        // Absent cost or context (status line off, tab ended): keep the last value.
        if (addCost(m, s.costUsd, tabId)) markDirty(who.roomId)
        if (Number.isFinite(s.contextPercent) && m.contextPercent !== s.contextPercent) {
          m.contextPercent = s.contextPercent
          markDirty(who.roomId)
        }
      }
      const bucket = s ? bucketOf(s.status) : null
      const key = `${who.roomId}\0${who.name}`
      live.add(key)
      const iv = open.get(key)
      if (!iv) open.set(key, { roomId: who.roomId, name: who.name, bucket, since: t })
      else if (iv.bucket !== bucket) {
        credit(iv, t)
        iv.bucket = bucket
      }
    }
    // A member whose tab is no longer one of its room's (left, fired, closed): its interval ends now.
    for (const [key, iv] of open) {
      if (live.has(key)) continue
      credit(iv, t)
      open.delete(key)
    }
  }

  function onSessions(list) {
    lastSessions = Array.isArray(list) ? list : []
    let changed = false
    for (const s of lastSessions) {
      const sig = `${s.room ? JSON.stringify(s.room) : ''}|${s.held ?? 0}`
      if (seen.get(s.tabId) !== sig) changed = true
      seen.set(s.tabId, sig)
    }
    for (const tabId of [...seen.keys()]) if (!lastSessions.some((s) => s.tabId === tabId)) seen.delete(tabId)
    applySessions(lastSessions)
    // A tab joined, left or got a message: read the log and the member list now rather than in up to 5 s.
    if (changed) requestPoll()
  }

  /** Apply one log entry to a team's metrics (design §4's counts, hired and left). */
  function applyEntry(rec, e) {
    const at = Number.isFinite(e.at) ? e.at : now()
    switch (e.type) {
      case 'join': {
        if (!isMemberName(e.member)) return
        const m = memberOf(rec, e.member)
        // A name can come back after it left: a new stint, the counts go on.
        m.hiredAt = at
        delete m.leftAt
        delete m.leftWhy
        if (typeof e.coordinator === 'boolean') m.coordinator = e.coordinator
        return
      }
      case 'leave': {
        if (!isMemberName(e.member)) return
        const m = memberOf(rec, e.member)
        m.leftAt = at
        m.leftWhy = leftWhy(e.why)
        return
      }
      case 'end':
        for (const m of Object.values(rec.metrics.members)) {
          if (m && typeof m === 'object' && m.hiredAt !== undefined && m.leftAt === undefined) {
            m.leftAt = at
            m.leftWhy = 'team ended'
          }
        }
        return
      case 'send': {
        if (isMemberName(e.from)) memberOf(rec, e.from).sent++
        // Received: every recipient it reached or queued for (`gone` and `refused` got nothing). Every real send
        // carries `delivery`; the one without is the person's held-badge click (`from: 'person', via: 'badge'`), a
        // pointer to messages already counted through their own `held` answers, so it counts nowhere.
        if (Array.isArray(e.delivery)) {
          for (const d of e.delivery) {
            if (d && (d.path === 'delivered' || d.path === 'held') && isMemberName(d.to)) memberOf(rec, d.to).received++
          }
        }
        return
      }
      // Main logs docs as `{ by, path, bytes }`: `by` is the member, or 'plugin' / 'person' (reserved names, so the
      // plugin's own kickoff writes and the person's reads count for nobody).
      case 'doc-read':
        if (isMemberName(e.by)) memberOf(rec, e.by).docReads++
        return
      case 'doc-write':
        if (isMemberName(e.by)) memberOf(rec, e.by).docWrites++
        return
      default:
    }
  }

  /**
   * Read a team's log from its cursor to the end (or LOG_PAGES_PER_POLL pages), applying every entry. True when it
   * reached the end, false when entries are left for the next poll.
   */
  async function drain(rec) {
    for (let page = 0; page < LOG_PAGES_PER_POLL; page++) {
      const { entries, more } = await ctx.rooms.log(rec.roomId, { since: rec.metrics.logSeq, limit: LOG_PAGE })
      for (const e of entries) {
        // `seq` only goes up; an entry at or below the cursor was counted already (a resend, a restart).
        if (!e || !Number.isInteger(e.seq) || e.seq <= rec.metrics.logSeq) continue
        applyEntry(rec, e)
        rec.metrics.logSeq = e.seq
      }
      if (entries.length) markDirty(rec.roomId)
      if (!more || entries.length === 0) return true
    }
    return false
  }

  async function pollOnce() {
    const t = now()
    const rooms = await ctx.rooms.list()
    const nextTabs = new Map()
    const ids = new Set()
    for (const room of rooms) {
      const rec = await teams.get(room.id)
      if (!rec) continue
      ids.add(room.id)
      recs.set(room.id, rec)
      const ended = rec.endedAt !== undefined || room.endedAt !== undefined
      if (ended) {
        // Never polled again once ended; the one last drain reads up to the end entry (the room's log stays until
        // delete), then the members' open intervals close at the end.
        creditRoom(room.id, room.endedAt ?? rec.endedAt ?? t, true)
        if (!rec.metrics.logDone) {
          try {
            // A backlog longer than one poll's pages: the next poll goes on, until the end entry is read.
            if (await drain(rec)) {
              rec.metrics.logDone = true
              markDirty(room.id)
            }
          } catch (err) {
            warn(`log of ${room.id}`, err)
          }
        }
        continue
      }
      // A pause flip closes the intervals at the flip as seen: time before it counts by the old state.
      if (Boolean(paused.get(room.id)) !== room.paused) {
        creditRoom(room.id, t, false)
        paused.set(room.id, room.paused)
      }
      try {
        for (const m of await ctx.rooms.members(room.id)) {
          if (typeof m.tabId === 'string') nextTabs.set(m.tabId, { roomId: room.id, name: m.name })
        }
        await drain(rec)
      } catch (err) {
        warn(`poll of ${room.id}`, err)
      }
    }
    // Rooms deleted since the last poll: forget them (their record is gone with them).
    for (const id of [...recs.keys()]) {
      if (ids.has(id)) continue
      for (const [key, iv] of open) if (iv.roomId === id) open.delete(key)
      recs.delete(id)
      paused.delete(id)
      dirty.delete(id)
    }
    tabs.clear()
    for (const [k, v] of nextTabs) tabs.set(k, v)
    applySessions(lastSessions)
    // A long stretch with no status change: move it into the totals now and then, so a crash loses little.
    for (const iv of open.values()) if (now() - iv.since >= CHECKPOINT_MS) credit(iv, now())
  }

  /** Poll now, or once more right after the poll running now (calls never overlap). */
  function requestPoll() {
    if (stopped) return Promise.resolve()
    if (polling) {
      again = true
      return polling
    }
    polling = (async () => {
      try {
        do {
          again = false
          try {
            await pollOnce()
          } catch (err) {
            warn('poll', err)
          }
        } while (again && !stopped)
      } finally {
        polling = null
      }
    })()
    return polling
  }

  /** Save every dirty team (its running intervals moved into the totals first). */
  async function flush() {
    if (saveTimer !== null) {
      clearT(saveTimer)
      saveTimer = null
    }
    const t = now()
    const ids = [...dirty]
    dirty.clear()
    for (const iv of open.values()) if (ids.includes(iv.roomId)) credit(iv, t, true)
    for (const id of ids) {
      const rec = recs.get(id)
      if (!rec) continue
      try {
        await teams.save(rec)
      } catch (err) {
        // The team was deleted meanwhile (no record), or storage refused: the next change saves again.
        warn(`save ${id}`, err)
      }
    }
  }

  /**
   * The record of a team for a mark or stats: the teams module's own object, with the running intervals of a live
   * room moved into the totals first so the numbers are current to this instant. The credit marks the team dirty (a
   * throttled save): each credit restarts the intervals, so a panel reading stats every few seconds would otherwise
   * keep the poll's 60 s checkpoint from ever firing, and the credited time would sit unsaved until another change.
   */
  async function currentRecord(roomId) {
    const rec = await teams.get(roomId)
    if (!rec) throw new TeamError('no-team', 'no such team')
    recs.set(roomId, rec)
    if (rec.endedAt === undefined) {
      const t = now()
      for (const iv of open.values()) if (iv.roomId === roomId) credit(iv, t)
    }
    return rec
  }

  /**
   * The record of a team for a display (the panel's state, pushed every few seconds): the running intervals of a live
   * room are added to a copy, so nothing is credited and nothing is marked dirty. A read that marked the team dirty
   * armed a save, whose record write moved the panel's push, which read again: a write of the whole record every
   * few seconds for as long as a page showed the team.
   */
  async function viewRecord(roomId) {
    const rec = await teams.get(roomId)
    if (!rec) throw new TeamError('no-team', 'no such team')
    if (rec.endedAt !== undefined || paused.get(roomId)) return rec
    const t = now()
    let copy = null
    for (const iv of open.values()) {
      if (iv.roomId !== roomId || !iv.bucket || t - iv.since <= 0) continue
      if (copy === null) copy = structuredClone(rec)
      memberOf(copy, iv.name)[iv.bucket + 'Ms'] += t - iv.since
    }
    return copy || rec
  }

  return {
    /** Subscribe to session changes and start the 5 s poll; the first poll runs at once. */
    async start() {
      stopped = false
      disposers.push(ctx.sessions.onChange(onSessions))
      disposers.push(ctx.schedule(POLL_SECONDS, () => requestPoll()))
      try {
        lastSessions = await ctx.sessions.list()
      } catch (err) {
        warn('sessions', err)
      }
      await requestPoll()
    },

    /** Unsubscribe and save what is pending (deactivate, which returns this promise so the host waits for it). */
    async stop() {
      stopped = true
      for (const d of disposers) d()
      disposers = []
      // A poll already running goes on to its end (it may reopen intervals and mark teams dirty), and a throttled
      // save may be writing: wait for both, so the final credit and flush below include what they did.
      if (polling) await polling
      if (flushing) await flushing
      const t = now()
      for (const iv of open.values()) credit(iv, t)
      open.clear()
      await flush()
    },

    /**
     * A timestamp on the team's timeline (design §4): stores the team's cost and working time so far, so spans
     * between marks are plain differences. `by` is the member's name or 'person' (the panel). A mark on an ended
     * team is refused. Saved at once (a mark is an event, not a throttled counter) and rolled back when the save fails.
     */
    async mark(roomId, label, by) {
      if (typeof label !== 'string') throw new TeamError('bad-label', 'a mark needs a label')
      const text = label.trim()
      if (text === '') throw new TeamError('bad-label', 'the mark label is empty')
      if ([...text].length > LABEL_MAX) throw new TeamError('bad-label', `a mark label is at most ${LABEL_MAX} characters`)
      const bad = badTextChar(text)
      if (bad || /[\t\r\n]/.test(text)) throw new TeamError('bad-label', 'a mark label is one line with no control, bidi or invisible format character')
      if (BOUNDARY_LABELS.has(text.toLowerCase())) throw new TeamError('bad-label', `"${text}" names a span's end: pick another label`)
      // The panel's Mark button comes here with no command before it: a room that ended on Rooms' side and is not
      // reconciled yet must not take a mark stamped after its end.
      await teams.refresh()
      const rec = await currentRecord(roomId)
      if (rec.endedAt !== undefined) throw new TeamError('ended', 'the team has ended: no more marks')
      if (rec.marks.length >= MARKS_MAX) throw new TeamError('too-many', `a team has at most ${MARKS_MAX} marks`)
      const totals = totalsOf(rec)
      const m = { at: now(), label: text, by: typeof by === 'string' ? by : 'person', cost: totals.costUsd, workingMs: totals.workingMs }
      rec.marks.push(m)
      try {
        await teams.save(rec)
      } catch (err) {
        const i = rec.marks.indexOf(m)
        if (i >= 0) rec.marks.splice(i, 1)
        // Another save of this record (a second mark's, a throttled flush) may have written the mark while this one
        // was pending: storage would keep a mark the caller is told failed. Mark the team dirty, so the next
        // throttled save writes the record without it.
        markDirty(roomId)
        throw err
      }
      return m
    },

    /**
     * The stats object of a team (lib/stats.js `statsOf`) as of now. `endAt` (the export, run just before the room
     * ends): the stats as if the team had ended then, so its last span runs to "end", not "now". `readOnly` (a display):
     * the same numbers, with the running intervals counted on a copy instead of credited (no save armed).
     */
    async stats(roomId, { endAt, readOnly = false } = {}) {
      const rec = readOnly ? await viewRecord(roomId) : await currentRecord(roomId)
      if (Number.isFinite(endAt) && rec.endedAt === undefined) return statsOf({ ...rec, endedAt: endAt }, endAt)
      return statsOf(rec, now())
    },

    /**
     * The person did something in the panel (design §4: their active time, a proxy): its time is kept, capped, and
     * counted for a short window by `personActiveMs`. Ended teams and a failed save change nothing visible.
     */
    async panelAction(roomId) {
      // As for mark: a room ended behind the record's back takes no action. A failed refresh is not the person's
      // problem (an action is a proxy): go on with the record as it is.
      try {
        await teams.refresh()
      } catch (err) {
        warn('refresh', err)
      }
      const rec = await teams.get(roomId)
      if (!rec || rec.endedAt !== undefined) return
      recs.set(roomId, rec)
      if (!Array.isArray(rec.metrics.actions)) rec.metrics.actions = []
      const t = now()
      rec.metrics.actions.push(t)
      if (rec.metrics.actions.length > ACTIONS_MAX) {
        // The oldest fall out, their time folded into the stored counters first so the person's time never drops.
        const dropped = rec.metrics.actions.splice(0, rec.metrics.actions.length - ACTIONS_MAX)
        foldOut(rec, [], dropped, t)
      }
      markDirty(roomId)
    },

    poll: requestPoll,
    flush,
    /** For tests and the host: the sessions listener. */
    onSessions,

    /**
     * What a hire knows that the log does not: the member's model and effort (absent: the person's default). Called
     * after a successful open; a name hired again takes the new values.
     */
    async hired(roomId, name, { model, effort } = {}) {
      const rec = await teams.get(roomId)
      if (!rec) return
      recs.set(roomId, rec)
      const m = memberOf(rec, name)
      if (model !== undefined) m.model = model
      else delete m.model
      if (effort !== undefined) m.effort = effort
      else delete m.effort
      markDirty(roomId)
      requestPoll()
    },
  }
}

module.exports = { LOG_PAGE, createMetrics, bucketOf, leftWhy, addCost, POLL_SECONDS, SAVE_MS, CHECKPOINT_MS, LABEL_MAX, MARKS_MAX }
