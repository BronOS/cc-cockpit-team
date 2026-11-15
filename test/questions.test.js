'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { fakeCtx } = require('./fake-ctx')
const { createTeams, TeamError, NOT_IN_TEAM } = require('../lib/teams.js')
const { createCommands } = require('../lib/commands.js')
const { createQuestions, TEXT_MAX, OPEN_MAX, OPEN_TEXT_MAX, KEPT_MAX, STORED_TEXT_MAX, replyPrefix } = require('../lib/questions.js')

/** A team with a coordinator `lead` and a member `dev`, driven directly (the panel's path) and through `ccc team`. */
async function setup(opts) {
  const f = fakeCtx(opts)
  // One teams store shared by the `ccc team` handler and the direct calls (the panel's path): records live in memory.
  const teams = createTeams(f.ctx)
  const questions = createQuestions(f.ctx, teams)
  f.ctx.cli.register('team', createCommands(f.ctx, teams, questions))
  const { id } = await f.ctx.rooms.create({ title: 'Build it' })
  await teams.add((await f.ctx.rooms.list()).find((r) => r.id === id))
  const lead = (await f.ctx.rooms.open(id, { name: 'lead', coordinator: true })).tabId
  const dev = (await f.ctx.rooms.open(id, { name: 'dev' })).tabId
  return { f, teams, questions, id, lead, dev }
}

const ask = (f, tabId, ...args) => f.run(['ask', ...args], { tabId })

test('ask from a member records the question, notifies and prints the id', async () => {
  const { f, teams, id, dev } = await setup()
  const r = await ask(f, dev, 'Which database?')
  assert.equal(r.code, undefined, r.stderr)
  assert.match(r.stdout, /^asked q1:/)
  const rec = await teams.get(id)
  assert.equal(rec.questions.length, 1)
  assert.equal(rec.questions[0].id, 'q1')
  assert.equal(rec.questions[0].from, 'dev')
  assert.equal(rec.questions[0].text, 'Which database?')
  assert.ok(Number.isFinite(rec.questions[0].askedAt))
  assert.equal(f.notices.length, 1)
  assert.match(f.notices[0].text, /^dev asks: Which database\?/)
  assert.equal(f.notices[0].options.title, 'Team: Build it')
  // Stored: the question survives in ctx.storage.
  assert.equal(f.store.get(`team:${id}`).questions[0].text, 'Which database?')
  // A second question gets the next id; a coordinator can ask too.
  assert.match((await ask(f, (await f.ctx.rooms.members(id)).find((m) => m.name === 'lead').tabId, 'Again?')).stdout, /asked q2:/)
})

test('ask from an outsider gets the not-in-a-team answer and stores nothing', async () => {
  const { f, teams, id } = await setup()
  f.emitSession({ tabId: 'out', status: 'waiting' })
  for (const call of [{ tabId: 'out' }, {}, { tabId: 'nope' }]) {
    const r = await f.run(['ask', 'hello?'], call)
    assert.equal(r.code, 1)
    assert.equal(r.stderr, NOT_IN_TEAM + '\n')
  }
  assert.equal((await teams.get(id)).questions.length, 0)
  assert.equal(f.notices.length, 0)
})

test('ask - reads stdin and drops the trailing newline; text with several lines is kept whole', async () => {
  const { f, teams, id, dev } = await setup()
  const r = await f.run(['ask', '-'], { tabId: dev, stdin: 'line one\nline two\n\n' })
  assert.equal(r.code, undefined, r.stderr)
  assert.equal((await teams.get(id)).questions[0].text, 'line one\nline two')
  // The notice shows the first line only.
  assert.match(f.notices[0].text, /^dev asks: line one$/)
  // `-- -` is a literal dash, not stdin.
  await f.run(['ask', '--', '-'], { tabId: dev, stdin: 'ignored' })
  assert.equal((await teams.get(id)).questions[1].text, '-')
})

