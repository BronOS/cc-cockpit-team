'use strict'
// Kickoff files and Rooms' text rules (docs/design.md §2, §8).
//
// `hire --kickoff <file>` reads a file the calling tab names and seeds it as the member's `members/<name>/kickoff.md`
// before its tab opens. Every check runs here, before any doc is written or tab opened: a kickoff Rooms would refuse
// must not leave a half-hired member behind. The tool never reads what the kickoff says.
//
// Not a boundary: the coordinator is a Claude tab of the same OS user and can read the file itself. The checks are
// for a clear refusal (a typo, a directory, a binary file) rather than a confusing one from Rooms.

const fs = require('node:fs')
const path = require('node:path')

const { TeamError } = require('./teams.js')
const { cutUnits } = require('./text.js')

/** Rooms' doc limit (types.ts `ctx.rooms.docs`): at most 256 KiB of UTF-8. */
const KICKOFF_MAX = 256 * 1024

// Rooms' rules for a message and a doc, copied from cc-cockpit's src/shared/session-name.ts: CONTROL (C0, DEL, C1,
// the bidi marks and controls, the line and paragraph separators, the invisible operators, BOM) and every other
// Unicode format character (Cf) but ZWNJ and ZWJ, which words and emoji need. Tab, LF and CR are let through here and
// CR is checked apart: it is allowed only as part of CRLF.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/
const HIDDEN_TEXT = new RegExp(`${CONTROL.source}|(?![\\u200c\\u200d])\\p{Cf}`, 'u')

/**
 * The first character Rooms refuses in a message or doc text, as `U+XXXX at line L`, or null when there is none.
 * Shared with `ask` (questions are checked by the same rules before they are stored).
 */
function badTextChar(text) {
  let line = 1
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    const next = i + ch.length
    if (ch === '\n') line++
    else if (ch === '\r') {
      // A lone CR moves a terminal's cursor back over what was printed: allowed only before LF.
      if (text[next] !== '\n') return `U+000D (a CR not followed by LF) at line ${line}`
    } else if (ch !== '\t' && HIDDEN_TEXT.test(ch)) {
      return `U+${cp.toString(16).toUpperCase().padStart(4, '0')} at line ${line}`
    }
    i = next
  }
  return null
}

const refuse = (file, why) => new TeamError('kickoff', `kickoff ${file}: ${why}`)

/**
 * Read a kickoff file, resolved against `baseDir` (the caller's cwd for `ccc team hire`, the project folder for the
 * panel), and return its text. Refuses (TeamError, code `kickoff`) a missing file, a symlink, anything but a regular
 * file, an empty file, one over 256 KiB, text that is not UTF-8 and a character Rooms refuses.
 *
 * Opened once with no-follow and checked by `fstat` on that descriptor (the plan's "lstat regular file", without a
 * window between the check and the read); O_NONBLOCK so a FIFO answers "not a regular file" instead of hanging the
 * call until its 30 s abort.
 */
async function readKickoff(file, baseDir) {
  if (typeof file !== 'string' || file === '') throw new TeamError('kickoff', '--kickoff needs a file')
  if (file.includes('\0')) throw refuse(JSON.stringify(file), 'not a file name')
  const abs = path.resolve(baseDir, file)
  let fh
  try {
    fh = await fs.promises.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (err) {
    if (err.code === 'ENOENT') throw refuse(file, 'no such file')
    if (err.code === 'ELOOP') throw refuse(file, 'is a symlink: name the file itself')
    if (err.code === 'EACCES') throw refuse(file, 'permission denied')
    throw refuse(file, err.code || err.message)
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw refuse(file, st.isDirectory() ? 'is a directory' : 'not a regular file')
    if (st.size === 0) throw refuse(file, 'is empty')
    if (st.size > KICKOFF_MAX) throw refuse(file, `is ${st.size} bytes; a kickoff is at most 256 KiB (Rooms' doc limit)`)
    // Read one byte past the limit: a file that grew after the fstat is still refused, never cut.
    const buf = Buffer.alloc(KICKOFF_MAX + 1)
    let got = 0
    for (;;) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got)
      if (bytesRead === 0) break
      got += bytesRead
      if (got === buf.length) break
    }
    if (got > KICKOFF_MAX) throw refuse(file, "is over 256 KiB (Rooms' doc limit)")
    if (got === 0) throw refuse(file, 'is empty')
    let text
    try {
      // `fatal`: a bad byte refuses rather than turning into U+FFFD. A leading BOM is dropped (the decoder's
      // default), since Rooms would refuse it as an invisible character.
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, got))
    } catch {
      throw refuse(file, 'is not UTF-8 text')
    }
    const bad = badTextChar(text)
    if (bad) throw refuse(file, `has a character Rooms refuses (control, bidi or invisible format): ${bad}`)
    if (text.trim() === '') throw refuse(file, 'is empty')
    return text
  } finally {
    await fh.close()
  }
}

