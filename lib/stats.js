'use strict'
// Totals, spans and the `stats` text (docs/design.md §4). Pure functions over a team record: no ctx, no clock, so the
// span math is testable on its own and the export (metrics.json, metrics.md) can reuse it.
//
// A mark stores a snapshot of the team's running totals (`cost`, `workingMs`) when it was made; a span is the
// difference between two snapshots, so a span's numbers never depend on a later re-read of the members.

/**
 * How long one panel action counts as the person's active time (design §4: "plus panel actions", a proxy). An action
 * has no duration of its own; a fixed short window merged with the question intervals keeps a burst of clicks from
 * adding up to more than the time they took.
 */
const ACTION_MS = 15_000
/** Panel action times kept per team (oldest dropped): a record is one 1 MiB storage value. */
const ACTIONS_MAX = 500

const sum = (members, key) => members.reduce((n, m) => n + (Number.isFinite(m[key]) ? m[key] : 0), 0)

/**
 * Team totals from the members' metrics. `costUsd` is null when no member's cost was ever seen (unknown, not 0).
 * The working time is the sum over members (parallel members add up: it is effort, not elapsed time).
 */
function totalsOf(rec) {
  const members = Object.values(rec.metrics.members).filter((m) => m && typeof m === 'object')
  const seen = members.filter((m) => Number.isFinite(m.costUsd))
  return {
    costUsd: seen.length ? sum(seen, 'costUsd') : null,
    workingMs: sum(members, 'workingMs'),
    waitingMs: sum(members, 'waitingMs'),
    idleMs: sum(members, 'idleMs'),
    sent: sum(members, 'sent'),
    received: sum(members, 'received'),
    docReads: sum(members, 'docReads'),
    docWrites: sum(members, 'docWrites'),
  }
}

const isObj = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x)
/** The stored questions that are objects (a record from storage is only shape-checked, its entries are not). */
const questionsOf = (rec) => (Array.isArray(rec.questions) ? rec.questions.filter(isObj) : [])
const num = (x) => (Number.isFinite(x) && x >= 0 ? x : 0)

/**
 * The person's busy intervals: [question asked, answered] (a question closed with Done took no answer, so it counts
 * nothing) and ACTION_MS after each panel action, capped at `until`.
 */
function personIntervals(questions, actions, until) {
  const iv = []
  for (const q of questions) {
    if (isObj(q) && Number.isFinite(q.answeredAt) && Number.isFinite(q.askedAt) && q.answeredAt > q.askedAt) iv.push([q.askedAt, q.answeredAt])
  }
  for (const at of actions) if (Number.isFinite(at) && at < until) iv.push([at, Math.min(at + ACTION_MS, until)])
  return iv.sort((a, b) => a[0] - b[0])
}

/** The length of the union of sorted intervals, counting only what lies between `lo` and `hi`. */
function unionMs(iv, lo, hi) {
  let total = 0
  let end = lo
  for (const [from, to] of iv) {
    const top = Math.min(to, hi)
    if (top <= end) continue
    total += top - Math.max(from, end)
    end = top
  }
  return total
}

/**
 * What history compaction dropped, folded into stored counters (`rec.metrics.folded`) so a total never goes down as
 * a team goes on: questions.js drops the oldest closed questions past KEPT_MAX, and panel actions are capped at
 * ACTIONS_MAX. The person's time already counted is `personMs`, everything before `personUntil`; the kept history
 * counts only after it. Read defensively: it is stored data.
 */
function foldedOf(rec) {
  const f = isObj(rec.metrics.folded) ? rec.metrics.folded : {}
  const members = {}
  if (isObj(f.members)) {
    for (const [name, m] of Object.entries(f.members)) {
      if (isObj(m)) members[name] = { asked: num(m.asked), answered: num(m.answered), answerMs: num(m.answerMs) }
    }
  }
  return { personMs: num(f.personMs), personUntil: num(f.personUntil), asked: num(f.asked), answered: num(f.answered), members }
}

/**
 * Fold questions and panel action times just removed from `rec` into `rec.metrics.folded`, at time `t`. The person's
 * time of the whole history (kept and dropped) up to the dropped intervals' last end is moved into `personMs` and the
 * watermark moves there, so `personActiveMs` gives the same value before and after the drop.
 */
