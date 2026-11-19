'use strict'
// The Team panel's backend (docs/design.md §7): the port protocol between the host and `panels/team.html`.
//
// The page only renders what the host pushes and asks for things; every action is checked again here, as if the page
// were not there: the room id names one of this plugin's teams (`teams.get`, and `ctx.rooms` sees no other room
// anyway), a member is found by name in main's member list (`ctx.rooms.members`) and its tab id never comes from the
// page. The person is the one at the panel, so the panel may do what a coordinator may, and Delete of an ended team.
//
// Protocol (all JSON; the page's `req` is echoed on an answer so it can match it):
// - page -> host `{ type: 'hello', selected? }` when it connects (`ccPanel.onConnect`; a hidden panel drops posts,
//   so it re-sends what it holds) and `{ type: 'select', roomId }`: the host answers that view at once with the
//   whole state. Every view (the desktop window, each web access browser) has its own selection.
// - page -> host `{ type: 'ping', selected? }` every PING_SECONDS (30 s) while the page is shown. Main never says a
//   view left (a post to a hidden or gone page is dropped silently), so a view not heard from for VIEW_TTL_MS is
//   forgotten and gets no more pushes; a ping from a view the host forgot is answered like a hello.
// - host -> page `{ type: 'state', teams, team, exportDir }`: `teams` the summary of every team (live and ended),
//   `team` the selected team's details (members, open questions, marks, stats), or null. Pushed to each known view on
//   change (records written, sessions changed, a 5 s tick for the running times), at most once a second, and only
//   when it differs from what that view got last.
// - page -> host actions and reads `{ type, req, roomId, ... }`; the answer goes to that view only:
//   `{ type: 'result', action, req, ok: true, ...data }` or `{ type: 'result', action, req, ok: false, error }`.
//   Activity, the docs list and a doc's text come the same way, on request: the page asks for the activity and the
//   docs list again when the team's `logSeq` in the state moved, but NEVER re-reads a doc's text on that: a doc read
//   is the plugin's, which Rooms logs (`doc-read`, `by: 'plugin'`), so it moves `logSeq` itself and a re-read on
//   every move would read and log forever. A doc's text is read when the person opens it (or asks to refresh it).
//   An answer too big to post (over 1 MiB) comes back as `ok: false, error: 'too big to show'`.
// - Guests (cc-cockpit's guest invites; the manifest declares `guests.aware`): main tags each view with who is behind
//   it, `from.access` ('owner', or a guest's 'read' / 'write'; an app before guests sends none: the owner, as before),
//   never the page. A guest's view gets the state (without `exportDir`, the owner's folder) and the reads (activity,
//   docs, a doc), and every action is refused to it: a guest watches a team, the owner runs it. `ccc team` from a tab
//   the owner shared with a write guest is the owner's command, as any typing there (out of the plugin's reach).
// - `team.membersUnknown: true`: main's member list could not be read (a timeout, the room ending meanwhile); the
//   members are the last list read, or from the metrics with `status: 'unknown'`, never shown as having left.

const fsp = require('node:fs/promises')
const path = require('node:path')

const { TeamError, abandonStart, checkName } = require('./teams.js')
const { readKickoff } = require('./kickoff.js')
const { totalsOf } = require('./stats.js')
const { isOpen, TEXT_MAX } = require('./questions.js')
const { LOG_PAGE, LABEL_MAX } = require('./metrics.js')

const PANEL = 'team'
/** What a guest's view may ask beyond the state (hello, select, ping): reading the team. */
const GUEST_ACTIONS = new Set(['activity', 'docs', 'doc'])
const GUEST_REFUSED = 'Guests can watch a team, not change it: the owner runs it.'

/**
 * Who is behind a view, as main tagged it (`from.access`). None at all: an app before guests, whose every view is the
 * owner's (as today). Anything but the owner's is a guest's, an unknown value read as the lesser role.
 */
function accessOf(from) {
  const a = from && typeof from === 'object' ? from.access : undefined
  if (a === undefined || a === 'owner') return 'owner'
  return a === 'write' ? 'write' : 'read'
}
/** At most one push a second: sessions change up to 4 times a second, metrics save every 5 s. */
const PUSH_MS = 1000
/** The running times (working, elapsed) move with no event: a push this often while a page is there. */
const TICK_SECONDS = 5
/**
 * Views are remembered from their messages (main never says one left: a post to a gone browser view is dropped).
 * Past this many, the one heard from least recently is forgotten (it says hello again when it comes back).
 */
const VIEWS_MAX = 16
/** The page pings this often while shown; a view silent for VIEW_TTL_MS (two missed pings and some) is forgotten. */
const PING_SECONDS = 30
const VIEW_TTL_MS = 75_000
/** Activity entries per page, and log pages read at most to fill one (a filter matching little must not hold the host). */
const ACTIVITY_PAGE = 50
const ACTIVITY_SCAN_PAGES = 10
/**
 * `ctx.rooms.log` calls at most for one activity page: a log page is bounded by bytes as well as by count (about 50
 * long sends fill one), so a window of LOG_PAGE seqs can take a few reads; 40 cover a whole 20 MiB log.
 */
