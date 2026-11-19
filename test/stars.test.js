'use strict'
// Stars (lib/stars.js): `ccc team star`, the member's room message, the record, stats, the panel and the export.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const host = require('../dist/host.js')
const { fakeCtx } = require('./fake-ctx')
const { NOT_IN_TEAM, NOT_COORDINATOR, KEY_PREFIX, createTeams } = require('../lib/teams.js')
const { starMessage, REASON_MAX, STARS_MAX } = require('../lib/stars.js')
const { starsOf, statsOf, formatStats } = require('../lib/stats.js')
const V = require('../panels/view-model.js')

test.afterEach(() => host.deactivate())

const dirs = []
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

/** A started team (`lead` joined) with `dev` hired (opus, high, Code Mode), and an `out` folder for exports. */
async function team(opts = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-stars-')))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'dev.md'), '# You are dev\n')
  fs.mkdirSync(path.join(dir, 'out'))
  const f = fakeCtx({ projectDir: dir, ...opts })
  host.activate(f.ctx)
  f.emitSession({ tabId: 'lead-tab', status: 'waiting' })
  const lead = { tabId: 'lead-tab', cwd: dir }
  const r = await f.run(['start', 'Checkout v2'], lead)
  assert.equal(r.code, undefined, r.stderr)
  f.join(/ccc room join (\S+)/.exec(r.stdout)[1], 'lead-tab')
  const h = await f.run(['hire', 'dev', '--kickoff', 'dev.md', '--model', 'opus', '--effort', 'high', '--env', 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1'], lead)
  assert.equal(h.code, undefined, h.stderr)
  const roomId = [...f.rooms.keys()][0]
  const devTab = f.opens.find((o) => o.name === 'dev').tabId
  f.emitSession({ tabId: devTab, status: 'waiting' })
  return { f, dir, lead, roomId, dev: { tabId: devTab } }
}

/** The plugin's sends to `name`, as the room logged them. */
const sendsTo = (f, roomId, name) => f.rooms.get(roomId).log.filter((e) => e.type === 'send' && e.from === 'plugin' && e.to === name).map((e) => e.text)

/** Gate the next call of `ctx.rooms[method]` (after `skip` calls) right after it answered. */
function holdNext(f, method, skip = 0) {
  const real = f.ctx.rooms[method]
  let armed = true
  let release
  let reached
  const gate = new Promise((r) => (release = r))
  const came = new Promise((r) => (reached = r))
  f.ctx.rooms[method] = async (...a) => {
    if (!armed) return real(...a)
    if (skip > 0) {
      skip--
      return real(...a)
    }
    armed = false
    const answer = await real(...a)
    reached()
    await gate
    return answer
  }
  return { reached: came, release }
}

test('star: the member is told through the room, the star is kept with its settings; several per member', async () => {
  const { f, lead, roomId } = await team()
  const r = await f.run(['star', 'dev', 'found the race in the export'], lead)
  assert.equal(r.code, undefined, r.stderr)
  assert.equal(r.stdout, 'starred dev (1 star): it was told\n')
  assert.deepEqual(sendsTo(f, roomId, 'dev'), ['The person gave you a star: found the race in the export (recorded by lead)'])
  assert.equal(starMessage('x', 'lead'), 'The person gave you a star: x (recorded by lead)')
  const r2 = await f.run(['star', 'dev', '  clean review fixes  '], lead)
  assert.equal(r2.stdout, 'starred dev (2 stars): it was told\n')
  const rec = await host.instances().teams.get(roomId)
  assert.equal(rec.stars.length, 2)
  const [a, b] = rec.stars
  assert.deepEqual({ ...a, at: 0 }, { at: 0, name: 'dev', reason: 'found the race in the export', by: 'lead', coordinator: false, model: 'opus', effort: 'high', codeMode: true })
  // Trimmed, as a mark label.
  assert.equal(b.reason, 'clean review fixes')
  assert.ok(Number.isFinite(a.at))
  // Stored: the record as storage holds it has them too.
  assert.equal(f.store.get(KEY_PREFIX + roomId).stars.length, 2)
})

test('star: the coordinator can star itself; a held message says so', async () => {
  const { f, lead, roomId } = await team()
  // The lead's tab is the person's (typed in): Rooms holds the message until it reads.
  f.emitSession({ tabId: 'lead-tab', status: 'waiting', typed: true })
  const r = await f.run(['star', 'lead', 'kept the team moving'], lead)
  assert.equal(r.code, undefined, r.stderr)
  assert.match(r.stdout, /^starred lead \(1 star\): it is in its queue, read at its next `ccc room read` \(held: typed\)\n$/)
  const [s] = (await host.instances().teams.get(roomId)).stars
  // Joined by invite: no model, effort or Code Mode known.
  assert.deepEqual({ ...s, at: 0 }, { at: 0, name: 'lead', reason: 'kept the team moving', by: 'lead', coordinator: true })
})

test('star is coordinator-only; outsiders get the one not-in-team text; usage errors exit 2', async () => {
  const { f, lead, roomId, dev } = await team()
  const m = await f.run(['star', 'dev', 'me'], dev)
  assert.equal(m.code, 1)
  assert.equal(m.stderr, NOT_COORDINATOR + '\n')
  const out = await f.run(['star', 'dev', 'x'], { tabId: 'nobody' })
  assert.equal(out.stderr, NOT_IN_TEAM + '\n')
  for (const argv of [['star', 'dev'], ['star'], ['star', 'dev', 'a', 'b'], ['star', 'dev', 'x', '--bogus']]) {
    const u = await f.run(argv, lead)
    assert.equal(u.code, 2, argv.join(' '))
    assert.match(u.stderr, /usage: ccc team star <name> "<reason>"/)
  }
  assert.deepEqual(sendsTo(f, roomId, 'dev'), [])
})

test('star: a bad reason or a name not in the team is refused; nothing is sent or kept', async () => {
  const { f, lead, roomId } = await team()
  for (const [reason, re] of [
    ['   ', /reason is empty/],
    ['two\nlines', /one line/],
    ['tab\there', /one line/],
    ['bidi ‮', /one line/],
    ['x'.repeat(REASON_MAX + 1), new RegExp(`at most ${REASON_MAX} characters`)],
  ]) {
    const r = await f.run(['star', 'dev', reason], lead)
    assert.equal(r.code, 1, JSON.stringify(reason))
    assert.match(r.stderr, re)
  }
  // At the limit in code points (an emoji is one).
  assert.equal((await f.run(['star', 'dev', '🌟'.repeat(REASON_MAX)], lead)).code, undefined)
  const gone = await f.run(['star', 'qa', 'x'], lead)
  assert.equal(gone.code, 1)
  assert.match(gone.stderr, /qa is not in the team/)
  assert.equal(sendsTo(f, roomId, 'qa').length, 0)
  assert.equal((await host.instances().teams.get(roomId)).stars.length, 1)
})

test('star: a send the member could not take keeps no star; Rooms\' refusal passes through', async () => {
  const { f, lead, roomId } = await team()
  const send = f.ctx.rooms.send
  f.ctx.rooms.send = async () => [{ to: 'dev', path: 'refused', why: 'queue full' }]
  const r = await f.run(['star', 'dev', 'x'], lead)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /dev cannot take the message now \(queue full\): no star given/)
  f.ctx.rooms.send = async () => {
    throw new Error('rooms.send: at most 60 sends a minute in a room')
  }
  assert.match((await f.run(['star', 'dev', 'x'], lead)).stderr, /^rooms\.send: at most 60 sends/)
  f.ctx.rooms.send = send
  assert.equal((await host.instances().teams.get(roomId)).stars.length, 0)
})

test('star: at most STARS_MAX a team', async () => {
  const { f, lead, roomId } = await team()
  const rec = await host.instances().teams.get(roomId)
  for (let i = 0; i < STARS_MAX; i++) rec.stars.push({ at: i, name: 'dev', reason: `r${i}`, by: 'lead', coordinator: false })
  const r = await f.run(['star', 'dev', 'one more'], lead)
  assert.equal(r.code, 1)
  assert.match(r.stderr, new RegExp(`at most ${STARS_MAX} stars`))
  assert.deepEqual(sendsTo(f, roomId, 'dev'), [])
})

test('star: a fire of the starred member while the star holds its name is refused; the star lands', async () => {
  const { f, lead, roomId } = await team()
  // The first members read is the command's coordinator check; the second is the star's own, under the locks.
  const held = holdNext(f, 'members', 1)
  const starred = f.run(['star', 'dev', 'x'], lead)
  await held.reached
  const fired = await host.instances().hiring.fire(roomId, 'dev').catch((e) => e)
  assert.match(fired.message, /a star given by or to dev is on its way: try again in a moment/)
  held.release()
  assert.equal((await starred).code, undefined)
  assert.equal((await host.instances().teams.get(roomId)).stars.length, 1)
  assert.ok(f.rooms.get(roomId).members.has('dev'))
})

test('star: a fire of the coordinator giving a star is refused while it holds its own name', async () => {
  const { f, lead, roomId } = await team()
  const held = holdNext(f, 'members', 1)
  const starred = f.run(['star', 'dev', 'x'], lead)
  await held.reached
  const fired = await host.instances().hiring.fire(roomId, 'lead').catch((e) => e)
  assert.match(fired.message, /a star given by or to lead is on its way: try again in a moment/)
  held.release()
  assert.equal((await starred).code, undefined)
})

test('star: a member fired after its command\'s check, before the star\'s own read, gets nothing', async () => {
  const { f, lead, roomId } = await team()
  const held = holdNext(f, 'members')
  const starred = f.run(['star', 'dev', 'x'], lead)
  await held.reached
  assert.equal((await f.run(['fire', 'dev'], lead)).code, undefined)
  held.release()
  const r = await starred
  assert.equal(r.code, 1)
  assert.match(r.stderr, /dev is not in the team/)
  assert.deepEqual(sendsTo(f, roomId, 'dev'), [])
})

test('star: a fired member keeps its stars (stats, the panel); a rehire with other settings keeps the old snapshot', async () => {
  const { f, lead, roomId } = await team()
  assert.equal((await f.run(['star', 'dev', 'first stint'], lead)).code, undefined)
  assert.equal((await f.run(['fire', 'dev'], lead)).code, undefined)
  const { metrics } = host.instances()
  await metrics.poll()
  // The panel's member list: dev has left, its row (from the metrics) carries the star.
  await f.page({ type: 'hello', selected: roomId }, 'desktop')
  const state = f.posts.filter(([p, m, o]) => p === 'team' && m.type === 'state' && o && o.view === 'desktop').at(-1)[1]
  const devRow = state.team.members.find((m) => m.name === 'dev')
  assert.equal(devRow.status, 'left')
  assert.deepEqual(devRow.stars.map((s) => [s.reason, s.by]), [['first stint', 'lead']])
  assert.equal(V.starBadge(devRow).count, 1)
  // Hired again, sonnet and no Code Mode: a second star is a second group in the stats.
  assert.equal((await f.run(['hire', 'dev', '--kickoff', 'dev.md', '--model', 'sonnet'], lead)).code, undefined)
  assert.equal((await f.run(['star', 'dev', 'second stint'], lead)).code, undefined)
  const s = await metrics.stats(roomId)
  assert.deepEqual(
    s.stars.map((g) => [g.name, g.coordinator, g.model, g.effort, g.codeMode, g.stars.map((x) => x.reason)]),
    [
      ['dev', false, 'opus', 'high', true, ['first stint']],
      ['dev', false, 'sonnet', null, false, ['second stint']],
    ],
  )
  // The member row lists every star of the name.
  assert.equal(s.members.find((m) => m.name === 'dev').stars.length, 2)
  const text = (await f.run(['stats'], lead)).stdout
  assert.match(text, /stars:\n {2}dev: 1 \(member, model opus, effort high, Code Mode on\)\n {4}- first stint \(by lead\)\n {2}dev: 1 \(member, model sonnet, effort default, Code Mode off\)\n {4}- second stint \(by lead\)\n/)
  assert.equal(JSON.parse((await f.run(['stats', '--json'], lead)).stdout).stars.length, 2)
})

test('star: a coordinator check that finishes after an End is refused inside the guard; nothing is sent', async () => {
  const { f, lead, roomId } = await team()
  const held = holdNext(f, 'members')
  const pending = f.run(['star', 'dev', 'x'], lead)
  await held.reached
  await host.instances().ending.endTeam(roomId)
  const logAt = f.rooms.get(roomId).log.length
  held.release()
  const r = await pending
  assert.equal(r.code, 1)
  assert.match(r.stderr, /team has ended/)
  assert.equal(f.rooms.get(roomId).log.length, logAt)
  assert.equal((await host.instances().teams.get(roomId)).stars.length, 0)
})

test('end --export: metrics.json and metrics.md list the stars per member with role, model, effort and Code Mode', async () => {
  const { f, dir, lead } = await team()
  assert.equal((await f.run(['star', 'dev', 'found | the race'], lead)).code, undefined)
  assert.equal((await f.run(['star', 'dev', 'tests first'], lead)).code, undefined)
  assert.equal((await f.run(['star', 'lead', 'good calls'], lead)).code, undefined)
  const r = await f.run(['end', '--export', 'out'], lead)
  assert.equal(r.code, undefined, r.stderr)
  const [name] = fs.readdirSync(path.join(dir, 'out'))
  const folder = path.join(dir, 'out', name)
  const m = JSON.parse(fs.readFileSync(path.join(folder, 'metrics.json'), 'utf8'))
  assert.deepEqual(
    m.stars.map((g) => ({ ...g, stars: g.stars.map((s) => `${s.reason}/${s.by}`) })),
    [
      { name: 'dev', coordinator: false, model: 'opus', effort: 'high', codeMode: true, stars: ['found | the race/lead', 'tests first/lead'] },
      { name: 'lead', coordinator: true, model: null, effort: null, codeMode: null, stars: ['good calls/lead'] },
    ],
  )
  assert.equal(m.members.find((x) => x.name === 'dev').codeMode, true)
  const md = fs.readFileSync(path.join(folder, 'metrics.md'), 'utf8')
  assert.match(md, /## Stars\n/)
  assert.match(md, /\| member \| role \| model \| effort \| Code Mode \| stars \| reasons \|/)
  assert.match(md, /\| dev \| member \| opus \| high \| on \| 2 \| found \\\| the race \(by lead, [^)]+\); tests first \(by lead, [^)]+\) \|/)
  assert.match(md, /\| lead \| coordinator \| default \| default \| unknown \| 1 \| good calls \(by lead, [^)]+\) \|/)
})