function foldOut(rec, droppedQuestions, droppedActions, t) {
  const f = foldedOf(rec)
  const dropped = personIntervals(droppedQuestions, droppedActions, t)
  const top = dropped.reduce((n, [, to]) => Math.max(n, to), f.personUntil)
  if (top > f.personUntil) {
    const all = personIntervals(questionsOf(rec), Array.isArray(rec.metrics.actions) ? rec.metrics.actions : [], t)
      .concat(dropped)
      .sort((a, b) => a[0] - b[0])
    f.personMs += unionMs(all, f.personUntil, top)
    f.personUntil = top
  }
  for (const q of droppedQuestions) {
    if (!isObj(q)) continue
    const answered = Number.isFinite(q.answeredAt)
    f.asked++
    if (answered) f.answered++
    if (typeof q.from === 'string') {
      const m = Object.hasOwn(f.members, q.from) ? f.members[q.from] : (f.members[q.from] = { asked: 0, answered: 0, answerMs: 0 })
      m.asked++
      if (answered) {
        m.answered++
        if (Number.isFinite(q.askedAt)) m.answerMs += Math.max(0, q.answeredAt - q.askedAt)
      }
    }
  }
  rec.metrics.folded = f
}

/**
 * The person's active time: the union of their busy intervals (`personIntervals`), merged so overlapping questions
 * and a click inside a question's wait are not counted twice, plus what compaction folded away. `until` caps an
 * interval at the end of the team or "now".
 */
function personActiveMs(rec, until) {
  const f = foldedOf(rec)
  const iv = personIntervals(questionsOf(rec), Array.isArray(rec.metrics.actions) ? rec.metrics.actions : [], until)
  return f.personMs + unionMs(iv, f.personUntil, Infinity)
}

/**
 * Spans between the start, every mark and the end (`endTotals` at `endAt`: now for a live team). Each carries the
 * labels it runs between, the time it took and the cost and working time added in it. A span's cost is null when
 * neither end knew one.
 */
function spansOf(rec, endAt, endTotals) {
  const cuts = [{ label: 'start', at: rec.createdAt, cost: null, workingMs: 0 }]
  for (const m of rec.marks.filter(isObj)) cuts.push({ label: m.label, at: m.at, cost: m.cost, workingMs: m.workingMs })
  cuts.push({ label: rec.endedAt !== undefined ? 'end' : 'now', at: endAt, cost: endTotals.costUsd, workingMs: endTotals.workingMs })
  const spans = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]
    const b = cuts[i + 1]
    const known = Number.isFinite(a.cost) || Number.isFinite(b.cost)
    spans.push({
      from: a.label,
      to: b.label,
      fromAt: a.at,
      toAt: b.at,
      ms: Math.max(0, b.at - a.at),
      costUsd: known ? Math.max(0, (Number.isFinite(b.cost) ? b.cost : 0) - (Number.isFinite(a.cost) ? a.cost : 0)) : null,
      workingMs: Math.max(0, (b.workingMs || 0) - (a.workingMs || 0)),
    })
  }
  return spans
}

/** A stored counter as a number: missing, negative or not finite is 0. */
const count = (x) => (Number.isFinite(x) && x > 0 ? x : 0)

/** Per member: its metrics, and the questions it asked with the person's answer time. */
function membersOf(rec) {
  const out = []
  const questions = questionsOf(rec)
  const folded = foldedOf(rec).members
  for (const [name, m] of Object.entries(rec.metrics.members)) {
    if (!m || typeof m !== 'object') continue
    const asked = questions.filter((q) => q.from === name)
    const answered = asked.filter((q) => Number.isFinite(q.answeredAt))
    const old = Object.hasOwn(folded, name) ? folded[name] : { asked: 0, answered: 0, answerMs: 0 }
    out.push({
      name,
      coordinator: m.coordinator === true,
      model: m.model,
      effort: m.effort,
      hiredAt: m.hiredAt,
      leftAt: m.leftAt,
      leftWhy: m.leftWhy,
      costUsd: Number.isFinite(m.costUsd) ? m.costUsd : null,
      contextPercent: Number.isFinite(m.contextPercent) ? m.contextPercent : null,
      // A record from an older version or a hand edit may miss a counter: 0, never `undefined` in a table.
      workingMs: count(m.workingMs),
      waitingMs: count(m.waitingMs),
      idleMs: count(m.idleMs),
      sent: count(m.sent),
      received: count(m.received),
      docReads: count(m.docReads),
      docWrites: count(m.docWrites),
      questionsAsked: old.asked + asked.length,
      questionsAnswered: old.answered + answered.length,
      answerMs: old.answerMs + answered.reduce((n, q) => n + (Number.isFinite(q.askedAt) ? Math.max(0, q.answeredAt - q.askedAt) : 0), 0),
    })
  }
  return out.sort((a, b) => (a.hiredAt ?? Infinity) - (b.hiredAt ?? Infinity) || (a.name < b.name ? -1 : 1))
}