const ACTIVITY_SCAN_READS = 40
/**
 * A message text in an activity entry is cut to this many characters (`cut: true`): 50 messages of 20000 characters
 * would pass the 1 MiB post limit. The whole text is in core's room view and in the export's log.jsonl.
 */
const FIELD_TEXT_MAX = 2000
/** Docs listed at most (Rooms holds 20 MiB a room; each doc can be a few bytes). */
const DOCS_MAX = 2000
/** Rooms' log entry types (types.ts RoomLogEntry), plus the team's marks: the activity's kind filter. */
const ACTIVITY_KINDS = new Set(['create', 'invite', 'join', 'leave', 'send', 'doc-read', 'doc-write', 'doc-refused', 'pause', 'resume', 'auto-pause', 'end', 'trimmed', 'mark'])
/**
 * Lengths a page may send (Rooms, metrics and the kickoff reader check the real rules; these only bound the input),
 * in UTF-16 units. A bound must never refuse what the real rule takes: those rules count code points (an emoji is
 * one character and two units) and a title or a mark label is trimmed first, so those two fields are measured after
 * the trim against a ceiling far over their rule (`chars`: four times it, so the rule's own refusal speaks for all
 * but absurd input; twice would already be met by 200 emoji, and the 201st would get this bound's text). The other fields are ASCII by their rule (member names, model, effort,
 * kind, question ids, doc paths, room ids), and a path's units never exceed its bytes (Linux PATH_MAX is 4096 bytes).
 */
const LINE_MAX = 300
const PATH_MAX = 4096
/** Rooms' title rule (room-names.ts): 60 code points after the trim. */
const TITLE_CHARS = 60

const bad = (what) => new TeamError('bad-input', what)

/** A string field of a page message, or a refusal naming it. */
function str(m, key, { max = LINE_MAX, optional = false, empty = false, chars } = {}) {
  const v = m[key]
  if (v === undefined || v === null || (v === '' && optional && !empty)) {
    if (optional) return undefined
    throw bad(`${key} is missing`)
  }
  if (typeof v !== 'string') throw bad(`${key} must be text`)
  if (!empty && v.trim() === '') throw bad(`${key} is empty`)
  if (chars !== undefined) {
    // The rule behind trims first and counts code points: padding it drops is not counted (the value goes on as
    // given), and only input far over the rule is refused here.
    if (v.trim().length > chars * 4) throw bad(`${key} is far longer than ${chars} characters`)
    return v
  }
  if (v.length > max) throw bad(`${key} is at most ${max} characters`)
  return v
}

/** The page's request id, echoed back: a short string or a safe integer, else none. */
function reqOf(v) {
  if (typeof v === 'string' && v.length <= 64) return v
  if (Number.isSafeInteger(v)) return v
  return undefined
}

/** What a member's tab is doing, as one word: SessionStatus, or `closed` for no tab (or a process that ended). */
function statusOf(s) {
  if (!s || s.status === 'ended') return 'closed'
  return s.status
}

/** A text field of a log entry as the page gets it: cut at FIELD_TEXT_MAX. */
function cutText(v, flags) {
  if (v.length <= FIELD_TEXT_MAX) return v
  flags.cut = true
  return v.slice(0, FIELD_TEXT_MAX)
}

/** One flat object of a log entry's array field (`delivery`): its plain values only. */
function flatOf(x, flags) {
  const out = {}
  for (const [k, v] of Object.entries(x).slice(0, 10)) {
    if (typeof v === 'string') out[k] = cutText(v, flags)
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') out[k] = v
  }
  return out
}

/**
 * A log entry as the page gets it: plain values (strings cut), and arrays of flat objects (`delivery`). The fields
 * are main's (types.ts: "the other fields depend on it"), so none is assumed; a member's text stays text, the page
 * renders it as such.
 */
function cleanEntry(e) {
  const flags = {}
  const out = {}
  for (const [k, v] of Object.entries(e).slice(0, 20)) {
    if (typeof v === 'string') out[k] = cutText(v, flags)
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') out[k] = v
    else if (Array.isArray(v)) out[k] = v.slice(0, 50).filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map((x) => flatOf(x, flags))
  }
  if (flags.cut) out.cut = true
  return out
}

/** Whether a log entry concerns member `name`: it is its subject, sender, recipient, reader or writer. */
function entryHasMember(e, name) {
  if (e.member === name || e.from === name || e.to === name || e.by === name) return true
  return Array.isArray(e.delivery) && e.delivery.some((d) => d && d.to === name)
}

/**
 * The panel backend. `inst` is the host's one set of shared instances (`host.instances()`: teams, questions, metrics,
 * ending, hiring): the reply lock, the end lock, the hire lock and the metrics' intervals live in them, so a second set
 * would let the panel and `ccc team` race. `opts` is for tests: `now`, `setTimeout`, `clearTimeout`.
 */
