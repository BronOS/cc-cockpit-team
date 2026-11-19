'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const host = require('../dist/host.js')
const { fakeCtx } = require('./fake-ctx')
const { parseArgs, UsageError } = require('../lib/commands.js')
const { kickoffPrompt, PROMPT_MAX } = require('../lib/kickoff.js')
const { NOT_IN_TEAM, NOT_COORDINATOR } = require('../lib/teams.js')

test.afterEach(() => host.deactivate())

const dirs = []
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

/** A project folder with a kickoff file, the host activated on a fake ctx, and a Claude tab in no room. */
function project(opts = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-cmd-')))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, 'kick'))
  fs.writeFileSync(path.join(dir, 'kick', 'dev.md'), '# You are dev\n')
  const f = fakeCtx({ projectDir: dir, ...opts })
  host.activate(f.ctx)
  f.emitSession({ tabId: 'lead-tab', status: 'waiting' })
  return { f, dir }
}

const codeOf = (stdout) => /ccc room join (\S+)/.exec(stdout)[1]

/** A started team with the caller joined as its coordinator `lead`. */
async function started(opts) {
  const p = project(opts)
  const r = await p.f.run(['start', 'Build it'], { tabId: 'lead-tab' })
  assert.equal(r.code, undefined, r.stderr)
  p.f.join(codeOf(r.stdout), 'lead-tab')
  p.roomId = [...p.f.rooms.keys()][0]
  p.lead = { tabId: 'lead-tab' }
  return p
}

// --- parseArgs

test('parseArgs: values, --x=value, bools, -- and errors', () => {
  const flags = { as: 'value', json: 'bool' }
  assert.deepEqual(parseArgs(['T', '--as', 'boss'], flags, 1), { opts: { as: 'boss' }, pos: ['T'] })
  assert.deepEqual(parseArgs(['--as=boss', 'T'], flags, 1), { opts: { as: 'boss' }, pos: ['T'] })
  assert.deepEqual(parseArgs(['--json'], flags, 0), { opts: { json: true }, pos: [] })
  assert.deepEqual(parseArgs(['--', '--as'], flags, 1), { opts: {}, pos: ['--as'] })
  assert.deepEqual(parseArgs(['-'], flags, 1), { opts: {}, pos: ['-'] })
  for (const [args, re] of [
    [['--bogus'], /unknown option --bogus/],
    [['--as'], /--as needs a value/],
    [['--json=1'], /takes no value/],
    [['--json', '--json'], /given twice/],
    [['a', 'b'], /unexpected argument: b/],
    [[], /missing argument/],
    [['--constructor'], /unknown option/],
  ]) {
    assert.throws(() => parseArgs(args, flags, args[0] === 'a' ? 1 : args.length === 0 ? 1 : 0), (e) => e instanceof UsageError && re.test(e.message))
  }
})

// --- start

test('start: creates the room and its record, prints a coordinator invite for lead', async () => {
  const { f } = project()
  const r = await f.run(['start', 'Build it'], { tabId: 'lead-tab' })
  assert.equal(r.code, undefined, r.stderr)
  assert.match(r.stdout, /team "Build it" started/)
  assert.match(r.stdout, /ccc room join inv\d+/)
  assert.match(r.stdout, /as lead \(coordinator\)/)
  // The coordinator's tab is typed in: Rooms holds members' messages to it until it reads them.
  assert.match(r.stdout, /run `ccc room read` when you expect answers/)
  const [room] = f.rooms.values()
  assert.equal(room.title, 'Build it')
  const [inv] = room.invites.values()
  assert.deepEqual({ name: inv.name, coordinator: inv.coordinator }, { name: 'lead', coordinator: true })
  assert.ok(f.store.has(`team:${room.id}`))
  // The invite works: the caller joins and is the coordinator.
  f.join(codeOf(r.stdout), 'lead-tab')
  assert.match((await f.run(['list'], { tabId: 'lead-tab' })).stdout, /\* lead/)
})

test('start --as names the coordinator', async () => {
  const { f } = project()
  const r = await f.run(['start', 'T', '--as', 'boss'], { tabId: 'lead-tab' })
  assert.match(r.stdout, /as boss/)
  assert.equal([...[...f.rooms.values()][0].invites.values()][0].name, 'boss')
})

test('start is refused for a tab already in a room (any room), with no tab, and from an unknown tab', async () => {
  const { f } = project()
  f.emitSession({ tabId: 'busy', status: 'waiting', room: { title: 'Theirs', name: 'x', coordinator: false } })
  const busy = await f.run(['start', 'T'], { tabId: 'busy' })
  assert.equal(busy.code, 1)
  assert.match(busy.stderr, /already in a room/)
  for (const call of [{}, { tabId: 'nope' }]) {
    const r = await f.run(['start', 'T'], call)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /run `ccc team start` in the Claude tab/)
  }
  assert.equal(f.rooms.size, 0)
})

test('start: a bad or reserved --as is refused before the room is created', async () => {
  const { f } = project()
  for (const [as, re] of [['Bob', /lower-case letter/], ['all', /reserved/]]) {
    const r = await f.run(['start', 'T', '--as', as], { tabId: 'lead-tab' })
    assert.equal(r.code, 1)
    assert.match(r.stderr, re)
  }
  assert.equal(f.rooms.size, 0)
})

test("start: Rooms' title and cap refusals pass through as they are", async () => {
  const { f } = project({ maxRooms: 1 })
  const bad = await f.run(['start', 'a "quoted" title'], { tabId: 'lead-tab' })
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /^rooms\.create: title may not contain quote or bracket characters/)
  assert.equal((await f.run(['start', 'One'], { tabId: 'lead-tab' })).code, undefined)
  f.emitSession({ tabId: 'other', status: 'waiting' })
  const cap = await f.run(['start', 'Two'], { tabId: 'other' })
  assert.equal(cap.code, 1)
  assert.match(cap.stderr, /^rooms\.create: at most 1 rooms \(roomsPerProject\)/)
})

