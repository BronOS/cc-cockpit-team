'use strict'
// The fake ctx must keep the real ctx.rooms / ctx.sessions shapes (cc-cockpit src/sdk/types.ts), or every
// test built on it passes against an API the app does not have. These pin the shapes and refusals.
const test = require('node:test')
const assert = require('node:assert/strict')
const { fakeCtx } = require('./fake-ctx')

test('rooms.create takes { title } and answers { id }; list has the RoomInfo fields', async () => {
  const { ctx, clock } = fakeCtx()
  const { id, ...rest } = await ctx.rooms.create({ title: 'API work' })
  assert.equal(typeof id, 'string')
  assert.deepEqual(rest, {})
  assert.deepEqual(await ctx.rooms.list(), [{ id, title: 'API work', createdAt: clock.t, paused: false, members: 0 }])
  for (const title of ['', 'x'.repeat(61), 'a "quoted" one', 'two\nlines', 'a [b]', 'ab\u202e']) {
    await assert.rejects(ctx.rooms.create({ title }), /rooms\.create: title/)
  }
  await assert.rejects(ctx.rooms.create('plain string'), /rooms\.create: title/)
})

test('rooms caps: 5 open rooms; delete only an ended room; end sets endedAt', async () => {
  const { ctx } = fakeCtx()
  const ids = []
  for (let i = 0; i < 5; i++) ids.push((await ctx.rooms.create({ title: `t${i}` })).id)
  await assert.rejects(ctx.rooms.create({ title: 'six' }), /roomsPerProject/)
  await assert.rejects(ctx.rooms.delete(ids[0]), /only an ended room/)
  await ctx.rooms.end(ids[0])
  assert.equal(typeof (await ctx.rooms.list())[0].endedAt, 'number')
  await ctx.rooms.create({ title: 'six' })
  await ctx.rooms.delete(ids[0])
  await assert.rejects(ctx.rooms.members(ids[0]), /no such room/)
  await assert.rejects(ctx.rooms.docs.get('nope', 'shared/a.md'), /no such room/)
  await assert.rejects(ctx.rooms.docs.list('nope'), /no such room/)
})

test('rooms.open records its options, checks the name, joins and counts against 5 opens a minute', async () => {
  const f = fakeCtx()
  const { id } = await f.ctx.rooms.create({ title: 'T' })
  const { tabId } = await f.ctx.rooms.open(id, { name: 'lead', coordinator: true, prompt: 'go', model: 'opus', effort: 'high', cwd: 'sub' })
  assert.deepEqual(f.opens[0], {
    via: 'rooms.open',
    roomId: id,
    tabId,
    name: 'lead',
    coordinator: true,
    prompt: 'go',
    model: 'opus',
    effort: 'high',
    cwd: '/proj/sub',
  })
  assert.deepEqual(await f.ctx.rooms.members(id), [{ name: 'lead', coordinator: true, tabId, held: 0 }])
  const [s] = await f.ctx.sessions.list()
  assert.deepEqual(s.room, { title: 'T', name: 'lead', coordinator: true })
  assert.equal(s.typed, false)
  assert.deepEqual(s.notes, [])
  for (const name of ['all', 'Bob', '1x', 'plugin', 'a'.repeat(32)]) {
    await assert.rejects(f.ctx.rooms.open(id, { name }), /rooms\.open: name/)
  }
  await assert.rejects(f.ctx.rooms.open(id, { name: 'lead' }), /already a member/)
  await assert.rejects(f.ctx.rooms.open(id, { name: 'x', model: 'gpt' }), /unknown model/)
  await assert.rejects(f.ctx.rooms.open(id, { name: 'x', cwd: '../out' }), /inside the project/)
  for (const name of ['b', 'c', 'd', 'e']) await f.ctx.rooms.open(id, { name })
  await assert.rejects(f.ctx.rooms.open(id, { name: 'f' }), /opensPerMinute/)
  f.advance(60_000)
  await f.ctx.rooms.open(id, { name: 'f' })
  await f.ctx.rooms.end(id)
  await assert.rejects(f.ctx.rooms.open(id, { name: 'g' }), /the room ended/)
})

