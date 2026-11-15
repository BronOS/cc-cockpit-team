'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const host = require('../dist/host.js')
const { fakeCtx } = require('./fake-ctx')

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
  assert.match(r.stderr, /0\.18\.1/)
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
  assert.equal(m.version, '0.1.0')
  assert.equal(m.contributes.cli[0].name, 'team')
  assert.equal(m.contributes.cli[0].stdin, true)
  assert.equal(m.contributes.cli[0].stdinDash, true)
  assert.equal(m.contributes.panels[0].defaultZone, 'right')
  assert.equal(m.contributes.skills[0].id, 'team-tool')
  assert.equal(m.contributes.settings.app.properties.exportDir.default, '')
  assert.match(m.description, /Needs cc-cockpit 0\.18\.1/)
  for (const f of [m.main, m.contributes.panels[0].entry, m.contributes.panels[0].icon, m.contributes.skills[0].dir + '/SKILL.md']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', f)), f)
  }
})
