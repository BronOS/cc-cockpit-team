'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const host = require('../dist/host.js')
const { fakeCtx } = require('./fake-ctx')
const { createEnding, exportTeam, checkDocPath, docClash, slugOf, stampOf } = require('../lib/export.js')

test.afterEach(() => host.deactivate())

const dirs = []
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  dirs.push(d)
  return d
}

/** A started team (`lead` joined), one hired member `dev`, an `out` folder for exports. */
async function team(opts = {}) {
  const dir = tmp('team-exp-')
  fs.writeFileSync(path.join(dir, 'dev.md'), '# You are dev\n')
  const out = path.join(dir, 'out')
  fs.mkdirSync(out)
  const f = fakeCtx({ projectDir: dir, ...opts })
  host.activate(f.ctx)
  f.emitSession({ tabId: 'lead-tab', status: 'waiting' })
  const lead = { tabId: 'lead-tab', cwd: dir }
  const r = await f.run(['start', 'Checkout v2'], lead)
  assert.equal(r.code, undefined, r.stderr)
  f.join(/ccc room join (\S+)/.exec(r.stdout)[1], 'lead-tab')
  assert.equal((await f.run(['hire', 'dev', '--kickoff', 'dev.md', '--model', 'opus'], lead)).code, undefined)
  const roomId = [...f.rooms.keys()][0]
  const devTab = f.opens.find((o) => o.name === 'dev').tabId
  return { f, dir, out, lead, roomId, dev: { tabId: devTab } }
}

const only = (dir) => {
  const names = fs.readdirSync(dir)
  assert.equal(names.length, 1, `one folder in ${dir}: ${names}`)
  return path.join(dir, names[0])
}

test('checkDocPath: Rooms\' rule again', () => {
  for (const ok of ['shared/a.md', 'shared/a/b/c/d.md', 'members/dev/kickoff.md', 'members/a-1/x/y.txt', 'shared/.hidden']) {
    assert.ok(checkDocPath(ok), ok)
  }
  for (const bad of [
    'shared',
    'shared/',
    'shared/../x',
    'shared/./x',
    'shared/a/b/c/d/e.md',
    'members/Dev/x',
    'members/dev',
    'members/../x',
    'other/x',
    '/shared/x',
    'shared/a b',
    'shared/a\\b',
    'shared/' + 'a'.repeat(129),
    'shared//x',
    null,
  ]) {
    assert.equal(checkDocPath(bad), null, String(bad))
  }
})

test('slugOf and stampOf', () => {
  assert.equal(slugOf('Checkout v2'), 'checkout-v2')
  assert.equal(slugOf('  --Über: API!! '), 'ber-api')
  assert.equal(slugOf('日本'), 'team')
  assert.equal(slugOf('x'.repeat(80)).length, 40)
  assert.equal(stampOf(new Date(2026, 10, 5, 7, 3).getTime()), '20261105-0703')
})