test('ask refuses empty, too long and bad-character text, and a wrong number of arguments', async () => {
  const { f, teams, id, dev } = await setup()
  const cases = [
    [['  '], 1, /the question is empty/],
    [['x'.repeat(20001)], 1, /at most 20000 characters/],
    [['bad\u0007text'], 1, /character Rooms refuses.*U\+0007 at line 1/],
    [['a‮b'], 1, /character Rooms refuses/],
    [[], 2, /missing argument/],
    [['a', 'b'], 2, /unexpected argument/],
  ]
  for (const [args, code, re] of cases) {
    const r = await ask(f, dev, ...args)
    assert.equal(r.code, code, r.stderr)
    assert.match(r.stderr, re)
  }
  const empty = await f.run(['ask', '-'], { tabId: dev, stdin: '\n' })
  assert.equal(empty.code, 1)
  assert.equal((await teams.get(id)).questions.length, 0)
  assert.equal(f.notices.length, 0)
  // 20000 characters is the limit and fits.
  assert.equal((await ask(f, dev, 'y'.repeat(20000))).code, undefined)
})

test('ask caps the open text per team; answering or closing frees it', async () => {
  const { f, questions, id, dev } = await setup()
  const each = 20000
  for (let i = 0; i < OPEN_TEXT_MAX / each; i++) assert.equal((await ask(f, dev, 'z'.repeat(each))).code, undefined)
  const r = await ask(f, dev, 'one more')
  assert.equal(r.code, 1)
  assert.match(r.stderr, /waiting on the person already hold 100000 characters.*answered or closed/)
  await questions.done(id, 'q1')
  assert.equal((await ask(f, dev, 'one more')).code, undefined)
  // 80008 open: another 20000 does not fit until an answer frees q2's.
  assert.equal((await ask(f, dev, 'z'.repeat(each))).code, 1)
  await questions.reply(id, 'q2', 'ok')
  assert.equal((await ask(f, dev, 'z'.repeat(each))).code, undefined)
})

test('ask caps the number of open questions; closing one frees a place', async () => {
  const { f, questions, id, dev } = await setup()
  for (let i = 0; i < OPEN_MAX; i++) assert.equal((await ask(f, dev, `q${i}?`)).code, undefined)
  const r = await ask(f, dev, 'one more')
  assert.equal(r.code, 1)
  assert.match(r.stderr, new RegExp(`${OPEN_MAX} questions are already waiting`))
  await questions.done(id, 'q3')
  assert.equal((await ask(f, dev, 'one more')).code, undefined)
})

test('closed questions are compacted, never refused: text trimmed, then the oldest dropped; ids go on', async () => {
  const { f, teams, questions, id, dev } = await setup()
  const found = await teams.requireMember({ tabId: dev })
  const long = 'L'.repeat(TEXT_MAX)
  for (let i = 0; i < KEPT_MAX + 20; i++) {
    const q = await questions.ask(found, i < 30 ? long : `short ${i}`)
    await questions.done(id, q.id)
  }
  const last = await questions.ask(found, 'still asking?')
  assert.equal(last.id, `q${KEPT_MAX + 21}`)
  const rec = await teams.get(id)
  assert.equal(rec.questions.length, KEPT_MAX)
  assert.equal(rec.questions.at(-1), last)
  assert.ok(rec.questions.reduce((s, q) => s + q.text.length, 0) <= STORED_TEXT_MAX)
  // The stored record is the compacted one, well under ctx.storage's 1 MiB.
  assert.ok(Buffer.byteLength(JSON.stringify(f.store.get(`team:${id}`))) < 1024 * 1024)
})

test('compaction trims the oldest closed text first and leaves open questions whole', async () => {
  const { teams, questions, id, dev } = await setup()
  const found = await teams.requireMember({ tabId: dev })
  const long = 'L'.repeat(TEXT_MAX)
  const openOne = await questions.ask(found, 'O'.repeat(TEXT_MAX))
  for (let i = 0; i < 10; i++) await questions.done(id, (await questions.ask(found, long)).id)
  const rec = await teams.get(id)
  assert.equal(openOne.text.length, TEXT_MAX)
  assert.equal(openOne.trimmed, undefined)
  const trimmed = rec.questions.filter((q) => q.trimmed)
  assert.ok(trimmed.length >= 1)
  assert.equal(trimmed[0].id, 'q2')
  assert.ok(trimmed.every((q) => q.text.length <= 140))
  assert.ok(rec.questions.reduce((s, q) => s + q.text.length, 0) <= STORED_TEXT_MAX)
})