test('start: an invite that fails ends and deletes the new room and drops its record', async () => {
  const { f } = project()
  f.ctx.rooms.invite = async () => {
    throw new Error('rooms.invite: at most 20 invites waiting')
  }
  const r = await f.run(['start', 'T'], { tabId: 'lead-tab' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /at most 20 invites/)
  assert.equal(f.rooms.size, 0)
  assert.deepEqual([...f.store.keys()].filter((k) => k.startsWith('team:')), [])
})

test('start: an invite that main made but whose answer failed still cleans up (the start\'s own invite is not a change)', async () => {
  const { f } = project()
  const realInvite = f.ctx.rooms.invite
  f.ctx.rooms.invite = async (...a) => {
    await realInvite(...a)
    throw new Error('rooms.invite: timed out')
  }
  const r = await f.run(['start', 'T'], { tabId: 'lead-tab' })
  assert.equal(r.code, 1)
  assert.doesNotMatch(r.stderr, /was kept/)
  assert.equal(f.rooms.size, 0)
})

/** Hold the next `ctx.rooms[method]` call before it reaches the fake: `reached` answers its arguments. */
function holdBefore(f, method) {
  const real = f.ctx.rooms[method]
  let armed = true
  let release
  let reached
  const gate = new Promise((r) => (release = r))
  const came = new Promise((r) => (reached = r))
  f.ctx.rooms[method] = async (...a) => {
    if (!armed) return real(...a)
    armed = false
    reached(a)
    await gate
    return real(...a)
  }
  return { reached: came, release }
}

test('start: a team still being set up refuses the panel\'s Hire, Invite, Mark and End; its start then completes (round 10)', async () => {
  // The repro: a panel Hire of `lead` landed before start's invite, the invite was refused (lead is a member) and the
  // cleanup deleted the room with the hired member in it.
  const { f } = project()
  const held = holdBefore(f, 'invite')
  const pending = f.run(['start', 'T'], { tabId: 'lead-tab' })
  const [roomId] = await held.reached
  const { panel, ending } = host.instances()
  for (const m of [
    { type: 'hire', roomId, name: 'lead', kickoff: 'kick/dev.md' },
    { type: 'invite', roomId, name: 'qa' },
    { type: 'mark', roomId, label: 'm' },
  ]) {
    const before = f.posts.length
    await panel.onMessage({ ...m, req: 1 }, { view: 'desktop' })
    const res = f.posts.slice(before).find(([, x]) => x.type === 'result')
    assert.equal(res[1].ok, false, m.type)
    assert.match(res[1].error, /still being set up/, m.type)
  }
  await assert.rejects(ending.endTeam(roomId), /still being set up/)
  held.release()
  const r = await pending
  assert.equal(r.code, undefined, r.stderr)
  assert.equal(f.rooms.size, 1)
  assert.equal(f.opens.length, 0)
  f.join(codeOf(r.stdout), 'lead-tab')
  // Set up: the team takes changes again.
  const h = await f.run(['hire', 'dev', '--kickoff', 'kick/dev.md'], { tabId: 'lead-tab' })
  assert.equal(h.code, undefined, h.stderr)
})

test('start: a failed invite keeps a room someone else changed meanwhile (never deletes what is not its own)', async () => {
  const { f } = project()
  const realOpen = f.ctx.rooms.open
  // A member arrives by a path the plugin's guard does not cover (core's room view), then the invite fails.
  f.ctx.rooms.invite = async (id) => {
    await realOpen(id, { name: 'other' })
    throw new Error('rooms.invite: timed out')
  }
  const r = await f.run(['start', 'T'], { tabId: 'lead-tab' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /rooms\.invite: timed out/)
  assert.match(r.stderr, /was kept/)
  const [room] = f.rooms.values()
  assert.equal(room.endedAt, undefined, 'not ended')
  assert.ok(room.members.has('other'))
  assert.ok(f.store.has(`team:${room.id}`))
})

test('start: usage errors exit 2', async () => {
  const { f } = project()
  const r = await f.run(['start'], { tabId: 'lead-tab' })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /missing argument\nusage: ccc team start/)
})

// --- hire

test('hire: seeds the kickoff, opens the tab with the kickoff text as its prompt and the options', async () => {
  const { f, dir, roomId, lead } = await started()
  fs.mkdirSync(path.join(dir, 'wt'))
  const r = await f.run(['hire', 'dev', '--kickoff', 'kick/dev.md', '--model', 'sonnet', '--effort', 'high', '--cwd', 'wt'], lead)
  assert.equal(r.code, undefined, r.stderr)
  assert.match(r.stdout, /hired dev/)
  const room = f.rooms.get(roomId)
  assert.equal(room.docs.get('members/dev/kickoff.md'), '# You are dev\n')
  const open = f.opens.find((o) => o.name === 'dev')
  // The kickoff itself is the tab's first user message (auto mode treats a doc read by a tool as data).
  assert.equal(open.prompt, kickoffPrompt({ team: 'Build it', name: 'dev', coordinator: false, docPath: 'members/dev/kickoff.md', text: '# You are dev\n' }))
  assert.ok(open.prompt.endsWith('# You are dev\n'))
  assert.match(open.prompt, /team "Build it"/)
  assert.equal(open.model, 'sonnet')
  assert.equal(open.effort, 'high')
  assert.equal(open.cwd, path.join(dir, 'wt'))
  assert.equal(open.coordinator, undefined)
  assert.equal(room.members.get('dev').coordinator, false)
})

test('hire: the kickoff and --cwd resolve against the caller cwd; --coordinator is passed', async () => {
  const { f, dir, roomId, lead } = await started()
  const r = await f.run(['hire', 'rev', '--kickoff', '../kick/dev.md', '--cwd', '.', '--coordinator'], { ...lead, cwd: path.join(dir, 'kick') })
  assert.equal(r.code, undefined, r.stderr)
  const open = f.opens.find((o) => o.name === 'rev')
  assert.equal(open.cwd, path.join(dir, 'kick'))
  assert.equal(open.coordinator, true)
  assert.equal(f.rooms.get(roomId).members.get('rev').coordinator, true)
})

test('hire: a kickoff longer than the prompt limit is cut in the prompt, whole in the doc', async () => {
  const { f, dir, roomId, lead } = await started()
  const long = '# You are dev\n' + 'word '.repeat(50_000) + '\nTHE END\n'
  fs.writeFileSync(path.join(dir, 'kick', 'long.md'), long)
  const r = await f.run(['hire', 'dev', '--kickoff', 'kick/long.md'], lead)
  assert.equal(r.code, undefined, r.stderr)
  assert.equal(f.rooms.get(roomId).docs.get('members/dev/kickoff.md'), long)
  const open = f.opens.find((o) => o.name === 'dev')
  assert.ok(open.prompt.length <= PROMPT_MAX)
  assert.ok(open.prompt.includes('# You are dev\nword word'))
  assert.doesNotMatch(open.prompt, /THE END/)
  assert.match(open.prompt.trimEnd().split('\n').at(-1), /rest is in the room doc members\/dev\/kickoff\.md/)
})

test('hire is coordinator-only; outsiders get the one not-in-team text', async () => {
  const { f, lead } = await started()
  await f.run(['hire', 'dev', '--kickoff', 'kick/dev.md'], lead)
  const devTab = f.opens.find((o) => o.name === 'dev').tabId
  const member = await f.run(['hire', 'qa', '--kickoff', 'kick/dev.md'], { tabId: devTab })
  assert.equal(member.code, 1)
  assert.equal(member.stderr, NOT_COORDINATOR + '\n')
  f.emitSession({ tabId: 'outsider', status: 'waiting' })
  for (const call of [{}, { tabId: 'outsider' }, { tabId: 'tab999' }]) {
    for (const argv of [['hire', 'qa', '--kickoff', 'kick/dev.md'], ['hire'], ['invite', 'x'], ['fire', 'dev'], ['list'], ['end']]) {
      const r = await f.run(argv, call)
      assert.equal(r.code, 1, argv.join(' '))
      assert.equal(r.stderr, NOT_IN_TEAM + '\n')
    }
  }
})

test('hire: kickoff refusals come before any doc or tab', async () => {
  const { f, dir, roomId, lead } = await started()
  fs.writeFileSync(path.join(dir, 'bad.md'), 'x\u0007y')
  const before = f.opens.length
  for (const [file, re] of [['missing.md', /no such file/], ['bad.md', /U\+0007/], ['kick', /is a directory/]]) {
    const r = await f.run(['hire', 'dev', '--kickoff', file], lead)
    assert.equal(r.code, 1)
    assert.match(r.stderr, re)
  }
  const none = await f.run(['hire', 'dev'], lead)
  assert.equal(none.code, 2)
  assert.match(none.stderr, /hire needs --kickoff/)
  assert.equal(f.opens.length, before)
  assert.equal(f.rooms.get(roomId).docs.size, 0)
})

test('hire: a name already in the team is refused before anything is written', async () => {
  const { f, roomId, lead } = await started()
  const room = f.rooms.get(roomId)
  room.docs.set('members/lead/kickoff.md', 'original')
  const r = await f.run(['hire', 'lead', '--kickoff', 'kick/dev.md'], lead)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /lead is already in the team/)
  assert.equal(room.docs.get('members/lead/kickoff.md'), 'original')
})

