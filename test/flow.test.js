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
const { kickoffPrompt } = require('../lib/kickoff.js')

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
    ['backend', 'opus', kickoffPrompt({ team: 'Checkout v2', name: 'backend', coordinator: false, docPath: 'members/backend/kickoff.md', text: '# Backend\nBuild the API.\n' })],
    ['frontend', 'sonnet', kickoffPrompt({ team: 'Checkout v2', name: 'frontend', coordinator: false, docPath: 'members/frontend/kickoff.md', text: '# Frontend\nBuild the page.\n' })],
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

test('flow: two teams in one window, interleaved, with a plugin restart in the middle', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-flow3-')))
  t.after(() => {
    host.deactivate()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(dir, 'dev.md'), '# Dev\n')
  const f = fakeCtx({ projectDir: dir })
  host.activate(f.ctx)
  const teamsOf = {}
  for (const [key, title] of [['a', 'Team A'], ['b', 'Team B']]) {
    const lead = { tabId: `lead-${key}`, cwd: dir }
    f.emitSession({ tabId: lead.tabId, status: 'waiting' })
    const start = await f.run(['start', title], lead)
    f.join(/ccc room join (\S+)/.exec(start.stdout)[1], lead.tabId)
    assert.equal((await f.run(['hire', 'dev', '--kickoff', 'dev.md'], lead)).code, undefined)
    const dev = { tabId: f.opens.filter((o) => o.via === 'rooms.open').at(-1).tabId }
    const roomId = [...f.rooms.keys()].at(-1)
    teamsOf[key] = { lead, dev, roomId }
  }
  const { a, b } = teamsOf
  // Each dev asks in its own team; the ids are per team.
  assert.match((await f.run(['ask', 'A one?'], a.dev)).stdout, /asked q1/)
  assert.match((await f.run(['ask', 'B one?'], b.dev)).stdout, /asked q1/)
  assert.match((await f.run(['ask', 'A two?'], a.dev)).stdout, /asked q2/)
  await host.instances().questions.reply(a.roomId, 'q1', 'yes')
  assert.equal((await f.run(['mark', 'a-phase'], a.lead)).code, undefined)

  // The plugin restarts (a reload): records and questions come back from storage, nothing crosses teams.
  await host.deactivate()
  host.activate(f.ctx)
  const { questions, teams } = host.instances()
  await teams.load()
  assert.deepEqual((await questions.open(a.roomId)).map((q) => q.text), ['A two?'])
  assert.deepEqual((await questions.open(b.roomId)).map((q) => q.text), ['B one?'])
  await questions.reply(b.roomId, 'q1', 'no')
  assert.equal((await f.run(['mark', 'b-phase'], b.lead)).code, undefined)
  assert.match((await f.run(['ask', 'A three?'], a.dev)).stdout, /asked q3/)

  const sa = JSON.parse((await f.run(['stats', '--json'], a.dev)).stdout)
  const sb = JSON.parse((await f.run(['stats', '--json'], b.dev)).stdout)
  assert.deepEqual([sa.title, sa.marks.map((m) => m.label), sa.questions.asked, sa.questions.answered], ['Team A', ['a-phase'], 3, 1])
  assert.deepEqual([sb.title, sb.marks.map((m) => m.label), sb.questions.asked, sb.questions.answered], ['Team B', ['b-phase'], 1, 1])
  // The replies went to each team's own dev only.
  const plugin = (id) => f.rooms.get(id).log.filter((e) => e.type === 'send' && e.from === 'plugin').map((e) => e.text)
  assert.equal(plugin(a.roomId).length, 1)
  assert.match(plugin(a.roomId)[0], /q1:\nyes$|q1:[\s\S]*yes/)
  assert.equal(plugin(b.roomId).length, 1)
  assert.match(plugin(b.roomId)[0], /no$/)

  // Ending A leaves B running and reachable.
  assert.equal((await f.run(['end'], a.lead)).code, undefined)
  assert.notEqual(f.rooms.get(a.roomId).endedAt, undefined)
  assert.equal(f.rooms.get(b.roomId).endedAt, undefined)
  assert.equal(JSON.parse((await f.run(['list', '--json'], b.dev)).stdout).title, 'Team B')
})
