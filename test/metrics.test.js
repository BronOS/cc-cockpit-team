'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fakeCtx } = require('./fake-ctx')
const { createTeams } = require('../lib/teams.js')
const { createQuestions } = require('../lib/questions.js')
const { createCommands } = require('../lib/commands.js')
const { createMetrics, bucketOf, leftWhy, addCost, SAVE_MS, CHECKPOINT_MS, POLL_SECONDS } = require('../lib/metrics.js')

/** Timers a test fires by hand (the throttled save). */
function manualTimers() {
  const list = []
  return {
    list,
    setTimeout: (fn, ms) => {
      const t = { fn, ms }
      list.push(t)
      return t
    },
    clearTimeout: (t) => {
      const i = list.indexOf(t)
      if (i >= 0) list.splice(i, 1)
    },
    async fire() {
      for (const t of list.splice(0)) await t.fn()
    },
  }
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
}

/** A started metrics over a team with a coordinator `lead` and a member `dev`, each in its own tab. */
async function setup(opts) {
  const f = fakeCtx(opts)
  const teams = createTeams(f.ctx)
  const { id } = await f.ctx.rooms.create({ title: 'Build it' })
  await teams.add({ id })
  const lead = (await f.ctx.rooms.open(id, { name: 'lead', coordinator: true })).tabId
  const dev = (await f.ctx.rooms.open(id, { name: 'dev' })).tabId
  const timers = manualTimers()
  const make = (t = teams) => createMetrics(f.ctx, t, { now: () => f.clock.t, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout })
  const metrics = make()
  await metrics.start()
  const member = async (name, t = teams) => (await t.get(id)).metrics.members[name]
  return { f, teams, metrics, make, timers, id, lead, dev, member }
}

test('bucketOf maps every SessionStatus', () => {
  assert.equal(bucketOf('working'), 'working')
  assert.equal(bucketOf('needs-permission'), 'working')
  assert.equal(bucketOf('waiting'), 'waiting')
  assert.equal(bucketOf('idle'), 'idle')
  assert.equal(bucketOf('starting'), 'idle')
  assert.equal(bucketOf('ended'), null)
  assert.equal(bucketOf('bogus'), null)
})

test('leftWhy names Rooms\' reasons in the design\'s words', () => {
  assert.equal(leftWhy('removed'), 'fired')
  assert.equal(leftWhy('closed'), 'tab closed')
  assert.equal(leftWhy('left'), 'left')
  assert.equal(leftWhy(undefined), 'left')
})

test('status time: each interval goes to the earlier status', async () => {
  const { f, metrics, dev, member } = await setup()
  // Opened tabs start `starting` (idle) at the start.
  f.advance(1000)
  f.emitSession({ tabId: dev, status: 'working' }) // 1000 idle
  f.advance(3000)
  f.emitSession({ tabId: dev, status: 'needs-permission' }) // still working
  f.advance(2000)
  f.emitSession({ tabId: dev, status: 'waiting' }) // 5000 working
  f.advance(4000)
  f.emitSession({ tabId: dev, status: 'idle' }) // 4000 waiting
  f.advance(500)
  f.emitSession({ tabId: dev, status: 'ended' }) // 500 idle
  f.advance(10_000) // ended: counts nowhere
  f.emitSession({ tabId: dev, status: 'working' })
  await metrics.flush()
  const m = await member('dev')
  assert.equal(m.workingMs, 5000)
  assert.equal(m.waitingMs, 4000)
  assert.equal(m.idleMs, 1500)
})

test('a paused room adds no time; resuming counts again', async () => {
  const { f, metrics, id, dev, member } = await setup()
  f.emitSession({ tabId: dev, status: 'working' })
  f.advance(1000)
  f.setPaused(id, true)
  await metrics.poll() // the flip closes the interval: 1000 working before it
  f.advance(60_000)
  f.emitSession({ tabId: dev, status: 'waiting' })
  f.advance(5000)
  f.setPaused(id, false)
  await metrics.poll()
  f.advance(2000)
  f.emitSession({ tabId: dev, status: 'idle' })
  await metrics.flush()
  const m = await member('dev')
  assert.equal(m.workingMs, 1000)
  assert.equal(m.waitingMs, 2000)
})