test('hire: a bad name is refused before the doc is seeded', async () => {
  const { f, roomId, lead } = await started()
  const r = await f.run(['hire', 'Dev', '--kickoff', 'kick/dev.md'], lead)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /lower-case letter/)
  assert.equal(f.rooms.get(roomId).docs.size, 0)
})

test('hire: a failed open leaves an empty doc (no doc delete in Rooms) and passes the refusal through', async () => {
  const { f, roomId, lead } = await started()
  const r = await f.run(['hire', 'dev', '--kickoff', 'kick/dev.md', '--model', 'gpt'], lead)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^rooms\.open: unknown model: gpt/)
  assert.equal(f.rooms.get(roomId).docs.get('members/dev/kickoff.md'), '')
  assert.equal(f.rooms.get(roomId).members.has('dev'), false)
})

test('hire: a failed open puts back the kickoff an earlier member of that name had', async () => {
  const { f, roomId, lead } = await started()
  f.rooms.get(roomId).docs.set('members/dev/kickoff.md', 'the old one')
  const r = await f.run(['hire', 'dev', '--kickoff', 'kick/dev.md', '--cwd', '/elsewhere'], lead)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /cwd must be inside the project folder/)
  assert.equal(f.rooms.get(roomId).docs.get('members/dev/kickoff.md'), 'the old one')
})

test('hire: a failed restore says so beside the open refusal', async () => {
  const { f, lead } = await started()
  const put = f.ctx.rooms.docs.put
  let n = 0
  f.ctx.rooms.docs.put = async (...a) => {
    if (n++ === 1) throw new Error('rooms.docs.put: a room holds at most 20 MiB of docs')
    return put(...a)
  }
  const r = await f.run(['hire', 'dev', '--kickoff', 'kick/dev.md', '--effort', 'huge'], lead)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /unknown effort: huge\n\(and members\/dev\/kickoff\.md could not be restored: .*20 MiB/)
})

test("hire: Rooms' member cap and opens-a-minute cap pass through", async () => {
  const { f, lead } = await started({ maxMembers: 2, opensPerMinute: 5 })
  assert.equal((await f.run(['hire', 'a', '--kickoff', 'kick/dev.md'], lead)).code, undefined)
  const cap = await f.run(['hire', 'b', '--kickoff', 'kick/dev.md'], lead)
  assert.equal(cap.code, 1)
  assert.match(cap.stderr, /^rooms\.open: at most 2 members a room \(membersPerRoom\)/)

  const p = await started({ opensPerMinute: 1 })
  assert.equal((await p.f.run(['hire', 'a', '--kickoff', 'kick/dev.md'], p.lead)).code, undefined)
  const rate = await p.f.run(['hire', 'b', '--kickoff', 'kick/dev.md'], p.lead)
  assert.equal(rate.code, 1)
  assert.match(rate.stderr, /at most 1 tabs a minute \(opensPerMinute\)/)
})

// --- invite, fire, list, end

