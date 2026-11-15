'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { totalsOf, personActiveMs, spansOf, statsOf, formatStats, fmtDuration, fmtCost, foldOut, ACTION_MS } = require('../lib/stats.js')

const rec = (over = {}) => ({
  roomId: 'r1',
  title: 'T',
  createdAt: 1000,
  marks: [],
  questions: [],
  metrics: { members: {}, logSeq: 0 },
  ...over,
})

test('totalsOf: sums members; cost unknown (null) when never seen', () => {
  assert.equal(totalsOf(rec()).costUsd, null)
  const r = rec({
    metrics: {
      members: {
        a: { workingMs: 100, waitingMs: 10, idleMs: 1, sent: 2, received: 3, docReads: 4, docWrites: 5, costUsd: 0.5 },
        b: { workingMs: 50, costUsd: 0.25 },
        c: { workingMs: 1 }, // never saw a cost
      },
      logSeq: 0,
    },
  })
  assert.deepEqual(totalsOf(r), { costUsd: 0.75, workingMs: 151, waitingMs: 10, idleMs: 1, sent: 2, received: 3, docReads: 4, docWrites: 5 })
})

test('spansOf: start, marks and now; costs and working time are differences of the snapshots', () => {
  const r = rec({
    marks: [
      { at: 2000, label: 'one', by: 'lead', cost: 1, workingMs: 400 },
      { at: 5000, label: 'two', by: 'lead', cost: 3.5, workingMs: 1000 },
    ],
  })
  const spans = spansOf(r, 9000, { costUsd: 4, workingMs: 1700 })
  assert.deepEqual(spans.map((s) => [s.from, s.to, s.ms, s.costUsd, s.workingMs]), [
    ['start', 'one', 1000, 1, 400],
    ['one', 'two', 3000, 2.5, 600],
    ['two', 'now', 4000, 0.5, 700],
  ])
})

test('spansOf: no marks is one span; an ended team ends at "end"; unknown cost stays null', () => {
  const live = spansOf(rec(), 3000, { costUsd: null, workingMs: 0 })
  assert.deepEqual(live.map((s) => [s.from, s.to, s.costUsd]), [['start', 'now', null]])
  const ended = spansOf(rec({ endedAt: 3000 }), 3000, { costUsd: 2, workingMs: 5 })
  assert.equal(ended[0].to, 'end')
  assert.equal(ended[0].costUsd, 2)
})

test('spansOf: a mark made before any cost was seen: the span before it is unknown, the next gets the whole cost', () => {
  const r = rec({ marks: [{ at: 2000, label: 'early', by: 'lead', cost: null, workingMs: 0 }] })
  const spans = spansOf(r, 4000, { costUsd: 2, workingMs: 0 })
  assert.deepEqual(spans.map((s) => s.costUsd), [null, 2])
})

test('personActiveMs: question to answer, panel actions, overlaps counted once, Done counts nothing', () => {
  const r = rec({
    questions: [
      { id: 'q1', askedAt: 1000, answeredAt: 5000 },
      { id: 'q2', askedAt: 3000, answeredAt: 7000 }, // overlaps q1: union 1000..7000
      { id: 'q3', askedAt: 8000, doneAt: 9000 }, // closed with Done: nothing
      { id: 'q4', askedAt: 9000 }, // open: nothing
    ],
  })
  assert.equal(personActiveMs(r, 100000), 6000)
  r.metrics.actions = [6000, 100_000] // the first overlaps the union; the second is its own window
  // 6000 + ACTION_MS reaches 21000, past the union's end (7000): 1000..21000, then the separate window
  assert.equal(personActiveMs(r, 1_000_000), 20_000 + ACTION_MS)
  // Capped at the team's end.
  assert.equal(personActiveMs(rec({ metrics: { members: {}, logSeq: 0, actions: [10_000] } }), 12_000), 2000)
})

