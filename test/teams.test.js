'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { fakeCtx } = require('./fake-ctx')
const { createTeams, createTeamGuard, createNameLocks, EXPORTING, STARTING, TeamError, NOT_IN_TEAM, NOT_COORDINATOR, KEY_PREFIX } = require('../lib/teams.js')

/** A room of this plugin with a coordinator `lead` and a member `dev`, each in its own tab, and its record. */
async function setup(opts) {
  const f = fakeCtx(opts)
  const teams = createTeams(f.ctx)
  const { id } = await f.ctx.rooms.create({ title: 'Build it' })
  await teams.add((await f.ctx.rooms.list()).find((r) => r.id === id))
  const lead = (await f.ctx.rooms.open(id, { name: 'lead', coordinator: true })).tabId
  const dev = (await f.ctx.rooms.open(id, { name: 'dev' })).tabId
  return { f, teams, id, lead, dev }
}

test('teamOfTab finds the team, the member and the member list', async () => {
  const { teams, id, lead, dev } = await setup()
  const a = await teams.teamOfTab(lead)
  assert.equal(a.team.roomId, id)
  assert.equal(a.team.title, 'Build it')
  assert.equal(a.member.name, 'lead')
  assert.equal(a.member.coordinator, true)
  assert.deepEqual(a.members.map((m) => m.name).sort(), ['dev', 'lead'])
  const b = await teams.teamOfTab(dev)
  assert.equal(b.member.name, 'dev')
  assert.equal(b.member.coordinator, false)
})

test('teamOfTab picks the right one of two teams', async () => {
  const { f, teams, id } = await setup()
  const { id: id2 } = await f.ctx.rooms.create({ title: 'Other' })
  await teams.add((await f.ctx.rooms.list()).find((r) => r.id === id2))
  const t = (await f.ctx.rooms.open(id2, { name: 'qa' })).tabId
  assert.equal((await teams.teamOfTab(t)).team.roomId, id2)
  assert.notEqual(id, id2)
})

test('coordinator, member and outsider', async () => {
  const { f, teams, lead, dev } = await setup()
  assert.equal((await teams.requireCoordinator({ tabId: lead })).member.name, 'lead')
  assert.equal((await teams.requireMember({ tabId: dev })).member.name, 'dev')
  await assert.rejects(teams.requireCoordinator({ tabId: dev }), (e) => e instanceof TeamError && e.code === 'not-coordinator' && e.message === NOT_COORDINATOR)
  // An outsider tab: open in the window, in no room.
  const outsider = (await f.ctx.sessions.open({})).tabId
  await assert.rejects(teams.requireMember({ tabId: outsider }), (e) => e.code === 'not-in-team')
  await assert.rejects(teams.requireCoordinator({ tabId: outsider }), (e) => e.code === 'not-in-team')
})

test('unknown tab, no tab, a foreign id and a tab in another plugin’s room all answer the same text', async () => {
  const { f, teams } = await setup()
  // A tab in another plugin's room: ctx.rooms never lists that room, so to this plugin it is a tab in no room.
  // The fake models it as a tab with SessionInfo.room set but in none of our rooms.
  f.emitSession({ tabId: 'other-plugin-tab', status: 'waiting', room: { title: 'Theirs', name: 'x', coordinator: true } })
  const texts = new Set()
  for (const call of [{}, { tabId: 'tab999' }, { tabId: 'other-plugin-tab' }, { tabId: 'win2:tab1' }, { tabId: '' }, undefined]) {
    await assert.rejects(teams.requireCoordinator(call), (e) => {
      texts.add(e.message)
      return e instanceof TeamError && e.code === 'not-in-team'
    })
  }
  assert.deepEqual([...texts], [NOT_IN_TEAM])
})

test('a member of an ended team and a fired member are outsiders', async () => {
  const { f, teams, id, lead, dev } = await setup()
  await f.ctx.rooms.remove(id, 'dev')
  assert.equal(await teams.teamOfTab(dev), null)
  await f.ctx.rooms.end(id)
  assert.equal(await teams.teamOfTab(lead), null)
})

