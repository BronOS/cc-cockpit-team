'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const host = require('../dist/host.js')
const { fakeCtx } = require('./fake-ctx')
const { createTeams } = require('../lib/teams.js')
const { createQuestions, replyPrefix } = require('../lib/questions.js')
const { createMetrics } = require('../lib/metrics.js')
const { createEnding } = require('../lib/export.js')
const { createHiring } = require('../lib/commands.js')
const { createPanel, cleanEntry, entryHasMember, statusOf, PUSH_MS, VIEWS_MAX, VIEW_TTL_MS, ACTIVITY_PAGE, FIELD_TEXT_MAX } = require('../lib/panel.js')

const dirs = []
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})
test.afterEach(() => host.deactivate())

function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-panel-')))
  dirs.push(d)
  return d
}

/** Timers the test fires by hand. */
function fakeTimers() {
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
  }
}

const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r))
}

/**
 * The host's set of instances built by hand (so the timers are the test's), and the panel on them. A project folder
 * with two kickoff files.
 */
function setup(opts = {}) {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'lead.md'), '# You lead\n')
  fs.writeFileSync(path.join(dir, 'dev.md'), '# You are dev\n')
  const f = fakeCtx({ projectDir: dir, ...opts })
  const now = () => f.clock.t
  const mt = fakeTimers()
  const pt = fakeTimers()
  const teams = createTeams(f.ctx)
  const questions = createQuestions(f.ctx, teams)
  const metrics = createMetrics(f.ctx, teams, { now, setTimeout: mt.setTimeout, clearTimeout: mt.clearTimeout })
  const ending = createEnding(f.ctx, teams, metrics, { now })
  const hiring = createHiring(f.ctx, metrics)
  const inst = { teams, questions, metrics, ending, hiring }
  const panel = createPanel(f.ctx, inst, { now, setTimeout: pt.setTimeout, clearTimeout: pt.clearTimeout })
  panel.start()
  /** Fire the panel's pending push timer(s) and let the push finish. */
  async function fire() {
    for (const t of pt.list.splice(0)) t.fn()
    await settle()
  }
  return { f, dir, inst, panel, timers: pt, metricTimers: mt, fire }
}

/** Every post of `type` to `view`, oldest first. */
const postsOf = (f, type, view = 'desktop') => f.posts.filter(([p, m, o]) => p === 'team' && m.type === type && o && o.view === view).map(([, m]) => m)

/** Run one page message and answer its one `result` for that view. */
async function act(f, message, view = 'desktop') {
  const before = f.posts.length
  await f.page(message, view)
  const results = f.posts.slice(before).filter(([, m, o]) => m.type === 'result' && o && o.view === view)
  assert.equal(results.length, 1, `one result for ${message.type}`)
  return results[0][1]
}

/** A team made through the panel (lead with lead.md) and `dev` hired through it. */
async function team(s, view = 'desktop') {
  const r = await act(s.f, { type: 'new-team', req: 1, title: 'Checkout v2', kickoff: 'lead.md', model: 'opus' }, view)
  assert.equal(r.ok, true, r.error)
  const h = await act(s.f, { type: 'hire', roomId: r.roomId, name: 'dev', kickoff: 'dev.md', effort: 'high' }, view)
  assert.equal(h.ok, true, h.error)
  const leadTab = s.f.opens.find((o) => o.name === 'lead').tabId
  const devTab = s.f.opens.find((o) => o.name === 'dev').tabId
  return { roomId: r.roomId, leadTab, devTab }
}

// ---- connect, state, per view ----

test('hello: the whole state goes to that view at once; no team selected answers team null', async () => {
  const s = setup()
  await s.f.page({ type: 'hello' }, 'web:3')
  const st = postsOf(s.f, 'state', 'web:3')
  assert.equal(st.length, 1)
  assert.deepEqual(st[0], { type: 'state', teams: [], team: null, exportDir: null })
  // Nothing went to a view that never said hello, and nothing went to all views at once.
  assert.equal(s.f.posts.filter(([, , o]) => !o || o.view !== 'web:3').length, 0)
})

