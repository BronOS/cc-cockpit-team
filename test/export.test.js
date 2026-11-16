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
  assert.equal(seqs.length, f.rooms.get(roomId).log.length - 1) // the end entry comes after the export
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1))
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