test('records survive a restart: save, then load in a new store over the same storage', async () => {
  const { f, teams, id } = await setup()
  const rec = await teams.get(id)
  rec.marks.push({ at: 1, label: 'plan done', by: 'lead' })
  rec.exportDir = '/out'
  await teams.save(rec)
  const again = createTeams(f.ctx)
  const back = await again.get(id)
  assert.deepEqual(back.marks, [{ at: 1, label: 'plan done', by: 'lead' }])
  assert.equal(back.exportDir, '/out')
  assert.deepEqual(back.metrics, { members: {}, logSeq: 0 })
  assert.ok(f.store.has(KEY_PREFIX + id))
})

test('save refuses a record that is not the store’s own', async () => {
  const { teams, id } = await setup()
  const copy = structuredClone(await teams.get(id))
  await assert.rejects(teams.save(copy), /no record/)
  await assert.rejects(teams.save({ roomId: 'nope' }), /no record/)
})

test('a record whose room is gone is dropped on load, its key deleted', async () => {
  const { f, id } = await setup()
  f.store.set(KEY_PREFIX + 'room-gone', { roomId: 'room-gone', title: 'Old', createdAt: 1, marks: [], questions: [], metrics: { members: {}, logSeq: 0 } })
  const teams = createTeams(f.ctx)
  const list = await teams.list()
  assert.deepEqual(list.map((r) => r.roomId), [id])
  assert.equal(f.store.has(KEY_PREFIX + 'room-gone'), false)
})

test('a room deleted after load is dropped on the next refresh', async () => {
  const { f, teams, id } = await setup()
  await teams.load()
  await f.ctx.rooms.end(id)
  await f.ctx.rooms.delete(id)
  await teams.refresh()
  assert.equal(await teams.get(id), undefined)
  assert.equal(f.store.has(KEY_PREFIX + id), false)
})

test('an ended room marks its record ended, kept and saved', async () => {
  const { f, teams, id } = await setup()
  await teams.load()
  f.advance(5000)
  await f.ctx.rooms.end(id)
  await teams.refresh()
  const rec = await teams.get(id)
  assert.equal(rec.endedAt, (await f.ctx.rooms.list())[0].endedAt)
  assert.equal(f.store.get(KEY_PREFIX + id).endedAt, rec.endedAt)
})

test('a room of ours with no record gets a fresh one', async () => {
  const f = fakeCtx()
  const { id } = await f.ctx.rooms.create({ title: 'Lost record' })
  const teams = createTeams(f.ctx)
  const rec = await teams.get(id)
  assert.equal(rec.title, 'Lost record')
  assert.deepEqual(rec.questions, [])
  assert.ok(f.store.has(KEY_PREFIX + id))
})

test('a broken stored value is dropped; other plugin keys are left alone', async () => {
  const { f, id } = await setup()
  f.store.set(KEY_PREFIX + 'x', 'not a record')
  f.store.set(KEY_PREFIX + 'y', { roomId: 'z' }) // key and id disagree
  f.store.set('settings-cache', { keep: true })
  const teams = createTeams(f.ctx)
  assert.deepEqual((await teams.list()).map((r) => r.roomId), [id])
  assert.equal(f.store.has(KEY_PREFIX + 'x'), false)
  assert.equal(f.store.has(KEY_PREFIX + 'y'), false)
  assert.deepEqual(f.store.get('settings-cache'), { keep: true })
})

test('missing fields of a stored record are filled, not trusted', async () => {
  const f = fakeCtx()
  const { id } = await f.ctx.rooms.create({ title: 'T' })
  f.store.set(KEY_PREFIX + id, { roomId: id, title: 'T', createdAt: 1, marks: 'bad', metrics: { logSeq: -3 } })
  const rec = await createTeams(f.ctx).get(id)
  assert.deepEqual(rec.marks, [])
  assert.deepEqual(rec.questions, [])
  assert.deepEqual(rec.metrics, { logSeq: 0, members: {} })
})

test('remove forgets the record and its key', async () => {
  const { f, teams, id } = await setup()
  await teams.remove(id)
  assert.equal(await teams.get(id), undefined)
  assert.equal(f.store.has(KEY_PREFIX + id), false)
})