test('cost and context: last value kept when absent, unknown when never seen, a drop is a new process', async () => {
  const { f, metrics, dev, member } = await setup()
  f.emitSession({ tabId: dev, costUsd: 0.5, contextPercent: 12 })
  f.emitSession({ tabId: dev, costUsd: 0.75, contextPercent: 20 })
  // The status line went off (or the tab ended): fields absent, the last values stay.
  const s = f.sessions.get(dev)
  delete s.costUsd
  delete s.contextPercent
  f.emitSession({ tabId: dev, status: 'ended' })
  await metrics.flush()
  let m = await member('dev')
  assert.equal(m.costUsd, 0.75)
  assert.equal(m.contextPercent, 20)
  // A restored tab whose cost starts again from 0.
  f.emitSession({ tabId: dev, status: 'idle', costUsd: 0.25 })
  await metrics.flush()
  m = await member('dev')
  assert.equal(m.costUsd, 1)
  // Never seen: unknown, not 0.
  const lead = await member('lead')
  assert.equal(lead.costUsd, undefined)
  assert.equal(lead.contextPercent, undefined)
})

test('addCost ignores a non-number', () => {
  const m = {}
  assert.equal(addCost(m, undefined), false)
  assert.equal(addCost(m, -1), false)
  assert.equal(m.costUsd, undefined)
})

test('the log is paged with the seq cursor: sends, receives, doc reads and writes, hired and left', async () => {
  const { f, metrics, id, teams, member } = await setup()
  for (let i = 0; i < 2500; i++) {
    f.pushLog(id, { type: 'send', from: 'dev', to: 'lead', text: `m${i}`, delivery: [{ to: 'lead', path: i % 2 ? 'held' : 'delivered', why: 'not-waiting' }] })
  }
  f.pushLog(id, { type: 'send', from: 'lead', to: 'all', text: 'hi', delivery: [{ to: 'dev', path: 'delivered' }, { to: 'gone1', path: 'gone' }] })
  f.pushLog(id, { type: 'send', from: 'plugin', to: 'dev', text: 'x', delivery: [{ to: 'dev', path: 'refused', why: 'full' }] })
  // Main's doc entries: `{ by, path, bytes }`, `by` a member, 'plugin' or 'person' (the last two count for nobody).
  f.pushLog(id, { type: 'doc-read', by: 'dev', path: 'shared/a.md', bytes: 10 })
  f.pushLog(id, { type: 'doc-write', by: 'dev', path: 'shared/a.md', bytes: 10 })
  f.pushLog(id, { type: 'doc-write', by: 'lead', path: 'shared/b.md', bytes: 3 })
  f.pushLog(id, { type: 'doc-write', by: 'plugin', path: 'members/dev/kickoff.md', bytes: 3 })
  f.pushLog(id, { type: 'doc-read', by: 'person', path: 'shared/a.md', bytes: 10 })
  f.pushLog(id, { type: 'leave', member: 'dev', why: 'closed' })
  const calls = []
  const log = f.ctx.rooms.log
  f.ctx.rooms.log = async (rid, o) => {
    calls.push(o)
    return log(rid, o)
  }
  await metrics.poll()
  await metrics.flush()
  const dev = await member('dev')
  const lead = await member('lead')
  assert.equal(dev.sent, 2500)
  assert.equal(lead.received, 2500)
  assert.equal(lead.sent, 1)
  assert.equal(dev.received, 1) // `refused` got nothing
  assert.equal(dev.docReads, 1)
  assert.equal(dev.docWrites, 1)
  assert.equal(lead.docWrites, 1)
  assert.equal(dev.leftWhy, 'tab closed')
  assert.ok(Number.isFinite(dev.hiredAt))
  assert.equal(lead.coordinator, true)
  assert.equal(lead.leftAt, undefined)
  // Three pages of 1000 (and more), each from the last seq.
  assert.ok(calls.length >= 3)
  assert.equal(calls[1].since, calls[0].since + 1000)
  const rec = await teams.get(id)
  assert.equal(rec.metrics.logSeq, f.rooms.get(id).seq)
  // Stored, cursor included.
  assert.equal(f.store.get(`team:${id}`).metrics.logSeq, rec.metrics.logSeq)
  // A second poll reads nothing twice.
  await metrics.poll()
  assert.equal((await member('dev')).sent, 2500)
})