test('invite: a one-time code; a coordinator invite; a taken name passes Rooms through', async () => {
  const { f, roomId, lead } = await started()
  const r = await f.run(['invite', 'ext'], lead)
  assert.equal(r.code, undefined, r.stderr)
  assert.match(r.stdout, /invite for ext: in the tab to add, run\n {2}ccc room join inv\d+\n\(one use, expires 20\d\d-/)
  const c = await f.run(['invite', 'boss', '--coordinator'], lead)
  assert.match(c.stdout, /invite for boss \(coordinator\)/)
  const invites = [...f.rooms.get(roomId).invites.values()]
  assert.deepEqual(invites.map((i) => [i.name, i.coordinator]), [['ext', false], ['boss', true]])
  const taken = await f.run(['invite', 'lead'], lead)
  assert.equal(taken.code, 1)
  assert.match(taken.stderr, /^rooms\.invite: lead is already a member/)
  assert.equal((await f.run(['invite'], lead)).code, 2)
})

test('fire: removes the member, its tab stays; an unknown name passes Rooms through', async () => {
  const { f, roomId, lead } = await started()
  await f.run(['hire', 'dev', '--kickoff', 'kick/dev.md'], lead)
  const devTab = f.opens.find((o) => o.name === 'dev').tabId
  const r = await f.run(['fire', 'dev'], lead)
  assert.equal(r.code, undefined, r.stderr)
  assert.match(r.stdout, /fired dev: its tab stays open/)
  assert.equal(f.rooms.get(roomId).members.has('dev'), false)
  assert.ok(f.sessions.has(devTab))
  assert.equal((await f.run(['list'], { tabId: devTab })).stderr, NOT_IN_TEAM + '\n')
  const gone = await f.run(['fire', 'dev'], lead)
  assert.equal(gone.code, 1)
  assert.match(gone.stderr, /^rooms\.remove: no member dev/)
})

test('list: any member; text and --json with status, held, paused', async () => {
  const { f, roomId, lead } = await started()
  await f.run(['hire', 'dev', '--kickoff', 'kick/dev.md'], lead)
  const devTab = f.opens.find((o) => o.name === 'dev').tabId
  f.emitSession({ tabId: devTab, status: 'working', sessionId: 'sess-dev' })
  f.setPaused(roomId, true)
  const text = await f.run(['list'], { tabId: devTab })
  assert.equal(text.code, undefined, text.stderr)
  assert.match(text.stdout, /^Build it \(paused\): 2 members/)
  assert.match(text.stdout, /\* lead +waiting +0 waiting/)
  assert.match(text.stdout, / {3}dev +working +0 waiting {2}\(you\)/)
  const json = JSON.parse((await f.run(['list', '--json'], lead)).stdout)
  assert.equal(json.title, 'Build it')
  assert.equal(json.paused, true)
  assert.equal(json.you, 'lead')
  assert.deepEqual(json.members.find((m) => m.name === 'dev'), { name: 'dev', coordinator: false, status: 'working', held: 0, sessionId: 'sess-dev' })
  assert.equal('sessionId' in json.members.find((m) => m.name === 'lead'), false, 'no session id: none known')
  assert.equal((await f.run(['list', 'x'], lead)).code, 2)
})

test('list: a member without a tab shows no-tab', async () => {
  const { f, roomId, lead } = await started()
  f.rooms.get(roomId).members.set('gone', { name: 'gone', coordinator: false, held: 3 })
  const json = JSON.parse((await f.run(['list', '--json'], lead)).stdout)
  assert.deepEqual(json.members.find((m) => m.name === 'gone'), { name: 'gone', coordinator: false, status: 'no-tab', held: 3 })
})

test('end: coordinator-only; ends the room, the record is marked ended, members are out', async () => {
  const { f, roomId, lead } = await started()
  await f.run(['hire', 'dev', '--kickoff', 'kick/dev.md'], lead)
  const devTab = f.opens.find((o) => o.name === 'dev').tabId
  assert.equal((await f.run(['end'], { tabId: devTab })).stderr, NOT_COORDINATOR + '\n')
  const r = await f.run(['end'], lead)
  assert.equal(r.code, undefined, r.stderr)
  assert.match(r.stdout, /team "Build it" ended/)
  assert.ok(f.rooms.get(roomId).endedAt !== undefined)
  assert.equal(f.store.get(`team:${roomId}`).endedAt, f.rooms.get(roomId).endedAt)
  assert.equal((await f.run(['list'], lead)).stderr, NOT_IN_TEAM + '\n')
  // The ended team no longer blocks a new start from the same tab.
  assert.equal((await f.run(['start', 'Next'], lead)).code, undefined)
})

test('end: usage errors (extra arguments, an empty or valueless --export)', async () => {
  const { f, lead } = await started()
  assert.equal((await f.run(['end', 'now'], lead)).code, 2)
  assert.equal((await f.run(['end', '--export'], lead)).code, 2)
  const r = await f.run(['end', '--export', ''], lead)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /usage: ccc team end \[--export <dir>\]/)
})

test('a non-Rooms failure (an RPC error) is printed, exit 1', async () => {
  const { f, lead } = await started()
  await f.run(['hire', 'dev', '--kickoff', 'kick/dev.md'], lead)
  f.ctx.rooms.remove = async () => {
    throw new Error('plugin host call timed out')
  }
  const r = await f.run(['fire', 'dev'], lead)
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'plugin host call timed out\n')
})

test('end: a failing record refresh after the room ended is logged, the command still succeeds', async () => {
  const { f, roomId, lead } = await started()
  const list = f.ctx.rooms.list
  const end = f.ctx.rooms.end
  f.ctx.rooms.end = async (...a) => {
    await end(...a)
    f.ctx.rooms.list = async () => {
      throw new Error('plugin host call timed out')
    }
  }
  const r = await f.run(['end'], lead)
  f.ctx.rooms.list = list
  f.ctx.rooms.end = end
  assert.equal(r.code, undefined, r.stderr)
  assert.match(r.stdout, /ended/)
  assert.ok(f.rooms.get(roomId).endedAt !== undefined)
})

test('fire: not yourself (it could leave no coordinator); another coordinator can be fired', async () => {
  const { f, roomId, lead } = await started()
  const self = await f.run(['fire', 'lead'], lead)
  assert.equal(self.code, 1)
  assert.match(self.stderr, /cannot fire yourself/)
  assert.equal(f.rooms.get(roomId).members.has('lead'), true)
  await f.run(['hire', 'boss', '--kickoff', 'kick/dev.md', '--coordinator'], lead)
  const ok = await f.run(['fire', 'boss'], lead)
  assert.equal(ok.code, undefined, ok.stderr)
  assert.equal(f.rooms.get(roomId).members.has('boss'), false)
})