test('state shape: the summary of every team and the selected team in detail', async () => {
  const s = setup({ app: { exportDir: 'exports' } })
  const { roomId, leadTab, devTab } = await team(s)
  s.f.emitSession({ tabId: devTab, status: 'working', tool: 'Edit', costUsd: 0.5, contextPercent: 42 })
  s.f.emitSession({ tabId: leadTab, status: 'waiting' })
  // The metrics are not started here: hand them the sessions as their onChange would.
  await s.inst.metrics.poll()
  s.inst.metrics.onSessions(await s.f.ctx.sessions.list())
  await s.inst.questions.ask({ team: await s.inst.teams.get(roomId), member: { name: 'dev', tabId: devTab } }, 'Which database?')
  await s.inst.metrics.mark(roomId, 'build', 'lead')
  await s.f.page({ type: 'select', roomId })
  const st = postsOf(s.f, 'state').at(-1)
  assert.equal(st.exportDir, path.join(s.dir, 'exports'))
  assert.equal(st.teams.length, 1)
  const sum = st.teams[0]
  assert.equal(sum.roomId, roomId)
  assert.equal(sum.title, 'Checkout v2')
  assert.equal(sum.members, 2)
  assert.equal(sum.waiting, 1)
  assert.equal(sum.paused, false)
  assert.equal(sum.endedAt, undefined)
  const t = st.team
  assert.equal(t.roomId, roomId)
  const dev = t.members.find((m) => m.name === 'dev')
  assert.equal(dev.status, 'working')
  assert.equal(dev.tool, 'Edit')
  assert.equal(dev.effort, 'high')
  assert.equal(dev.costUsd, 0.5)
  assert.equal(dev.contextPercent, 42)
  assert.equal(dev.held, 0)
  assert.equal(dev.in, true)
  assert.equal(dev.coordinator, false)
  assert.equal(dev.tabId, undefined, 'tab ids never reach the page')
  const lead = t.members.find((m) => m.name === 'lead')
  assert.equal(lead.coordinator, true)
  assert.equal(lead.model, 'opus')
  assert.equal(lead.status, 'waiting')
  assert.deepEqual(
    t.questions.map((q) => [q.id, q.from, q.text]),
    [['q1', 'dev', 'Which database?']],
  )
  assert.deepEqual(
    t.marks.map((m) => m.label),
    ['build'],
  )
  assert.ok(t.stats && Array.isArray(t.stats.spans) && t.stats.personActiveIsProxy === true)
  assert.ok(Number.isInteger(t.logSeq) && t.logSeq > 0)
})

test('a member that left shows as left with why; a closed tab as closed', async () => {
  const s = setup()
  const { roomId, devTab } = await team(s)
  await act(s.f, { type: 'hire', roomId, name: 'qa', kickoff: 'dev.md' })
  await s.inst.metrics.poll()
  assert.equal((await act(s.f, { type: 'fire', roomId, name: 'qa' })).ok, true)
  await s.inst.metrics.poll()
  s.f.sessions.delete(devTab)
  await s.f.page({ type: 'select', roomId })
  const t = postsOf(s.f, 'state').at(-1).team
  const qa = t.members.find((m) => m.name === 'qa')
  assert.equal(qa.in, false)
  assert.equal(qa.status, 'left')
  assert.equal(qa.leftWhy, 'fired')
  assert.equal(t.members.find((m) => m.name === 'dev').status, 'closed')
})

test('re-push on connect: a second hello posts the state again although nothing changed', async () => {
  const s = setup()
  await s.f.page({ type: 'hello' })
  await s.f.page({ type: 'hello' })
  assert.equal(postsOf(s.f, 'state').length, 2)
})

test('each view keeps its own selection; a hello carries the page\'s selection back', async () => {
  const s = setup()
  const { roomId } = await team(s)
  await s.f.page({ type: 'hello', selected: roomId }, 'web:1')
  await s.f.page({ type: 'hello' }, 'desktop')
  assert.equal(postsOf(s.f, 'state', 'web:1').at(-1).team.roomId, roomId)
  assert.equal(postsOf(s.f, 'state', 'desktop').at(-1).team, null)
  // An unknown id selected is no team, not an error.
  await s.f.page({ type: 'select', roomId: 'room-x' }, 'desktop')
  assert.equal(postsOf(s.f, 'state', 'desktop').at(-1).team, null)
})

test('per-view replies: an action\'s answer goes to the view that asked only', async () => {
  const s = setup()
  await s.f.page({ type: 'hello' }, 'desktop')
  const before = s.f.posts.length
  const r = await act(s.f, { type: 'new-team', req: 'a1', title: 'T' }, 'web:2')
  assert.equal(r.ok, true, r.error)
  assert.equal(r.req, 'a1')
  assert.equal(r.action, 'new-team')
  const answers = s.f.posts.slice(before).filter(([, m]) => m.type === 'result')
  assert.deepEqual(
    answers.map(([, , o]) => o.view),
    ['web:2'],
  )
})

test('throttling: a burst of changes is one push, at most one a second, and an unchanged state is not re-posted', async () => {
  const s = setup()
  const { roomId, devTab } = await team(s)
  // The selected team's members carry the statuses, so a status change changes this page's state.
  await s.f.page({ type: 'hello', selected: roomId })
  await s.fire()
  const n0 = postsOf(s.f, 'state').length
  for (let i = 0; i < 5; i++) s.f.emitSession({ tabId: devTab, status: i % 2 ? 'working' : 'waiting', tool: `T${i}` })
  // One timer for the whole burst.
  assert.equal(s.timers.list.length, 1)
  await s.fire()
  assert.equal(postsOf(s.f, 'state').length, n0 + 1)
  // A change right after a push waits out the rest of the second.
  s.f.emitSession({ tabId: devTab, status: 'idle' })
  assert.equal(s.timers.list.length, 1)
  assert.ok(s.timers.list[0].ms > 0 && s.timers.list[0].ms <= PUSH_MS)
  s.f.advance(PUSH_MS)
  await s.fire()
  const n1 = postsOf(s.f, 'state').length
  // Nothing changed for the page (the same clock: the running times did not move either): no post.
  s.f.emitSession({ tabId: devTab, status: 'idle' })
  await s.fire()
  assert.equal(postsOf(s.f, 'state').length, n1)
})

