'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { fakeCtx } = require('./fake-ctx')
const { createTeams, TeamError, NOT_IN_TEAM, NOT_COORDINATOR, KEY_PREFIX } = require('../lib/teams.js')

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

test('a storage failure on one record does not fail the reconcile and is retried', async () => {
  const { f, teams, id } = await setup()
  await teams.load()
  f.advance(1000)
  await f.ctx.rooms.end(id)
  const realSet = f.ctx.storage.set
  f.ctx.storage.set = async () => {
    throw new RangeError('value too large')
  }
  await teams.refresh() // does not throw
  assert.equal((await teams.get(id)).endedAt, undefined, 'memory does not look done')
  f.ctx.storage.set = realSet
  await teams.refresh()
  assert.equal((await teams.get(id)).endedAt, f.store.get(KEY_PREFIX + id).endedAt)
  assert.notEqual(f.store.get(KEY_PREFIX + id).endedAt, undefined)
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

test('a failed delete of a gone room\'s record is logged and retried: the next refresh drops it', async () => {
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
  assert.ok(await teams.get(id), 'kept while its key could not be deleted')
  f.ctx.storage.delete = del
  await teams.refresh()
  assert.equal(await teams.get(id), undefined)
  assert.equal(f.store.has(KEY_PREFIX + id), false)
})