test('fire and end: left with why; an ended team is drained once and never polled again', async () => {
  const { f, metrics, id, dev, member } = await setup()
  await f.ctx.rooms.remove(id, 'dev')
  await metrics.poll()
  f.emitSession({ tabId: dev, status: 'working' }) // out of the room: not counted
  f.advance(1000)
  await f.ctx.rooms.end(id)
  const calls = []
  const log = f.ctx.rooms.log
  f.ctx.rooms.log = async (rid, o) => {
    calls.push(rid)
    return log(rid, o)
  }
  await metrics.poll()
  assert.equal(calls.length, 1)
  await metrics.poll()
  await metrics.poll()
  assert.equal(calls.length, 1)
  await metrics.flush()
  assert.equal((await member('dev')).leftWhy, 'fired')
  assert.equal((await member('dev')).workingMs, 0)
  const lead = await member('lead')
  assert.equal(lead.leftWhy, 'team ended')
  assert.equal(lead.leftAt, f.rooms.get(id).endedAt)
  assert.equal(f.store.get(`team:${id}`).metrics.logDone, true)
})

test('an ended team with a backlog longer than one poll is drained over several polls, up to its end entry', async () => {
  const { f, metrics, id, member } = await setup()
  for (let i = 0; i < 50_000; i++) f.pushLog(id, { type: 'pause' })
  await f.ctx.rooms.end(id) // its sessions event polls at once, and poll() asks for one more: 2 x 20 pages
  await metrics.poll() // the end entry is not read yet
  await metrics.flush()
  assert.equal((await member('lead')).leftWhy, undefined)
  assert.notEqual(f.store.get(`team:${id}`).metrics.logDone, true)
  await metrics.poll() // the rest, then never again
  await metrics.flush()
  assert.equal((await member('lead')).leftWhy, 'team ended')
  assert.equal(f.store.get(`team:${id}`).metrics.logDone, true)
})

test('a held-badge click (a send with no delivery) is not a received message', async () => {
  const { f, metrics, id, dev, member } = await setup()
  f.emitSession({ tabId: dev, status: 'working' })
  await f.ctx.rooms.send(id, 'dev', 'hello') // held: not waiting
  f.emitSession({ tabId: dev, status: 'waiting' })
  assert.equal(f.badgeClick(id, 'dev'), true)
  f.emitSession({ tabId: dev, status: 'working' })
  assert.equal(f.badgeClick(id, 'dev'), false) // a click that pasted nothing is logged too
  await metrics.poll()
  await metrics.flush()
  assert.equal((await member('dev')).received, 1)
  assert.equal(f.rooms.get(id).log.filter((e) => e.via === 'badge').length, 2)
})

test('the plugin\'s own doc reads and writes (logged by: plugin) count for no member', async () => {
  const { f, metrics, id, member } = await setup()
  await f.ctx.rooms.docs.put(id, 'shared/plan.md', '# plan\n')
  await f.ctx.rooms.docs.get(id, 'shared/plan.md')
  assert.deepEqual(f.rooms.get(id).log.filter((e) => e.type.startsWith('doc-')).map((e) => e.by), ['plugin', 'plugin'])
  await metrics.poll()
  await metrics.flush()
  for (const name of ['lead', 'dev']) {
    const m = await member(name)
    assert.equal(m.docReads, 0)
    assert.equal(m.docWrites, 0)
  }
})

test('time after the room ended is not counted, even before the poll sees the end', async () => {
  const { f, metrics, id, dev, member } = await setup()
  f.emitSession({ tabId: dev, status: 'working' })
  f.advance(1000)
  await f.ctx.rooms.end(id) // the tabs' SessionInfo.room goes; the poll runs later
  f.advance(4000)
  f.emitSession({ tabId: dev, status: 'waiting' })
  f.advance(1000)
  await metrics.flush()
  await metrics.poll()
  await metrics.flush()
  const m = await member('dev')
  assert.equal(m.workingMs, 1000)
  assert.equal(m.waitingMs, 0)
})