test('hire: two hires of one name started together: one wins, the other is refused, the kickoff is the winner\'s', async () => {
  const { f, dir, roomId, lead } = await started()
  fs.writeFileSync(path.join(dir, 'kick', 'other.md'), '# other\n')
  const [a, b] = await Promise.all([
    f.run(['hire', 'dev', '--kickoff', 'kick/dev.md'], lead),
    f.run(['hire', 'dev', '--kickoff', 'kick/other.md'], lead),
  ])
  const codes = [a.code, b.code]
  assert.deepEqual(codes.sort(), [1, undefined])
  assert.match((a.code ? a : b).stderr, /dev is already being hired/)
  assert.equal(f.opens.filter((o) => o.name === 'dev').length, 1)
  assert.equal(f.rooms.get(roomId).docs.get('members/dev/kickoff.md'), a.code ? '# other\n' : '# You are dev\n')
})

test('hire: a failing docs read is refused before anything is written (no restore over an earlier kickoff)', async () => {
  const { f, roomId, lead } = await started()
  f.rooms.get(roomId).docs.set('members/dev/kickoff.md', 'the old one')
  const get = f.ctx.rooms.docs.get
  f.ctx.rooms.docs.get = async () => {
    throw new Error('plugin host call timed out')
  }
  const r = await f.run(['hire', 'dev', '--kickoff', 'kick/dev.md'], lead)
  f.ctx.rooms.docs.get = get
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'plugin host call timed out\n')
  assert.equal(f.rooms.get(roomId).docs.get('members/dev/kickoff.md'), 'the old one')
  assert.equal(f.opens.length, 0)
})

test('start: a second start from a tab that has not joined gets a fresh invite for the same room', async () => {
  const p = project()
  const first = await p.f.run(['start', 'Build it'], { tabId: 'lead-tab' })
  const second = await p.f.run(['start', 'Other', '--as', 'x'], { tabId: 'lead-tab' })
  assert.equal(second.code, undefined, second.stderr)
  assert.match(second.stdout, /already started team "Build it" and has not joined/)
  assert.notEqual(codeOf(second.stdout), codeOf(first.stdout))
  assert.equal(p.f.rooms.size, 1)
  assert.match(second.stdout, /as lead \(coordinator\)/)
  // Joining with the new code works, and after that the tab is simply in a room.
  p.f.join(codeOf(second.stdout), 'lead-tab')
  assert.match((await p.f.run(['start', 'Third'], { tabId: 'lead-tab' })).stderr, /already in a room/)
})

test('start: a transient failure while re-issuing keeps the started room; the retry re-issues, never a second room', async () => {
  const p = project()
  await p.f.run(['start', 'Build it'], { tabId: 'lead-tab' })
  for (const which of ['list', 'log', 'invite']) {
    const saved = p.f.ctx.rooms[which]
    p.f.ctx.rooms[which] = async () => {
      throw new Error('plugin host call timed out')
    }
    const failed = await p.f.run(['start', 'Build it'], { tabId: 'lead-tab' })
    p.f.ctx.rooms[which] = saved
    assert.equal(failed.code, 1, which)
    assert.equal(failed.stderr, 'plugin host call timed out\n', which)
    const retry = await p.f.run(['start', 'Build it'], { tabId: 'lead-tab' })
    assert.equal(retry.code, undefined, retry.stderr)
    assert.match(retry.stdout, /already started team "Build it" and has not joined/, `after a failing ${which}`)
    assert.equal(p.f.rooms.size, 1, `after a failing ${which}`)
  }
})

test('start: a pending room that ended meanwhile is dropped, and the start makes a new team', async () => {
  const p = project()
  await p.f.run(['start', 'Build it'], { tabId: 'lead-tab' })
  await p.f.ctx.rooms.end([...p.f.rooms.keys()][0])
  const second = await p.f.run(['start', 'Other'], { tabId: 'lead-tab' })
  assert.equal(second.code, undefined, second.stderr)
  assert.match(second.stdout, /team "Other" started/)
  assert.equal(p.f.rooms.size, 2)
})

test('start: a re-issue while the person Ends the pending team is refused inside the guard; no invite lands in the export (phase 4)', async () => {
  const p = project()
  await p.f.run(['start', 'Build it'], { tabId: 'lead-tab' })
  const roomId = [...p.f.rooms.keys()][0]
  const { teams } = host.instances()
  const invites = () => p.f.rooms.get(roomId).log.filter((e) => e.type === 'invite').length
  const before = invites()
  // The End holds the team (teams.guard.exclusive) from its catch-up to rooms.end: a join in that window would be in
  // neither the metrics nor log.jsonl.
  const r = await teams.guard.exclusive(roomId, () => p.f.run(['start', 'Build it'], { tabId: 'lead-tab' }))
  assert.equal(r.code, 1, r.stdout)
  assert.match(r.stderr, /being exported and ended/)
  assert.equal(invites(), before, 'no invite minted during the export')
  assert.equal(p.f.rooms.size, 1, 'no second room either')
  // The entry is kept: once the End let go (here: it failed, the team runs on), the retry re-issues for the same room.
  const retry = await p.f.run(['start', 'Build it'], { tabId: 'lead-tab' })
  assert.equal(retry.code, undefined, retry.stderr)
  assert.match(retry.stdout, /already started team "Build it" and has not joined/)
  assert.equal(p.f.rooms.size, 1)
})

test('start: a pending team ended while the re-issue read it is dropped inside the guard; the start makes a new team', async () => {
  const p = project()
  await p.f.run(['start', 'Build it'], { tabId: 'lead-tab' })
  const roomId = [...p.f.rooms.keys()][0]
  const { ending } = host.instances()
  // The start read the room as live and empty; the End finishes before its answer arrives (THE RULE: decided inside).
  const held = holdNext(p.f, 'list')
  const second = p.f.run(['start', 'Other'], { tabId: 'lead-tab' })
  await held.reached
  await ending.endTeam(roomId)
  const logAt = p.f.rooms.get(roomId).log.length
  held.release()
  const r = await second
  assert.equal(r.code, undefined, r.stderr)
  assert.match(r.stdout, /team "Other" started/)
  assert.equal(p.f.rooms.get(roomId).log.length, logAt, 'nothing reached the ended room')
  assert.equal(p.f.rooms.size, 2)
})