test('no push while no page is known; a record written pushes to the known views', async () => {
  const s = setup()
  const { roomId, devTab } = await team(s)
  // The actions above came from the desktop page, so it is known: let its push run, then drop it.
  await s.fire()
  s.panel.views.clear()
  s.f.emitSession({ tabId: devTab, status: 'working' })
  assert.equal(s.timers.list.length, 0)
  await s.f.page({ type: 'hello', selected: roomId }, 'web:1')
  const n = postsOf(s.f, 'state', 'web:1').length
  // `ccc team ask` writes the record: the panel hears it through teams.onChange.
  await s.inst.questions.ask({ team: await s.inst.teams.get(roomId), member: { name: 'dev', tabId: devTab } }, 'Why?')
  assert.equal(s.timers.list.length, 1)
  s.f.advance(PUSH_MS)
  await s.fire()
  const last = postsOf(s.f, 'state', 'web:1')
  assert.equal(last.length, n + 1)
  assert.equal(last.at(-1).team.questions.length, 1)
})

test('views are bounded: the least recently heard falls out past the cap', async () => {
  const s = setup()
  for (let i = 1; i <= VIEWS_MAX + 2; i++) await s.f.page({ type: 'hello' }, `web:${i}`)
  assert.equal(s.panel.views.size, VIEWS_MAX)
  assert.equal(s.panel.views.has('web:1'), false)
  assert.equal(s.panel.views.has(`web:${VIEWS_MAX + 2}`), true)
})

test('a malformed message is ignored; an unknown action is answered as such', async () => {
  const s = setup()
  await s.f.page(null)
  await s.f.page([1, 2])
  await s.f.page({ nope: 1 })
  assert.equal(s.f.posts.length, 0)
  const r = await act(s.f, { type: 'rm-rf', req: 7 })
  assert.equal(r.ok, false)
  assert.match(r.error, /unknown action/)
  assert.equal(r.req, 7)
})

test('a post that throws (over 1 MiB, a bad view) is logged, never thrown into the listener', async () => {
  const s = setup()
  const warned = []
  s.f.ctx.log.warn = (m) => warned.push(m)
  const { roomId } = await team(s)
  const real = s.f.ctx.panels.post
  s.f.ctx.panels.post = () => {
    throw new RangeError('panels.post: message too big')
  }
  await s.f.page({ type: 'docs', roomId })
  s.f.ctx.panels.post = real
  assert.match(warned.join('\n'), /too big/)
  // The real check: a view id main never minted throws in post; the listener still returns.
  await s.f.page({ type: 'hello' }, 'evil')
  assert.match(warned.join('\n'), /view must be/)
})

// ---- actions ----