/** Hold `rooms.list` until `release()`; resolves with the list as asked for at call time (a stale answer). */
function holdList(f) {
  const realList = f.ctx.rooms.list
  let release
  const gate = new Promise((r) => (release = r))
  f.ctx.rooms.list = async () => {
    const stale = await realList()
    await gate
    f.ctx.rooms.list = realList
    return stale
  }
  return { release, tick: () => new Promise((r) => setImmediate(r)) }
}

test('a team added while a refresh is in flight is not dropped', async () => {
  const f = fakeCtx()
  const teams = createTeams(f.ctx)
  await teams.load()
  const h = holdList(f)
  const refreshing = teams.refresh()
  await h.tick()
  const { id } = await f.ctx.rooms.create({ title: 'Racing' })
  const adding = teams.add({ id })
  h.release()
  await Promise.all([refreshing, adding])
  assert.equal((await teams.get(id)).title, 'Racing')
})

test('a team removed while a refresh is in flight is not brought back', async () => {
  const { f, teams, id } = await setup()
  await teams.load()
  await f.ctx.rooms.end(id)
  const h = holdList(f) // answers with the ended room
  const refreshing = teams.refresh()
  await h.tick()
  await f.ctx.rooms.delete(id)
  const removing = teams.remove(id)
  h.release()
  await Promise.all([refreshing, removing])
  assert.equal(await teams.get(id), undefined)
  assert.equal(f.store.has(KEY_PREFIX + id), false)
})

test('add after a reconcile adopted the room answers the adopted record', async () => {
  const f = fakeCtx()
  const teams = createTeams(f.ctx)
  await teams.load()
  const { id } = await f.ctx.rooms.create({ title: 'Adopted' })
  await teams.refresh() // another tab's command adopts it first
  const adopted = await teams.get(id)
  const rec = await teams.add({ id })
  assert.equal(rec, adopted)
  rec.marks.push({ at: 1, label: 'x', by: 'lead' })
  await teams.save(adopted)
})

test('add with a bare { id } (what rooms.create answers) takes title and createdAt from Rooms', async () => {
  const f = fakeCtx()
  const teams = createTeams(f.ctx)
  const created = await f.ctx.rooms.create({ title: 'Bare' })
  const rec = await teams.add(created)
  assert.equal(rec.title, 'Bare')
  assert.equal(typeof rec.createdAt, 'number')
  await assert.rejects(teams.add({ id: 'room-nope' }), /no such room/)
})

test('a stored endedAt: null does not end a live team; createdAt and title are repaired from Rooms', async () => {
  const { f, id, lead } = await setup()
  f.store.set(KEY_PREFIX + id, { roomId: id, endedAt: null, marks: [], questions: [], metrics: { members: [], logSeq: 0 } })
  const teams = createTeams(f.ctx)
  const rec = await teams.get(id)
  assert.equal(rec.endedAt, undefined)
  assert.equal(rec.title, 'Build it')
  assert.equal(typeof rec.createdAt, 'number')
  assert.ok(!Array.isArray(rec.metrics.members))
  assert.equal((await teams.requireCoordinator({ tabId: lead })).member.name, 'lead')
})

test('a storage failure does not hold Rooms\' state back: memory ends the team at once, the write is retried', async () => {
  const { f, teams, id } = await setup()
  await teams.load()
  f.advance(1000)
  await f.ctx.rooms.end(id)
  const realSet = f.ctx.storage.set
  f.ctx.storage.set = async () => {
    throw new RangeError('value too large')
  }
  const told = []
  teams.onChange((roomId) => told.push(roomId))
  await teams.refresh() // does not throw
  // Round 8: the record stayed live while storage was full, and Delete refused it for as long.
  const roomEnded = f.rooms.get(id).endedAt
  assert.equal((await teams.get(id)).endedAt, roomEnded, 'memory takes Rooms\' endedAt')
  assert.ok(told.includes(id), 'the panel is told')
  assert.equal(f.store.get(KEY_PREFIX + id).endedAt, undefined, 'not stored yet')
  await teams.refresh() // still failing: still ended, still not stored
  assert.equal((await teams.get(id)).endedAt, roomEnded)
  f.ctx.storage.set = realSet
  await teams.refresh()
  assert.equal(f.store.get(KEY_PREFIX + id).endedAt, roomEnded, 'written by the next reconcile')
})