test('invite answers { code, expiresAt }; join and remove are logged', async () => {
  const f = fakeCtx()
  const { id } = await f.ctx.rooms.create({ title: 'T' })
  const inv = await f.ctx.rooms.invite(id, { name: 'rev' })
  assert.equal(inv.expiresAt, f.clock.t + 600_000)
  f.emitSession({ tabId: 'tabX', status: 'waiting' })
  f.join(inv.code, 'tabX')
  assert.throws(() => f.join(inv.code, 'tabY'), /no such invite/)
  await f.ctx.rooms.remove(id, 'rev')
  await assert.rejects(f.ctx.rooms.remove(id, 'rev'), /no member/)
  const { entries } = await f.ctx.rooms.log(id)
  assert.deepEqual(
    entries.map((e) => [e.seq, e.type]),
    [
      [1, 'create'],
      [2, 'invite'],
      [3, 'join'],
      [4, 'leave'],
    ],
  )
  assert.ok(entries.every((e) => e.at === f.clock.t))
})

test('send answers per recipient: delivered, held with why, gone; logs type send', async () => {
  const f = fakeCtx()
  const { id } = await f.ctx.rooms.create({ title: 'T' })
  const a = await f.ctx.rooms.open(id, { name: 'a' })
  await f.ctx.rooms.open(id, { name: 'b' })
  f.emitSession({ tabId: a.tabId, status: 'waiting' })
  assert.deepEqual(await f.ctx.rooms.send(id, 'all', 'hi'), [
    { to: 'a', path: 'delivered' },
    { to: 'b', path: 'held', why: 'not-waiting', status: 'starting' },
  ])
  assert.deepEqual(await f.ctx.rooms.send(id, 'nobody', 'hi'), [{ to: 'nobody', path: 'gone' }])
  f.setPaused(id, true)
  assert.deepEqual(await f.ctx.rooms.send(id, 'a', 'x'), [{ to: 'a', path: 'held', why: 'paused' }])
  await assert.rejects(f.ctx.rooms.send(id, 'a', 'x'.repeat(20001)), /20000/)
  const last = (await f.ctx.rooms.log(id, { limit: 1 })).entries[0]
  assert.equal(last.type, 'send')
  assert.equal(last.from, 'plugin')
  assert.equal((await f.ctx.rooms.members(id))[0].held, 2)
})

test('log: since answers the oldest after it with more when newer remain; without it the newest', async () => {
  const f = fakeCtx()
  const { id } = await f.ctx.rooms.create({ title: 'T' })
  for (let i = 0; i < 4; i++) f.pushLog(id, { type: 'mark' })
  const oldest = await f.ctx.rooms.log(id, { since: 1, limit: 2 })
  assert.deepEqual(oldest.entries.map((e) => e.seq), [2, 3])
  assert.equal(oldest.more, true)
  const newest = await f.ctx.rooms.log(id, { limit: 2 })
  assert.deepEqual(newest.entries.map((e) => e.seq), [4, 5])
  assert.equal(newest.more, true)
  assert.equal((await f.ctx.rooms.log(id, { since: 3 })).more, false)
  assert.throws(() => f.pushLog(id, { kind: 'x' }), /needs a type/)
})

test('docs: area and path rules, RoomDoc list, a missing doc rejects', async () => {
  const { ctx } = fakeCtx()
  const { id } = await ctx.rooms.create({ title: 'T' })
  await ctx.rooms.docs.put(id, 'shared/brief.md', 'hello\r\n')
  await ctx.rooms.docs.put(id, 'members/a/kickoff.md', 'é')
  assert.deepEqual(await ctx.rooms.docs.list(id), [
    { path: 'shared/brief.md', size: 7 },
    { path: 'members/a/kickoff.md', size: 2 },
  ])
  assert.equal(await ctx.rooms.docs.get(id, 'shared/brief.md'), 'hello\r\n')
  await assert.rejects(ctx.rooms.docs.get(id, 'shared/none.md'), /no such doc/)
  for (const p of ['brief.md', 'shared', 'shared/../x', 'shared/a/b/c/d/e', 'members/A/x', 'shared/a b']) {
    await assert.rejects(ctx.rooms.docs.put(id, p, 'x'), /bad doc path/)
  }
  await assert.rejects(ctx.rooms.docs.put(id, 'shared/x', 'a\u0000'), /control/)
  await assert.rejects(ctx.rooms.docs.put(id, 'shared/x', 'a\rb'), /control/)
  await assert.rejects(ctx.rooms.docs.put(id, 'shared/x', 'x'.repeat(256 * 1024 + 1)), /256 KiB/)
})

