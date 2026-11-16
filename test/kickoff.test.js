'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readKickoff, badTextChar, kickoffPrompt, KICKOFF_MAX, PROMPT_MAX } = require('../lib/kickoff.js')
const { TeamError } = require('../lib/teams.js')

const ch = (cp) => String.fromCodePoint(cp)

const dirs = []
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'team-kickoff-'))
  dirs.push(d)
  return d
}
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

const refused = (re) => (e) => e instanceof TeamError && e.code === 'kickoff' && re.test(e.message)

test('reads a file relative to the base dir, and an absolute path', async () => {
  const dir = tmp()
  fs.mkdirSync(path.join(dir, 'k'))
  fs.writeFileSync(path.join(dir, 'k', 'dev.md'), '# Dev\n\nBuild\tit.\r\nThanks\n')
  assert.equal(await readKickoff('k/dev.md', dir), '# Dev\n\nBuild\tit.\r\nThanks\n')
  assert.equal(await readKickoff(path.join(dir, 'k', 'dev.md'), '/'), '# Dev\n\nBuild\tit.\r\nThanks\n')
  assert.equal(await readKickoff('../k/dev.md', path.join(dir, 'k')), '# Dev\n\nBuild\tit.\r\nThanks\n')
})

test('a leading BOM is dropped (Rooms would refuse it), ZWJ in an emoji is kept', async () => {
  const dir = tmp()
  const family = ch(0x1f468) + ch(0x200d) + ch(0x1f469)
  fs.writeFileSync(path.join(dir, 'a.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`hi ${family}\n`)]))
  assert.equal(await readKickoff('a.md', dir), `hi ${family}\n`)
})

test('missing file, directory, symlink, FIFO and empty file are refused', async () => {
  const dir = tmp()
  await assert.rejects(readKickoff('nope.md', dir), refused(/nope\.md: no such file/))
  fs.mkdirSync(path.join(dir, 'd'))
  await assert.rejects(readKickoff('d', dir), refused(/is a directory/))
  fs.writeFileSync(path.join(dir, 'real.md'), 'text\n')
  fs.symlinkSync(path.join(dir, 'real.md'), path.join(dir, 'link.md'))
  await assert.rejects(readKickoff('link.md', dir), refused(/is a symlink/))
  fs.writeFileSync(path.join(dir, 'empty.md'), '')
  await assert.rejects(readKickoff('empty.md', dir), refused(/is empty/))
  fs.writeFileSync(path.join(dir, 'blank.md'), ' \n\n')
  await assert.rejects(readKickoff('blank.md', dir), refused(/is empty/))
  const { spawnSync } = require('node:child_process')
  if (spawnSync('mkfifo', [path.join(dir, 'fifo')]).status === 0) {
    await assert.rejects(readKickoff('fifo', dir), refused(/not a regular file/))
  }
})

test('no file named, or a NUL in the name', async () => {
  await assert.rejects(readKickoff('', '/'), (e) => e instanceof TeamError && /--kickoff needs a file/.test(e.message))
  await assert.rejects(readKickoff(undefined, '/'), (e) => e instanceof TeamError)
  await assert.rejects(readKickoff('a\0b', '/'), refused(/not a file name/))
})

test('256 KiB is the limit: exactly that passes, one byte more is refused', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'max.md'), 'a'.repeat(KICKOFF_MAX))
  assert.equal((await readKickoff('max.md', dir)).length, KICKOFF_MAX)
  fs.writeFileSync(path.join(dir, 'big.md'), 'a'.repeat(KICKOFF_MAX + 1))
  await assert.rejects(readKickoff('big.md', dir), refused(/256 KiB/))
})

test('bytes that are not UTF-8 are refused', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'bin.md'), Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a]))
  await assert.rejects(readKickoff('bin.md', dir), refused(/not UTF-8/))
})

test('characters Rooms refuses: control, lone CR, bidi, invisible format, tag characters', async () => {
  const dir = tmp()
  const cases = [
    ['nul', 'a\u0000b', /U\+0000 at line 1/],
    ['esc', 'line\n\u001b[31mred', /U\+001B at line 2/],
    ['cr', 'a\rb', /U\+000D/],
    ['c1', 'a' + ch(0x85), /U\+0085/],
    ['rlo', 'x\n\ny' + ch(0x202e), /U\+202E at line 3/],
    ['zwsp', 'a' + ch(0x200b) + 'b', /U\+200B/],
    ['tag', 'a' + ch(0xe0041), /U\+E0041/],
    ['shy', 'a' + ch(0xad) + 'b', /U\+00AD/],
  ]
  for (const [name, text, re] of cases) {
    fs.writeFileSync(path.join(dir, name), text)
    await assert.rejects(readKickoff(name, dir), refused(re), name)
  }
})

