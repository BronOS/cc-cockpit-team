'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const host = require('../dist/host.js')
const { fakeCtx } = require('./fake-ctx')
const { createTeams } = require('../lib/teams.js')

test.afterEach(() => host.deactivate())

test('activate registers the team command', () => {
  const f = fakeCtx()
  host.activate(f.ctx)
  assert.ok(f.handlers.has('team'))
})

test('activate loads the records at once: a record of a gone room is dropped without a command', async () => {
  const f = fakeCtx()
  f.store.set('team:room-gone', { roomId: 'room-gone', title: 'Old', createdAt: 1, marks: [], questions: [], metrics: { members: {}, logSeq: 0 } })
  host.activate(f.ctx)
  await new Promise((r) => setImmediate(r))
  assert.equal(f.store.has('team:room-gone'), false)
})

test('a failing load is logged and the team handler is still registered', async () => {
  const f = fakeCtx()
  const warned = []
  f.ctx.log.warn = (m) => warned.push(m)
  f.ctx.rooms.list = async () => {
    throw new Error('rooms.list: boom')
  }
  host.activate(f.ctx)
  await new Promise((r) => setImmediate(r))
  assert.ok(f.handlers.has('team'))
  assert.match(warned.join('\n'), /boom/)
  assert.match((await f.run(['help'])).stdout, /ccc team/)
})

test('help prints usage, also with no argument', async () => {
  const f = fakeCtx()
  host.activate(f.ctx)
  for (const argv of [['help'], []]) {
    const r = await f.run(argv)
    assert.match(r.stdout, /ccc team/)
    assert.match(r.stdout, /hire <name> --kickoff/)
    assert.equal(r.code, undefined)
  }
})

test('an unknown subcommand exits 2 with usage', async () => {
  const f = fakeCtx()
  host.activate(f.ctx)
  const r = await f.run(['bogus'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /unknown command: bogus/)
})

test('an older app without ctx.rooms: help works, everything else refuses cleanly', async () => {
  const f = fakeCtx({ rooms: false })
  host.activate(f.ctx)
  assert.match((await f.run(['help'])).stdout, /ccc team/)
  const r = await f.run(['list'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /0\.19\.1/)
  // The declared panel's page is told why it is empty, and a request is answered, not left waiting.
  await f.page({ type: 'hello' }, 'web:2')
  await f.page({ type: 'mark', req: 7, roomId: 'room1', label: 'x' })
  const [state, result] = f.posts.map(([, m]) => m)
  assert.equal(state.type, 'state')
  assert.match(state.error, /0\.19\.1/)
  assert.equal(f.posts[0][2].view, 'web:2')
  assert.deepEqual([result.type, result.req, result.ok], ['result', 7, false])
  assert.match(result.error, /update the app/)
})

test('an older app: a non-string req is answered with none; a failing post is logged, never thrown', async () => {
  const f = fakeCtx({ rooms: false })
  const warns = []
  f.ctx.log.warn = (t) => warns.push(t)
  host.activate(f.ctx)
  await f.page({ type: 'mark', req: { x: 1 }, roomId: 'room1' })
  await f.page({ type: 'mark', req: 'a1', roomId: 'room1' })
  const results = f.posts.map(([, m]) => m)
  assert.deepEqual(results.map((m) => [m.type, m.req, m.ok, m.error]), [
    ['result', undefined, false, 'Team needs cc-cockpit 0.19.1 or newer (Rooms): update the app.'],
    ['result', 'a1', false, 'Team needs cc-cockpit 0.19.1 or newer (Rooms): update the app.'],
  ])
  f.ctx.panels.post = () => {
    throw new Error('panels.post: no such view')
  }
  await f.page({ type: 'hello' }, 'web:4')
  assert.ok(warns.some((t) => /team panel: panels\.post: no such view/.test(t)))
})

test('deactivate unregisters the handler', () => {
  const f = fakeCtx()
  host.activate(f.ctx)
  host.deactivate()
  assert.equal(f.handlers.has('team'), false)
})

test('manifest: id, version, cli, panel, skill, setting, description names the app version', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'))
  assert.equal(m.id, 'bronos.team')
  assert.equal(m.version, '0.2.0')
  assert.equal(m.contributes.cli[0].name, 'team')
  assert.equal(m.contributes.cli[0].stdin, true)
  assert.equal(m.contributes.cli[0].stdinDash, true)
  assert.equal(m.contributes.panels[0].defaultZone, 'right')
  assert.equal(m.contributes.skills[0].id, 'team-tool')
  assert.equal(m.contributes.settings.app.properties.exportDir.default, '')
  assert.match(m.description, /Needs cc-cockpit 0\.22\.0/)
  for (const f of [m.main, m.contributes.panels[0].entry, m.contributes.panels[0].icon, m.contributes.skills[0].dir + '/SKILL.md']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', f)), f)
  }
})

test('the host wires ask: a member asks through ccc team and the question is stored', async () => {
  const f = fakeCtx()
  const { id } = await f.ctx.rooms.create({ title: 'T' })
  await f.ctx.rooms.open(id, { name: 'lead', coordinator: true })
  const dev = (await f.ctx.rooms.open(id, { name: 'dev' })).tabId
  host.activate(f.ctx)
  const r = await f.run(['ask', 'which db?'], { tabId: dev })
  assert.equal(r.code, undefined, r.stderr)
  assert.match(r.stdout, /^asked q1:/)
  assert.equal(f.store.get(`team:${id}`).questions[0].text, 'which db?')
})

test('one metrics instance: started on activate (one poll schedule), stopped on deactivate, which waits for its save', async () => {
  const f = fakeCtx()
  const { id } = await f.ctx.rooms.create({ title: 'T' })
  await createTeams(f.ctx).add({ id })
  await f.ctx.rooms.open(id, { name: 'lead', coordinator: true })
  await f.ctx.rooms.open(id, { name: 'dev' })
  f.pushLog(id, { type: 'send', from: 'dev', to: 'lead', text: 'a', delivery: [{ to: 'lead', path: 'delivered' }] })
  host.activate(f.ctx)
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
  // Two schedules: the metrics' poll and the panel's tick (both 5 s); one each.
  assert.equal(f.schedules.length, 2)
  // The first poll counted the send; the throttled save is 5 s away, so only deactivate's final save writes it.
  assert.equal(f.store.get(`team:${id}`).metrics.members.dev, undefined)
  const done = host.deactivate()
  assert.equal(typeof (done && done.then), 'function')
  await done
  assert.equal(f.store.get(`team:${id}`).metrics.members.dev.sent, 1)
  assert.equal(f.schedules.length, 0)
})

test('instances(): null before activate and after deactivate; the objects the team command uses', async () => {
  host.deactivate()
  assert.equal(host.instances(), null)
  const f = fakeCtx()
  host.activate(f.ctx)
  const inst = host.instances()
  assert.ok(inst && inst.teams && inst.questions && inst.metrics)
  f.emitSession({ tabId: 'lead-tab', status: 'waiting' })
  const r = await f.run(['start', 'Shared'], { tabId: 'lead-tab' })
  assert.equal(r.code, undefined, r.stderr)
  // The record the command made is in the same teams store, and the same metrics answers for it.
  const roomId = [...f.rooms.keys()][0]
  assert.ok(await inst.teams.get(roomId))
  assert.equal((await inst.metrics.stats(roomId)).title, 'Shared')
  await host.deactivate()
  assert.equal(host.instances(), null)
})
