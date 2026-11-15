'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const host = require('../dist/host.js')
const { fakeCtx } = require('./fake-ctx')
const { parseArgs, UsageError } = require('../lib/commands.js')
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
  assert.match(bad.stderr, /^rooms\.create: title is 1-60 characters/)
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

test('start: usage errors exit 2', async () => {
  const { f } = project()
  const r = await f.run(['start'], { tabId: 'lead-tab' })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /missing argument\nusage: ccc team start/)
})

// --- hire

test('hire: seeds the kickoff, opens the tab with the fixed prompt and the options', async () => {
  const { f, dir, roomId, lead } = await started()
  fs.mkdirSync(path.join(dir, 'wt'))
  const r = await f.run(['hire', 'dev', '--kickoff', 'kick/dev.md', '--model', 'sonnet', '--effort', 'high', '--cwd', 'wt'], lead)
  assert.equal(r.code, undefined, r.stderr)
  assert.match(r.stdout, /hired dev/)
  const room = f.rooms.get(roomId)
  assert.equal(room.docs.get('members/dev/kickoff.md'), '# You are dev\n')
  const open = f.opens.find((o) => o.name === 'dev')
  assert.equal(open.prompt, 'Read your kickoff: ccc room doc get members/dev/kickoff.md')
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
  f.emitSession({ tabId: devTab, status: 'working' })
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
  assert.deepEqual(json.members.find((m) => m.name === 'dev'), { name: 'dev', coordinator: false, status: 'working', held: 0 })
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

test('end: --export is not part of this version yet (usage error); extra arguments too', async () => {
  const { f, lead } = await started()
  assert.equal((await f.run(['end', '--export', '/tmp'], lead)).code, 2)
  assert.equal((await f.run(['end', 'now'], lead)).code, 2)
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