test('cost: a new tab for the same name is a new process even when its cost is already past the old one', async () => {
  const { f, metrics, make, id, dev, member } = await setup()
  f.emitSession({ tabId: dev, costUsd: 0.5 })
  await f.ctx.rooms.remove(id, 'dev')
  const dev2 = (await f.ctx.rooms.open(id, { name: 'dev' })).tabId
  await metrics.poll()
  f.emitSession({ tabId: dev2, costUsd: 0.8 }) // first seen already past 0.5
  await metrics.flush()
  assert.equal((await member('dev')).costUsd, 1.3)
  // A plugin reload keeps the tab: the same process, only the growth counts.
  await metrics.stop()
  const metrics2 = make()
  await metrics2.start()
  f.emitSession({ tabId: dev2, costUsd: 0.9 })
  await metrics2.flush()
  assert.equal(Math.round((await member('dev')).costUsd * 100) / 100, 1.4)
  await metrics2.stop()
})

test('stop waits for a poll in flight and saves what it counted', async () => {
  const { f, metrics, id } = await setup()
  await metrics.flush()
  f.pushLog(id, { type: 'send', from: 'dev', to: 'lead', text: 'a', delivery: [{ to: 'lead', path: 'delivered' }] })
  let release
  const gate = new Promise((r) => (release = r))
  const members = f.ctx.rooms.members
  f.ctx.rooms.members = async (rid) => {
    await gate
    return members(rid)
  }
  const polled = metrics.poll()
  await settle()
  let stopped = false
  const stopping = metrics.stop().then(() => (stopped = true))
  await settle()
  assert.equal(stopped, false)
  release()
  await stopping
  await polled
  assert.equal(f.store.get(`team:${id}`).metrics.members.dev.sent, 1)
  assert.equal(f.store.get(`team:${id}`).metrics.members.lead.received, 1)
})

test('a throttled save in flight, a status event meanwhile, then stop: nothing lost, stop waits for the save', async () => {
  const { f, metrics, timers, id, dev } = await setup()
  await metrics.flush()
  f.emitSession({ tabId: dev, status: 'working' })
  f.advance(1000)
  f.emitSession({ tabId: dev, status: 'working', costUsd: 0.1 }) // arms the save
  assert.equal(timers.list.length, 1)
  let release
  let gate = new Promise((r) => (release = r))
  const set = f.ctx.storage.set
  f.ctx.storage.set = async (k, v) => {
    await gate
    return set(k, v)
  }
  const firing = timers.fire() // the save credits 1000 working and blocks on the write
  await settle()
  f.advance(500)
  f.emitSession({ tabId: dev, status: 'waiting' }) // 500 more working, a new save armed
  assert.equal(timers.list.length, 1)
  let stopped = false
  const stopping = metrics.stop().then(() => (stopped = true))
  await settle()
  assert.equal(stopped, false) // waiting for the save in flight
  release()
  gate = Promise.resolve()
  await firing
  await stopping
  const m = f.store.get(`team:${id}`).metrics.members.dev
  assert.equal(m.workingMs, 1500)
  assert.equal(m.costUsd, 0.1)
})

test('restart: counts and the cursor resume from storage; the quit gap is not time', async () => {
  const { f, metrics, make, id, dev, member } = await setup()
  f.pushLog(id, { type: 'send', from: 'dev', to: 'lead', text: 'a', delivery: [{ to: 'lead', path: 'delivered' }] })
  f.emitSession({ tabId: dev, status: 'working' })
  f.advance(2000)
  await metrics.poll()
  await metrics.stop() // deactivate: the running interval is saved
  f.advance(3_600_000) // the app was quit for an hour
  const teams2 = createTeams(f.ctx)
  const metrics2 = make(teams2)
  await metrics2.start()
  f.advance(1000)
  f.emitSession({ tabId: dev, status: 'idle' })
  await metrics2.poll()
  await metrics2.flush()
  const m = await member('dev', teams2)
  assert.equal(m.sent, 1)
  assert.equal(m.workingMs, 3000)
  await metrics2.stop()
})

test('saves are throttled: many status events, one write per team', async () => {
  const { f, metrics, timers, dev } = await setup()
  await metrics.flush()
  let writes = 0
  const set = f.ctx.storage.set
  f.ctx.storage.set = async (k, v) => {
    writes++
    return set(k, v)
  }
  for (let i = 0; i < 20; i++) {
    f.advance(100)
    f.emitSession({ tabId: dev, status: i % 2 ? 'working' : 'waiting', costUsd: i / 10 })
  }
  assert.equal(writes, 0)
  assert.equal(timers.list.length, 1)
  assert.equal(timers.list[0].ms, SAVE_MS)
  await timers.fire()
  assert.equal(writes, 1)
})