/**
 * The opening prompt's size, in UTF-16 units. cc-cockpit refuses a prompt over 100 000 units (prepareText,
 * MAX_TEXT_CHARS in its src/main/sessions/send-gate.ts: refused, never cut), and passes it to `claude` as one argv
 * element, which Linux caps at 128 KiB of bytes (MAX_ARG_STRLEN; a longer one fails the spawn with E2BIG). One unit is
 * at most 3 bytes of UTF-8 (a surrogate pair, two units, is 4), so 40 000 units is at most 120 000 bytes: below both.
 */
const PROMPT_MAX = 40_000

/**
 * What cc-cockpit's prepareText strips from a prompt (stripControls there): C0 but tab and LF, DEL and C1, after CR
 * and CRLF become LF. A kickoff read by readKickoff has none of them but CRLF; stripped here anyway, so the prompt the
 * app gets is the one this builder measured (its length cap counts the text before its own cleaning).
 */
// eslint-disable-next-line no-control-regex
const PROMPT_STRIPS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
const cleanPrompt = (text) => text.replace(/\r\n?/g, '\n').replace(PROMPT_STRIPS, '')

/**
 * The opening prompt of a hired member's tab: the kickoff text itself, under a short header naming the team, the
 * member, its role in the room (coordinator or member: the tool has no other roles) and the doc that holds the same
 * text. The kickoff goes in the prompt, not only a pointer to its doc: the prompt is the tab's first user message,
 * while a doc fetched with `ccc room doc get` reaches Claude as tool output, which Claude Code's auto mode treats as
 * data, not the user's instructions. A member told only to read its kickoff had its first step (a `ccc room doc put`
 * the kickoff asked for) denied by the auto-mode classifier as unsanctioned, and stopped.
 *
 * Over PROMPT_MAX the kickoff is cut (never inside a surrogate pair, cutUnits) and the prompt ends with a line saying
 * the rest is in the doc and must be read before starting. The prompt starts with a letter, so the app's refusal of
 * a leading "/", "!", "#" or "&" never applies; it travels as one argv element (no shell), so nothing in it can act
 * as an option or a command. `team` (a Rooms title: no quote, bracket or control) may be '' when the room's title was
 * not found.
 */
function kickoffPrompt({ team, name, coordinator, docPath, text }) {
  const role = coordinator ? 'the coordinator' : 'a member'
  const where = team ? `the team "${team}"` : 'the team'
  const header =
    `You are ${name}, ${role} of ${where} (cc-cockpit Team, one room). Your kickoff follows. ` +
    `The same text is in the room doc ${docPath}; re-read it with \`ccc room doc get ${docPath}\` when you need it.\n\n`
  const body = cleanPrompt(text)
  if (header.length + body.length <= PROMPT_MAX) return header + body
  const pointer =
    `\n\n[The kickoff is cut here. The rest is in the room doc ${docPath}: read all of it with ` +
    `\`ccc room doc get ${docPath}\` before you start.]\n`
  return header + cutUnits(body, PROMPT_MAX - header.length - pointer.length) + pointer
}

module.exports = { readKickoff, badTextChar, kickoffPrompt, KICKOFF_MAX, PROMPT_MAX }
