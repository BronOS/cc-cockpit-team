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
/**
 * Uncounted stretches below the folded watermark kept for open questions (`foldOut`), oldest dropped past this: only
 * a question open across hundreds of folds loses the part of its wait that lies in the dropped ones.
 */
const GAPS_MAX = 200

/**
 * Former members (left, fired, team ended) kept with their own row, per team: a record is one 1 MiB value and a team
 * that hires and fires names for weeks must not grow it without end (5,700 distinct names filled it). Past this the
 * ones that left longest ago are folded into `rec.metrics.folded.former` (`foldFormer`): their numbers stay in the
 * team totals, only their rows go. Current members are never folded.
 */
const FORMER_MAX = 50

const sum = (members, key) => members.reduce((n, m) => n + (Number.isFinite(m[key]) ? m[key] : 0), 0)

/**
 * Team totals from the members' metrics. `costUsd` is null when no member's cost was ever seen (unknown, not 0).
 * The working time is the sum over members (parallel members add up: it is effort, not elapsed time).
 */
function totalsOf(rec) {
  const members = Object.values(rec.metrics.members).filter((m) => m && typeof m === 'object')
  // The members folded away (`foldFormer`) count as one more member, so a total never drops when a row is folded.
  const former = foldedOf(rec).former
  const all = former.count > 0 ? members.concat([former]) : members
  const seen = all.filter((m) => Number.isFinite(m.costUsd))
  return {
    costUsd: seen.length ? sum(seen, 'costUsd') : null,
    workingMs: sum(all, 'workingMs'),
    waitingMs: sum(all, 'waitingMs'),
    idleMs: sum(all, 'idleMs'),
    sent: sum(all, 'sent'),
    received: sum(all, 'received'),
    held: sum(all, 'held'),
    docReads: sum(all, 'docReads'),
    docWrites: sum(all, 'docWrites'),
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

/** Sorted intervals merged into disjoint ones (touching ones joined). */
function mergeIv(iv) {
  const out = []
  for (const [from, to] of iv) {
    const last = out[out.length - 1]
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else out.push([from, to])
  }
  return out
}
/** The length of the overlap of two disjoint sorted interval lists. */
function overlapMs(a, b) {
  let total = 0
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    const lo = Math.max(a[i][0], b[j][0])
    const hi = Math.min(a[i][1], b[j][1])
    if (hi > lo) total += hi - lo
    if (a[i][1] < b[j][1]) i++
    else j++
  }
  return total
}
/** Disjoint sorted `a` minus disjoint sorted `b`. */
function minusIv(a, b) {
  const out = []
  for (const [from, to] of a) {
    let at = from
    for (const [bf, bt] of b) {
      if (bt <= at || bf >= to) continue
      if (bf > at) out.push([at, bf])
      at = Math.max(at, bt)
      if (at >= to) break
    }
    if (at < to) out.push([at, to])
  }
  return out
}

/**
 * What history compaction dropped, folded into stored counters (`rec.metrics.folded`) so a total never goes down as
 * a team goes on: questions.js drops the oldest closed questions past KEPT_MAX, and panel actions are capped at
 * ACTIONS_MAX. The person's time already counted is `personMs`, everything before `personUntil`; the kept history
 * counts only after it, except in `gaps`: the stretches below the watermark nothing counted yet, kept while an open
 * question asked before them could still cover them once answered. Read defensively: it is stored data (a gap that is
 * not a finite, non-empty pair below the watermark is ignored).
 */
function foldedOf(rec) {
  const f = isObj(rec.metrics.folded) ? rec.metrics.folded : {}
  const members = {}
  if (isObj(f.members)) {
    for (const [name, m] of Object.entries(f.members)) {
      if (isObj(m)) members[name] = { asked: num(m.asked), answered: num(m.answered), answerMs: num(m.answerMs) }
    }
  }
  const personUntil = num(f.personUntil)
  const gaps = Array.isArray(f.gaps)
    ? mergeIv(
        f.gaps
          .filter((g) => Array.isArray(g) && g.length === 2 && Number.isFinite(g[0]) && Number.isFinite(g[1]) && g[0] < g[1] && g[1] <= personUntil)
          .map(([a, b]) => [a, b])
          .sort((a, b) => a[0] - b[0]),
      )
    : []
  // The folded former members' numbers; `costUsd` stays null until some folded member had a cost seen.
  const fm = isObj(f.former) ? f.former : {}
  const former = { count: num(fm.count), costUsd: Number.isFinite(fm.costUsd) && fm.costUsd >= 0 ? fm.costUsd : null }
  for (const k of MEMBER_COUNTERS) former[k] = num(fm[k])
  return { personMs: num(f.personMs), personUntil, gaps, asked: num(f.asked), answered: num(f.answered), members, former }
}

/** The per-member counters a totals sum is made of. */
const MEMBER_COUNTERS = ['workingMs', 'waitingMs', 'idleMs', 'sent', 'received', 'held', 'docReads', 'docWrites']

/**
 * Fold the former members past FORMER_MAX (the ones that left longest ago first) into `rec.metrics.folded.former`
 * and drop their rows and their folded question counts. `keep` names members that must stay for now (one whose
 * interval is still open in memory would be recreated with its time as a row of nothing). Returns how many were
 * folded. A name hired again later starts a fresh row: its earlier numbers are in the totals only.
 */
function foldFormer(rec, keep) {
  const all = rec.metrics.members
  const gone = Object.entries(all)
    .filter(([name, m]) => m && typeof m === 'object' && Number.isFinite(m.leftAt) && !(keep && keep.has(name)))
    .sort((a, b) => a[1].leftAt - b[1].leftAt || (a[0] < b[0] ? -1 : 1))
  const excess = gone.length - FORMER_MAX
  if (excess <= 0) return 0
  const f = foldedOf(rec)
  for (const [name, m] of gone.slice(0, excess)) {
    f.former.count++
    if (Number.isFinite(m.costUsd) && m.costUsd >= 0) f.former.costUsd = (f.former.costUsd ?? 0) + m.costUsd
    for (const k of MEMBER_COUNTERS) f.former[k] += num(m[k])
    delete all[name]
    delete f.members[name]
  }
  rec.metrics.folded = f
  return excess
}

/**
 * Fold questions and panel action times just removed from `rec` into `rec.metrics.folded`, at time `t`. The person's
 * time of the whole history (kept and dropped) up to the dropped intervals' last end is moved into `personMs` and the
 * watermark moves there, so `personActiveMs` gives the same value before and after the drop.
 *
 * An open question asked before the new watermark is answered later (an incident of the external review: a long wait
 * with the action cap folding meanwhile lost the wait's part below the watermark). So the stretches below it that
 * nothing covered are kept as `gaps` from the oldest open question's ask on; `personActiveMs` counts what the kept
 * questions cover of them, and the next fold moves that into `personMs` and takes it out of the gaps.
 */
function foldOut(rec, droppedQuestions, droppedActions, t) {
  const f = foldedOf(rec)
  const dropped = personIntervals(droppedQuestions, droppedActions, t)
  const top = dropped.reduce((n, [, to]) => Math.max(n, to), f.personUntil)
  const kept = questionsOf(rec)
  const all = mergeIv(
    personIntervals(kept, Array.isArray(rec.metrics.actions) ? rec.metrics.actions : [], t)
      .concat(dropped)
      .sort((a, b) => a[0] - b[0]),
  )
  // What the history covers of the old gaps is counted now (the dropped part leaves the record with this fold).
  f.personMs += overlapMs(all, f.gaps)
  let gaps = minusIv(f.gaps, all)
  if (top > f.personUntil) {
    f.personMs += unionMs(all, f.personUntil, top)
    gaps = gaps.concat(minusIv([[f.personUntil, top]], all))
    f.personUntil = top
  }
  // Only an open question can still add to a gap, and only to one after its ask (a new question is asked after `t`).
  const openAsks = kept.filter((q) => q.answeredAt === undefined && q.doneAt === undefined && Number.isFinite(q.askedAt)).map((q) => q.askedAt)
  const from = openAsks.length ? Math.min(...openAsks) : Infinity
  gaps = gaps.map(([a, b]) => [Math.max(a, from), b]).filter(([a, b]) => a < b)
  f.gaps = gaps.slice(-GAPS_MAX)
  for (const q of droppedQuestions) {
    if (!isObj(q)) continue
    const answered = Number.isFinite(q.answeredAt)
    f.asked++
    if (answered) f.answered++
    // Only for a member still in the record: a folded one's row is gone (`foldFormer`), its entry would be unreachable.
    if (typeof q.from === 'string' && Object.hasOwn(rec.metrics.members, q.from)) {
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
  // Below the watermark only the gaps are uncounted (a question answered after a fold that passed its ask).
  return f.personMs + overlapMs(mergeIv(iv), f.gaps) + unionMs(iv, f.personUntil, Infinity)
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
      held: count(m.held),
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
    // Former members folded into the totals (`foldFormer`): no row of their own.
    membersFolded: folded.former.count,
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
  lines.push(`  messages ${t.sent} sent, ${t.received} received, ${t.held} held  docs ${t.docReads} read, ${t.docWrites} written`)
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
        `msgs ${m.sent}/${m.received}${m.held ? ` (${m.held} held)` : ''}  docs ${m.docReads}r/${m.docWrites}w  asked ${m.questionsAsked}`,
    )
  }
  if (s.members.length === 0) lines.push('  (no members seen yet)')
  if (s.membersFolded > 0) lines.push(`  (${s.membersFolded} earlier former members are not listed: their numbers are in the totals)`)
  return lines.join('\n') + '\n'
}

/** A finite epoch ms as an ISO time (invite expiries, the export's times), else `unknown`. */
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown')

module.exports = { iso, totalsOf, personActiveMs, foldOut, foldedOf, foldFormer, FORMER_MAX, spansOf, membersOf, statsOf, formatStats, fmtDuration, fmtCost, ACTION_MS, ACTIONS_MAX, GAPS_MAX }