test('ask - with a 256 KiB run of newlines is refused at once (no regex backtracking)', async () => {
  const { f, teams, id, dev } = await setup()
  const t0 = Date.now()
  const r = await f.run(['ask', '-'], { tabId: dev, stdin: '\n'.repeat(256 * 1024) + 'x' })
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /at most 20000 characters/)
  // Trailing newlines only: dropped, also \r\n ones.
  const ok = await f.run(['ask', '-'], { tabId: dev, stdin: 'why?' + '\r\n'.repeat(100000) })
  assert.equal(ok.code, undefined, ok.stderr)
  assert.equal((await teams.get(id)).questions[0].text, 'why?')
})

test('two asks at once get two ids; a failed save removes its own question, not the other', async () => {
  const { f, teams, id, dev, lead } = await setup()
  const both = await Promise.all([ask(f, dev, 'a?'), ask(f, lead, 'b?')])
  assert.deepEqual(both.map((r) => r.stdout.slice(0, 8)).sort(), ['asked q1', 'asked q2'])
  // The first save waits, then fails; the second, started while it waits, succeeds.
  const set = f.ctx.storage.set
  let release
  const gate = new Promise((r) => (release = r))
  let calls = 0
  f.ctx.storage.set = async (k, v) => {
    if (++calls === 1) {
      await gate
      throw new Error('disk full')
    }
    return set(k, v)
  }
  const first = ask(f, dev, 'first')
  await new Promise((r) => setTimeout(r, 20))
  const second = await ask(f, lead, 'second')
  assert.match(second.stdout, /^asked q4:/)
  release()
  assert.match((await first).stderr, /disk full/)
  f.ctx.storage.set = set
  assert.deepEqual((await teams.get(id)).questions.map((q) => `${q.id} ${q.text}`), ['q1 a?', 'q2 b?', 'q4 second'])
})

test('a restart reads the questions back and the ids go on after answered and closed ones', async () => {
  const { f, questions, id, dev } = await setup()
  await ask(f, dev, 'a?')
  await ask(f, dev, 'b?')
  await ask(f, dev, 'c?')
  await questions.reply(id, 'q2', 'yes')
  await questions.done(id, 'q3')
  const teams2 = createTeams(f.ctx)
  const questions2 = createQuestions(f.ctx, teams2)
  const rec = await teams2.get(id)
  assert.deepEqual(rec.questions.map((q) => q.id), ['q1', 'q2', 'q3'])
  assert.ok(Number.isFinite(rec.questions[1].answeredAt))
  assert.ok(Number.isFinite(rec.questions[2].doneAt))
  assert.deepEqual((await questions2.open(id)).map((q) => q.id), ['q1'])
  const found = await teams2.requireMember({ tabId: dev })
  assert.equal((await questions2.ask(found, 'd?')).id, 'q4')
  // After a restart the asker's tab is not known: the reply goes by name.
  await questions2.reply(id, 'q1', 'answer')
})

test("ask lands in the caller's team when there are two", async () => {
  const { f, teams, id, dev } = await setup()
  const { id: id2 } = await f.ctx.rooms.create({ title: 'Other' })
  await teams.add({ id: id2 })
  await f.ctx.rooms.open(id2, { name: 'lead', coordinator: true })
  const dev2 = (await f.ctx.rooms.open(id2, { name: 'dev' })).tabId
  await ask(f, dev2, 'in two?')
  await ask(f, dev, 'in one?')
  assert.deepEqual((await teams.get(id)).questions.map((q) => q.text), ['in one?'])
  assert.deepEqual((await teams.get(id2)).questions.map((q) => q.text), ['in two?'])
})

test('a failing notice does not fail ask; a failing save does not leave the question in memory', async () => {
  const { f, teams, id, dev } = await setup()
  f.ctx.notify = async () => {
    throw new Error('no notifications')
  }
  assert.equal((await ask(f, dev, 'first')).code, undefined)
  const set = f.ctx.storage.set
  f.ctx.storage.set = async () => {
    throw new Error('disk full')
  }
  const r = await ask(f, dev, 'second')
  assert.equal(r.code, 1)
  assert.match(r.stderr, /disk full/)
  f.ctx.storage.set = set
  assert.deepEqual((await teams.get(id)).questions.map((q) => q.text), ['first'])
})

test('a very long first line is cut in the notice', async () => {
  const { f, dev } = await setup()
  await ask(f, dev, 'w'.repeat(500))
  assert.ok(f.notices[0].text.length < 170)
  assert.match(f.notices[0].text, /…$/)
})