test('badTextChar: tab, LF and CRLF pass; ZWNJ and ZWJ pass', () => {
  assert.equal(badTextChar('a\tb\nc\r\nd'), null)
  assert.equal(badTextChar('a' + ch(0x200c) + ch(0x200d) + 'b'), null)
  assert.equal(badTextChar('a\r'), 'U+000D (a CR not followed by LF) at line 1')
  assert.equal(badTextChar(ch(0x2066)), 'U+2066 at line 1')
})

// --- the opening prompt

// What cc-cockpit's prepareText (src/main/sessions/send-gate.ts) strips or refuses in a prompt.
// eslint-disable-next-line no-control-regex
const APP_STRIPS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/
const MODE_PREFIX = /^\s*[/!#&]/

test('kickoffPrompt: the kickoff text itself, under a header naming the team, the member, its role and the doc', () => {
  const p = kickoffPrompt({ team: 'Checkout v2', name: 'dev', coordinator: false, docPath: 'members/dev/kickoff.md', text: '# You are dev\nBuild the API.\n' })
  assert.match(p, /team "Checkout v2"/)
  assert.match(p, /\bdev\b/)
  assert.match(p, /a member/)
  assert.match(p, /`ccc room doc get members\/dev\/kickoff\.md`/)
  assert.ok(p.endsWith('# You are dev\nBuild the API.\n'), p)
  assert.doesNotMatch(p, MODE_PREFIX)
  assert.doesNotMatch(p, /cut here/)
  const lead = kickoffPrompt({ team: 'T', name: 'lead', coordinator: true, docPath: 'members/lead/kickoff.md', text: 'x' })
  assert.match(lead, /the coordinator/)
})

test('kickoffPrompt: a long kickoff is cut below the app limit and ends with the pointer to the doc', () => {
  const docPath = 'members/dev/kickoff.md'
  const text = 'a'.repeat(KICKOFF_MAX)
  const p = kickoffPrompt({ team: 'T', name: 'dev', coordinator: false, docPath, text })
  assert.ok(p.length <= PROMPT_MAX, `${p.length}`)
  // Below cc-cockpit's own cap (MAX_TEXT_CHARS, 100 000 UTF-16 units) and Linux's 128 KiB for one argv element.
  assert.ok(PROMPT_MAX < 100_000)
  assert.ok(Buffer.byteLength('😀'.repeat(PROMPT_MAX / 2)) < 128 * 1024)
  const last = p.trimEnd().split('\n').at(-1)
  assert.match(last, /rest is in the room doc members\/dev\/kickoff\.md/)
  assert.match(last, /before you start/)
  assert.match(p, /a…\n/)
  // Exactly at the limit: not cut.
  const head = kickoffPrompt({ team: 'T', name: 'dev', coordinator: false, docPath, text: 'x' }).length - 1
  const fits = kickoffPrompt({ team: 'T', name: 'dev', coordinator: false, docPath, text: 'b'.repeat(PROMPT_MAX - head) })
  assert.equal(fits.length, PROMPT_MAX)
  assert.doesNotMatch(fits, /cut here/)
})

test('kickoffPrompt: the cut never splits a surrogate pair', () => {
  for (const pad of [0, 1]) {
    const p = kickoffPrompt({ team: 'T', name: 'dev', coordinator: false, docPath: 'members/dev/kickoff.md', text: 'x'.repeat(pad) + '😀'.repeat(PROMPT_MAX) })
    assert.ok(p.length <= PROMPT_MAX)
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i)
      if (c >= 0xd800 && c <= 0xdbff) assert.ok(p.charCodeAt(i + 1) >= 0xdc00 && p.charCodeAt(i + 1) <= 0xdfff, `lone high at ${i}`)
      else if (c >= 0xdc00 && c <= 0xdfff) assert.ok(p.charCodeAt(i - 1) >= 0xd800 && p.charCodeAt(i - 1) <= 0xdbff, `lone low at ${i}`)
    }
  }
})

test('kickoffPrompt: control characters the app would strip are taken out; tab, LF and CRLF become tab and LF', () => {
  const p = kickoffPrompt({
    team: 'T',
    name: 'dev',
    coordinator: false,
    docPath: 'members/dev/kickoff.md',
    text: 'a\0b\x1b[201~c\td\r\ne\rf\x7fg\x9bh\n',
  })
  assert.doesNotMatch(p, APP_STRIPS)
  assert.ok(p.endsWith('ab[201~c\td\ne\nfgh\n'), JSON.stringify(p.slice(-30)))
})