test('a failed save is written again by the next reconcile (memory is the truth)', async () => {
  const { f, teams, id } = await setup()
  const rec = await teams.get(id)
  rec.marks.push({ at: 1, label: 'x' })
  const realSet = f.ctx.storage.set
  f.ctx.storage.set = async () => {
    throw new RangeError('storage would exceed')
  }
  await assert.rejects(teams.save(rec), /would exceed/)
  f.ctx.storage.set = realSet
  await teams.refresh()
  assert.equal(f.store.get(KEY_PREFIX + id).marks.length, 1)
})

test('a fresh record of an adopted room is in memory even when its first write fails', async () => {
  const f = fakeCtx()
  const { id } = await f.ctx.rooms.create({ title: 'Adopted' })
  const teams = createTeams(f.ctx)
  const realSet = f.ctx.storage.set
  f.ctx.storage.set = async () => {
    throw new RangeError('full')
  }
  await teams.load()
  assert.equal((await teams.get(id)).title, 'Adopted')
  assert.equal(f.store.has(KEY_PREFIX + id), false)
  f.ctx.storage.set = realSet
  await teams.refresh()
  assert.equal(f.store.get(KEY_PREFIX + id).title, 'Adopted')
})

test('ended: a provisional end in memory when no refresh could bring Rooms\' time; the next reconcile puts Rooms\' in', async () => {
  const { f, teams, id } = await setup()
  await teams.load()
  f.advance(5000)
  await f.ctx.rooms.end(id)
  await teams.ended(id, 42)
  assert.equal((await teams.get(id)).endedAt, 42)
  assert.equal(f.store.get(KEY_PREFIX + id).endedAt, 42)
  await teams.refresh()
  assert.equal((await teams.get(id)).endedAt, f.rooms.get(id).endedAt)
  assert.equal(f.store.get(KEY_PREFIX + id).endedAt, f.rooms.get(id).endedAt)
  // An ended record is left as it is.
  await teams.ended(id, 7)
  assert.equal((await teams.get(id)).endedAt, f.rooms.get(id).endedAt)
})

test('guard.live: refuses a team that is gone, replaced or ended; answers the record otherwise', async () => {
  const { f, teams, id } = await setup()
  const rec = await teams.get(id)
  assert.equal(teams.guard.live(id, rec), rec)
  assert.equal(teams.guard.live(id), rec)
  assert.throws(() => teams.guard.live('nope'), (e) => e instanceof TeamError && e.code === 'no-team')
  assert.throws(() => teams.guard.live(id, { ...rec }), (e) => e.code === 'no-team')
  await f.ctx.rooms.end(id)
  await teams.guard.refresh()
  assert.throws(() => teams.guard.live(id, rec), (e) => e.code === 'ended' && e.message === 'the team has ended')
  // A guard built alone checks nothing.
  assert.equal(createTeamGuard().live('any', rec), rec)
})

test('a caller with no tab never matches a member that has none', async () => {
  const { f, teams, id } = await setup()
  // A member after a quit, before the restore: no tabId.
  const realMembers = f.ctx.rooms.members
  f.ctx.rooms.members = async (rid) => [...(await realMembers(rid)), { name: 'ghost', coordinator: true, held: false }]
  for (const call of [{}, undefined, { tabId: '' }]) {
    await assert.rejects(teams.requireCoordinator(call), (e) => e.code === 'not-in-team')
  }
  assert.ok(id)
})

test('teamOfTab goes on to the next room when members says the room is gone', async () => {
  const { f, teams, id } = await setup()
  const { id: id2 } = await f.ctx.rooms.create({ title: 'Second' })
  await teams.add({ id: id2 })
  const t = (await f.ctx.rooms.open(id2, { name: 'qa' })).tabId
  const realMembers = f.ctx.rooms.members
  f.ctx.rooms.members = async (rid) => {
    if (rid === id) throw new Error('rooms.members: no such room')
    return realMembers(rid)
  }
  assert.equal((await teams.teamOfTab(t)).team.roomId, id2)
})