test('start: after the tab joined and left (the room empty, still live), a start makes a new team', async () => {
  const p = project()
  const first = await p.f.run(['start', 'Build it'], { tabId: 'lead-tab' })
  p.f.join(codeOf(first.stdout), 'lead-tab')
  const roomId = [...p.f.rooms.keys()][0]
  await p.f.ctx.rooms.remove(roomId, 'lead')
  const second = await p.f.run(['start', 'Other', '--as', 'boss'], { tabId: 'lead-tab' })
  assert.equal(second.code, undefined, second.stderr)
  assert.match(second.stdout, /team "Other" started\. .* as boss \(coordinator\)/)
  assert.equal(p.f.rooms.size, 2)
})

test('start: two at once from one tab make one room; the second is refused while the first runs', async () => {
  const p = project()
  const [a, b] = await Promise.all([p.f.run(['start', 'One'], { tabId: 'lead-tab' }), p.f.run(['start', 'Two'], { tabId: 'lead-tab' })])
  assert.equal(a.code, undefined, a.stderr)
  assert.equal(b.code, 1)
  assert.match(b.stderr, /already starting a team/)
  assert.equal(p.f.rooms.size, 1)
  // Once it is done, a start from the tab is answered again (here: the invite of the room already started).
  assert.match((await p.f.run(['start', 'Two'], { tabId: 'lead-tab' })).stdout, /already started team "One"/)
})

// --- THE RULE (teams.js createTeamGuard): every change decides its preconditions inside its guard, after its awaits

/**
 * Hold the answer of the next call of `ctx.rooms.<method>` until `release()`: the call reads the host at once and its
 * answer arrives late (a host call in flight while the team changes). Every other call passes. `reached` resolves when
 * the held call has read its answer (the command is past its first checks and waiting on the host).
 */
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

/** A started team with a hired member `dev`. */
async function withDev() {
  const p = await started()
  const r = await p.f.run(['hire', 'dev', '--kickoff', 'kick/dev.md'], p.lead)
  assert.equal(r.code, undefined, r.stderr)
  p.dev = { tabId: p.f.opens.find((o) => o.name === 'dev').tabId }
  return p
}

test('hire: a second hire of a name with a member list read before the first finished is refused under the lock; the kickoff stays the first\'s', async () => {
  const { f, dir, roomId } = await started()
  fs.writeFileSync(path.join(dir, 'kick', 'other.md'), '# other\n')
  const { hiring } = host.instances()
  // The second hire's caller read the members before the first hire of `dev` finished (round 8: it seeded its own
  // kickoff over the first member's until its open failed and put it back).
  const stale = await f.ctx.rooms.members(roomId)
  await hiring.hire(roomId, stale, 'dev', { kickoff: 'kick/dev.md' }, dir)
  const puts = []
  const put = f.ctx.rooms.docs.put
  f.ctx.rooms.docs.put = async (...a) => {
    puts.push(a[2])
    return put(...a)
  }
  await assert.rejects(hiring.hire(roomId, stale, 'dev', { kickoff: 'kick/other.md' }, dir), /dev is already in the team/)
  f.ctx.rooms.docs.put = put
  assert.deepEqual(puts, [], 'nothing seeded, not even for a moment')
  assert.equal(f.rooms.get(roomId).docs.get('members/dev/kickoff.md'), '# You are dev\n')
  assert.equal(f.opens.filter((o) => o.name === 'dev').length, 1)
})

test('ask: a member lookup that finishes after an End stores nothing on the ended team (round 8)', async () => {
  const { f, roomId, dev } = await withDev()
  const { ending, teams } = host.instances()
  const held = holdNext(f, 'members')
  const asked = f.run(['ask', 'Which db?'], dev)
  await held.reached
  await ending.endTeam(roomId)
  held.release()
  const r = await asked
  assert.equal(r.code, 1)
  assert.equal(r.stderr, `${NOT_IN_TEAM}\n`)
  assert.equal((await teams.get(roomId)).questions.length, 0)
  assert.equal(f.notices.length, 0)
})

test('ask: an asker fired while its lookup was on the way stores nothing', async () => {
  const { f, roomId, lead, dev } = await withDev()
  const { teams } = host.instances()
  const held = holdNext(f, 'members')
  const asked = f.run(['ask', 'Which db?'], dev)
  await held.reached
  // The lookup read the list before the fire: the asker looks like a member until the guard reads it again.
  assert.equal((await f.run(['fire', 'dev'], lead)).code, undefined)
  held.release()
  const r = await asked
  assert.equal(r.code, 1)
  assert.equal(r.stderr, `${NOT_IN_TEAM}\n`)
  assert.equal((await teams.get(roomId)).questions.length, 0)
})

test('ask: a fire of the asker while the ask\'s own member read is answering is refused; the question is for a member (round 9)', async () => {
  const { f, roomId, lead, dev } = await withDev()
  const { teams } = host.instances()
  // The second read is the ask's own, under the asker's name lock: it has answered (dev is in it), the answer is on
  // its way back, and a fire of dev lands in between (round 9 stored the question for a member already gone).
  const held = holdNext(f, 'members', 1)
  const asked = f.run(['ask', 'Which db?'], dev)
  await held.reached
  const fired = await f.run(['fire', 'dev'], lead)
  assert.equal(fired.code, 1)
  assert.match(fired.stderr, /dev is asking a question: try again in a moment/)
  held.release()
  const r = await asked
  assert.equal(r.code, undefined, r.stderr)
  const rec = await teams.get(roomId)
  assert.deepEqual(rec.questions.map((q) => q.from), ['dev'])
  assert.ok((await f.ctx.rooms.members(roomId)).some((m) => m.name === 'dev' && m.tabId === dev.tabId), 'the asker is still in the team')
  assert.equal(f.notices.length, 1)
  // Released with the ask: the fire goes through now.
  assert.equal((await f.run(['fire', 'dev'], lead)).code, undefined)
})