test('end --export: the full folder, then the room ends', async () => {
  const { f, out, lead, roomId, dev } = await team()
  f.emitSession({ tabId: dev.tabId, status: 'working', costUsd: 0.75 })
  await f.ctx.rooms.docs.put(roomId, 'shared/plan/notes.md', 'the plan\n')
  await f.ctx.rooms.send(roomId, 'dev', 'hello')
  assert.equal((await f.run(['mark', 'design done'], lead)).code, undefined)
  assert.match((await f.run(['ask', 'Which db?\nPostgres or SQLite'], dev)).stdout, /asked q1/)
  await host.instances().questions.reply(roomId, 'q1', 'Postgres')
  assert.match((await f.run(['ask', 'Second | one'], dev)).stdout, /asked q2/)

  const r = await f.run(['end', '--export', 'out'], lead)
  assert.equal(r.code, undefined, r.stderr)
  const folder = only(out)
  assert.match(path.basename(folder), /^checkout-v2-\d{8}-\d{4}$/)
  assert.match(r.stdout, new RegExp(`exported to ${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(r.stdout, /ended/)
  assert.ok(f.rooms.get(roomId).endedAt !== undefined)

  assert.deepEqual(fs.readdirSync(folder).sort(), ['docs', 'log.jsonl', 'metrics.json', 'metrics.md', 'questions.md'])
  assert.equal(fs.readFileSync(path.join(folder, 'docs/shared/plan/notes.md'), 'utf8'), 'the plan\n')
  assert.equal(fs.readFileSync(path.join(folder, 'docs/members/dev/kickoff.md'), 'utf8'), '# You are dev\n')

  const log = fs.readFileSync(path.join(folder, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(log[0].type, 'create')
  assert.deepEqual(log.map((e) => e.seq), log.map((_, i) => i + 1))
  assert.ok(log.some((e) => e.type === 'send' && e.text === 'hello'))

  const m = JSON.parse(fs.readFileSync(path.join(folder, 'metrics.json'), 'utf8'))
  assert.equal(m.title, 'Checkout v2')
  assert.ok(Number.isFinite(m.exportedAt))
  assert.equal(m.endedAt, m.exportedAt)
  assert.deepEqual(m.spans.map((s) => `${s.from}>${s.to}`), ['start>design done', 'design done>end'])
  assert.equal(m.totals.costUsd, 0.75)
  assert.deepEqual(m.questions, { asked: 2, answered: 1, open: 1 })
  const devM = m.members.find((x) => x.name === 'dev')
  assert.equal(devM.model, 'opus')
  // Internal bookkeeping stays out of the export.
  assert.ok(!('costTab' in devM) && !('costRaw' in devM))
  assert.ok(!JSON.stringify(m).includes('costRaw'))

  const md = fs.readFileSync(path.join(folder, 'metrics.md'), 'utf8')
  assert.match(md, /^# Checkout v2: metrics/)
  assert.match(md, /## Spans \(split at marks\)/)
  assert.match(md, /\| start \| design done \|/)
  assert.match(md, /\| design done \| end \|/)
  assert.match(md, /a proxy/)
  assert.match(md, /\| dev \| opus \|/)

  // Owner-only: members' private docs and the log's messages are not for other users of the machine.
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(folder, 'docs/members/dev')).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(folder, 'log.jsonl')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(folder, 'docs/shared/plan/notes.md')).mode & 0o777, 0o600)

  const q = fs.readFileSync(path.join(folder, 'questions.md'), 'utf8')
  assert.match(q, /2 asked, 1 answered, 1 open/)
  assert.match(q, /## q1 from dev: answered/)
  assert.match(q, /> Which db\?\n> Postgres or SQLite/)
  assert.match(q, /## q2 from dev: open/)
  assert.match(q, /> Second \| one/)
})

test('a message sent right before the end is in the export\'s metrics as in its log (the log is drained first)', async () => {
  const { f, out, lead, roomId } = await team()
  await host.instances().metrics.poll()
  // As Rooms logs a member's own send: no poll ran since.
  f.pushLog(roomId, { type: 'send', from: 'lead', to: 'dev', text: 'last words', delivery: [{ to: 'dev', path: 'delivered' }] })
  const r = await f.run(['end', '--export', out], lead)
  assert.equal(r.code, undefined, r.stderr)
  const m = JSON.parse(fs.readFileSync(path.join(only(out), 'metrics.json'), 'utf8'))
  assert.equal(m.members.find((x) => x.name === 'lead').sent, 1)
  assert.equal(m.members.find((x) => x.name === 'dev').received, 1)
})

test('a backlog longer than one poll\'s pages is drained before the stats: the metrics count what log.jsonl holds', async () => {
  // One entry a page: 30 sends are more than one poll reads (LOG_PAGES_PER_POLL, 20 pages).
  const { f, out, lead, roomId } = await team({ logPageBytes: 1 })
  await host.instances().metrics.poll()
  await host.instances().metrics.poll()
  for (let i = 0; i < 30; i++) f.pushLog(roomId, { type: 'send', from: 'lead', to: 'dev', text: `m${i}`, delivery: [{ to: 'dev', path: 'delivered' }] })
  const r = await f.run(['end', '--export', out], lead)
  assert.equal(r.code, undefined, r.stderr)
  const folder = only(out)
  const sends = fs.readFileSync(path.join(folder, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'send' && e.from === 'lead')
  assert.equal(sends.length, 30)
  const m = JSON.parse(fs.readFileSync(path.join(folder, 'metrics.json'), 'utf8'))
  assert.equal(m.members.find((x) => x.name === 'lead').sent, 30)
  assert.equal(m.members.find((x) => x.name === 'dev').received, 30)
})

test('a message sent while the export runs: log.jsonl stops where the stats were taken, both name that entry', async () => {
  const { f, out, lead, roomId } = await team()
  await f.ctx.rooms.docs.put(roomId, 'shared/a.md', 'A')
  await f.ctx.rooms.send(roomId, 'dev', 'before')
  // A member still sends while the export writes the docs (the room is live until rooms.end): after the stats.
  const get = f.ctx.rooms.docs.get
  let during = 0
  f.ctx.rooms.docs.get = async (...a) => {
    if (during++ === 0) f.pushLog(roomId, { type: 'send', from: 'lead', to: 'dev', text: 'during', delivery: [{ to: 'dev', path: 'delivered' }] })
    return get(...a)
  }
  const r = await f.run(['end', '--export', out], lead)
  f.ctx.rooms.docs.get = get
  assert.equal(r.code, undefined, r.stderr)
  const folder = only(out)
  const log = fs.readFileSync(path.join(folder, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const m = JSON.parse(fs.readFileSync(path.join(folder, 'metrics.json'), 'utf8'))
  const sentIn = (name) => log.filter((e) => e.type === 'send' && e.from === name).length
  const gotIn = (name, p) => log.filter((e) => e.type === 'send' && (e.delivery || []).some((d) => d.to === name && d.path === p)).length
  assert.ok(log.some((e) => e.type === 'send' && e.text === 'before'))
  assert.ok(!log.some((e) => e.type === 'send' && e.text === 'during'), 'the late send is in neither')
  assert.equal(m.members.find((x) => x.name === 'lead').sent ?? 0, sentIn('lead'))
  assert.equal(m.members.find((x) => x.name === 'dev').received ?? 0, gotIn('dev', 'delivered'))
  assert.equal(m.members.find((x) => x.name === 'dev').held ?? 0, gotIn('dev', 'held'))
  assert.equal(m.logSeq, log[log.length - 1].seq)
  assert.match(fs.readFileSync(path.join(folder, 'metrics.md'), 'utf8'), new RegExp(`up to entry ${m.logSeq}\\b`))
  assert.ok(f.rooms.get(roomId).endedAt !== undefined)
})

test('a log read failing in the metrics catch-up fails the export: the team keeps running, nothing is written', async () => {
  const { f, out, lead, roomId } = await team()
  await host.instances().metrics.poll()
  f.pushLog(roomId, { type: 'send', from: 'lead', to: 'dev', text: 'unread', delivery: [{ to: 'dev', path: 'delivered' }] })
  // The metrics' reads fail; the export's own (after docs.list) would work, so only the catch-up can refuse.
  const log = f.ctx.rooms.log
  const list = f.ctx.rooms.docs.list
  let failing = true
  f.ctx.rooms.log = async (...a) => {
    if (failing) throw new Error('plugin host call timed out')
    return log(...a)
  }
  f.ctx.rooms.docs.list = async (...a) => {
    failing = false
    return list(...a)
  }
  const r = await f.run(['end', '--export', out], lead)
  f.ctx.rooms.log = log
  f.ctx.rooms.docs.list = list
  assert.equal(r.code, 1)
  assert.match(r.stderr, /export failed, the team is still running: .*plugin host call timed out/)
  assert.deepEqual(fs.readdirSync(out), [])
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
})

test('end without --export uses the Export folder setting; none when both are empty', async () => {
  {
    const { f, out, lead, roomId } = await team()
    f.ctx.settings.app.exportDir = 'out'
    const r = await f.run(['end'], lead)
    assert.equal(r.code, undefined, r.stderr)
    assert.match(r.stdout, /exported to /)
    assert.ok(fs.existsSync(path.join(only(out), 'metrics.json')))
    assert.ok(f.rooms.get(roomId).endedAt !== undefined)
    host.deactivate()
  }
  {
    const { f, out, lead, roomId } = await team()
    f.ctx.settings.app.exportDir = '  '
    const r = await f.run(['end'], lead)
    assert.equal(r.code, undefined, r.stderr)
    assert.match(r.stdout, /not exported/)
    assert.deepEqual(fs.readdirSync(out), [])
    assert.ok(f.rooms.get(roomId).endedAt !== undefined)
  }
})

test('settingDir: ~ is the home folder, relative is the project\'s, absolute stays', async () => {
  const f = fakeCtx({ projectDir: '/proj' })
  const e = createEnding(f.ctx, null, null)
  assert.equal(e.settingDir(), null)
  f.ctx.settings.app.exportDir = '~/exports'
  assert.equal(e.settingDir(), path.join(os.homedir(), 'exports'))
  f.ctx.settings.app.exportDir = 'exports'
  assert.equal(e.settingDir(), path.resolve('/proj', 'exports'))
  f.ctx.settings.app.exportDir = '/data/x'
  assert.equal(e.settingDir(), path.resolve('/data/x'))
})

test('an existing folder is refused, never written into; the room keeps running', async () => {
  const { f, out, lead, roomId } = await team()
  const t = new Date(2026, 10, 15, 9, 30).getTime()
  const { teams, metrics } = host.instances()
  const ending = createEnding(f.ctx, teams, metrics, { now: () => t })
  const target = path.join(out, `checkout-v2-${stampOf(t)}`)
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'keep.txt'), 'mine')
  await assert.rejects(ending.endTeam(roomId, { dir: out }), /export failed, the team is still running: .*already exists/)
  assert.deepEqual(fs.readdirSync(target), ['keep.txt'])
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
  // Still the coordinator's team: a later end works.
  assert.equal((await f.run(['list'], lead)).code, undefined)
})

test('a symlink in the folder\'s place is refused and its target untouched', async () => {
  const { f, out, roomId } = await team()
  const t = new Date(2026, 10, 15, 9, 31).getTime()
  const { teams, metrics } = host.instances()
  const ending = createEnding(f.ctx, teams, metrics, { now: () => t })
  const elsewhere = tmp('team-elsewhere-')
  fs.symlinkSync(elsewhere, path.join(out, `checkout-v2-${stampOf(t)}`))
  await assert.rejects(ending.endTeam(roomId, { dir: out }), /already exists/)
  assert.deepEqual(fs.readdirSync(elsewhere), [])
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
})

test('a symlink planted where a file goes is not followed; what the export wrote is removed', async () => {
  const { f, out, lead, roomId } = await team()
  const victim = path.join(tmp('team-victim-'), 'victim.txt')
  fs.writeFileSync(victim, 'original')
  // Plant the link while the log is being read (after the folder exists, before metrics.json is written).
  const log = f.ctx.rooms.log
  f.ctx.rooms.log = async (...a) => {
    // The metrics' own polls read the log too: act only once the export's folder exists.
    const names = fs.readdirSync(out)
    const link = names.length === 1 ? path.join(out, names[0], 'metrics.json') : null
    if (link && !fs.existsSync(link)) fs.symlinkSync(victim, link)
    return log(...a)
  }
  const r = await f.run(['end', '--export', out], lead)
  f.ctx.rooms.log = log
  assert.equal(r.code, 1)
  assert.match(r.stderr, /export failed, the team is still running: .*EEXIST/)
  assert.equal(fs.readFileSync(victim, 'utf8'), 'original')
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
  // Only the planted link is left (not ours to remove), so its folder stays; every file the export wrote is gone.
  const folder = only(out)
  assert.deepEqual(fs.readdirSync(folder), ['metrics.json'])
  assert.ok(fs.lstatSync(path.join(folder, 'metrics.json')).isSymbolicLink())
})

test('a bad doc path refuses the export before anything is written', async () => {
  const { f, out, lead, roomId } = await team()
  f.rooms.get(roomId).docs.set('shared/../../escape.md', 'x')
  const r = await f.run(['end', '--export', out], lead)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /export failed, the team is still running: a doc path Rooms should not have given/)
  assert.deepEqual(fs.readdirSync(out), [])
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
})

test('docs that cannot both be files (case, a doc that is a folder) refuse the export before anything is written', async () => {
  assert.equal(docClash(['shared/a.md', 'shared/b/a.md', 'members/dev/kickoff.md']), null)
  assert.deepEqual(docClash(['shared/Notes.md', 'shared/notes.md']), ['shared/Notes.md', 'shared/notes.md'])
  assert.deepEqual(docClash(['shared/a', 'shared/a/b']), ['shared/a', 'shared/a/b'])
  assert.deepEqual(docClash(['shared/A/b', 'shared/a']), ['shared/a', 'shared/A/b'])
  for (const pair of [['shared/Notes.md', 'shared/notes.md'], ['shared/a', 'shared/a/b']]) {
    const { f, out, lead, roomId } = await team()
    for (const p of pair) f.rooms.get(roomId).docs.set(p, 'x')
    const r = await f.run(['end', '--export', out], lead)
    assert.equal(r.code, 1)
    assert.match(r.stderr, new RegExp(`export failed, the team is still running: the docs ${pair[0]} and ${pair[1]} cannot both be written`))
    assert.deepEqual(fs.readdirSync(out), [])
    assert.equal(f.rooms.get(roomId).endedAt, undefined)
    host.deactivate()
  }
})

test('a missing folder, a file as the folder and a failing Rooms call keep the room; partial output is removed', async () => {
  const { f, dir, out, lead, roomId } = await team()
  let r = await f.run(['end', '--export', 'nope'], lead)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /no such folder: .*nope/)
  fs.writeFileSync(path.join(dir, 'file'), '')
  r = await f.run(['end', '--export', 'file'], lead)
  assert.match(r.stderr, /not a folder/)

  const get = f.ctx.rooms.docs.get
  f.ctx.rooms.docs.get = async () => {
    throw new Error('plugin host call timed out')
  }
  r = await f.run(['end', '--export', out], lead)
  f.ctx.rooms.docs.get = get
  assert.equal(r.code, 1)
  assert.match(r.stderr, /export failed, the team is still running: plugin host call timed out/)
  assert.deepEqual(fs.readdirSync(out), [])
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
})

test('a failing end after a written export says where the export is', async () => {
  const { f, out, lead, roomId } = await team()
  f.ctx.rooms.end = async () => {
    throw new Error('rooms.end: refused')
  }
  const r = await f.run(['end', '--export', out], lead)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /rooms\.end: refused\n\(the export was written to .*checkout-v2-/)
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
})

test('log.jsonl pages through a long log to the end', async () => {
  const { f, out, lead, roomId } = await team()
  for (let i = 0; i < 2500; i++) f.pushLog(roomId, { type: 'doc-read', by: 'dev', path: 'shared/x' })
  assert.equal((await f.run(['end', '--export', out], lead)).code, undefined)
  const lines = fs.readFileSync(path.join(only(out), 'log.jsonl'), 'utf8').trim().split('\n')
  const seqs = lines.map((l) => JSON.parse(l).seq)
  // To the stats' cursor: every entry before the export (the export's own doc reads and the end come after it).
  const { logSeq } = JSON.parse(fs.readFileSync(path.join(only(out), 'metrics.json'), 'utf8'))
  assert.ok(logSeq > 2500)
  assert.ok(!lines.some((l) => JSON.parse(l).by === 'plugin' && JSON.parse(l).type === 'doc-read'))
  assert.deepEqual(seqs, Array.from({ length: logSeq }, (_, i) => i + 1))
  assert.ok(f.rooms.get(roomId).log.length > logSeq)
})

test('a reply during the export is refused (the team is held); the export and the record agree it is open', async () => {
  const { f, out, lead, roomId, dev } = await team()
  assert.match((await f.run(['ask', 'Which db?'], dev)).stdout, /asked q1/)
  // A reply tried after the stats and the log cursor were taken (docs.list is the export's first Rooms call).
  const list = f.ctx.rooms.docs.list
  let refused = null
  f.ctx.rooms.docs.list = async (...args) => {
    if (!refused) refused = await host.instances().questions.reply(roomId, 'q1', 'Postgres').then(() => 'replied', (e) => e)
    return list(...args)
  }
  const r = await f.run(['end', '--export', out], lead)
  f.ctx.rooms.docs.list = list
  assert.equal(r.code, undefined, r.stderr)
  assert.match(refused.message, /^the team is being exported and ended: try again in a moment$/)
  assert.equal(refused.code, 'exporting')
  const folder = only(out)
  const m = JSON.parse(fs.readFileSync(path.join(folder, 'metrics.json'), 'utf8'))
  assert.deepEqual(m.questions, { asked: 1, answered: 0, open: 1 })
  const log = fs.readFileSync(path.join(folder, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(!log.some((e) => e.type === 'send' && /Postgres/.test(e.text || '')))
  const q = fs.readFileSync(path.join(folder, 'questions.md'), 'utf8')
  assert.match(q, /## q1 from dev: open/)
  // Nothing was sent, and the live record agrees.
  assert.equal((await host.instances().teams.get(roomId)).questions[0].answeredAt, undefined)
})

/** `rooms.send` held until `release()`: a reply in flight. */
function holdSends(f) {
  const send = f.ctx.rooms.send
  let release
  const gate = new Promise((r) => (release = r))
  f.ctx.rooms.send = async (...a) => {
    await gate
    return send(...a)
  }
  return { release, restore: () => (f.ctx.rooms.send = send) }
}

test('a reply in flight when the End starts finishes before the catch-up: its answer is in every file of the export', async () => {
  const { f, out, lead, roomId, dev } = await team()
  const { questions, metrics, teams } = host.instances()
  assert.match((await f.run(['ask', 'Which db?'], dev)).stdout, /asked q1/)
  const held = holdSends(f)
  const reply = questions.reply(roomId, 'q1', 'Postgres')
  let replyDone = false
  reply.then(() => (replyDone = true), () => (replyDone = true))
  // The round-6 race: the reply lands after the catch-up, before the snapshot. Without the hold the reply would be
  // let through right after the catch-up; with it the End has waited for the reply before the catch-up began.
  const catchUp = metrics.catchUp
  metrics.catchUp = async (...a) => {
    await catchUp(...a)
    if (!replyDone) {
      // No log read meanwhile (no poll comes between the reply and the snapshot): the answer is after the cursor.
      const log = f.ctx.rooms.log
      f.ctx.rooms.log = async () => ({ entries: [], more: false })
      held.release()
      await reply.catch(() => {})
      f.ctx.rooms.log = log
    }
  }
  // The End holds the team at once: from then on the reply in flight may finish (the gate opens), new changes are refused.
  const ended = f.run(['end', '--export', out], lead)
  for (let i = 0; i < 50 && !teams.guard.exporting(roomId); i++) await new Promise((r) => setImmediate(r))
  if (teams.guard.exporting(roomId)) held.release()
  const r = await ended
  metrics.catchUp = catchUp
  held.restore()
  assert.equal(r.code, undefined, r.stderr)
  await reply
  const folder = only(out)
  const m = JSON.parse(fs.readFileSync(path.join(folder, 'metrics.json'), 'utf8'))
  assert.deepEqual(m.questions, { asked: 1, answered: 1, open: 0 })
  const log = fs.readFileSync(path.join(folder, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const answer = log.find((e) => e.type === 'send' && /Postgres/.test(e.text || ''))
  assert.ok(answer, 'the answer is in log.jsonl')
  assert.ok(answer.seq <= m.logSeq)
  assert.match(fs.readFileSync(path.join(folder, 'questions.md'), 'utf8'), /## q1 from dev: answered/)
})

test('while a team is exported and ended, every change of the plugin\'s own is refused; after a failed export they work again', async () => {
  const { f, dir, out, lead, roomId, dev } = await team()
  fs.writeFileSync(path.join(dir, 'qa.md'), '# You are qa\n')
  const { questions, metrics, hiring, panel } = host.instances()
  assert.match((await f.run(['ask', 'Which db?'], dev)).stdout, /asked q1/)
  assert.match((await f.run(['ask', 'And the cache?'], dev)).stdout, /asked q2/)
  const EXPORTING = /^the team is being exported and ended: try again in a moment$/
  const tries = {}
  const panelResults = {}
  // Every change, tried while the End holds the team (inside the catch-up), which then fails (a log read error).
  const catchUp = metrics.catchUp
  metrics.catchUp = async () => {
    const err = (p) => p.then(() => null, (e) => e.message)
    tries.reply = await err(questions.reply(roomId, 'q1', 'Postgres'))
    tries.done = await err(questions.done(roomId, 'q2'))
    tries.mark = await err(metrics.mark(roomId, 'v1', 'person'))
    tries.hire = await err(hiring.hire(roomId, [], 'qa', { kickoff: 'qa.md' }, dir))
    tries.fire = await err(hiring.fire(roomId, 'dev'))
    for (const [k, argv, who] of [['cli-ask', ['ask', 'Why?'], dev], ['cli-mark', ['mark', 'v1'], lead], ['cli-hire', ['hire', 'qa', '--kickoff', 'qa.md'], lead], ['cli-fire', ['fire', 'dev'], lead], ['cli-invite', ['invite', 'qa'], lead]]) {
      const r = await f.run(argv, who)
      tries[k] = r.code === 1 ? r.stderr.trim() : `ok: ${r.stdout}`
    }
    for (const m of [
      { type: 'reply', roomId, id: 'q1', text: 'Postgres' },
      { type: 'done', roomId, id: 'q2' },
      { type: 'mark', roomId, label: 'v1' },
      { type: 'hire', roomId, name: 'qa', kickoff: 'qa.md' },
      { type: 'fire', roomId, name: 'dev' },
      { type: 'invite', roomId, name: 'qa' },
    ]) {
      const before = f.posts.length
      await panel.onMessage({ ...m, req: 1 }, { view: 'desktop' })
      const res = f.posts.slice(before).find(([, x]) => x.type === 'result')
      panelResults[m.type] = res && res[1].ok === false ? res[1].error : 'ok'
    }
    throw new Error('log read failed')
  }
  const sentBefore = f.rooms.get(roomId).log.length
  const r = await f.run(['end', '--export', out], lead)
  metrics.catchUp = catchUp
  assert.equal(r.code, 1)
  assert.match(r.stderr, /export failed, the team is still running: log read failed/)
  for (const [k, v] of Object.entries(tries)) assert.match(v, EXPORTING, k)
  for (const [k, v] of Object.entries(panelResults)) assert.match(v, EXPORTING, `panel ${k}`)
  // Nothing of them reached the room or the record.
  assert.equal(f.rooms.get(roomId).log.length, sentBefore)
  const rec = await host.instances().teams.get(roomId)
  assert.equal(rec.marks.length, 0)
  assert.ok(rec.questions.every((q) => q.answeredAt === undefined && q.doneAt === undefined))
  assert.deepEqual((await f.ctx.rooms.members(roomId)).map((x) => x.name).sort(), ['dev', 'lead'])
  // The hold ended with the failed End: the same changes work again.
  await questions.reply(roomId, 'q1', 'Postgres')
  await questions.done(roomId, 'q2')
  assert.equal((await f.run(['mark', 'v1'], lead)).code, undefined)
})

test('two ends at once: the second is refused by the lock', async () => {
  const { f, roomId } = await team()
  const { ending } = host.instances()
  const [a, b] = await Promise.allSettled([ending.endTeam(roomId), ending.endTeam(roomId)])
  assert.equal(a.status, 'fulfilled')
  assert.equal(b.status, 'rejected')
  assert.match(b.reason.message, /already being ended/)
  await assert.rejects(ending.endTeam(roomId), /already ended/)
  assert.ok(f.rooms.get(roomId).endedAt !== undefined)
})

test('delete: only an ended team; removes the room and the record', async () => {
  const { f, lead, roomId } = await team()
  const { ending, teams } = host.instances()
  await assert.rejects(ending.deleteTeam(roomId), /only an ended team can be deleted/)
  assert.ok(f.rooms.has(roomId))
  assert.equal((await f.run(['end'], lead)).code, undefined)
  const r = await ending.deleteTeam(roomId)
  assert.equal(r.title, 'Checkout v2')
  assert.equal(f.rooms.has(roomId), false)
  assert.equal(await teams.get(roomId), undefined)
  assert.equal(f.store.has(`team:${roomId}`), false)
  await assert.rejects(ending.deleteTeam(roomId), /no such team/)
})

test('delete: a Rooms refusal keeps the record', async () => {
  const { f, lead, roomId } = await team()
  const { ending, teams } = host.instances()
  assert.equal((await f.run(['end'], lead)).code, undefined)
  f.ctx.rooms.delete = async () => {
    throw new Error('rooms.delete: refused')
  }
  await assert.rejects(ending.deleteTeam(roomId), /rooms\.delete: refused/)
  assert.ok(await teams.get(roomId))
})

test('docs sharing folders under members/<name>/ and an --export path that is a link to a folder', async () => {
  const { f, dir, out, lead, roomId } = await team()
  await f.ctx.rooms.docs.put(roomId, 'members/dev/notes/a.md', 'A')
  await f.ctx.rooms.docs.put(roomId, 'members/dev/notes/deep/b.md', 'B')
  await f.ctx.rooms.docs.put(roomId, 'members/dev/notes/c.md', 'C')
  fs.symlinkSync(out, path.join(dir, 'out-link'))
  const r = await f.run(['end', '--export', 'out-link'], lead)
  assert.equal(r.code, undefined, r.stderr)
  const folder = only(out)
  // The folder is named by the link's target: the person named the link, it is resolved once.
  assert.match(r.stdout, new RegExp(`exported to ${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  const notes = path.join(folder, 'docs/members/dev/notes')
  assert.deepEqual(fs.readdirSync(notes).sort(), ['a.md', 'c.md', 'deep'])
  assert.equal(fs.readFileSync(path.join(notes, 'deep/b.md'), 'utf8'), 'B')
  assert.equal(fs.readFileSync(path.join(folder, 'docs/members/dev/kickoff.md'), 'utf8'), '# You are dev\n')
})

test('a folder of the export swapped for a link mid-export: nothing is written there, the room keeps running', async () => {
  const { f, out, lead, roomId } = await team()
  await f.ctx.rooms.docs.put(roomId, 'shared/a.md', 'A')
  await f.ctx.rooms.docs.put(roomId, 'shared/c.md', 'C')
  const elsewhere = tmp('team-elsewhere-')
  const moved = tmp('team-moved-')
  const get = f.ctx.rooms.docs.get
  f.ctx.rooms.docs.get = async (id, p) => {
    if (p === 'shared/c.md') {
      const shared = path.join(only(out), 'docs/shared')
      fs.renameSync(shared, path.join(moved, 'shared'))
      fs.symlinkSync(elsewhere, shared)
    }
    return get(id, p)
  }
  const r = await f.run(['end', '--export', out], lead)
  f.ctx.rooms.docs.get = get
  assert.equal(r.code, 1)
  assert.match(r.stderr, /export failed, the team is still running: .*changed during the export/)
  assert.deepEqual(fs.readdirSync(elsewhere), [])
  // Our a.md, moved away with its folder, is no longer at its path: left alone rather than chased.
  assert.deepEqual(fs.readdirSync(path.join(moved, 'shared')), ['a.md'])
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
})

test('a folder swapped for a link before the cleanup: the cleanup removes nothing through it', async () => {
  const { f, out, lead, roomId } = await team()
  await f.ctx.rooms.docs.put(roomId, 'shared/a.md', 'mine')
  const victimDir = tmp('team-victim-')
  fs.writeFileSync(path.join(victimDir, 'a.md'), 'original')
  const moved = tmp('team-moved-')
  const log = f.ctx.rooms.log
  f.ctx.rooms.log = async (...a) => {
    const names = fs.readdirSync(out)
    if (names.length === 1) {
      const folder = path.join(out, names[0])
      const shared = path.join(folder, 'docs/shared')
      if (!fs.existsSync(path.join(folder, 'metrics.json'))) {
        // After every doc is written: swap docs/shared for a link to the victim, then make metrics.json fail.
        fs.renameSync(shared, path.join(moved, 'shared'))
        fs.symlinkSync(victimDir, shared)
        fs.symlinkSync(path.join(victimDir, 'nothing'), path.join(folder, 'metrics.json'))
      }
    }
    return log(...a)
  }
  const r = await f.run(['end', '--export', out], lead)
  f.ctx.rooms.log = log
  assert.equal(r.code, 1)
  assert.match(r.stderr, /export failed, the team is still running: .*EEXIST/)
  assert.deepEqual(fs.readdirSync(victimDir), ['a.md'])
  assert.equal(fs.readFileSync(path.join(victimDir, 'a.md'), 'utf8'), 'original')
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
})

test('a file of the export swapped for a link before the cleanup: the link is left, its target untouched', async () => {
  const { f, out, lead, roomId } = await team()
  await f.ctx.rooms.docs.put(roomId, 'shared/a.md', 'mine')
  const victimDir = tmp('team-victim-')
  const victim = path.join(victimDir, 'v.md')
  fs.writeFileSync(victim, 'original')
  const warned = []
  f.ctx.log.warn = (m) => warned.push(m)
  const log = f.ctx.rooms.log
  f.ctx.rooms.log = async (...a) => {
    const names = fs.readdirSync(out)
    if (names.length === 1) {
      const folder = path.join(out, names[0])
      const file = path.join(folder, 'docs/shared/a.md')
      if (fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink()) {
        // After the doc is written: the file replaced by a link to the victim, then metrics.json made to fail.
        fs.unlinkSync(file)
        fs.symlinkSync(victim, file)
        fs.symlinkSync(path.join(victimDir, 'nothing'), path.join(folder, 'metrics.json'))
      }
    }
    return log(...a)
  }
  const r = await f.run(['end', '--export', out], lead)
  f.ctx.rooms.log = log
  assert.equal(r.code, 1)
  assert.match(r.stderr, /export failed, the team is still running/)
  assert.match(warned.join('\n'), /not removing .*docs\/shared\/a\.md: it changed during the export/)
  assert.deepEqual(fs.readdirSync(victimDir), ['v.md'])
  assert.equal(fs.readFileSync(victim, 'utf8'), 'original')
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
})

test('a failure after docs and log.jsonl were written removes every file and folder it made', async () => {
  const { f, out, roomId } = await team()
  await f.ctx.rooms.docs.put(roomId, 'shared/a/b/c/d.md', 'deep')
  await f.ctx.rooms.docs.put(roomId, 'members/dev/x/y.md', 'y')
  await f.ctx.rooms.docs.put(roomId, 'members/dev/x/z.md', 'z')
  const rec = await host.instances().teams.get(roomId)
  // A BigInt makes metrics.json's JSON.stringify throw: after docs/ and log.jsonl, before the last three files.
  await assert.rejects(exportTeam(f.ctx, { rec, stats: { totals: 1n }, dir: out, at: Date.now() }), /BigInt/)
  assert.deepEqual(fs.readdirSync(out), [])
})

test('an export past its budget fails before the end; the room keeps running', async () => {
  const { f, out, roomId } = await team()
  await f.ctx.rooms.docs.put(roomId, 'shared/a.md', 'A')
  const { teams, metrics } = host.instances()
  let t = new Date(2026, 10, 15, 9, 40).getTime()
  const ending = createEnding(f.ctx, teams, metrics, { now: () => (t += 1000) })
  await assert.rejects(ending.endTeam(roomId, { dir: out, budgetMs: 1500 }), /export failed, the team is still running: the export took too long/)
  assert.deepEqual(fs.readdirSync(out), [])
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
})

test('the export budget counts the metrics catch-up: a slow one fails the export before anything is written', async () => {
  const { f, out, roomId } = await team()
  const { teams, metrics } = host.instances()
  let t = new Date(2026, 10, 15, 9, 40).getTime()
  // A catch-up that takes 5 s of the 1.5 s budget (the clock moves only inside it).
  const slow = { poll: async () => {}, catchUp: async () => { t += 5000 }, exportSnapshot: (...a) => metrics.exportSnapshot(...a) }
  const ending = createEnding(f.ctx, teams, slow, { now: () => t })
  await assert.rejects(ending.endTeam(roomId, { dir: out, budgetMs: 1500 }), /export failed, the team is still running: the export took too long/)
  assert.deepEqual(fs.readdirSync(out), [])
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
})

test('a long catch-up stops at the budget between its rounds, not at the end of the backlog', async () => {
  const { f, out, roomId } = await team({ logPageBytes: 1 })
  const { teams, metrics } = host.instances()
  await metrics.poll()
  for (let i = 0; i < 200; i++) f.pushLog(roomId, { type: 'send', from: 'lead', to: 'dev', text: `m${i}`, delivery: [{ to: 'dev', path: 'delivered' }] })
  let t = new Date(2026, 10, 15, 9, 40).getTime()
  let reads = 0
  const log = f.ctx.rooms.log
  f.ctx.rooms.log = async (...a) => {
    reads++
    t += 100
    return log(...a)
  }
  const ending = createEnding(f.ctx, teams, metrics, { now: () => t })
  await assert.rejects(ending.endTeam(roomId, { dir: out, budgetMs: 1500 }), /export failed, the team is still running: the export took too long/)
  f.ctx.rooms.log = log
  assert.ok(reads < 100, `stopped early: ${reads} log reads for a 200-page backlog`)
  assert.deepEqual(fs.readdirSync(out), [])
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
})

test('the budget is checked after the last write: an export that ran out there is removed and the room keeps running', async () => {
  const { f, out, roomId } = await team()
  const { teams, metrics } = host.instances()
  let t = new Date(2026, 10, 15, 9, 40).getTime()
  // The clock jumps past the budget only once the last Rooms call (the log's final page) is done.
  const log = f.ctx.rooms.log
  f.ctx.rooms.log = async (...a) => {
    const r = await log(...a)
    if (!r.more) t += 60_000
    return r
  }
  const ending = createEnding(f.ctx, teams, { poll: async () => {}, catchUp: async () => {}, exportSnapshot: (...a) => metrics.exportSnapshot(...a) }, { now: () => t })
  await assert.rejects(ending.endTeam(roomId, { dir: out, budgetMs: 20_000 }), /the export took too long/)
  f.ctx.rooms.log = log
  assert.deepEqual(fs.readdirSync(out), [])
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
})

test('a cancelled ccc call never ends the team: not during the catch-up, not after the export', async () => {
  const { f, out, roomId } = await team()
  const { teams, metrics } = host.instances()
  // Cancelled while the catch-up runs (one that never ends would hold the handler for ever).
  const ac = new AbortController()
  const hung = { poll: async () => {}, catchUp: () => { ac.abort(); return new Promise(() => {}) }, exportSnapshot: (...a) => metrics.exportSnapshot(...a) }
  const ending = createEnding(f.ctx, teams, hung)
  await assert.rejects(ending.endTeam(roomId, { dir: out, signal: ac.signal }), /cancelled/)
  assert.deepEqual(fs.readdirSync(out), [])
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
  // Cancelled after the last Rooms call of the export.
  const ac2 = new AbortController()
  const log = f.ctx.rooms.log
  f.ctx.rooms.log = async (...a) => {
    const r = await log(...a)
    if (!r.more) ac2.abort()
    return r
  }
  const ending2 = createEnding(f.ctx, teams, { poll: async () => {}, catchUp: async () => {}, exportSnapshot: (...a) => metrics.exportSnapshot(...a) })
  await assert.rejects(ending2.endTeam(roomId, { dir: out, signal: ac2.signal }), /cancelled/)
  f.ctx.rooms.log = log
  assert.deepEqual(fs.readdirSync(out), [])
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
})

test('ccc team end passes its call\'s signal: a call cancelled mid-export leaves the team running', async () => {
  const { f, out, lead, roomId } = await team()
  const ac = new AbortController()
  const log = f.ctx.rooms.log
  f.ctx.rooms.log = async (...a) => {
    const r = await log(...a)
    if (!r.more) ac.abort()
    return r
  }
  const r = await f.run(['end', '--export', out], { ...lead, signal: ac.signal })
  f.ctx.rooms.log = log
  assert.equal(r.code, 1)
  assert.match(r.stderr, /cancelled/)
  assert.deepEqual(fs.readdirSync(out), [])
  assert.equal(f.rooms.get(roomId).endedAt, undefined)
})

test('End while storage refuses every write: the team is ended in memory at once and Delete works (round 8)', async () => {
  const { f, roomId } = await team()
  const { ending, teams } = host.instances()
  const realSet = f.ctx.storage.set
  f.ctx.storage.set = async () => {
    throw new RangeError('storage would exceed 5242880 characters in total')
  }
  await ending.endTeam(roomId)
  assert.equal((await teams.get(roomId)).endedAt, f.rooms.get(roomId).endedAt)
  await teams.refresh()
  assert.ok((await teams.get(roomId)).endedAt !== undefined, 'still ended after another reconcile')
  await ending.deleteTeam(roomId)
  assert.equal(await teams.get(roomId), undefined)
  assert.equal(f.rooms.has(roomId), false)
  f.ctx.storage.set = realSet
})

test('End whose record refresh fails outright: the record is ended in memory (a provisional time), then Rooms\' time', async () => {
  const { f, roomId } = await team()
  const { ending, teams } = host.instances()
  const list = f.ctx.rooms.list
  const end = f.ctx.rooms.end
  f.ctx.rooms.end = async (...a) => {
    await end(...a)
    f.ctx.rooms.list = async () => {
      throw new Error('plugin host call timed out')
    }
  }
  await ending.endTeam(roomId)
  f.ctx.rooms.end = end
  const rec = await teams.get(roomId)
  assert.ok(rec.endedAt !== undefined, 'not live while Rooms has ended it')
  // A change past its awaits now is refused by its own check inside the guard.
  assert.throws(() => teams.guard.live(roomId, rec), /the team has ended/)
  f.ctx.rooms.list = list
  await teams.refresh()
  assert.equal(rec.endedAt, f.rooms.get(roomId).endedAt)
})

test('end closes the hired members\' tabs, never the lead\'s (invited), a coordinator\'s or one the person typed in', async () => {
  const { f, dir, lead, roomId, dev } = await team()
  fs.writeFileSync(path.join(dir, 'qa.md'), '# You are qa\n')
  fs.writeFileSync(path.join(dir, 'co.md'), '# You are co\n')
  assert.equal((await f.run(['hire', 'qa', '--kickoff', 'qa.md'], lead)).code, undefined)
  assert.equal((await f.run(['hire', 'co', '--kickoff', 'co.md', '--coordinator'], lead)).code, undefined)
  const qaTab = f.opens.find((o) => o.name === 'qa').tabId
  const coTab = f.opens.find((o) => o.name === 'co').tabId
  // The person took qa over: its tab stays.
  f.emitSession({ tabId: qaTab, status: 'waiting', typed: true })
  const r = await f.run(['end'], lead)
  assert.equal(r.code, undefined, r.stderr)
  assert.match(r.stdout, /\(1 member tab closed, the others stay\)/)
  assert.deepEqual(f.closedTabs, [dev.tabId])
  assert.ok(f.rooms.get(roomId).endedAt !== undefined)
  for (const kept of ['lead-tab', qaTab, coTab]) assert.ok(!f.closedTabs.includes(kept), kept)
})

test('end on an app before 0.22.0 (no closeTabs): the room ends and every tab stays, as before', async () => {
  const { f, lead } = await team({ noCloseTabs: true })
  const r = await f.run(['end'], lead)
  assert.equal(r.code, undefined, r.stderr)
  assert.match(r.stdout, /\(their tabs stay\)/)
  assert.deepEqual(f.closedTabs, [])
})
