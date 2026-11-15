'use strict'
// Drift guard: the skill's command list is `plugin.json`'s usage (the one the app shows) and the `ccc team help` text,
// and its front matter obeys the app's skill rules (ccc guide plugins), which refuse the whole plugin otherwise.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { USAGE } = require('../lib/commands')
const { KICKOFF_MAX } = require('../lib/kickoff')

const root = path.join(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'))
const skill = fs.readFileSync(path.join(root, 'skills', 'team-tool', 'SKILL.md'), 'utf8')

/** The usage line split into one command form per `|` outside quotes and `<...>`/`[...]`. */
function forms(usage) {
  const out = []
  let cur = ''
  let depth = 0
  let quote = false
  const rest = usage.replace(/^team\s+/, '')
  for (const ch of rest) {
    if (ch === '"') quote = !quote
    if (!quote && (ch === '[' || ch === '<')) depth++
    if (!quote && (ch === ']' || ch === '>')) depth--
    if (ch === '|' && !quote && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

const usage = manifest.contributes.cli[0].usage
const block = /```\n([\s\S]*?)```/.exec(skill)[1].split('\n').filter(Boolean)

test('the skill front matter is exactly name and description, plain strings', () => {
  const m = /^---\n([^\n]*)\n([^\n]*)\n---\n/.exec(skill)
  assert.ok(m, 'two-line front matter')
  assert.equal(m[1], `name: ${manifest.contributes.skills[0].id}`)
  assert.match(m[2], /^description: /)
  const desc = m[2].slice('description: '.length)
  assert.ok(desc.length <= 1024)
  assert.ok(!/^["']/.test(desc) && !desc.includes(': ') && !desc.includes(' #'))
  assert.ok(!skill.includes('\r'))
})

test('the skill command block lists every command form of plugin.json usage', () => {
  assert.deepEqual(block, forms(usage).map((f) => `ccc team ${f}`))
})

test('every command of the help text is in the skill block', () => {
  const subs = [...USAGE.matchAll(/^ {2}(\w+)/gm)].map((m) => m[1])
  const inSkill = new Set(block.map((l) => l.split(' ')[2]))
  for (const s of subs) assert.ok(inSkill.has(s), `${s} missing from the skill`)
})

test('the skill gives no workflow advice (a smoke check, not a proof)', () => {
  // A regex cannot judge flow advice; this only bans the vocabulary of one, outside the one sentence that says the
  // tool has none. Read the skill in review for the rest.
  const allowed = 'what a member is told, who does what and in what order is up to the person'
  const text = skill.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').replace(allowed, '')
  assert.doesNotMatch(text, /\b(role|persona|phase|workflow|stage|step)s?\b/i)
  assert.match(skill, /up to the person/)
})

test('the kickoff size in the skill is the code\'s KICKOFF_MAX', () => {
  assert.equal(KICKOFF_MAX, 256 * 1024)
  assert.match(skill, /at most 256 KiB/)
})
