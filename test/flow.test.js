'use strict'
// The whole flow through the fake ctx, as a lead Claude tab would drive it with `ccc team`. Later tasks extend it:
// ask and reply (task 4), mark and stats (task 6), end with export and the folder checked (task 7).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const host = require('../dist/host.js')
const { fakeCtx } = require('./fake-ctx')

test('flow: start, join, hire two, list', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-flow-')))
  t.after(() => {
    host.deactivate()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(dir, 'team'))
  fs.writeFileSync(path.join(dir, 'team', 'backend.md'), '# Backend\nBuild the API.\n')
  fs.writeFileSync(path.join(dir, 'team', 'frontend.md'), '# Frontend\nBuild the page.\n')

  const f = fakeCtx({ projectDir: dir })
  host.activate(f.ctx)
  f.emitSession({ tabId: 'lead-tab', status: 'waiting' })
  const lead = { tabId: 'lead-tab', cwd: dir }

  // start: the caller gets a coordinator invite and joins with it.
  const start = await f.run(['start', 'Checkout v2'], lead)
  assert.equal(start.code, undefined, start.stderr)
  f.join(/ccc room join (\S+)/.exec(start.stdout)[1], 'lead-tab')

  // hire two members from kickoff files, relative to the lead's cwd.
  for (const [name, model] of [['backend', 'opus'], ['frontend', 'sonnet']]) {
    const r = await f.run(['hire', name, '--kickoff', `team/${name}.md`, '--model', model], lead)
    assert.equal(r.code, undefined, r.stderr)
  }

  const [room] = f.rooms.values()
  assert.deepEqual([...room.members.keys()].sort(), ['backend', 'frontend', 'lead'])
  assert.equal(room.docs.get('members/backend/kickoff.md'), '# Backend\nBuild the API.\n')
  assert.equal(room.docs.get('members/frontend/kickoff.md'), '# Frontend\nBuild the page.\n')
  const opens = f.opens.filter((o) => o.via === 'rooms.open')
  assert.deepEqual(opens.map((o) => [o.name, o.model, o.prompt]), [
    ['backend', 'opus', 'Read your kickoff: ccc room doc get members/backend/kickoff.md'],
    ['frontend', 'sonnet', 'Read your kickoff: ccc room doc get members/frontend/kickoff.md'],
  ])

  // A hired member sees the team.
  const list = JSON.parse((await f.run(['list', '--json'], { tabId: opens[0].tabId })).stdout)
  assert.equal(list.title, 'Checkout v2')
  assert.equal(list.you, 'backend')
  assert.deepEqual(list.members.map((m) => [m.name, m.coordinator]).sort(), [['backend', false], ['frontend', false], ['lead', true]])
})