function createPanel(ctx, inst, opts = {}) {
  const { teams, questions, metrics, ending, hiring } = inst
  for (const [k, v] of Object.entries({ teams, questions, metrics, ending, hiring })) {
    if (!v) throw new TypeError(`createPanel: pass the host's ${k} instance`)
  }
  // Hire and Fire are refused while a team is being exported and ended only if hiring holds the teams' own guard.
  if (hiring.guard !== teams.guard) throw new TypeError("createPanel: hiring must take the teams' export guard (createHiring(ctx, metrics, questions.names, teams.guard))")
  const now = opts.now || Date.now
  const setT = opts.setTimeout || setTimeout
  const clearT = opts.clearTimeout || clearTimeout

  /**
   * view -> { selected: roomId | null, last: the JSON of the last state posted to it, gen, heard: when its last
   * message came }; oldest heard first.
   */
  const views = new Map()
  /** roomId -> main's member list as last read (shown, marked unknown, when a read fails). */
  const lastMembers = new Map()
  let disposers = []
  let timer = null
  let lastPush = -Infinity
  let running = null
  let again = false
  let stopped = true

  const warn = (what, err) => ctx.log.warn(`team panel: ${what}: ${(err && err.message) || err}`)

  function post(message, view) {
    try {
      ctx.panels.post(PANEL, message, { view })
      return true
    } catch (err) {
      // Too big (over 1 MiB) or a view main does not know: logged, never thrown into a listener.
      warn(`post to ${view}`, err)
      return err instanceof RangeError ? 'too-big' : false
    }
  }

  /** An answer to a page's request: one that is too big is answered short, so the page never waits on its `req`. */
  function answer(message, view) {
    if (post(message, view) === 'too-big') {
      post({ type: 'result', action: message.action, req: message.req, ok: false, error: 'too big to show' }, view)
    }
  }

  /**
   * The view's entry, made on first sight and moved to the newest end; the least recent falls out past VIEWS_MAX.
   * `gen` moves on every hello and select: a push that started before it does not post to that view (it read the
   * old selection, or older records), so a slower earlier push never overwrites the newer state.
   */
  function touch(view) {
    let st = views.get(view)
    if (st) views.delete(view)
    else st = { selected: null, last: null, gen: 0, heard: 0, access: 'owner' }
    st.heard = now()
    views.set(view, st)
    while (views.size > VIEWS_MAX) views.delete(views.keys().next().value)
    return st
  }

  /** Forget the views not heard from for VIEW_TTL_MS (oldest heard first, so stop at the first one still fresh). */
  function prune() {
    const t = now()
    for (const [view, st] of views) {
      if (t - st.heard < VIEW_TTL_MS) break
      views.delete(view)
    }
  }

  // ---- state ----

  /** One line per team: what the Teams list shows. */
  function summaryOf(rec, info) {
    return {
      roomId: rec.roomId,
      title: rec.title,
      createdAt: rec.createdAt,
      ...(rec.endedAt !== undefined ? { endedAt: rec.endedAt } : {}),
      paused: Boolean(info && info.paused),
      members: info && Number.isInteger(info.members) ? info.members : 0,
      waiting: rec.questions.filter(isOpen).length,
      costUsd: totalsOf(rec).costUsd,
      logSeq: rec.metrics.logSeq,
    }
  }

  /**
   * The members of a team: those in the room now (main's list, joined with their tab's session and their metrics),
   * then those that left (from the metrics, with why). Never a tab id: a focus goes by name and is resolved here.
   */
  function membersOf(inRoom, stats, byTab) {
    const unknown = inRoom === null
    const metricsOf = new Map((stats ? stats.members : []).map((m) => [m.name, m]))
    const out = []
    const numbers = (st) => ({
      model: st.model,
      effort: st.effort,
      costUsd: Number.isFinite(st.costUsd) ? st.costUsd : null,
      workingMs: st.workingMs,
      waitingMs: st.waitingMs,
      idleMs: st.idleMs,
      sent: st.sent,
      received: st.received,
      docReads: st.docReads,
      docWrites: st.docWrites,
      questionsAsked: st.questionsAsked,
      hiredAt: st.hiredAt,
    })
    for (const m of inRoom || []) {
      const s = typeof m.tabId === 'string' ? byTab.get(m.tabId) : undefined
      const st = metricsOf.get(m.name) || {}
      metricsOf.delete(m.name)
      out.push({
        name: m.name,
        coordinator: m.coordinator === true,
        in: true,
        status: statusOf(s),
        ...(s && typeof s.tool === 'string' ? { tool: s.tool } : {}),
        held: Number.isInteger(m.held) ? m.held : 0,
        ...numbers(st),
        // The tab's own value is the freshest; the metrics keep the last one seen.
        contextPercent: s && Number.isFinite(s.contextPercent) ? s.contextPercent : Number.isFinite(st.contextPercent) ? st.contextPercent : null,
      })
    }
    for (const st of metricsOf.values()) {
      out.push({
        name: st.name,
        coordinator: st.coordinator === true,
        // Main's list could not be read: a member not seen to leave may be in the room, so it is not shown as left.
        in: unknown && st.leftAt === undefined ? null : false,
        // Hired but never seen to leave (a record from before the log was read): still not in the room.
        status: unknown && st.leftAt === undefined ? 'unknown' : 'left',
        ...(st.leftWhy !== undefined ? { leftWhy: st.leftWhy } : {}),
        ...(st.leftAt !== undefined ? { leftAt: st.leftAt } : {}),
        held: 0,
        ...numbers(st),
        contextPercent: Number.isFinite(st.contextPercent) ? st.contextPercent : null,
      })
    }
    return out
  }

  /** The selected team's details, or null when it is gone. */
  async function detailOf(roomId, byTab, infos) {
    const rec = await teams.get(roomId)
    if (!rec) return null
    const info = infos.get(roomId)
    let stats = null
    try {
      // Read-only: a display must not credit the running times (that marks the team dirty and arms a save every push).
      stats = await metrics.stats(roomId, { readOnly: true })
    } catch (err) {
      warn(`stats of ${roomId}`, err)
    }
    let inRoom = []
    let membersUnknown = false
    if (rec.endedAt === undefined) {
      try {
        inRoom = await ctx.rooms.members(roomId)
        lastMembers.set(roomId, inRoom)
      } catch (err) {
        // A failed read is not a state: the last list read, else unknown (never "everyone left").
        warn(`members of ${roomId}`, err)
        membersUnknown = true
        inRoom = lastMembers.has(roomId) ? lastMembers.get(roomId) : null
      }
    }
    return {
      ...summaryOf(rec, info),
      members: membersOf(inRoom, stats, byTab),
      ...(membersUnknown ? { membersUnknown: true } : {}),
      // Open questions only (at most 50 and 100,000 characters a team, questions.js): the closed ones are history.
      questions: rec.questions.filter(isOpen).map((q) => ({ id: q.id, from: q.from, text: q.text, askedAt: q.askedAt })),
      marks: stats ? stats.marks : [],
      stats: stats
        ? {
            elapsedMs: stats.elapsedMs,
            totals: stats.totals,
            personActiveMs: stats.personActiveMs,
            personActiveIsProxy: stats.personActiveIsProxy,
            questions: stats.questions,
            spans: stats.spans,
          }
        : null,
    }
  }

  /** The whole state for `targets` (views): one summary, one detail per selected team. */
  async function pushOnce(targets, force) {
    if (targets.length === 0) return
    // Each view's selection generation as this push starts: a hello or select landing meanwhile wins.
    const gens = new Map(targets.map((v) => [v, views.get(v)]).filter(([, st]) => st).map(([v, st]) => [v, { st, gen: st.gen }]))
    try {
      // A room ended or deleted outside the plugin (core's room view) shows as such.
      await teams.refresh()
    } catch (err) {
      warn('refresh', err)
    }
    const recs = await teams.list()
    for (const id of lastMembers.keys()) if (!recs.some((r) => r.roomId === id && r.endedAt === undefined)) lastMembers.delete(id)
    const infos = new Map()
    try {
      for (const r of await ctx.rooms.list()) infos.set(r.id, r)
    } catch (err) {
      warn('rooms', err)
    }
    let sessions = []
    try {
      sessions = await ctx.sessions.list()
    } catch (err) {
      warn('sessions', err)
    }
    const byTab = new Map(sessions.map((s) => [s.tabId, s]))
    // Newest first: the team being worked on is on top.
    const summaries = recs.map((rec) => summaryOf(rec, infos.get(rec.roomId))).sort((a, b) => b.createdAt - a.createdAt)
    const exportDir = ending.settingDir()
    const details = new Map()
    for (const view of targets) {
      const st = views.get(view)
      const g = gens.get(view)
      // Forgotten, or a newer hello/select came meanwhile (its own push posts the newer state).
      if (!st || !g || g.st !== st || g.gen !== st.gen) continue
      let team = null
      if (st.selected !== null) {
        if (!details.has(st.selected)) details.set(st.selected, await detailOf(st.selected, byTab, infos))
        team = details.get(st.selected)
      }
      // Checked again after the detail's reads.
      if (views.get(view) !== st || g.gen !== st.gen) continue
      // The export folder is the owner's (a path on their machine): a guest's view gets none.
      const dirFor = st.access === 'owner' ? exportDir : null
      const message = { type: 'state', teams: summaries, team, exportDir: dirFor }
      const text = JSON.stringify(message)
      if (!force && text === st.last) continue
      st.last = text
      if (post(message, view) === 'too-big') {
        // Too big for one post (the caps should keep it under 1 MiB): the summary alone, saying so.
        st.last = null
        post({ type: 'state', teams: summaries, team: null, exportDir: dirFor, error: 'the team is too big to show' }, view)
      }
    }
  }

  /** Push to every known view now, or once more when this one ends (pushes never overlap). */
  function runPush() {
    if (running) {
      again = true
      return running
    }
    lastPush = now()
    prune()
    running = pushOnce([...views.keys()], false)
      .catch((err) => warn('push', err))
      .finally(() => {
        running = null
        if (again) {
          again = false
          schedulePush()
        }
      })
    return running
  }

  /** A push within PUSH_MS of the last one (a burst of changes is one push). Nothing while no page is known. */
  function schedulePush() {
    prune()
    if (stopped || views.size === 0 || timer !== null) return
    const wait = Math.max(0, lastPush + PUSH_MS - now())
    timer = setT(() => {
      timer = null
      if (!stopped) runPush()
    }, wait)
  }

  /** One view's whole state now (it connected or changed its selection): not throttled, always posted. */
  function pushTo(view) {
    return pushOnce([view], true).catch((err) => warn(`push to ${view}`, err))
  }

  // ---- checks ----

  /** The team named by the page, refusing an unknown id (any id: `ctx.rooms` knows only ours). */
  async function teamOf(m, { live = false } = {}) {
    if (typeof m.roomId !== 'string' || m.roomId === '' || m.roomId.length > LINE_MAX) throw new TeamError('no-team', 'no such team')
    // The record's endedAt can lag Rooms (a room ended from core's room view): bring it in line first.
    if (live) await teams.refresh()
    const rec = await teams.get(m.roomId)
    if (!rec) throw new TeamError('no-team', 'no such team')
    if (live && rec.endedAt !== undefined) throw new TeamError('ended', 'the team has ended')
    return rec
  }

  /** A member of a live team, by name, from main's list. */
  async function memberOf(rec, name) {
    const members = await ctx.rooms.members(rec.roomId)
    const m = members.find((x) => x.name === name)
    if (!m) throw new TeamError('no-member', `${name} is not in the team`)
    return m
  }

  /**
   * A path the page named (kickoff, cwd, export folder), resolved against the project folder. From the desktop window
   * it is any path, as for a coordinator tab (design §8: same OS user, not a boundary). From a web access browser view
   * (`from.view` is not `desktop`) it must be inside the project folder by its real path, as the app's own rules for
   * `ctx.files` (reveal, download): a paired device is another caller than the person at the desktop, and these paths
   * are read (a kickoff, seeded as a room doc the page can show) or written (an export folder) by the host. Answers the
   * real path for a remote view, so what is used is what was checked.
   */
  async function pathOf(p, what, remote) {
    const abs = path.resolve(ctx.projectDir, p)
    if (!remote) return abs
    const outside = new TeamError('outside', `${what} ${p}: from a browser, only a path inside the project folder`)
    let real
    let project
    try {
      real = await fsp.realpath(abs)
      project = await fsp.realpath(ctx.projectDir)
    } catch (err) {
      if (err && err.code === 'ENOENT') throw new TeamError('no-path', `${what} ${p}: no such file or folder`)
      throw outside
    }
    const rel = path.relative(project, real)
    if (rel !== '' && (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) throw outside
    return real
  }

  /** The common hire options of the New team and Hire forms. */
  async function hireOptions(m, remote) {
    const o = {}
    const model = str(m, 'model', { optional: true })
    const effort = str(m, 'effort', { optional: true })
    const cwd = str(m, 'cwd', { optional: true, max: PATH_MAX })
    if (model !== undefined) o.model = model
    if (effort !== undefined) o.effort = effort
    if (cwd !== undefined) o.cwd = remote ? await pathOf(cwd, 'cwd', true) : cwd
    return o
  }

  // ---- the activity ----

  /**
   * One page of a team's activity, newest first: the room log (paged backwards from `before`, a `{ seq, at }`
   * cursor the previous page answered) with the marks of the same stretch of time, filtered by member and kind.
   * Rooms pages the log oldest-first after a `seq` (or the newest without one), so an older page is read as the
   * entries after `before.seq - 1 - window` (LOG_PAGE seqs, fewer when its entries are long: a log page is bounded by
   * bytes too). The log is trimmed only from its start, so an empty answer is its start.
   */
  async function activity(rec, m) {
    const member = str(m, 'member', { optional: true })
    const kind = str(m, 'kind', { optional: true })
    if (kind !== undefined && !ACTIVITY_KINDS.has(kind)) throw bad(`unknown kind: ${kind}`)
    let before
    if (m.before !== undefined && m.before !== null) {
      const b = m.before
      if (!b || typeof b !== 'object' || !Number.isSafeInteger(b.seq) || b.seq < 1 || !Number.isFinite(b.at)) throw bad('before must be a cursor')
      before = { seq: b.seq, at: b.at }
    }
    const markOk = (mk) => member === undefined || mk.by === member
    const markItem = (mk) => ({ type: 'mark', at: mk.at, label: mk.label, by: mk.by })
    const marks = rec.marks.filter((mk) => Number.isFinite(mk.at) && typeof mk.label === 'string')

    // Marks only: at most 200 a team (metrics.js MARKS_MAX), one page with no cursor.
    if (kind === 'mark') {
      const items = marks.filter(markOk).map(markItem).sort((a, b) => b.at - a.at)
      return { roomId: rec.roomId, entries: items, before: null }
    }

    const want = (e) => (kind === undefined || e.type === kind) && (member === undefined || entryHasMember(e, member))
    const valid = (e) => e && Number.isSafeInteger(e.seq) && typeof e.type === 'string'
    const out = []
    let cursor = null
    let start = false
    let upper = before ? before.seq : null
    // How many seqs a window below `upper` spans: a log page is bounded by bytes too (main answers at least one entry
    // and `more`), so a window that did not fit one read is made smaller for the next one.
    let window = LOG_PAGE
    let reads = 0
    for (let i = 0; i < ACTIVITY_SCAN_PAGES && reads < ACTIVITY_SCAN_READS && out.length < ACTIVITY_PAGE && !start; i++) {
      let entries
      let older = true
      if (upper === null) {
        // The newest entries, contiguous up to the newest (a byte-capped page drops the OLDEST); `more` false: there
        // is nothing older than them.
        const page = await ctx.rooms.log(rec.roomId, { limit: LOG_PAGE })
        reads++
        entries = page.entries
        older = page.more === true
      } else if (upper <= 1) {
        entries = []
      } else {
        // Every entry in (since, upper): a `since` read answers the OLDEST after it and may stop short of `upper` on
        // its byte cap (`more`), so walking only that answer backwards would skip the entries between it and `upper`
        // for good. A first read cut short makes the window as small as what fitted and starts again nearer `upper`
        // (each restart is smaller, so it ends); a later read cut short is read on from its last seq.
        let since = Math.max(0, upper - 1 - window)
        let s = since
        let complete = false
        entries = []
        while (reads < ACTIVITY_SCAN_READS) {
          const page = await ctx.rooms.log(rec.roomId, { since: s, limit: LOG_PAGE })
          reads++
          const got = Array.isArray(page.entries) ? page.entries.filter(valid) : []
          const last = got.length > 0 ? got[got.length - 1].seq : null
          // Done: nothing newer, or reached `upper`, or an answer that does not move on (never loop on it).
          const done = page.more !== true || last === null || last >= upper - 1 || last <= s
          if (!done && s === since && got.length < upper - 1 - since) {
            window = Math.max(1, got.length)
            since = Math.max(0, upper - 1 - window)
            s = since
            entries = []
            continue
          }
          for (const e of got) if (e.seq > s && e.seq < upper) entries.push(e)
          if (done) {
            complete = true
            // A window read whole in one answer may grow again (entries are not all long).
            if (s === since) window = Math.min(LOG_PAGE, window * 2)
            break
          }
          s = last
        }
        // The read budget ran out inside the window: none of it is shown, the cursor stays at the last whole one.
        if (!complete) break
      }
      entries = entries.filter((e) => valid(e) && (upper === null || e.seq < upper))
      if (entries.length === 0) {
        start = true
        break
      }
      let j = entries.length - 1
      for (; j >= 0; j--) {
        const e = entries[j]
        cursor = { seq: e.seq, at: Number.isFinite(e.at) ? e.at : 0 }
        if (want(e)) out.push(cleanEntry(e))
        if (out.length >= ACTIVITY_PAGE) break
      }
      // Read to the oldest entry of a batch with nothing before it (seq 1, or the newest page said so): the start.
      if (j <= 0 && (cursor.seq <= 1 || !older)) start = true
      upper = cursor.seq
    }
    // The read budget ran out before a single window was whole: no progress, the page asks again from the same cursor.
    if (cursor === null && before && !start) cursor = before
    // The marks of this page's stretch of time: from the oldest entry read (or the team's start, on the last page) up
    // to the previous page's oldest (exclusive; the newest page has no upper end), so each mark is on one page only.
    // A kind filter naming a log type leaves the marks out (kind `mark` is answered above).
    const high = before ? before.at : Infinity
    const low = start || cursor === null ? -Infinity : cursor.at
    const items = out.concat(marks.filter((mk) => kind === undefined && mk.at >= low && mk.at < high && markOk(mk)).map(markItem))
    // Newest first; a stable sort keeps the log's own order for entries of one millisecond.
    items.sort((a, b) => b.at - a.at)
    return { roomId: rec.roomId, entries: items, before: start ? null : cursor }
  }

  // ---- actions ----

  /**
   * Each action: `(m) => data` for the answer. `team: true` counts it as the person's activity on its team
   * (metrics.panelAction, design §4); reads the page makes by itself (state, activity paging) are not counted.
   */
  const actions = {
    'new-team': {
      async run(m, { remote }) {
        // Rooms' 60 code points after the trim: rooms.create says what is too long.
        const title = str(m, 'title', { chars: TITLE_CHARS })
        const name = str(m, 'name', { optional: true }) ?? 'lead'
        checkName(name)
        const kickoff = str(m, 'kickoff', { optional: true, max: PATH_MAX })
        const o = await hireOptions(m, remote)
        // The kickoff is refused before the room exists, so a bad file leaves nothing behind.
        const kickoffText = kickoff !== undefined ? await readKickoff(await pathOf(kickoff, 'kickoff', remote), ctx.projectDir) : undefined
        const { id } = await ctx.rooms.create({ title })
        // Held from here (no await in between) to the lead's open, or to the cleanup of a New team that failed, as
        // `ccc team start`: a Hire landing while the lead's open was on its way, then a failed open, had the cleanup
        // delete the room with the hired member in it (round 10). Only this setup's own hire passes (its token).
        const { tabId } = await teams.guard.setup(id, async (own) => {
          try {
            await teams.add({ id })
            return await hiring.hire(id, [], name, { ...o, kickoffText, coordinator: true, setup: own }, ctx.projectDir)
          } catch (err) {
            // No lead, no team: a room nobody is in would only hold one of the plugin's room slots. Ended and deleted
            // while it is still as this New team left it (teams.js abandonStart).
            throw await abandonStart(ctx, teams, id, name, err)
          }
        })
        // The person clicked: show them the lead's tab. Inside this listener, so it acts in the view they clicked in.
        try {
          await ctx.sessions.focus(tabId)
        } catch (err) {
          warn('new team: focus', err)
        }
        return { roomId: id, name }
      },
      team: (m, out) => out && out.roomId,
    },
    hire: {
      async run(m, { remote }) {
        const rec = await teamOf(m, { live: true })
        const name = str(m, 'name')
        const kickoff = await pathOf(str(m, 'kickoff', { max: PATH_MAX }), 'kickoff', remote)
        const o = await hireOptions(m, remote)
        if (m.coordinator !== undefined && typeof m.coordinator !== 'boolean') throw bad('coordinator must be true or false')
        const members = await ctx.rooms.members(rec.roomId)
        const { docPath } = await hiring.hire(rec.roomId, members, name, { ...o, kickoff, coordinator: m.coordinator === true }, ctx.projectDir)
        return { roomId: rec.roomId, name, docPath }
      },
    },
    mark: {
      async run(m) {
        const rec = await teamOf(m, { live: true })
        // metrics.mark counts LABEL_MAX code points after the trim, as for `ccc team mark`, and says what is too long.
        const label = str(m, 'label', { chars: LABEL_MAX })
        const mk = await metrics.mark(rec.roomId, label, 'person')
        return { roomId: rec.roomId, label: mk.label, at: mk.at }
      },
    },
    end: {
      async run(m, { remote }) {
        const rec = await teamOf(m, { live: true })
        const dir = str(m, 'dir', { optional: true, max: PATH_MAX })
        // No budget (the panel has no 30 s cut): a big team takes as long as its export takes. No folder named: the
        // app setting's, which the person chose in Settings (a browser view may use it too).
        const { folder, closed } = await ending.endTeam(rec.roomId, dir !== undefined ? { dir: await pathOf(dir, 'export folder', remote) } : {})
        return { roomId: rec.roomId, ...(folder ? { folder } : {}), ...(closed > 0 ? { closed } : {}) }
      },
    },
    delete: {
      async run(m) {
        // Delete is the panel's only (an ended room has no member to run a command): checked here, then again by
        // ending.deleteTeam under its lock.
        await teams.refresh()
        const rec = await teamOf(m)
        if (rec.endedAt === undefined) throw new TeamError('live', 'only an ended team can be deleted: end it first')
        const { title } = await ending.deleteTeam(rec.roomId)
        // Every view that showed it shows nothing selected.
        for (const st of views.values()) if (st.selected === rec.roomId) st.selected = null
        return { roomId: rec.roomId, title }
      },
      team: () => undefined,
    },
    reply: {
      async run(m) {
        const rec = await teamOf(m)
        const id = str(m, 'id', { max: 20 })
        // A ceiling in UTF-16 units only (20000 characters are at most twice that); questions.reply counts code
        // points, as Rooms does, and says how many fit.
        const text = str(m, 'text', { max: TEXT_MAX * 2 })
        const { answers } = await questions.reply(rec.roomId, id, text)
        return { roomId: rec.roomId, id, answers }
      },
    },
    done: {
      async run(m) {
        // An ended team is read-only (questions.done refuses it too, after its own refresh).
        const rec = await teamOf(m, { live: true })
        const id = str(m, 'id', { max: 20 })
        await questions.done(rec.roomId, id)
        return { roomId: rec.roomId, id }
      },
    },
    fire: {
      async run(m) {
        const rec = await teamOf(m, { live: true })
        const name = str(m, 'name')
        await memberOf(rec, name)
        await hiring.fire(rec.roomId, name)
        return { roomId: rec.roomId, name }
      },
    },
    focus: {
      async run(m) {
        const rec = await teamOf(m, { live: true })
        const name = str(m, 'name')
        const member = await memberOf(rec, name)
        if (typeof member.tabId !== 'string') throw new TeamError('no-tab', `${name} has no tab now`)
        // Inside the listener: main shows the tab in the view the person clicked in.
        if (!(await ctx.sessions.focus(member.tabId))) throw new TeamError('no-tab', `${name}'s tab is gone`)
        return { roomId: rec.roomId, name }
      },
    },
    invite: {
      async run(m) {
        const rec = await teamOf(m, { live: true })
        const name = str(m, 'name')
        if (m.coordinator !== undefined && typeof m.coordinator !== 'boolean') throw bad('coordinator must be true or false')
        // A change of the plugin's to the team, as `ccc team invite`: under the guard, the team checked live inside.
        const inv = await hiring.invite(rec.roomId, name, m.coordinator === true)
        return { roomId: rec.roomId, name, code: inv.code, expiresAt: inv.expiresAt, line: `ccc room join ${inv.code}` }
      },
    },
    activity: {
      run: async (m) => activity(await teamOf(m), m),
      team: () => undefined,
    },
    docs: {
      async run(m) {
        const rec = await teamOf(m)
        const docs = (await ctx.rooms.docs.list(rec.roomId))
          .filter((d) => d && typeof d.path === 'string')
          .map((d) => ({ path: d.path, size: Number.isFinite(d.size) ? d.size : 0 }))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        return { roomId: rec.roomId, docs: docs.slice(0, DOCS_MAX), more: docs.length > DOCS_MAX }
      },
      team: () => undefined,
    },
    doc: {
      async run(m) {
        const rec = await teamOf(m)
        // A doc path may be longer than a line: up to 4 parts of 128 under `members/<name>/` (export.js
        // checkDocPath), over 550 characters, and every path the list gave must open. PATH_MAX only bounds the input.
        const p = str(m, 'path', { max: PATH_MAX })
        // Rooms checks the path (and answers missing and refused alike); the text is a member's, shown as text.
        const text = await ctx.rooms.docs.get(rec.roomId, p)
        return { roomId: rec.roomId, path: p, text }
      },
    },
  }

  async function onMessage(m, from) {
    if (stopped) return
    const view = from && typeof from.view === 'string' ? from.view : 'desktop'
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.type !== 'string') return
    const known = views.has(view)
    const st = touch(view)
    // Main's word for this view (fixed for its life); a change, should one come, re-sends the whole state.
    const access = accessOf(from)
    if (st.access !== access) {
      st.access = access
      st.last = null
    }
    // A ping only keeps a known view alive; from a forgotten one it is a hello (it gets the whole state again).
    if (m.type === 'ping' && known) return
    if (m.type === 'hello' || m.type === 'select' || m.type === 'ping') {
      const sel = m.type === 'select' ? m.roomId : m.selected
      st.selected = typeof sel === 'string' && sel !== '' && sel.length <= LINE_MAX ? sel : null
      st.gen++
      await pushTo(view)
      return
    }
    const req = reqOf(m.req)
    const action = Object.hasOwn(actions, m.type) ? actions[m.type] : null
    if (!action) {
      answer({ type: 'result', action: m.type.slice(0, 40), req, ok: false, error: `unknown action: ${m.type.slice(0, 40)}` }, view)
      return
    }
    // A guest only reads: refused before anything runs, and not counted as the person's activity (it is not theirs).
    if (access !== 'owner' && !GUEST_ACTIONS.has(m.type)) {
      answer({ type: 'result', action: m.type, req, ok: false, error: GUEST_REFUSED }, view)
      return
    }
    let out
    try {
      // Main sets `from.view` (never the page): 'desktop' for the window's own page, `web:<n>` for a browser.
      out = await action.run(m, { remote: view !== 'desktop' })
      answer({ type: 'result', action: m.type, req, ok: true, ...out }, view)
    } catch (err) {
      // Ours (TeamError) or Rooms' refusal, in its own words: it names the limit.
      answer({ type: 'result', action: m.type, req, ok: false, error: (err && err.message) || String(err) }, view)
    }
    // The person's active time (a proxy): every action on a team, a refused one included (they were at it).
    const roomId = action.team ? action.team(m, out) : m.roomId
    if (typeof roomId === 'string' && roomId !== '') metrics.panelAction(roomId).catch((err) => warn('panel action', err))
    schedulePush()
  }

  return {
    PANEL,
    /** Listen to the page, to record and session changes and to the tick. */
    start() {
      stopped = false
      disposers.push(ctx.panels.onMessage(PANEL, (m, from) => onMessage(m, from)))
      // New team is the panel title bar's + (no heading row in the page). The click names no view yet, so every page of
      // the panel opens the form; an app that passes `from` (a later one) opens it only where it was clicked.
      ctx.panels.header(PANEL, { actions: [{ id: 'new-team', icon: 'add', title: 'New team' }] })
      disposers.push(
        ctx.panels.onAction(PANEL, (id, from) => {
          if (id !== 'new-team' || stopped) return
          // A guest's click opens nothing (New team would be refused anyway).
          if (accessOf(from) !== 'owner') return
          const view = from && typeof from.view === 'string' ? from.view : undefined
          ctx.panels.post(PANEL, { type: 'new-team' }, view ? { view } : undefined)
        }),
      )
      disposers.push(teams.onChange(() => schedulePush()))
      disposers.push(ctx.sessions.onChange(() => schedulePush()))
      disposers.push(ctx.schedule(TICK_SECONDS, () => schedulePush()))
      if (typeof ctx.onSettingsChange === 'function') disposers.push(ctx.onSettingsChange(() => schedulePush()))
    },
    stop() {
      stopped = true
      for (const d of disposers) d()
      disposers = []
      if (timer !== null) {
        clearT(timer)
        timer = null
      }
    },
    /** For tests: the message listener, a push now, and the known views. */
    onMessage,
    push: runPush,
    views,
  }
}

module.exports = { createPanel, accessOf, GUEST_ACTIONS, GUEST_REFUSED, cleanEntry, entryHasMember, statusOf, PUSH_MS, VIEWS_MAX, PING_SECONDS, VIEW_TTL_MS, ACTIVITY_PAGE, FIELD_TEXT_MAX, ACTIVITY_KINDS }