test('reply sends the answer to the asker, records the time and closes the question', async () => {
  const { f, teams, questions, id, dev } = await setup()
  await ask(f, dev, 'Which database?')
  const { answers } = await questions.reply(id, 'q1', 'Use Postgres.')
  assert.equal(answers.length, 1)
  assert.equal(answers[0].to, 'dev')
  const sent = f.rooms.get(id).log.filter((e) => e.type === 'send')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].from, 'plugin')
  assert.equal(sent[0].to, 'dev')
  assert.equal(sent[0].text, 'Answer to your question q1:\nUse Postgres.')
  const q = (await teams.get(id)).questions[0]
  assert.ok(Number.isFinite(q.answeredAt))
  assert.equal(q.doneAt, undefined)
  assert.equal((await questions.open(id)).length, 0)
  // Persisted.
  assert.ok(Number.isFinite(f.store.get(`team:${id}`).questions[0].answeredAt))
  // Answering twice is refused and sends nothing more.
  await assert.rejects(questions.reply(id, 'q1', 'again'), (e) => e instanceof TeamError && e.code === 'closed')
  assert.equal(f.rooms.get(id).log.filter((e) => e.type === 'send').length, 1)
})

test('reply: unknown team, unknown question, empty text and an ended team', async () => {
  const { f, questions, id, dev } = await setup()
  await ask(f, dev, 'q?')
  await assert.rejects(questions.reply('nope', 'q1', 'x'), (e) => e.code === 'no-team')
  await assert.rejects(questions.reply(id, 'q9', 'x'), (e) => e.code === 'no-question')
  await assert.rejects(questions.reply(id, 'q1', '  '), (e) => e.code === 'empty')
  // Ended in Rooms (the room view) while the record still says live: refreshed, so "ended", not "left".
  await f.ctx.rooms.end(id)
  await assert.rejects(questions.reply(id, 'q1', 'x'), (e) => e.code === 'ended')
})

test('reply: rooms.members failing passes through, leaves the question open and the lock free', async () => {
  const { f, questions, id, dev } = await setup()
  await ask(f, dev, 'q?')
  const members = f.ctx.rooms.members
  f.ctx.rooms.members = async () => {
    throw new Error('rooms.members: timed out')
  }
  await assert.rejects(questions.reply(id, 'q1', 'x'), /timed out/)
  f.ctx.rooms.members = members
  assert.equal((await questions.open(id)).length, 1)
  await questions.reply(id, 'q1', 'x')
})

test('reply to a name now held by another member (fired, then hired again) answers gone', async () => {
  const { f, questions, id, dev } = await setup()
  await ask(f, dev, 'q?')
  await f.ctx.rooms.remove(id, 'dev')
  await f.ctx.rooms.open(id, { name: 'dev' })
  await assert.rejects(questions.reply(id, 'q1', 'x'), (e) => e.code === 'gone')
  assert.equal(f.rooms.get(id).log.filter((e) => e.type === 'send').length, 0)
})

test('reply length: the prefix counts, the plugin says how much fits', async () => {
  const { f, questions, id, dev } = await setup()
  await ask(f, dev, 'a?')
  await ask(f, dev, 'b?')
  const room = TEXT_MAX - replyPrefix('q1').length
  await assert.rejects(questions.reply(id, 'q1', 'x'.repeat(room + 1)), (e) => e.code === 'too-long' && e.message.includes(`at most ${room}`))
  await questions.reply(id, 'q1', 'x'.repeat(room))
  assert.equal(f.rooms.get(id).log.filter((e) => e.type === 'send')[0].text.length, TEXT_MAX)
})

test('Done while a reply is being sent is refused; the reply wins', async () => {
  const { f, teams, questions, id, dev } = await setup()
  await ask(f, dev, 'a?')
  const send = f.ctx.rooms.send
  let release
  const gate = new Promise((r) => (release = r))
  f.ctx.rooms.send = async (...a) => {
    await gate
    return send(...a)
  }
  const replying = questions.reply(id, 'q1', 'yes')
  await new Promise((r) => setTimeout(r, 10))
  await assert.rejects(questions.done(id, 'q1'), (e) => e.code === 'reply-pending')
  release()
  await replying
  f.ctx.rooms.send = send
  const q = (await teams.get(id)).questions[0]
  assert.ok(Number.isFinite(q.answeredAt))
  assert.equal(q.doneAt, undefined)
})