test('ask: the panel\'s Fire (hiring.fire) of the asker is refused the same way while the ask holds the name', async () => {
  const { f, roomId, dev } = await withDev()
  const { hiring, teams } = host.instances()
  const held = holdNext(f, 'members', 1)
  const asked = f.run(['ask', 'Which db?'], dev)
  await held.reached
  await assert.rejects(hiring.fire(roomId, 'dev'), (e) => e.code === 'ask-pending' && /dev is asking a question/.test(e.message))
  held.release()
  assert.equal((await asked).code, undefined)
  assert.equal((await teams.get(roomId)).questions.length, 1)
})

test('ask: a hire of the asker\'s name in flight refuses the ask (the name is the hire\'s)', async () => {
  const { f, roomId, lead } = await withDev()
  const { hiring } = host.instances()
  // dev is fired, then rehired; dev's old tab asks while the hire holds the name.
  assert.equal((await f.run(['fire', 'dev'], lead)).code, undefined)
  const open = f.ctx.rooms.open
  let ask
  f.ctx.rooms.open = async (...a) => {
    ask = await hiring.names.hold(roomId, 'dev', 'ask', async () => 'ran').then((x) => x, (e) => e)
    return open(...a)
  }
  assert.equal((await f.run(['hire', 'dev', '--kickoff', 'kick/dev.md'], lead)).code, undefined)
  f.ctx.rooms.open = open
  assert.equal(ask.code, 'hire-pending')
})

test('mark: a coordinator fired while its mark waits on its member read is refused; nothing is marked', async () => {
  const { f, roomId, lead } = await withDev()
  const { teams } = host.instances()
  assert.equal((await f.run(['hire', 'co', '--kickoff', 'kick/dev.md', '--coordinator'], lead)).code, undefined)
  const co = { tabId: f.opens.find((o) => o.name === 'co').tabId }
  // The first read is the command's coordinator check: co is fired after it, before the mark takes co's name.
  const held = holdNext(f, 'members')
  const marked = f.run(['mark', 'v1'], co)
  await held.reached
  assert.equal((await f.run(['fire', 'co'], lead)).code, undefined)
  held.release()
  const r = await marked
  assert.equal(r.code, 1)
  assert.equal(r.stderr, `${NOT_IN_TEAM}\n`)
  assert.equal((await teams.get(roomId)).marks.length, 0)
})

test('mark: a fire of the marking coordinator while the mark holds its name is refused; the mark is a member\'s', async () => {
  const { f, roomId, lead } = await withDev()
  const { teams } = host.instances()
  assert.equal((await f.run(['hire', 'co', '--kickoff', 'kick/dev.md', '--coordinator'], lead)).code, undefined)
  const co = { tabId: f.opens.find((o) => o.name === 'co').tabId }
  const held = holdNext(f, 'members', 1)
  const marked = f.run(['mark', 'v1'], co)
  await held.reached
  const fired = await f.run(['fire', 'co'], lead)
  assert.equal(fired.code, 1)
  assert.match(fired.stderr, /co is setting a mark: try again in a moment/)
  held.release()
  assert.equal((await marked).code, undefined)
  assert.deepEqual((await teams.get(roomId)).marks.map((m) => m.by), ['co'])
  assert.ok((await f.ctx.rooms.members(roomId)).some((m) => m.name === 'co'))
})

test('mark: a member\'s mark is decided on the list read inside: a member that is not a coordinator there is refused', async () => {
  const { f, roomId } = await withDev()
  const { metrics, hiring, teams } = host.instances()
  // dev is a plain member: a mark in its name, checked inside, is refused as not the coordinator.
  const dev = (await f.ctx.rooms.members(roomId)).find((m) => m.name === 'dev')
  await assert.rejects(metrics.mark(roomId, 'v1', 'dev', { names: hiring.names, tabId: dev.tabId }), (e) => e.code === 'not-coordinator')
  assert.equal((await teams.get(roomId)).marks.length, 0)
})

test('done and reply: a Done takes no name (it acts on the question); a reply and an ask of one name run together', async () => {
  const { f, roomId, dev } = await withDev()
  const { questions, hiring } = host.instances()
  assert.equal((await f.run(['ask', 'first?'], dev)).code, undefined)
  // An ask by dev while an answer to dev is on its way: both only need dev to stay, so neither refuses the other.
  let during
  const send = f.ctx.rooms.send
  f.ctx.rooms.send = async (...a) => {
    f.ctx.rooms.send = send
    during = await f.run(['ask', 'second?'], dev)
    return send(...a)
  }
  await questions.reply(roomId, 'q1', 'yes')
  assert.equal(during.code, undefined, during.stderr)
  // A Done while a fire holds the asker's name: the Done does not touch the name, so it is not refused by it.
  const ok = await hiring.names.hold(roomId, 'dev', 'fire', () => questions.done(roomId, 'q2'))
  assert.equal(ok.id, 'q2')
})

for (const [what, argv, check] of [
  ['hire', ['hire', 'qa', '--kickoff', 'kick/dev.md'], (f, roomId) => {
    assert.equal(f.rooms.get(roomId).docs.has('members/qa/kickoff.md'), false)
    assert.equal(f.opens.some((o) => o.name === 'qa'), false)
  }],
  ['fire', ['fire', 'dev'], () => {}],
  ['invite', ['invite', 'qa'], (f, roomId) => assert.equal(f.rooms.get(roomId).log.some((e) => e.type === 'invite' && e.member === 'qa'), false)],
  ['mark', ['mark', 'v1'], async (f, roomId) => assert.equal((await host.instances().teams.get(roomId)).marks.length, 0)],
]) {
  test(`${what}: a coordinator check that finishes after an End is refused inside the guard; nothing is written`, async () => {
    const { f, roomId, lead } = await withDev()
    const { ending } = host.instances()
    const held = holdNext(f, 'members')
    const pending = f.run(argv, lead)
    await held.reached
    await ending.endTeam(roomId)
    const logAt = f.rooms.get(roomId).log.length
    held.release()
    const r = await pending
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stderr, /team has ended/)
    assert.equal(f.rooms.get(roomId).log.length, logAt, 'nothing reached the room')
    await check(f, roomId)
  })
}