test('statsOf and formatStats: totals, spans, members with answer time, the proxy label', () => {
  const r = rec({
    marks: [{ at: 2000, label: 'one', by: 'lead', cost: 0.5, workingMs: 100 }],
    questions: [{ id: 'q1', from: 'dev', askedAt: 1000, answeredAt: 4000 }],
    metrics: {
      members: { dev: { workingMs: 200, waitingMs: 0, idleMs: 0, sent: 1, received: 0, docReads: 0, docWrites: 0, costUsd: 1, hiredAt: 1500 } },
      logSeq: 0,
    },
  })
  const s = statsOf(r, 10_000)
  assert.equal(s.elapsedMs, 9000)
  assert.equal(s.personActiveIsProxy, true)
  assert.equal(s.members[0].answerMs, 3000)
  assert.equal(s.members[0].contextPercent, null)
  const text = formatStats(s)
  assert.match(text, /cost \$1\.00/)
  assert.match(text, /start -> one: 1s, cost \$0\.50/)
  assert.match(text, /a proxy/)
  assert.match(text, /ctx unknown/)
})

test('fmtDuration and fmtCost', () => {
  assert.equal(fmtDuration(12_000), '12s')
  assert.equal(fmtDuration(247_000), '4m 07s')
  assert.equal(fmtDuration(3_900_000), '1h 05m')
  assert.equal(fmtDuration(undefined), 'unknown')
  assert.equal(fmtCost(null), 'unknown')
  assert.equal(fmtCost(1.005), '$1.00')
})

test('foldOut: dropped questions and actions keep the counts and the person\'s time exactly', () => {
  const qs = [
    { id: 'q1', from: 'dev', askedAt: 1000, answeredAt: 5000 },
    { id: 'q2', from: 'dev', askedAt: 3000, answeredAt: 9000 }, // overlaps q1 and the kept q4
    { id: 'q3', from: 'lead', askedAt: 6000, doneAt: 6500 },
    { id: 'q4', from: 'dev', askedAt: 8000, answeredAt: 12_000 },
  ]
  const members = { dev: { workingMs: 0 }, lead: { workingMs: 0 } }
  const r = rec({ questions: qs.slice(), metrics: { members, logSeq: 0, actions: [500, 20_000] } })
  const before = statsOf(r, 30_000)
  // Drop the three oldest questions and the first action, as compaction and the action cap do.
  const dropped = r.questions.splice(0, 3)
  const actions = r.metrics.actions.splice(0, 1)
  foldOut(r, dropped, actions, 30_000)
  const after = statsOf(r, 30_000)
  assert.equal(after.personActiveMs, before.personActiveMs)
  assert.deepEqual(after.questions, before.questions)
  assert.deepEqual(
    after.members.map((m) => [m.name, m.questionsAsked, m.questionsAnswered, m.answerMs]),
    before.members.map((m) => [m.name, m.questionsAsked, m.questionsAnswered, m.answerMs]),
  )
  // Folding again (the rest) still keeps it, and a later question adds on top.
  foldOut(r, r.questions.splice(0), r.metrics.actions.splice(0), 30_000)
  assert.equal(statsOf(r, 30_000).personActiveMs, before.personActiveMs)
  r.questions.push({ id: 'q5', from: 'dev', askedAt: 40_000, answeredAt: 41_000 })
  assert.equal(statsOf(r, 50_000).personActiveMs, before.personActiveMs + 1000)
  assert.equal(statsOf(r, 50_000).questions.asked, 5)
})

test('statsOf reads stored data defensively: null questions, marks, members and folded counters', () => {
  const r = rec({
    questions: [null, 5, { id: 'q1', from: 'dev', askedAt: 1000, answeredAt: 2000 }],
    marks: [null, { at: 1500, label: 'one', by: 'lead', cost: null, workingMs: 0 }],
    metrics: { members: { dev: { workingMs: 1 }, ghost: null }, logSeq: 0, actions: 'x', folded: { personMs: 'x', members: { dev: null } } },
  })
  const s = statsOf(r, 3000)
  assert.equal(s.questions.asked, 1)
  assert.equal(s.personActiveMs, 1000)
  assert.deepEqual(s.marks.map((m) => m.label), ['one'])
  assert.deepEqual(s.members.map((m) => [m.name, m.questionsAsked]), [['dev', 1]])
  assert.match(formatStats(s), /start -> one/)
})
