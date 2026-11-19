'use strict'
// Pure helpers of the Team panel page (formatting, wording, request building): no DOM, no ccPanel, so
// `test/panel-page.test.js` runs them under node. The page (`team.js`) loads this file first as a classic script
// (the page's CSP allows only the plugin's own files) and reads `TeamView`; node reads it with `require`.
// Every word the page shows about a state comes from here, so a state is always an icon AND a word, never a colour.
;(function (root) {
  /** 1h 05m / 4m 07s / 12s; `unknown` for a missing value (same wording as `ccc team stats`). */
  function fmtDuration(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'unknown'
    const total = Math.round(Math.max(0, ms) / 1000)
    if (total < 60) return `${total}s`
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
    return `${m}m ${String(s).padStart(2, '0')}s`
  }

  /** $1.23, or `unknown` when no cost was ever seen. */
  const fmtCost = (usd) => (typeof usd === 'number' && Number.isFinite(usd) ? `$${usd.toFixed(2)}` : 'unknown')

  /** 42%, or `unknown`. */
  const fmtPercent = (p) => (typeof p === 'number' && Number.isFinite(p) ? `${Math.round(p)}%` : 'unknown')

  /** HH:MM:SS of an epoch ms in local time (with the date when it is not today), `unknown` for a bad value. */
  function fmtTime(at, nowMs) {
    if (typeof at !== 'number' || !Number.isFinite(at)) return 'unknown'
    const d = new Date(at)
    const p = (n) => String(n).padStart(2, '0')
    const clock = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    const n = new Date(typeof nowMs === 'number' ? nowMs : Date.now())
    if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return clock
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${clock}`
  }

  /**
   * A member's state as an icon and a word. `status` is a SessionStatus or what the host adds: `closed` (no tab),
   * `left` (a former member), `unknown` (main's member list could not be read).
   */
  const STATUS = {
    working: { icon: '▶', word: 'working' },
    waiting: { icon: '◆', word: 'waiting for input' },
    'needs-permission': { icon: '⚠', word: 'needs permission' },
    idle: { icon: '○', word: 'idle' },
    starting: { icon: '…', word: 'starting' },
    ended: { icon: '✕', word: 'closed' },
    closed: { icon: '✕', word: 'closed' },
    left: { icon: '–', word: 'left' },
    unknown: { icon: '?', word: 'unknown' },
  }
  function statusInfo(status) {
    return Object.hasOwn(STATUS, status) ? STATUS[status] : { icon: '?', word: 'unknown' }
  }

  /**
   * The shape a member's state is drawn as (a second signal next to the word, so no state rests on a colour):
   * working a filled circle with a play mark, waiting for input a ring with a tick, needs permission a filled rounded
   * square with !, idle and starting a dashed ring, and left / exited / no tab a cross. `shape` is the class suffix.
   */
  const SHAPES = {
    working: { shape: 'filled', glyph: '▶' },
    waiting: { shape: 'ring', glyph: '✓' },
    'needs-permission': { shape: 'square', glyph: '!' },
    idle: { shape: 'dashed', glyph: '' },
    starting: { shape: 'dashed', glyph: '' },
    ended: { shape: 'gone', glyph: '✕' },
    closed: { shape: 'gone', glyph: '✕' },
    left: { shape: 'gone', glyph: '✕' },
  }
  function stateShape(status) {
    return Object.hasOwn(SHAPES, status) ? SHAPES[status] : { shape: 'unknown', glyph: '?' }
  }

  /** A team's state as a symbol and an upper-case word: LIVE, PAUSED or ENDED (an ended team is never "paused"). */
  function teamState(t) {
    if (t.endedAt !== undefined) return { key: 'ended', symbol: '■', label: 'ENDED' }
    if (t.paused) return { key: 'paused', symbol: '‖', label: 'PAUSED' }
    return { key: 'live', symbol: '●', label: 'LIVE' }
  }

  /** `21m ago` / `3h ago` / `2d ago` / `just now`; empty for a bad value. */
  function fmtAge(at, nowMs) {
    if (typeof at !== 'number' || !Number.isFinite(at)) return ''
    const sec = Math.max(0, Math.round(((typeof nowMs === 'number' ? nowMs : Date.now()) - at) / 1000))
    if (sec < 45) return 'just now'
    const min = Math.round(sec / 60)
    if (min < 60) return `${min}m ago`
    const h = Math.round(min / 60)
    if (h < 48) return `${h}h ago`
    return `${Math.round(h / 24)}d ago`
  }

  /** The four summary tiles of a team: from `team.stats` when it has them, else a dash. */
  function kpis(team) {
    const st = team && team.stats
    const t = st && st.totals
    return [
      { label: 'elapsed', value: st ? fmtDuration(st.elapsedMs) : '—' },
      { label: 'cost', value: t ? fmtCost(t.costUsd) : '—' },
      { label: 'members', value: String(Array.isArray(team && team.members) ? team.members.length : 0) },
      { label: 'sent / recv', value: t ? `${t.sent} / ${t.received}` : '—' },
    ]
  }

  /** A context percent as 0..100 (clamped) or null, and whether it is high enough to be called out. */
  const CONTEXT_HIGH = 80
  const contextLevel = (p) => (typeof p === 'number' && Number.isFinite(p) ? { pct: Math.min(100, Math.max(0, Math.round(p))), high: p >= CONTEXT_HIGH } : null)

  /** Why a member left, in words (metrics `leftWhy`). */
  function leftText(m) {
    if (m.status !== 'left') return ''
    return m.leftWhy ? `left (${m.leftWhy})` : 'left'
  }

  /**
   * A member's star badge, or null with none: the count, and the reasons for its tooltip, one a line (plain text: a
   * coordinator's words, shown through `title`). Not the coordinator's lone star: that one has no count.
   */
  function starBadge(m) {
    const stars = m && Array.isArray(m.stars) ? m.stars.filter((s) => s && typeof s.reason === 'string') : []
    if (stars.length === 0) return null
    const n = stars.length
    const head = `${n} star${n === 1 ? '' : 's'} from the person:`
    const lines = stars.map((s) => `• ${s.reason}${typeof s.by === 'string' && s.by !== '' ? ` (by ${s.by})` : ''}`)
    return { count: n, text: `✦ ${n}`, label: `${n} star${n === 1 ? '' : 's'}`, title: [head, ...lines].join('\n') }
  }

  /** "ended" / "paused" as text. */
  function teamFlags(t) {
    const out = []
    if (t.endedAt !== undefined) out.push('ended')
    else if (t.paused) out.push('paused')
    return out
  }

  /** One line of meta for a team row: `3 members · 2 waiting on you · ended`. */
  function teamMeta(t) {
    const parts = [`${t.members} member${t.members === 1 ? '' : 's'}`]
    if (t.waiting > 0) parts.push(`${t.waiting} waiting on you`)
    parts.push(...teamFlags(t))
    return parts.join(' · ')
  }

  /** Teams, newest first (the host sends them so; kept here so the order does not depend on it). */
  const sortTeams = (teams) => [...teams].sort((a, b) => b.createdAt - a.createdAt)

  /**
   * The roomId the page selects after a state: the one it holds when that team still exists, else the newest live
   * team, else the newest, else none.
   */
  function pickSelected(teams, selected) {
    if (selected && teams.some((t) => t.roomId === selected)) return selected
    const sorted = sortTeams(teams)
    const live = sorted.find((t) => t.endedAt === undefined)
    return (live || sorted[0] || {}).roomId || null
  }

  /**
   * Whether the page re-asks the activity and the docs list: the team's `logSeq` moved. A doc's text is never
   * re-asked on this (a plugin's doc read is logged by Rooms and moves `logSeq` itself: a loop).
   */
  const logMoved = (prev, next) => prev !== next

  /**
   * What the activity list is "as of": the log position AND the team's marks. Marks live in the plugin's record, not
   * in the Rooms log, so a mark moves no `logSeq`; keyed on the log alone, a new mark stayed out of a loaded list
   * (open or opened again) until some other entry was logged. A string, compared with `!==` like `logSeq`.
   */
  const activityKey = (team) => {
    if (!team) return undefined
    const marks = Array.isArray(team.marks) ? team.marks.map((m) => (m ? [m.at, m.label, m.by] : null)) : []
    return JSON.stringify([team.logSeq === undefined ? null : team.logSeq, marks])
  }

  /** One line for a log entry (or mark) of the activity: plain text, a member's words included as text. */
  function describeEntry(e) {
    const to = (d) => (Array.isArray(d) ? d.map((x) => x && x.to).filter(Boolean).join(', ') : '')
    switch (e.type) {
      case 'mark':
        return `mark: ${e.label}${e.by ? ` (by ${e.by})` : ''}`
      case 'create':
        return 'team created'
      case 'invite':
        return `invite for ${e.name ?? e.member ?? 'a new name'}`
      case 'join':
        return `${e.member ?? 'someone'} joined${e.coordinator ? ' as coordinator' : ''}`
      case 'leave':
        return `${e.member ?? 'someone'} left${e.why ? ` (${e.why})` : ''}`
      case 'send': {
        const dest = typeof e.to === 'string' ? e.to : to(e.delivery)
        return `${e.from ?? 'someone'} to ${dest || 'the team'}${typeof e.text === 'string' ? `: ${e.text}` : ''}`
      }
      case 'doc-read':
        return `${e.member ?? e.by ?? 'someone'} read ${e.path ?? 'a doc'}`
      case 'doc-write':
        return `${e.member ?? e.by ?? 'someone'} wrote ${e.path ?? 'a doc'}`
      case 'doc-refused':
        return `a doc access was refused${e.path ? `: ${e.path}` : ''}`
      case 'pause':
        return 'paused'
      case 'resume':
        return 'resumed'
      case 'auto-pause':
        return 'paused automatically'
      case 'end':
        return 'team ended'
      case 'trimmed':
        return 'older log entries were trimmed'
      default:
        return String(e.type)
    }
  }

  /** The kinds the activity filter offers (the host's list). */
  const KINDS = ['mark', 'send', 'join', 'leave', 'doc-write', 'doc-read', 'doc-refused', 'invite', 'pause', 'resume', 'auto-pause', 'end', 'create', 'trimmed']

  /** A doc in the list: its path and size. */
  const docLabel = (d) => `${d.path} (${d.size} B)`

  // ---- request building (the forms) ----

  const clean = (s) => (typeof s === 'string' ? s.trim() : '')

  /** Optional hire fields shared by New team and Hire: only those filled in. */
  function hireExtras(f) {
    const out = {}
    for (const k of ['model', 'effort', 'cwd']) if (clean(f[k]) !== '') out[k] = clean(f[k])
    return out
  }

  /** The New team form -> a message, or `{ error }`. The lead's name defaults to `lead` (host). */
  function newTeamRequest(f) {
    const title = clean(f.title)
    if (title === '') return { error: 'Give the team a title.' }
    const m = { type: 'new-team', title, ...hireExtras(f) }
    if (clean(f.name) !== '') m.name = clean(f.name)
    if (clean(f.kickoff) !== '') m.kickoff = clean(f.kickoff)
    return { message: m }
  }

  /** The Hire form -> a message, or `{ error }`: a name and a kickoff file are required (as `ccc team hire`). */
  function hireRequest(roomId, f) {
    const name = clean(f.name)
    if (name === '') return { error: 'Give the member a name.' }
    if (clean(f.kickoff) === '') return { error: 'Name the kickoff file (a path).' }
    return { message: { type: 'hire', roomId, name, kickoff: clean(f.kickoff), coordinator: f.coordinator === true, ...hireExtras(f) } }
  }

  /** The Invite form -> a message, or `{ error }`. */
  function inviteRequest(roomId, f) {
    const name = clean(f.name)
    if (name === '') return { error: 'Give the new member a name.' }
    return { message: { type: 'invite', roomId, name, coordinator: f.coordinator === true } }
  }

  /** Reply: the text is sent as typed (an answer may need its blank lines), only an empty one is refused. */
  function replyRequest(roomId, id, text) {
    if (typeof text !== 'string' || text.trim() === '') return { error: 'Write an answer first.' }
    return { message: { type: 'reply', roomId, id, text } }
  }

  /**
   * Why Rooms held a message (types.ts RoomSendAnswer): the member has it in its queue and reads it at its next
   * `ccc room read`, but nothing has pointed it there yet. After an app restart every room comes back paused and its
   * members count as typed, so a held answer is common then and the person must hear it, not "sent".
   */
  const HELD_WHY = {
    paused: 'the room is paused (Resume it in the room view)',
    'no-tab': 'the member has no tab open',
    typed: "its tab counts as typed in (click the tab's badge, or mark it to deliver room messages)",
    capped: "it had 5 pointers in a row (click the tab's badge)",
    draft: 'its tab has a half-typed prompt',
    'not-waiting': 'it is busy; it gets the pointer when it waits again',
  }

  /** The notice after a reply: `{ text, held }` from the host's per-recipient answers (one recipient). */
  function replyOutcome(from, answers) {
    const a = Array.isArray(answers) ? answers[0] : undefined
    if (a && a.path === 'held') {
      const why = typeof a.why === 'string' && Object.hasOwn(HELD_WHY, a.why) ? HELD_WHY[a.why] : clean(String(a.why || 'held'))
      return { text: `Answer queued for ${from}, not yet pointed out to it: ${why}.`, held: true }
    }
    return { text: `Answer sent to ${from}.`, held: false }
  }

  /** Mark: one line. */
  function markRequest(roomId, label) {
    const l = clean(label)
    if (l === '') return { error: 'Give the mark a label.' }
    return { message: { type: 'mark', roomId, label: l } }
  }

  /** End: the export folder is optional (empty: the app's setting). */
  function endRequest(roomId, dir) {
    return { message: { type: 'end', roomId, ...(clean(dir) !== '' ? { dir: clean(dir) } : {}) } }
  }

  /** The activity request: the filters only when set; `before` is the previous answer's cursor. */
  function activityRequest(roomId, { member, kind, before } = {}) {
    const m = { type: 'activity', roomId }
    if (member) m.member = member
    if (kind) m.kind = kind
    if (before) m.before = before
    return m
  }

  const api = {
    fmtDuration, fmtCost, fmtPercent, fmtTime, statusInfo, stateShape, teamState, fmtAge, kpis, contextLevel, leftText, starBadge, teamFlags, teamMeta, sortTeams, pickSelected, logMoved, activityKey,
    describeEntry, KINDS, docLabel, newTeamRequest, hireRequest, inviteRequest, replyRequest, replyOutcome, markRequest, endRequest,
    activityRequest, PING_SECONDS: 30,
  }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.TeamView = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