/**
 * The whole stats object of a team at `now` (a live team) or at its end. The numbers are the metrics': nothing here is
 * a judgement about the work.
 */
function statsOf(rec, now) {
  const endAt = rec.endedAt !== undefined ? rec.endedAt : now
  const totals = totalsOf(rec)
  const questions = questionsOf(rec)
  const folded = foldedOf(rec)
  return {
    title: rec.title,
    createdAt: rec.createdAt,
    endedAt: rec.endedAt,
    elapsedMs: Math.max(0, endAt - rec.createdAt),
    totals,
    // A proxy: the time between a question and its answer and a short window per panel action; not the person's time.
    personActiveMs: personActiveMs(rec, endAt),
    personActiveIsProxy: true,
    questions: {
      asked: folded.asked + questions.length,
      answered: folded.answered + questions.filter((q) => Number.isFinite(q.answeredAt)).length,
      open: questions.filter((q) => q.answeredAt === undefined && q.doneAt === undefined).length,
    },
    marks: rec.marks.filter(isObj).map((m) => ({ at: m.at, label: m.label, by: m.by })),
    spans: spansOf(rec, endAt, totals),
    members: membersOf(rec),
  }
}

/** 1h 05m / 4m 07s / 12s; `unknown` for a missing value. */
function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return 'unknown'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m ${String(s).padStart(2, '0')}s`
}

/** $1.23, or `unknown` when no cost was ever seen. */
const fmtCost = (usd) => (Number.isFinite(usd) ? `$${usd.toFixed(2)}` : 'unknown')

/** The text of `ccc team stats`. */
function formatStats(s) {
  const lines = []
  lines.push(`${s.title}${s.endedAt !== undefined ? ' (ended)' : ''}: ${fmtDuration(s.elapsedMs)} elapsed`)
  const t = s.totals
  lines.push(
    `  cost ${fmtCost(t.costUsd)}  working ${fmtDuration(t.workingMs)}  waiting ${fmtDuration(t.waitingMs)}  idle ${fmtDuration(t.idleMs)}`,
  )
  lines.push(`  messages ${t.sent} sent, ${t.received} received  docs ${t.docReads} read, ${t.docWrites} written`)
  lines.push(
    `  the person: ${fmtDuration(s.personActiveMs)} active (a proxy: question to answer, plus panel actions); ` +
      `${s.questions.asked} question${s.questions.asked === 1 ? '' : 's'}, ${s.questions.answered} answered, ${s.questions.open} open`,
  )
  lines.push('')
  lines.push('spans (split at marks):')
  for (const sp of s.spans) {
    lines.push(`  ${sp.from} -> ${sp.to}: ${fmtDuration(sp.ms)}, cost ${fmtCost(sp.costUsd)}, working ${fmtDuration(sp.workingMs)}`)
  }
  lines.push('')
  lines.push('members:')
  const width = Math.max(...s.members.map((m) => m.name.length), 4)
  for (const m of s.members) {
    const state = m.leftAt !== undefined ? `left (${m.leftWhy})` : 'in'
    lines.push(
      `  ${m.name.padEnd(width)}  ${state}  cost ${fmtCost(m.costUsd)}  ctx ${m.contextPercent === null ? 'unknown' : m.contextPercent + '%'}  ` +
        `working ${fmtDuration(m.workingMs)}  waiting ${fmtDuration(m.waitingMs)}  idle ${fmtDuration(m.idleMs)}  ` +
        `msgs ${m.sent}/${m.received}  docs ${m.docReads}r/${m.docWrites}w  asked ${m.questionsAsked}`,
    )
  }
  if (s.members.length === 0) lines.push('  (no members seen yet)')
  return lines.join('\n') + '\n'
}

/** A finite epoch ms as an ISO time (invite expiries, the export's times), else `unknown`. */
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown')

module.exports = { iso, totalsOf, personActiveMs, foldOut, foldedOf, spansOf, membersOf, statsOf, formatStats, fmtDuration, fmtCost, ACTION_MS, ACTIONS_MAX }