test('teamOfTab does not turn a transient members failure into "not in a team"', async () => {
  const { f, teams, lead } = await setup()
  f.ctx.rooms.members = async () => {
    throw new Error('rpc timeout')
  }
  await assert.rejects(teams.requireCoordinator({ tabId: lead }), /rpc timeout/)
})

test('refresh while the first load is in flight waits for it; after a failed load it loads again', async () => {
  const { f, id } = await setup()
  const teams = createTeams(f.ctx)
  const loading = teams.load()
  await teams.refresh()
  await loading
  assert.equal((await teams.get(id)).title, 'Build it')

  const g = fakeCtx()
  const created = await g.ctx.rooms.create({ title: 'T' })
  const realList = g.ctx.rooms.list
  g.ctx.rooms.list = async () => {
    throw new Error('boom')
  }
  const again = createTeams(g.ctx)
  await assert.rejects(again.refresh(), /boom/)
  g.ctx.rooms.list = realList
  await again.refresh()
  assert.equal((await again.get(created.id)).title, 'T')
})

test('a failed load is retried by the next call', async () => {
  const f = fakeCtx()
  const { id } = await f.ctx.rooms.create({ title: 'T' })
  const realList = f.ctx.rooms.list
  f.ctx.rooms.list = async () => {
    throw new Error('rooms.list: boom')
  }
  const teams = createTeams(f.ctx)
  await assert.rejects(teams.load(), /boom/)
  f.ctx.rooms.list = realList
  assert.equal((await teams.get(id)).title, 'T')
})

test('a gone room leaves memory at once; a failed key delete is logged and retried by the next refresh', async () => {
  const { f, teams, id } = await setup()
  await teams.load()
  await f.ctx.rooms.end(id)
  await f.ctx.rooms.delete(id)
  const warned = []
  f.ctx.log.warn = (m) => warned.push(m)
  const del = f.ctx.storage.delete
  f.ctx.storage.delete = async () => {
    throw new Error('disk busy')
  }
  await teams.refresh()
  assert.match(warned.join('\n'), /drop/)
  assert.equal(await teams.get(id), undefined, 'gone from memory with its room')
  assert.equal(f.store.has(KEY_PREFIX + id), true, 'the key is still stored')
  f.ctx.storage.delete = del
  await teams.refresh()
  assert.equal(f.store.has(KEY_PREFIX + id), false)
})

test('remove forgets the record in memory even when the key delete fails; the next refresh deletes the key', async () => {
  const { f, teams, id } = await setup()
  await f.ctx.rooms.end(id)
  await f.ctx.rooms.delete(id)
  const del = f.ctx.storage.delete
  f.ctx.storage.delete = async () => {
    throw new Error('disk busy')
  }
  await teams.remove(id) // does not throw: the room is gone
  assert.equal(await teams.get(id), undefined)
  f.ctx.storage.delete = del
  await teams.refresh()
  assert.equal(f.store.has(KEY_PREFIX + id), false)
})

test('export guard: a change is refused while its team is held, waited for when it started first, free again after', async () => {
  const g = createTeamGuard()
  let finish
  const running = g.change('r1', () => new Promise((r) => (finish = r)))
  const order = []
  let refused = null
  const held = g.exclusive('r1', async (settled) => {
    // Held at once: a new change of r1 is refused, another team's is not.
    refused = await g.change('r1', async () => 'no').catch((e) => e)
    assert.equal(await g.change('r2', async () => 'other'), 'other')
    assert.equal(g.exporting('r1'), true)
    const waited = settled().then(() => order.push('settled'))
    await new Promise((r) => setImmediate(r))
    order.push('finish')
    finish('first')
    await waited
    // A second exclusive hold of the same team is refused.
    await assert.rejects(g.exclusive('r1', async () => {}), /already being ended/)
    throw new Error('export failed')
  })
  assert.equal(await running, 'first')
  await assert.rejects(held, /export failed/)
  assert.ok(refused instanceof TeamError)
  assert.equal(refused.code, 'exporting')
  assert.equal(refused.message, EXPORTING)
  assert.deepEqual(order, ['finish', 'settled'])
  // The hold ended with its failure: changes run again; nothing running settles at once.
  assert.equal(g.exporting('r1'), false)
  assert.equal(await g.change('r1', async () => 'again'), 'again')
  assert.equal(await g.exclusive('r1', (settled) => settled().then(() => 'idle')), 'idle')
})