test('a long unchanged stretch is checkpointed by the poll', async () => {
  const { f, metrics, timers, dev, member } = await setup()
  f.emitSession({ tabId: dev, status: 'working' })
  f.advance(CHECKPOINT_MS)
  await metrics.poll()
  await timers.fire()
  assert.equal((await member('dev')).workingMs, CHECKPOINT_MS)
})

test('the poll runs every 5 s and at once when a tab joins or gets a message', async () => {
  const { f, metrics, id, dev, member } = await setup()
  assert.equal(f.schedules.length, 1)
  assert.equal(f.schedules[0].seconds, POLL_SECONDS)
  let polls = 0
  const log = f.ctx.rooms.log
  f.ctx.rooms.log = async (rid, o) => {
    polls++
    return log(rid, o)
  }
  await f.schedules[0].fn()
  assert.equal(polls, 1)
  // A message changes the recipient's held count.
  await f.ctx.rooms.send(id, 'dev', 'hello')
  await settle()
  assert.equal(polls, 2)
  // A status change alone does not poll.
  f.emitSession({ tabId: dev, status: 'working' })
  await settle()
  assert.equal(polls, 2)
  // A new member joins: polled, and its tab is known for time at once.
  const qa = (await f.ctx.rooms.open(id, { name: 'qa' })).tabId
  await settle()
  assert.equal(polls, 3)
  f.emitSession({ tabId: qa, status: 'working' })
  f.advance(700)
  f.emitSession({ tabId: qa, status: 'waiting' })
  await metrics.flush()
  assert.equal((await member('qa')).workingMs, 700)
})

test('hire records the model and effort; a hire with none clears them', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-metrics-')))
  try {
    fs.writeFileSync(path.join(dir, 'k.md'), '# qa\n')
    const { f, teams, metrics, id, lead, member } = await setup({ projectDir: dir })
    const handler = createCommands(f.ctx, teams, createQuestions(f.ctx, teams), metrics)
    const call = { tabId: lead, cwd: dir, signal: new AbortController().signal, stdin: '' }
    let r = await handler(['hire', 'qa', '--kickoff', 'k.md', '--model', 'opus', '--effort', 'high'], call)
    assert.equal(r.code, undefined, r.stderr)
    let qa = await member('qa')
    assert.equal(qa.model, 'opus')
    assert.equal(qa.effort, 'high')
    await f.ctx.rooms.remove(id, 'qa')
    r = await handler(['hire', 'qa', '--kickoff', 'k.md'], call)
    assert.equal(r.code, undefined, r.stderr)
    qa = await member('qa')
    assert.equal(qa.model, undefined)
    assert.equal(qa.effort, undefined)
    await metrics.poll()
    qa = await member('qa')
    assert.equal(qa.leftAt, undefined) // hired again after the fire
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a failing metrics call never fails the hire', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-metrics-')))
  try {
    fs.writeFileSync(path.join(dir, 'k.md'), '# qa\n')
    const { f, teams, lead } = await setup({ projectDir: dir })
    const broken = { hired: async () => { throw new Error('boom') } }
    const handler = createCommands(f.ctx, teams, createQuestions(f.ctx, teams), broken)
    const r = await handler(['hire', 'qa', '--kickoff', 'k.md'], { tabId: lead, cwd: dir })
    assert.equal(r.code, undefined, r.stderr)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a log failure is logged and the poll goes on; a deleted team is forgotten', async () => {
  const { f, metrics, id } = await setup()
  const warned = []
  f.ctx.log.warn = (m) => warned.push(m)
  const log = f.ctx.rooms.log
  f.ctx.rooms.log = async () => {
    throw new Error('rooms.log: boom')
  }
  await metrics.poll()
  assert.match(warned.join('\n'), /boom/)
  f.ctx.rooms.log = log
  await f.ctx.rooms.end(id)
  await metrics.poll()
  await f.ctx.rooms.delete(id)
  await metrics.poll()
  await metrics.flush() // nothing left to save, no throw
})