test('panel hire: a team ended while the panel read its members is refused inside the guard', async () => {
  const { f, roomId } = await withDev()
  const { ending, panel } = host.instances()
  const held = holdNext(f, 'members')
  const before = f.posts.length
  const done = panel.onMessage({ type: 'hire', req: 1, roomId, name: 'qa', kickoff: 'kick/dev.md' }, { view: 'desktop' })
  await held.reached
  await ending.endTeam(roomId)
  held.release()
  await done
  const res = f.posts.slice(before).find(([, x]) => x.type === 'result')
  assert.equal(res[1].ok, false)
  assert.match(res[1].error, /team has ended/)
  assert.equal(f.opens.some((o) => o.name === 'qa'), false)
})

// --- split panes (rooms.open beside / side)

const placeOf = (f, name) => {
  const o = f.opens.find((x) => x.name === name)
  return { beside: o.beside, side: o.side }
}
async function hireAll(p, names) {
  for (const n of names) {
    const r = await p.f.run(['hire', n, '--kickoff', 'kick/dev.md'], p.lead)
    assert.equal(r.code, undefined, r.stderr)
  }
}

test('hire: column (default): members stack below one another on the right; the 4th other member is plain once the app refuses', async () => {
  const p = await started()
  await hireAll(p, ['a', 'b', 'c'])
  const rd = await p.f.run(['hire', 'd', '--kickoff', 'kick/dev.md'], p.lead)
  assert.match(rd.stdout, /plain tab \(the app did not place it: the group is full or a pane would be too small\)/)
  const tabOf = (n) => p.f.rooms.get(p.roomId).members.get(n).tabId
  assert.deepEqual(placeOf(p.f, 'a'), { beside: 'lead-tab', side: 'right' })
  assert.deepEqual(placeOf(p.f, 'b'), { beside: tabOf('a'), side: 'down' })
  assert.deepEqual(placeOf(p.f, 'c'), { beside: tabOf('b'), side: 'down' })
  // Still asked: the app (here the fake, group of 4) answers placed false.
  assert.deepEqual(placeOf(p.f, 'd'), { beside: tabOf('c'), side: 'down' })
  assert.equal(p.f.groups.get('lead-tab').length, 4)
})

test('hire: layout grid is the 2x2', async () => {
  const p = await started({ app: { layout: 'grid' } })
  await hireAll(p, ['a', 'b', 'c', 'd'])
  const tabOf = (n) => p.f.rooms.get(p.roomId).members.get(n).tabId
  assert.deepEqual(placeOf(p.f, 'a'), { beside: 'lead-tab', side: 'right' })
  assert.deepEqual(placeOf(p.f, 'b'), { beside: 'lead-tab', side: 'down' })
  assert.deepEqual(placeOf(p.f, 'c'), { beside: tabOf('a'), side: 'down' })
  assert.deepEqual(placeOf(p.f, 'd'), { beside: undefined, side: undefined })
})

test('hire: layout tabs opens every member plain', async () => {
  const p = await started({ app: { layout: 'tabs' } })
  await hireAll(p, ['a'])
  assert.deepEqual(placeOf(p.f, 'a'), { beside: undefined, side: undefined })
})

test('hire output says where the tab opened', async () => {
  const p = await started()
  const r = await p.f.run(['hire', 'a', '--kickoff', 'kick/dev.md'], p.lead)
  assert.match(r.stdout, /^hired a: its tab opened as a split pane right of lead \(kickoff in its first prompt; also in members\/a\/kickoff\.md\)/)
  const r1 = await p.f.run(['hire', 'b', '--kickoff', 'kick/dev.md'], p.lead)
  assert.match(r1.stdout, /split pane below a \(/)
  const q = await started({ app: { layout: 'tabs' } })
  const r2 = await q.f.run(['hire', 'a', '--kickoff', 'kick/dev.md'], q.lead)
  assert.match(r2.stdout, /plain tab \(split panes off\)/)
  const o = await started({ noBeside: true })
  const r3 = await o.f.run(['hire', 'a', '--kickoff', 'kick/dev.md'], o.lead)
  assert.doesNotMatch(r3.stdout, /split pane|plain tab/)
})

test('hire: placed false (pane too small) is a plain tab, no retry, the hire stands', async () => {
  const p = await started()
  p.f.tooSmall.add('lead-tab')
  await hireAll(p, ['a'])
  assert.equal(p.f.opens.filter((o) => o.name === 'a').length, 1)
  assert.ok(p.f.rooms.get(p.roomId).members.has('a'))
  assert.equal(p.f.groups.has('lead-tab'), false)
})

test('hire: the column lands in one group of 4 in the fake, as in the app', async () => {
  const p = await started()
  await hireAll(p, ['a', 'b', 'c'])
  assert.equal(p.f.groups.get('lead-tab').length, 4)
})

test('hire: an anchor gone from the window is retried once as a plain tab, costing one open', async () => {
  const p = await started({ opensPerMinute: 2 })
  // The member list still names the lead's tab, but the window no longer has it.
  p.f.sessions.delete('lead-tab')
  await hireAll(p, ['a'])
  const opens = p.f.opens.filter((o) => o.name === 'a')
  assert.equal(opens.length, 1)
  assert.equal(opens[0].beside, undefined)
  assert.ok(p.f.rooms.get(p.roomId).members.has('a'))
})

test('hire: other open refusals are not retried', async () => {
  const p = await started({ opensPerMinute: 1 })
  await hireAll(p, ['b'])
  const r = await p.f.run(['hire', 'a', '--kickoff', 'kick/dev.md'], p.lead)
  assert.notEqual(r.code, undefined)
  assert.match(r.stderr, /tabs a minute/)
})

test('hire: the old splitPanes false setting reads as tabs', async () => {
  const p = await started({ app: { splitPanes: false } })
  await hireAll(p, ['a', 'b'])
  assert.deepEqual(placeOf(p.f, 'a'), { beside: undefined, side: undefined })
  assert.deepEqual(placeOf(p.f, 'b'), { beside: undefined, side: undefined })
})

test('hire: an older app ignores beside and answers no placed; the hire works', async () => {
  const p = await started({ noBeside: true })
  await hireAll(p, ['a', 'b'])
  assert.ok(p.f.rooms.get(p.roomId).members.has('b'))
})