test('setup guard: a team being set up refuses every change but its own and an End; free again after a failure', async () => {
  const g = createTeamGuard()
  let own = null
  const run = g.setup('r1', async (token) => {
    own = token
    assert.equal(g.starting('r1'), true)
    const other = await g.change('r1', async () => 'no').catch((e) => e)
    assert.ok(other instanceof TeamError)
    assert.equal(other.code, 'starting')
    assert.equal(other.message, STARTING)
    // A token of another room or a forged one is not this setup's.
    await assert.rejects(g.change('r1', async () => 'no', { roomId: 'r1' }), /still being set up/)
    assert.equal(await g.change('r1', async () => 'mine', token), 'mine')
    assert.equal(await g.change('r2', async () => 'other team'), 'other team')
    await assert.rejects(g.exclusive('r1', async () => {}), /still being set up/)
    throw new Error('invite failed')
  })
  await assert.rejects(run, /invite failed/)
  assert.ok(own)
  assert.equal(g.starting('r1'), false)
  assert.equal(await g.change('r1', async () => 'free'), 'free')
  assert.equal(await g.exclusive('r1', (settled) => settled().then(() => 'idle')), 'idle')
})

test('every teams instance has its own export guard', () => {
  const f = fakeCtx()
  const a = createTeams(f.ctx)
  assert.equal(typeof a.guard.change, 'function')
  assert.notEqual(a.guard, createTeams(f.ctx).guard)
})

test('name locks: reply, ask and mark of one name run together; hire and fire are alone and refuse them (and are refused)', async () => {
  const names = createNameLocks()
  let release
  const gate = new Promise((r) => (release = r))
  const kinds = ['reply', 'ask', 'mark']
  const running = kinds.map((k) => names.hold('r1', 'dev', k, () => gate))
  // Every member-stays kind may join the others; a hire or a fire is refused while any of them holds the name.
  for (const k of kinds) assert.equal(await names.hold('r1', 'dev', k, async () => k), k)
  await assert.rejects(names.hold('r1', 'dev', 'fire', async () => 1), (e) => e instanceof TeamError && /-pending$/.test(e.code) && /try again in a moment/.test(e.message))
  await assert.rejects(names.hold('r1', 'dev', 'hire', async () => 1), /try again in a moment/)
  // Another name, or the same name in another room, is free.
  assert.equal(await names.hold('r1', 'qa', 'fire', async () => 'ok'), 'ok')
  assert.equal(await names.hold('r2', 'dev', 'fire', async () => 'ok'), 'ok')
  release()
  await Promise.all(running)
  // Released: a fire holds it now, and refuses an ask and a mark in its own words.
  let free
  const fire = names.hold('r1', 'dev', 'fire', () => new Promise((r) => (free = r)))
  await assert.rejects(names.hold('r1', 'dev', 'ask', async () => 1), (e) => e.code === 'fire-pending' && e.message === 'dev is being fired: try again in a moment')
  await assert.rejects(names.hold('r1', 'dev', 'mark', async () => 1), (e) => e.code === 'fire-pending')
  await assert.rejects(names.hold('r1', 'dev', 'fire', async () => 1), (e) => e.message === 'dev is already being fired')
  free()
  await fire
  // An ask's own text, for a hire refused by it.
  let done
  const ask = names.hold('r1', 'dev', 'ask', () => new Promise((r) => (done = r)))
  await assert.rejects(names.hold('r1', 'dev', 'hire', async () => 1), (e) => e.code === 'ask-pending' && e.message === 'dev is asking a question: try again in a moment')
  done()
  await ask
  await assert.rejects(names.hold('r1', 'dev', 'bogus', async () => 1), TypeError)
})