test('sessions.onChange gets the whole list; storage, notify and cli match the real API', async () => {
  const f = fakeCtx()
  const seen = []
  f.ctx.sessions.onChange((list) => seen.push(list.map((s) => s.tabId)))
  f.emitSession({ tabId: 't1', status: 'idle' })
  f.emitSession({ tabId: 't2', status: 'working' })
  assert.deepEqual(seen, [['t1'], ['t1', 't2']])
  await f.ctx.storage.set('k', { a: 1 })
  assert.deepEqual(await f.ctx.storage.keys(), ['k'])
  await f.ctx.storage.delete('k')
  assert.equal(await f.ctx.storage.get('k'), undefined)
  assert.deepEqual(await f.ctx.notify('hi', { title: 'Team' }), { clicked: false })
  assert.deepEqual(f.notices, [{ text: 'hi', options: { title: 'Team' } }])
  assert.throws(() => f.ctx.cli.register('other', () => {}), /not declared/)
  f.ctx.cli.register('team', () => {})
  assert.throws(() => f.ctx.cli.register('team', () => {}), /already has a handler/)
  assert.throws(() => f.ctx.panels.show('nope'), /undeclared panel/)
})

test('run passes stdin only for a `-` argument (stdinDash)', async () => {
  const f = fakeCtx()
  let got
  f.ctx.cli.register('team', (argv, call) => void (got = call))
  await f.run(['ask', 'q'], { stdin: 'text' })
  assert.equal(got.stdin, '')
  assert.equal(got.tabId, undefined)
  await f.run(['ask', '-'], { stdin: 'text', tabId: 'tab1' })
  assert.equal(got.stdin, 'text')
  assert.equal(got.tabId, 'tab1')
})

test("rooms text rules follow cc-cockpit's HIDDEN_TEXT: Cf refused (but ZWNJ/ZWJ), CRLF allowed, lone CR refused; typographic quotes refused in a title", async () => {
  const f = fakeCtx()
  const { id } = await f.ctx.rooms.create({ title: 'T' })
  const c = (cp) => String.fromCodePoint(cp)
  await f.ctx.rooms.docs.put(id, 'shared/a.md', 'a\r\nb\tc' + c(0x200d))
  for (const bad of ['a' + c(0xad), 'a' + c(0xe0041), 'a\rb', 'a' + c(0x85)]) {
    await assert.rejects(f.ctx.rooms.docs.put(id, 'shared/a.md', bad), /rooms\.docs\.put/)
  }
  await f.ctx.rooms.open(id, { name: 'dev' })
  await assert.rejects(f.ctx.rooms.send(id, 'dev', 'x' + c(0x202e)), /rooms\.send/)
  await assert.rejects(f.ctx.rooms.create({ title: 'a' + c(0x201c) + 'b' }), /rooms\.create/)
})

test('rooms.end on an ended room resolves; an ended room keeps its members (unbound); a blank message is refused', async () => {
  const f = fakeCtx()
  const { id } = await f.ctx.rooms.create({ title: 'T' })
  const { tabId } = await f.ctx.rooms.open(id, { name: 'dev' })
  await assert.rejects(f.ctx.rooms.send(id, 'dev', '  \n'), /rooms\.send/)
  await f.ctx.rooms.end(id)
  await f.ctx.rooms.end(id)
  assert.deepEqual(await f.ctx.rooms.members(id), [{ name: 'dev', coordinator: false, held: 0 }])
  assert.equal((await f.ctx.rooms.list())[0].members, 1)
  assert.equal(f.sessions.get(tabId).room, undefined)
  await assert.rejects(f.ctx.rooms.send(id, 'dev', 'hi'), /rooms\.send/)
})