test('createCommands refuses to run without the shared questions instance', () => {
  const f = fakeCtx()
  assert.throws(() => createCommands(f.ctx, createTeams(f.ctx)), /questions instance/)
})

test('reply to a member that left says so and keeps the question open', async () => {
  const { f, teams, questions, id, dev } = await setup()
  await ask(f, dev, 'q?')
  await f.ctx.rooms.remove(id, 'dev')
  await assert.rejects(questions.reply(id, 'q1', 'x'), (e) => e.code === 'gone' && /dev left the team/.test(e.message))
  assert.equal((await questions.open(id)).length, 1)
  assert.equal((await teams.get(id)).questions[0].answeredAt, undefined)
  // Done closes it all the same.
  await questions.done(id, 'q1')
  assert.equal((await questions.open(id)).length, 0)
})

test('reply: a member that leaves during the send answers gone; a full queue is refused; held counts as answered', async () => {
  const { f, questions, id, dev } = await setup()
  await ask(f, dev, 'a?')
  await ask(f, dev, 'b?')
  await ask(f, dev, 'c?')
  const send = f.ctx.rooms.send
  f.ctx.rooms.send = async () => [{ to: 'dev', path: 'gone' }]
  await assert.rejects(questions.reply(id, 'q1', 'x'), (e) => e.code === 'gone')
  f.ctx.rooms.send = async () => [{ to: 'dev', path: 'refused', why: 'queue full' }]
  await assert.rejects(questions.reply(id, 'q2', 'x'), (e) => e.code === 'refused' && /queue full/.test(e.message))
  f.ctx.rooms.send = async () => [{ to: 'dev', path: 'held', why: 'not-waiting' }]
  await questions.reply(id, 'q3', 'x')
  f.ctx.rooms.send = send
  assert.deepEqual((await questions.open(id)).map((q) => q.id), ['q1', 'q2'])
})

test("reply: Rooms' refusal (bad text, length, rate) passes through and leaves the question open", async () => {
  const { f, questions, id, dev } = await setup({ roomSendsPerMinute: 1 })
  await ask(f, dev, 'a?')
  await assert.rejects(questions.reply(id, 'q1', 'x\u0007y'), /rooms\.send/)
  assert.equal((await questions.open(id)).length, 1)
  // The rate cap: the first send passes, the second is refused naming the cap.
  await ask(f, dev, 'b?')
  await questions.reply(id, 'q1', 'ok')
  await assert.rejects(questions.reply(id, 'q2', 'ok'), /sends a minute/)
  assert.deepEqual((await questions.open(id)).map((q) => q.id), ['q2'])
})

test('two replies at once send one message', async () => {
  const { f, questions, id, dev } = await setup()
  await ask(f, dev, 'a?')
  const results = await Promise.allSettled([questions.reply(id, 'q1', 'one'), questions.reply(id, 'q1', 'two')])
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected'])
  assert.equal(f.rooms.get(id).log.filter((e) => e.type === 'send').length, 1)
})

test('done closes without a message; done twice and an unknown id are refused', async () => {
  const { f, teams, questions, id, dev } = await setup()
  await ask(f, dev, 'a?')
  await questions.done(id, 'q1')
  const q = (await teams.get(id)).questions[0]
  assert.ok(Number.isFinite(q.doneAt))
  assert.equal(q.answeredAt, undefined)
  assert.equal(f.rooms.get(id).log.filter((e) => e.type === 'send').length, 0)
  await assert.rejects(questions.done(id, 'q1'), (e) => e.code === 'closed')
  await assert.rejects(questions.done(id, 'q7'), (e) => e.code === 'no-question')
  await assert.rejects(questions.reply(id, 'q1', 'late'), (e) => e.code === 'closed')
})

test('ids are not reused and an ended team keeps its questions', async () => {
  const { f, teams, questions, id, dev } = await setup()
  await ask(f, dev, 'a?')
  await ask(f, dev, 'b?')
  await questions.done(id, 'q2')
  await ask(f, dev, 'c?')
  assert.deepEqual((await teams.get(id)).questions.map((q) => q.id), ['q1', 'q2', 'q3'])
})