test('new team: opens a lead tab as coordinator with the kickoff seeded, focuses it, counts as a panel action', async () => {
  const s = setup()
  const r = await act(s.f, { type: 'new-team', title: 'Launch', kickoff: 'lead.md', model: 'sonnet', effort: 'low', cwd: '.' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.name, 'lead')
  const open = s.f.opens.find((o) => o.via === 'rooms.open')
  assert.equal(open.roomId, r.roomId)
  assert.equal(open.coordinator, true)
  assert.equal(open.model, 'sonnet')
  assert.equal(open.effort, 'low')
  assert.equal(open.cwd, s.dir)
  assert.equal(open.prompt, 'Read your kickoff: ccc room doc get members/lead/kickoff.md')
  assert.equal(s.f.rooms.get(r.roomId).docs.get('members/lead/kickoff.md'), '# You lead\n')
  assert.ok(await s.inst.teams.get(r.roomId))
  await settle()
  assert.equal((await s.inst.teams.get(r.roomId)).metrics.actions.length, 1)
})

test('new team: no kickoff opens the lead with no prompt; --as name is checked', async () => {
  const s = setup()
  const r = await act(s.f, { type: 'new-team', title: 'Bare', name: 'boss' })
  assert.equal(r.ok, true, r.error)
  const open = s.f.opens.find((o) => o.via === 'rooms.open')
  assert.equal(open.name, 'boss')
  assert.equal(open.prompt, undefined)
  assert.equal(s.f.rooms.get(r.roomId).docs.size, 0)
  const bad = await act(s.f, { type: 'new-team', title: 'X', name: 'person' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /reserved/)
})

test('new team refusals: a bad kickoff creates no room; a failed open removes the room; Rooms\' text passes through', async () => {
  const s = setup()
  const missing = await act(s.f, { type: 'new-team', title: 'T', kickoff: 'nope.md' })
  assert.equal(missing.ok, false)
  assert.equal(s.f.rooms.size, 0)
  const empty = await act(s.f, { type: 'new-team', title: '' })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /title is empty/)
  const badModel = await act(s.f, { type: 'new-team', title: 'T', model: 'gpt' })
  assert.equal(badModel.ok, false)
  assert.match(badModel.error, /unknown model/)
  // The room was made and then cleaned up: ended, deleted and its record gone.
  assert.equal(s.f.rooms.size, 0)
  assert.equal((await s.inst.teams.list()).length, 0)
  const quote = await act(s.f, { type: 'new-team', title: 'say "hi"' })
  assert.equal(quote.ok, false)
  assert.match(quote.error, /rooms\.create: title/)
})

test('hire: same checks as the command, against the project folder', async () => {
  const s = setup()
  const { roomId } = await team(s)
  const open = s.f.opens.find((o) => o.name === 'dev')
  assert.equal(open.effort, 'high')
  assert.equal(open.prompt, 'Read your kickoff: ccc room doc get members/dev/kickoff.md')
  const taken = await act(s.f, { type: 'hire', roomId, name: 'dev', kickoff: 'dev.md' })
  assert.equal(taken.ok, false)
  assert.match(taken.error, /already in the team/)
  const noKickoff = await act(s.f, { type: 'hire', roomId, name: 'qa' })
  assert.equal(noKickoff.ok, false)
  assert.match(noKickoff.error, /kickoff is missing/)
  const foreign = await act(s.f, { type: 'hire', roomId: 'room-other', name: 'qa', kickoff: 'dev.md' })
  assert.equal(foreign.ok, false)
  assert.equal(foreign.error, 'no such team')
  const coord = await act(s.f, { type: 'hire', roomId, name: 'qa', kickoff: 'dev.md', coordinator: 'yes' })
  assert.equal(coord.ok, false)
  assert.match(coord.error, /coordinator must be/)
})

test('hire and every live-team action refuse an ended team', async () => {
  const s = setup()
  const { roomId } = await team(s)
  await s.f.ctx.rooms.end(roomId)
  for (const m of [
    { type: 'hire', name: 'qa', kickoff: 'dev.md' },
    { type: 'mark', label: 'x' },
    { type: 'fire', name: 'dev' },
    { type: 'focus', name: 'dev' },
    { type: 'invite', name: 'qa' },
    { type: 'end' },
  ]) {
    const r = await act(s.f, { ...m, roomId })
    assert.equal(r.ok, false, m.type)
    assert.match(r.error, /ended/, m.type)
  }
})

test('mark: by the person; a boundary label is refused', async () => {
  const s = setup()
  const { roomId } = await team(s)
  const r = await act(s.f, { type: 'mark', roomId, label: 'review' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.label, 'review')
  const rec = await s.inst.teams.get(roomId)
  assert.equal(rec.marks.at(-1).by, 'person')
  const bad = await act(s.f, { type: 'mark', roomId, label: 'end' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /span's end/)
})

test('end and export: into a folder resolved against the project, no budget; a second end is refused', async () => {
  const s = setup()
  const { roomId } = await team(s)
  fs.mkdirSync(path.join(s.dir, 'out'))
  const r = await act(s.f, { type: 'end', roomId, dir: 'out' })
  assert.equal(r.ok, true, r.error)
  assert.ok(r.folder.startsWith(path.join(s.dir, 'out') + path.sep))
  assert.ok(fs.existsSync(path.join(r.folder, 'metrics.json')))
  assert.notEqual(s.f.rooms.get(roomId).endedAt, undefined)
  const again = await act(s.f, { type: 'end', roomId })
  assert.equal(again.ok, false)
})

test('end with no folder and no setting ends without an export; a missing folder refuses and keeps the team', async () => {
  const s = setup()
  const { roomId } = await team(s)
  const bad = await act(s.f, { type: 'end', roomId, dir: 'missing' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /still running/)
  assert.equal(s.f.rooms.get(roomId).endedAt, undefined)
  const r = await act(s.f, { type: 'end', roomId })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.folder, undefined)
})

test('delete: refused for a live team (checked by the panel), then deletes an ended one and clears the selection', async () => {
  const s = setup()
  const { roomId } = await team(s)
  await s.f.page({ type: 'select', roomId }, 'web:1')
  const live = await act(s.f, { type: 'delete', roomId })
  assert.equal(live.ok, false)
  assert.match(live.error, /only an ended team/)
  assert.ok(s.f.rooms.has(roomId))
  await act(s.f, { type: 'end', roomId })
  const r = await act(s.f, { type: 'delete', roomId })
  assert.equal(r.ok, true, r.error)
  assert.equal(s.f.rooms.has(roomId), false)
  assert.equal(await s.inst.teams.get(roomId), undefined)
  assert.equal(s.panel.views.get('web:1').selected, null)
  const gone = await act(s.f, { type: 'delete', roomId })
  assert.equal(gone.ok, false)
  assert.equal(gone.error, 'no such team')
})

test('reply and done: through the shared questions instance', async () => {
  const s = setup()
  const { roomId, devTab } = await team(s)
  const found = { team: await s.inst.teams.get(roomId), member: { name: 'dev', tabId: devTab } }
  await s.inst.questions.ask(found, 'A or B?')
  await s.inst.questions.ask(found, 'And C?')
  const r = await act(s.f, { type: 'reply', roomId, id: 'q1', text: 'A' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.answers[0].to, 'dev')
  const sent = s.f.rooms.get(roomId).log.filter((e) => e.type === 'send' && e.from === 'plugin')
  assert.equal(sent.at(-1).text, replyPrefix('q1') + 'A')
  const empty = await act(s.f, { type: 'reply', roomId, id: 'q2', text: '  ' })
  assert.equal(empty.ok, false)
  const twice = await act(s.f, { type: 'reply', roomId, id: 'q1', text: 'again' })
  assert.equal(twice.ok, false)
  assert.match(twice.error, /already answered/)
  const d = await act(s.f, { type: 'done', roomId, id: 'q2' })
  assert.equal(d.ok, true, d.error)
  const unknown = await act(s.f, { type: 'done', roomId, id: 'q9' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /no such question/)
})

test('fire: a member by name; an unknown name is refused before Rooms is asked', async () => {
  const s = setup()
  const { roomId } = await team(s)
  const r = await act(s.f, { type: 'fire', roomId, name: 'dev' })
  assert.equal(r.ok, true, r.error)
  assert.equal(s.f.rooms.get(roomId).members.has('dev'), false)
  const bad = await act(s.f, { type: 'fire', roomId, name: 'dev' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /dev is not in the team/)
})

test('focus: the member\'s tab from main\'s member list, never a tab id from the page', async () => {
  const s = setup()
  const { roomId, devTab } = await team(s)
  const focused = []
  s.f.ctx.sessions.focus = async (tabId) => {
    focused.push(tabId)
    return true
  }
  const r = await act(s.f, { type: 'focus', roomId, name: 'dev', tabId: 'tab-evil' })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(focused, [devTab])
  s.f.ctx.sessions.focus = async () => false
  const gone = await act(s.f, { type: 'focus', roomId, name: 'dev' })
  assert.equal(gone.ok, false)
  assert.match(gone.error, /tab is gone/)
  s.f.rooms.get(roomId).members.get('dev').tabId = undefined
  const none = await act(s.f, { type: 'focus', roomId, name: 'dev' })
  assert.equal(none.ok, false)
  assert.match(none.error, /no tab now/)
})

test('invite: a one-time code and the join line, to the asking view; a taken name is Rooms\' refusal', async () => {
  const s = setup()
  const { roomId } = await team(s)
  const r = await act(s.f, { type: 'invite', roomId, name: 'qa', coordinator: true }, 'web:4')
  assert.equal(r.ok, true, r.error)
  assert.match(r.line, /^ccc room join \S+$/)
  assert.ok(r.expiresAt > s.f.clock.t)
  s.f.join(r.code, 'tab-qa')
  assert.equal(s.f.rooms.get(roomId).members.get('qa').coordinator, true)
  const taken = await act(s.f, { type: 'invite', roomId, name: 'dev' })
  assert.equal(taken.ok, false)
  assert.match(taken.error, /rooms\.invite: dev is already a member/)
})

test('docs and doc: the list sorted, a doc\'s text read-only; a bad path is Rooms\' refusal', async () => {
  const s = setup()
  const { roomId } = await team(s)
  await s.f.ctx.rooms.docs.put(roomId, 'shared/plan.md', '<b>not html</b>')
  const list = await act(s.f, { type: 'docs', roomId })
  assert.equal(list.ok, true, list.error)
  assert.deepEqual(
    list.docs.map((d) => d.path),
    ['members/dev/kickoff.md', 'members/lead/kickoff.md', 'shared/plan.md'],
  )
  const doc = await act(s.f, { type: 'doc', roomId, path: 'shared/plan.md' })
  assert.equal(doc.text, '<b>not html</b>')
  const bad = await act(s.f, { type: 'doc', roomId, path: '../x' })
  assert.equal(bad.ok, false)
  // An ended team's docs stay readable.
  await s.f.ctx.rooms.end(roomId)
  assert.equal((await act(s.f, { type: 'doc', roomId, path: 'shared/plan.md' })).ok, true)
})

test('panel actions count as the person\'s activity; activity paging does not', async () => {
  const s = setup()
  const { roomId } = await team(s)
  await settle()
  const n = (await s.inst.teams.get(roomId)).metrics.actions.length
  await act(s.f, { type: 'mark', roomId, label: 'a' })
  await act(s.f, { type: 'activity', roomId })
  await act(s.f, { type: 'docs', roomId })
  await settle()
  assert.equal((await s.inst.teams.get(roomId)).metrics.actions.length, n + 1)
})

// ---- activity ----

test('activity: newest first, paged by a cursor, to the start of the log', async () => {
  const s = setup()
  const { roomId } = await team(s)
  for (let i = 0; i < 2500; i++) s.f.pushLog(roomId, { type: 'send', from: 'dev', to: 'lead', text: `m${i}`, delivery: [{ to: 'lead', path: 'held', why: 'not-waiting' }] })
  const total = s.f.rooms.get(roomId).log.length
  const seen = []
  let before
  for (let page = 0; page < 100; page++) {
    const r = await act(s.f, { type: 'activity', roomId, ...(before ? { before } : {}) })
    assert.equal(r.ok, true, r.error)
    assert.ok(r.entries.length <= ACTIVITY_PAGE)
    seen.push(...r.entries.map((e) => e.seq))
    if (!r.before) break
    before = r.before
  }
  assert.equal(seen.length, total)
  assert.deepEqual(
    seen,
    [...seen].sort((a, b) => b - a),
  )
  assert.equal(new Set(seen).size, total)
})

test('activity filters: by kind across many log pages, by member (sender, recipient, subject, doc reader)', async () => {
  const s = setup()
  const { roomId } = await team(s)
  for (let i = 0; i < 2500; i++) s.f.pushLog(roomId, { type: 'send', from: 'lead', to: 'dev', text: 'x', delivery: [{ to: 'dev', path: 'delivered' }] })
  s.f.pushLog(roomId, { type: 'pause' })
  s.f.pushLog(roomId, { type: 'doc-read', by: 'qa', path: 'shared/a.md', bytes: 1 })
  const pauses = await act(s.f, { type: 'activity', roomId, kind: 'pause' })
  assert.deepEqual(
    pauses.entries.map((e) => e.type),
    ['pause'],
  )
  const qa = await act(s.f, { type: 'activity', roomId, member: 'qa' })
  assert.deepEqual(
    qa.entries.map((e) => e.type),
    ['doc-read'],
  )
  const dev = await act(s.f, { type: 'activity', roomId, member: 'dev', kind: 'join' })
  assert.equal(dev.entries.length, 1)
  assert.equal(dev.entries[0].member, 'dev')
  const bad = await act(s.f, { type: 'activity', roomId, kind: 'bogus' })
  assert.equal(bad.ok, false)
  const badCursor = await act(s.f, { type: 'activity', roomId, before: { seq: 'x' } })
  assert.equal(badCursor.ok, false)
})

test('activity: a filter matching nothing stops after its scan budget with a cursor to go on', async () => {
  const s = setup()
  const { roomId } = await team(s)
  for (let i = 0; i < 12000; i++) s.f.pushLog(roomId, { type: 'send', from: 'lead', to: 'dev', text: 'x' })
  const r = await act(s.f, { type: 'activity', roomId, kind: 'pause' })
  assert.equal(r.entries.length, 0)
  assert.ok(r.before && r.before.seq > 1)
  const r2 = await act(s.f, { type: 'activity', roomId, kind: 'pause', before: r.before })
  assert.equal(r2.before, null)
})

test('activity: marks are interleaved by time, each on one page; kind mark lists only marks', async () => {
  const s = setup()
  const { roomId } = await team(s)
  for (let i = 0; i < 60; i++) {
    s.f.advance(1000)
    s.f.pushLog(roomId, { type: 'send', from: 'lead', to: 'dev', text: `m${i}` })
    if (i === 5 || i === 55) {
      s.f.advance(1)
      await s.inst.metrics.mark(roomId, `mk${i}`, 'lead')
    }
  }
  const all = []
  let before
  for (;;) {
    const r = await act(s.f, { type: 'activity', roomId, ...(before ? { before } : {}) })
    all.push(...r.entries)
    if (!r.before) break
    before = r.before
  }
  const marks = all.filter((e) => e.type === 'mark').map((e) => e.label)
  assert.deepEqual(marks, ['mk55', 'mk5'])
  // In time order: mk55 sits right after (newer than) the 56th send.
  const i55 = all.findIndex((e) => e.label === 'mk55')
  assert.equal(all[i55 + 1].text, 'm55')
  const only = await act(s.f, { type: 'activity', roomId, kind: 'mark' })
  assert.deepEqual(
    only.entries.map((e) => e.label),
    ['mk55', 'mk5'],
  )
  assert.equal(only.before, null)
  const byOther = await act(s.f, { type: 'activity', roomId, kind: 'mark', member: 'dev' })
  assert.equal(byOther.entries.length, 0)
})

test('activity: long message text is cut, and the entry says so', async () => {
  const s = setup()
  const { roomId } = await team(s)
  s.f.pushLog(roomId, { type: 'send', from: 'lead', to: 'dev', text: 'y'.repeat(FIELD_TEXT_MAX + 10), delivery: [{ to: 'dev', path: 'delivered' }] })
  const r = await act(s.f, { type: 'activity', roomId, kind: 'send' })
  assert.equal(r.entries[0].text.length, FIELD_TEXT_MAX)
  assert.equal(r.entries[0].cut, true)
  assert.deepEqual(r.entries[0].delivery, [{ to: 'dev', path: 'delivered' }])
})

test('activity: a log page bounded by bytes (long messages) still shows every entry once, newest first', async () => {
  // About three 20,000-character sends fit one log page here: a `since` read answers only the oldest of its window.
  const s = setup({ logPageBytes: 64 * 1024 })
  const { roomId } = await team(s)
  for (let i = 0; i < 400; i++) {
    const long = i % 3 !== 0
    s.f.pushLog(roomId, { type: 'send', from: 'dev', to: 'lead', text: long ? `${i} ` + 'z'.repeat(20000) : `m${i}` })
  }
  const total = s.f.rooms.get(roomId).log.length
  for (const kind of [undefined, 'send']) {
    const seen = []
    let before
    for (let page = 0; page < 500; page++) {
      const r = await act(s.f, { type: 'activity', roomId, ...(kind ? { kind } : {}), ...(before ? { before } : {}) })
      assert.equal(r.ok, true, r.error)
      seen.push(...r.entries.map((e) => e.seq))
      if (!r.before) break
      before = r.before
    }
    assert.deepEqual(
      seen,
      [...seen].sort((a, b) => b - a),
    )
    assert.equal(new Set(seen).size, seen.length)
    assert.equal(seen.length, kind ? 400 : total)
  }
})

test('activity: a kind filter naming a log type leaves the marks out', async () => {
  const s = setup()
  const { roomId } = await team(s)
  s.f.advance(10)
  await s.inst.metrics.mark(roomId, 'build', 'person')
  s.f.advance(10)
  s.f.pushLog(roomId, { type: 'pause' })
  const r = await act(s.f, { type: 'activity', roomId, kind: 'pause' })
  assert.deepEqual(
    r.entries.map((e) => e.type),
    ['pause'],
  )
  const all = await act(s.f, { type: 'activity', roomId })
  assert.ok(all.entries.some((e) => e.type === 'mark'))
})

test('the state read for a page credits nothing: no save is armed, the running time still moves', async () => {
  const s = setup()
  const { roomId, devTab } = await team(s)
  s.f.emitSession({ tabId: devTab, status: 'working' })
  await s.inst.metrics.poll()
  s.inst.metrics.onSessions(await s.f.ctx.sessions.list())
  // Let the hires' saves run, then count the writes from here on.
  for (const t of s.metricTimers.list.splice(0)) await t.fn()
  await settle()
  let writes = 0
  const set = s.f.ctx.storage.set
  s.f.ctx.storage.set = async (k, v) => {
    writes++
    return set(k, v)
  }
  await s.f.page({ type: 'hello', selected: roomId })
  const working = []
  for (let i = 0; i < 5; i++) {
    s.f.advance(5000)
    await s.panel.push()
    await settle()
    working.push(postsOf(s.f, 'state').at(-1).team.members.find((m) => m.name === 'dev').workingMs)
  }
  assert.equal(s.metricTimers.list.length, 0, 'no throttled save armed by a display')
  assert.equal(writes, 0)
  assert.ok(working.every((w, i) => i === 0 || w === working[i - 1] + 5000), working.join(','))
})

test('views are forgotten when silent past their time; a ping keeps one, and from a forgotten one is a hello', async () => {
  const s = setup()
  const { roomId, devTab } = await team(s)
  await s.fire()
  await s.f.page({ type: 'hello', selected: roomId }, 'web:1')
  s.f.advance(VIEW_TTL_MS / 2)
  const n = s.f.posts.length
  await s.f.page({ type: 'ping', selected: roomId }, 'web:1')
  assert.equal(s.f.posts.length, n, 'a ping is not answered')
  s.f.advance(VIEW_TTL_MS / 2 + 1)
  // The desktop (heard at the start) is gone; web:1 pinged in time.
  s.f.emitSession({ tabId: devTab, status: 'working' })
  assert.deepEqual([...s.panel.views.keys()], ['web:1'])
  s.f.advance(VIEW_TTL_MS)
  s.f.emitSession({ tabId: devTab, status: 'idle' })
  assert.equal(s.panel.views.size, 0)
  assert.equal(s.timers.list.length, 1, 'only the push timer armed before')
  await s.fire()
  // Back: its ping gets the whole state with its selection.
  const before = postsOf(s.f, 'state', 'web:1').length
  await s.f.page({ type: 'ping', selected: roomId }, 'web:1')
  const st = postsOf(s.f, 'state', 'web:1')
  assert.equal(st.length, before + 1)
  assert.equal(st.at(-1).team.roomId, roomId)
})

test('a select during a running push: the older push does not post the old team over the new one', async () => {
  const s = setup()
  const a = await team(s)
  const b = await act(s.f, { type: 'new-team', title: 'Other' })
  assert.equal(b.ok, true, b.error)
  await s.fire()
  await s.f.page({ type: 'select', roomId: a.roomId })
  // Hold the throttled push inside its detail of team A (the selection already read).
  const members = s.f.ctx.rooms.members
  let release
  const gate = new Promise((r) => (release = r))
  let held = false
  s.f.ctx.rooms.members = async (id) => {
    if (!held) {
      held = true
      await gate
    }
    return members(id)
  }
  s.f.advance(PUSH_MS)
  const p = s.panel.push()
  await settle()
  assert.equal(held, true)
  await s.f.page({ type: 'select', roomId: b.roomId })
  assert.equal(postsOf(s.f, 'state').at(-1).team.roomId, b.roomId)
  release()
  await p
  await settle()
  assert.equal(postsOf(s.f, 'state').at(-1).team.roomId, b.roomId)
})

test('a failed member read is not "everyone left": the last list, else unknown, flagged', async () => {
  const s = setup()
  const { roomId } = await team(s)
  await s.inst.metrics.poll()
  const members = s.f.ctx.rooms.members
  s.f.ctx.rooms.members = async () => {
    throw new Error('rooms.members: timed out')
  }
  await s.f.page({ type: 'select', roomId })
  let t = postsOf(s.f, 'state').at(-1).team
  assert.equal(t.membersUnknown, true)
  const dev = t.members.find((m) => m.name === 'dev')
  assert.deepEqual([dev.status, dev.in], ['unknown', null])
  s.f.ctx.rooms.members = members
  await s.f.page({ type: 'select', roomId })
  assert.equal(postsOf(s.f, 'state').at(-1).team.membersUnknown, undefined)
  s.f.ctx.rooms.members = async () => {
    throw new Error('rooms.members: timed out')
  }
  await s.f.page({ type: 'select', roomId })
  t = postsOf(s.f, 'state').at(-1).team
  assert.equal(t.membersUnknown, true)
  assert.equal(t.members.find((m) => m.name === 'dev').in, true)
})

test('an answer too big to post is answered short, so the page never waits on its req', async () => {
  const s = setup()
  const { roomId } = await team(s)
  const real = s.f.ctx.panels.post
  s.f.ctx.panels.post = (id, m, o) => {
    if (m.type === 'result' && m.ok) throw new RangeError('panels.post: message of 2000000 chars exceeds 1048576')
    return real(id, m, o)
  }
  const r = await act(s.f, { type: 'docs', roomId, req: 'r9' })
  assert.deepEqual([r.ok, r.req, r.action, r.error], [false, 'r9', 'docs', 'too big to show'])
})

test('the largest state and the largest activity page stay under the 1 MiB post limit', async () => {
  const s = setup({ maxRooms: 55 })
  const ids = []
  for (let i = 0; i < 55; i++) {
    const { id } = await s.f.ctx.rooms.create({ title: `Team number ${i} with a long title here` })
    await s.inst.teams.add({ id })
    ids.push(id)
  }
  const rec = await s.inst.teams.get(ids[0])
  // 50 open questions holding the 100,000-character cap, in characters JSON doubles (quotes, line breaks).
  for (let i = 0; i < 50; i++) rec.questions.push({ id: `q${i + 1}`, from: 'm'.repeat(31), text: '"\n'.repeat(1000), askedAt: i })
  // 200 marks of 200 characters: in `marks` and twice in `spans`.
  for (let i = 0; i < 200; i++) rec.marks.push({ at: rec.createdAt + i + 1, label: '"'.repeat(200), by: 'm'.repeat(31), cost: i, workingMs: i })
  for (let i = 0; i < 100; i++) rec.metrics.members[`member-${String(i).padStart(24, '0')}`] = { workingMs: 1, waitingMs: 1, idleMs: 1, sent: 1, received: 1, docReads: 1, docWrites: 1, model: 'opus', effort: 'high', leftAt: 1, leftWhy: 'fired' }
  await s.inst.teams.save(rec)
  await s.f.page({ type: 'hello', selected: ids[0] })
  const st = postsOf(s.f, 'state').at(-1)
  assert.equal(st.error, undefined)
  assert.equal(st.teams.length, 55)
  assert.equal(st.team.questions.length, 50)
  assert.equal(st.team.marks.length, 200)
  assert.ok(JSON.stringify(st).length < 1024 * 1024)
  // 50 sends to everyone in a 50-member room: each with its full delivery list.
  const delivery = Array.from({ length: 50 }, (_, i) => ({ to: `member-${String(i).padStart(24, '0')}`, path: 'held', why: 'not-waiting' }))
  for (let i = 0; i < 60; i++) s.f.pushLog(ids[1], { type: 'send', from: 'm'.repeat(31), to: 'all', text: '"'.repeat(20000), delivery })
  const r = await act(s.f, { type: 'activity', roomId: ids[1], kind: 'send' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.entries.length, ACTIVITY_PAGE)
  assert.equal(r.entries[0].delivery.length, 50)
  assert.ok(JSON.stringify(r).length < 1024 * 1024)
})

// ---- pure helpers ----

test('cleanEntry keeps plain values and flat arrays only; entryHasMember; statusOf', () => {
  const e = cleanEntry({ seq: 1, at: 2, type: 'send', from: 'a', nested: { x: 1 }, fn: null, delivery: [{ to: 'b', path: 'held', deep: { y: 1 } }, 'junk'] })
  assert.deepEqual(e, { seq: 1, at: 2, type: 'send', from: 'a', delivery: [{ to: 'b', path: 'held' }] })
  assert.equal(entryHasMember({ delivery: [{ to: 'x' }] }, 'x'), true)
  assert.equal(entryHasMember({ by: 'x' }, 'x'), true)
  assert.equal(entryHasMember({ from: 'y' }, 'x'), false)
  assert.equal(statusOf(undefined), 'closed')
  assert.equal(statusOf({ status: 'ended' }), 'closed')
  assert.equal(statusOf({ status: 'needs-permission' }), 'needs-permission')
})

// ---- the host ----

test('the host wires the panel on its shared instances and stops it on deactivate', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'dev.md'), '# dev\n')
  const f = fakeCtx({ projectDir: dir })
  host.activate(f.ctx)
  const inst = host.instances()
  assert.ok(inst.panel && inst.hiring)
  assert.ok(f.panelListeners.has('team'))
  // A team started through the command is the panel's too, and a panel hire shares the command's lock and records.
  f.emitSession({ tabId: 'lead-tab', status: 'waiting' })
  const r = await f.run(['start', 'Shared'], { tabId: 'lead-tab' })
  f.join(/ccc room join (\S+)/.exec(r.stdout)[1], 'lead-tab')
  const roomId = [...f.rooms.keys()][0]
  await f.page({ type: 'hello', selected: roomId })
  const st = f.posts.filter(([, m]) => m.type === 'state').at(-1)[1]
  assert.equal(st.team.title, 'Shared')
  const before = f.posts.length
  await f.page({ type: 'hire', roomId, name: 'dev', kickoff: 'dev.md' })
  assert.equal(f.posts.slice(before).find(([, m]) => m.type === 'result')[1].ok, true)
  const list = await f.run(['list', '--json'], { tabId: 'lead-tab' })
  assert.deepEqual(
    JSON.parse(list.stdout).members.map((m) => m.name),
    ['lead', 'dev'],
  )
  await host.deactivate()
  assert.equal(f.panelListeners.has('team'), false)
})
