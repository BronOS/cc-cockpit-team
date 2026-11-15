'use strict'
// The whole flow through the fake ctx, as a lead Claude tab would drive it with `ccc team`. Later tasks extend it:
// ask and reply (task 4), mark and stats (task 6), end with export and the folder checked (task 7), the panel (task 8).
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

test('flow: ask, reply, mark, stats, end with export', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-flow2-')))
  t.after(() => {
    host.deactivate()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(dir, 'dev.md'), '# Dev\n')
  const f = fakeCtx({ projectDir: dir })
  host.activate(f.ctx)
  f.emitSession({ tabId: 'lead-tab', status: 'waiting' })
  const lead = { tabId: 'lead-tab', cwd: dir }
  const start = await f.run(['start', 'Checkout v2'], lead)
  f.join(/ccc room join (\S+)/.exec(start.stdout)[1], 'lead-tab')
  assert.equal((await f.run(['hire', 'dev', '--kickoff', 'dev.md'], lead)).code, undefined)
  const dev = { tabId: f.opens.find((o) => o.via === 'rooms.open').tabId }
  const { questions, teams } = host.instances()
  const roomId = [...f.rooms.keys()][0]

  f.emitSession({ tabId: dev.tabId, status: 'working', costUsd: 0.5 })
  const mark1 = await f.run(['mark', 'design done'], lead)
  assert.equal(mark1.code, undefined, mark1.stderr)
  assert.match(mark1.stdout, /marked "design done"/)
  // Only a coordinator marks.
  assert.equal((await f.run(['mark', 'x'], dev)).code, 1)

  assert.match((await f.run(['ask', 'Which db?'], dev)).stdout, /asked q1/)
  await questions.reply(roomId, 'q1', 'Postgres')
  f.emitSession({ tabId: dev.tabId, costUsd: 1.25 })
  assert.equal((await f.run(['mark', 'build done'], lead)).code, undefined)

  const stats = JSON.parse((await f.run(['stats', '--json'], dev)).stdout)
  assert.equal(stats.title, 'Checkout v2')
  assert.deepEqual(stats.marks.map((m) => m.label), ['design done', 'build done'])
  assert.deepEqual(stats.spans.map((s) => `${s.from}>${s.to}`), ['start>design done', 'design done>build done', 'build done>now'])
  const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-9, `${x} != ${y}`)
  near(stats.spans[0].costUsd, 0.5)
  near(stats.spans[1].costUsd, 0.75)
  near(stats.totals.costUsd, 1.25)
  assert.equal(stats.questions.answered, 1)
  const text = (await f.run(['stats'], dev)).stdout
  assert.match(text, /spans \(split at marks\)/)
  assert.match(text, /a proxy/)
  assert.equal((await teams.get(roomId)).marks.length, 2)

  // end with export: a new folder with the docs, log, metrics and questions; then the room ends.
  fs.mkdirSync(path.join(dir, 'exports'))
  const end = await f.run(['end', '--export', 'exports'], lead)
  assert.equal(end.code, undefined, end.stderr)
  const [name] = fs.readdirSync(path.join(dir, 'exports'))
  assert.match(name, /^checkout-v2-\d{8}-\d{4}$/)
  const folder = path.join(dir, 'exports', name)
  assert.deepEqual(fs.readdirSync(folder).sort(), ['docs', 'log.jsonl', 'metrics.json', 'metrics.md', 'questions.md'])
  assert.equal(fs.readFileSync(path.join(folder, 'docs', 'members', 'dev', 'kickoff.md'), 'utf8'), '# Dev\n')
  const exported = JSON.parse(fs.readFileSync(path.join(folder, 'metrics.json'), 'utf8'))
  assert.deepEqual(exported.marks.map((m) => m.label), ['design done', 'build done'])
  assert.equal(exported.spans.at(-1).to, 'end')
  assert.match(fs.readFileSync(path.join(folder, 'questions.md'), 'utf8'), /## q1 from dev: answered\n[\s\S]*> Which db\?/)
  assert.ok(f.rooms.get(roomId).endedAt !== undefined)
})