test('export without stars says so; a record from before stars reads with none', async () => {
  const rec = { title: 't', createdAt: 0, marks: [], questions: [], metrics: { members: {}, logSeq: 0 } }
  assert.deepEqual(starsOf(rec), [])
  assert.deepEqual(statsOf(rec, 1).stars, [])
  assert.doesNotMatch(formatStats(statsOf(rec, 1)), /stars:/)
  const f = fakeCtx()
  const { id: r1 } = await f.ctx.rooms.create({ title: 'Old' })
  const { id: r2 } = await f.ctx.rooms.create({ title: 'Bad' })
  f.store.set(KEY_PREFIX + r1, { roomId: r1, title: 'Old', createdAt: 1, marks: [], questions: [], metrics: { members: {}, logSeq: 0 } })
  f.store.set(KEY_PREFIX + r2, { roomId: r2, title: 'Bad', createdAt: 1, marks: [], questions: [], stars: [null, 3, { name: 'x' }, { name: 'dev', reason: 'ok' }], metrics: { members: {}, logSeq: 0 } })
  const teams = createTeams(f.ctx)
  assert.deepEqual((await teams.get(r1)).stars, [])
  assert.deepEqual((await teams.get(r2)).stars, [{ name: 'dev', reason: 'ok' }])
})

test('hire: Code Mode is what the app applied (an older app that ignored --env runs without it)', async () => {
  const p = await team({ noEnv: true })
  const s = await host.instances().metrics.stats(p.roomId)
  assert.equal(s.members.find((m) => m.name === 'dev').codeMode, false)
})

test('view model: the star badge is a count with the reasons in its tooltip; none without stars', () => {
  assert.equal(V.starBadge({ name: 'a' }), null)
  assert.equal(V.starBadge({ name: 'a', stars: [] }), null)
  const b = V.starBadge({ name: 'a', stars: [{ reason: 'fast fix', by: 'lead', at: 1 }, { reason: '<b>clean</b>', by: 'co', at: 2 }, null] })
  assert.deepEqual(b, { count: 2, text: '✦ 2', label: '2 stars', title: '2 stars from the person:\n• fast fix (by lead)\n• <b>clean</b> (by co)' })
  // Not the coordinator's mark (★).
  assert.ok(!b.text.includes('★'))
  assert.equal(V.starBadge({ stars: [{ reason: 'x' }] }).label, '1 star')
})
