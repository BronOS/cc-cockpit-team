'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const V = require('../panels/view-model.js')
const { ACTIVITY_KINDS, PING_SECONDS } = require('../lib/panel.js')

const panelsDir = path.join(__dirname, '..', 'panels')

test('durations, costs and percents: unknown for a missing value', () => {
  assert.equal(V.fmtDuration(12_000), '12s')
  assert.equal(V.fmtDuration(247_000), '4m 07s')
  assert.equal(V.fmtDuration(3_900_000), '1h 05m')
  assert.equal(V.fmtDuration(undefined), 'unknown')
  assert.equal(V.fmtDuration(NaN), 'unknown')
  assert.equal(V.fmtCost(1.234), '$1.23')
  assert.equal(V.fmtCost(null), 'unknown')
  assert.equal(V.fmtPercent(41.6), '42%')
  assert.equal(V.fmtPercent(null), 'unknown')
})

test('fmtTime: clock for today, date and clock otherwise, unknown for junk', () => {
  const now = new Date(2026, 10, 15, 12, 0, 0).getTime()
  assert.equal(V.fmtTime(new Date(2026, 10, 15, 9, 5, 7).getTime(), now), '09:05:07')
  assert.equal(V.fmtTime(new Date(2026, 10, 14, 9, 5, 7).getTime(), now), '2026-11-14 09:05:07')
  assert.equal(V.fmtTime('x', now), 'unknown')
})

test('every state is an icon and a word, never only a colour', () => {
  for (const s of ['working', 'waiting', 'needs-permission', 'idle', 'starting', 'ended', 'closed', 'left', 'unknown']) {
    const i = V.statusInfo(s)
    assert.ok(i.icon && i.word, s)
  }
  const icons = new Set(['working', 'waiting', 'needs-permission', 'idle', 'closed', 'left', 'unknown'].map((s) => V.statusInfo(s).icon))
  assert.equal(icons.size, 7, 'distinct shapes')
  assert.deepEqual(V.statusInfo('nonsense'), { icon: '?', word: 'unknown' })
  assert.deepEqual(V.statusInfo('__proto__'), { icon: '?', word: 'unknown' })
  assert.equal(V.leftText({ status: 'left', leftWhy: 'removed' }), 'left (removed)')
  assert.equal(V.leftText({ status: 'working' }), '')
})

test('team meta names ended, paused and what waits on the person as text', () => {
  assert.equal(V.teamMeta({ members: 1, waiting: 0 }), '1 member')
  assert.equal(V.teamMeta({ members: 3, waiting: 2, paused: true }), '3 members · 2 waiting on you · paused')
  assert.equal(V.teamMeta({ members: 0, waiting: 0, endedAt: 5, paused: true }), '0 members · ended')
  assert.deepEqual(V.teamFlags({ endedAt: 1 }), ['ended'])
})

test('pickSelected keeps a held team, else the newest live one, else the newest, else none', () => {
  const t = [
    { roomId: 'a', createdAt: 1, endedAt: 9 },
    { roomId: 'b', createdAt: 2 },
    { roomId: 'c', createdAt: 3, endedAt: 9 },
  ]
  assert.equal(V.pickSelected(t, 'a'), 'a')
  assert.equal(V.pickSelected(t, 'gone'), 'b')
  assert.equal(V.pickSelected(t, null), 'b')
  assert.equal(V.pickSelected([t[0], t[2]], null), 'c')
  assert.equal(V.pickSelected([], 'a'), null)
})

test('logMoved only when the sequence differs (the page then re-asks activity and docs list, never a doc text)', () => {
  assert.equal(V.logMoved(undefined, 3), true)
  assert.equal(V.logMoved(3, 3), false)
  assert.equal(V.logMoved(3, 4), true)
})

test('activityKey moves with the log and with the marks (a mark is no log entry)', () => {
  const t = { logSeq: 3, marks: [] }
  assert.equal(V.activityKey(t), V.activityKey({ logSeq: 3, marks: [] }))
  assert.notEqual(V.activityKey(t), V.activityKey({ logSeq: 4, marks: [] }))
  assert.notEqual(V.activityKey(t), V.activityKey({ logSeq: 3, marks: [{ at: 1, label: 'x', by: 'person' }] }))
  assert.equal(V.activityKey(null), undefined)
})

test('describeEntry keeps a member\'s words as plain text', () => {
  assert.equal(V.describeEntry({ type: 'send', from: 'api', to: 'ui', text: '<b>hi</b>' }), 'api to ui: <b>hi</b>')
  assert.equal(V.describeEntry({ type: 'send', from: 'api', delivery: [{ to: 'a' }, { to: 'b' }] }), 'api to a, b')
  assert.equal(V.describeEntry({ type: 'mark', label: 'v1', by: 'person' }), 'mark: v1 (by person)')
  assert.equal(V.describeEntry({ type: 'leave', member: 'x', why: 'removed' }), 'x left (removed)')
  assert.equal(V.describeEntry({ type: 'join', member: 'x', coordinator: true }), 'x joined as coordinator')
  assert.equal(V.describeEntry({ type: 'weird' }), 'weird')
  for (const type of ACTIVITY_KINDS) assert.equal(typeof V.describeEntry({ type }), 'string')
})

test('the kind filter and the ping interval match the host\'s', () => {
  assert.deepEqual([...V.KINDS].sort(), [...ACTIVITY_KINDS].sort())
  assert.equal(V.PING_SECONDS, PING_SECONDS)
})

test('new team form: a title is required; empty optional fields are left out', () => {
  assert.match(V.newTeamRequest({ title: '  ' }).error, /title/)
  assert.deepEqual(V.newTeamRequest({ title: ' Ship it ', name: '', kickoff: ' k.md ', model: 'opus', effort: '', cwd: ' ' }).message, {
    type: 'new-team', title: 'Ship it', model: 'opus', kickoff: 'k.md',
  })
})

test('hire form: name and kickoff are required, coordinator is a boolean', () => {
  assert.match(V.hireRequest('r', { kickoff: 'k.md' }).error, /name/)
  assert.match(V.hireRequest('r', { name: 'api' }).error, /kickoff/)
  assert.deepEqual(V.hireRequest('r', { name: 'api', kickoff: 'k.md', coordinator: true, effort: 'high' }).message, {
    type: 'hire', roomId: 'r', name: 'api', kickoff: 'k.md', coordinator: true, effort: 'high',
  })
  assert.equal(V.hireRequest('r', { name: 'api', kickoff: 'k.md', coordinator: 'yes' }).message.coordinator, false)
})

test('reply outcome: delivered is "sent"; held says so, with why, as a warning', () => {
  assert.deepEqual(V.replyOutcome('dev', [{ to: 'dev', path: 'delivered' }]), { text: 'Answer sent to dev.', held: false })
  const paused = V.replyOutcome('dev', [{ to: 'dev', path: 'held', why: 'paused' }])
  assert.equal(paused.held, true)
  assert.match(paused.text, /^Answer queued for dev, not yet pointed out to it: the room is paused/)
  for (const why of ['no-tab', 'typed', 'capped', 'draft', 'not-waiting']) {
    const o = V.replyOutcome('dev', [{ to: 'dev', path: 'held', why }])
    assert.equal(o.held, true, why)
    assert.doesNotMatch(o.text, new RegExp(`: ${why}\\.$`), why)
  }
  // A reason this page does not know yet is shown as it is; no answers at all is the old "sent".
  assert.match(V.replyOutcome('dev', [{ to: 'dev', path: 'held', why: 'new-why' }]).text, /: new-why\.$/)
  assert.equal(V.replyOutcome('dev', undefined).held, false)
})

test('reply, mark, invite, end requests', () => {
  assert.match(V.replyRequest('r', 'q1', '  \n').error, /answer/)
  assert.deepEqual(V.replyRequest('r', 'q1', 'yes\n\nplease').message, { type: 'reply', roomId: 'r', id: 'q1', text: 'yes\n\nplease' })
  assert.match(V.markRequest('r', '').error, /label/)
  assert.deepEqual(V.markRequest('r', ' v1 ').message, { type: 'mark', roomId: 'r', label: 'v1' })
  assert.match(V.inviteRequest('r', {}).error, /name/)
  assert.deepEqual(V.inviteRequest('r', { name: 'qa' }).message, { type: 'invite', roomId: 'r', name: 'qa', coordinator: false })
  assert.deepEqual(V.endRequest('r', '').message, { type: 'end', roomId: 'r' })
  assert.deepEqual(V.endRequest('r', ' out ').message, { type: 'end', roomId: 'r', dir: 'out' })
})

test('activity request carries only the filters that are set', () => {
  assert.deepEqual(V.activityRequest('r', {}), { type: 'activity', roomId: 'r' })
  assert.deepEqual(V.activityRequest('r', { member: 'api', kind: 'send', before: { seq: 5, at: 9 } }), {
    type: 'activity', roomId: 'r', member: 'api', kind: 'send', before: { seq: 5, at: 9 },
  })
})

test('panels/ never builds HTML from a string', () => {
  const banned = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/
  const files = fs.readdirSync(panelsDir)
  assert.ok(files.includes('team.js') && files.includes('view-model.js') && files.includes('team.html') && files.includes('team.css'))
  for (const f of files) {
    const text = fs.readFileSync(path.join(panelsDir, f), 'utf8')
    assert.doesNotMatch(text, banned, f)
  }
})

test('the page has no confirm/alert/prompt, no inline script or handler, and only relative URLs', () => {
  for (const f of ['team.js', 'view-model.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(panelsDir, f), 'utf8'), /\b(confirm|alert|prompt)\s*\(/, f)
  }
  const html = fs.readFileSync(path.join(panelsDir, 'team.html'), 'utf8')
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/)
  assert.doesNotMatch(html, /\son[a-z]+\s*=/)
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
  assert.ok(urls.length >= 4)
  for (const u of urls) {
    assert.doesNotMatch(u, /^(\/|[a-z]+:)/, u)
    const target = path.join(panelsDir, u)
    if (!u.startsWith('../__sdk/')) assert.ok(fs.existsSync(target), `${u} exists`)
  }
  assert.match(html, /\.\.\/__sdk\/panel\.js/)
})

test('every request type the page posts is an action of the host', () => {
  const src = fs.readFileSync(path.join(panelsDir, 'team.js'), 'utf8') + fs.readFileSync(path.join(panelsDir, 'view-model.js'), 'utf8')
  const host = fs.readFileSync(path.join(__dirname, '..', 'lib', 'panel.js'), 'utf8')
  const types = new Set([...src.matchAll(/type: '([a-z-]+)'/g)].map((m) => m[1]))
  for (const t of ['new-team', 'hire', 'mark', 'end', 'delete', 'reply', 'done', 'fire', 'focus', 'invite', 'activity', 'docs', 'doc']) {
    assert.ok(types.has(t), `page posts ${t}`)
    assert.match(host, new RegExp(`(^|\\n)\\s+'?${t}'?: \\{`), `host handles ${t}`)
  }
  for (const t of ['hello', 'select', 'ping']) assert.ok(types.has(t), t)
})

test('the page re-asks only the activity and docs list on a log move, and pings while shown', () => {
  const src = fs.readFileSync(path.join(panelsDir, 'team.js'), 'utf8')
  const body = src.slice(src.indexOf('function refreshLog'), src.indexOf('async function loadActivity'))
  assert.match(body, /loadActivity/)
  assert.match(body, /loadDocs/)
  assert.doesNotMatch(body, /readDoc/)
  assert.match(src, /type: 'ping', selected/)
  assert.match(src, /visibilityState/)
})

// ---- a smoke run of team.js against a minimal DOM stub (no jsdom here): it renders, posts and handles results ----

function stubDom() {
  class Node_ {}
  class Text extends Node_ {
    constructor(t) { super(); this.textContent = String(t) }
  }
  // One simple selector: `tag`, `.class`, `[attr]` or `[attr="v"]`, in any combination.
  const matchesOne = (el, sel) => {
    const re = /^([a-z0-9]+)?((?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/
    const m = re.exec(sel)
    if (!m) throw new Error(`stub selector: ${sel}`)
    if (m[1] && el.tag !== m[1]) return false
    for (const part of m[2].match(/\.[\w-]+|\[[^\]]+\]/g) || []) {
      if (part[0] === '.') {
        if (!el.className.split(' ').includes(part.slice(1))) return false
      } else {
        const [k, v] = part.slice(1, -1).split('=')
        if (!(k in el.attrs)) return false
        if (v !== undefined && el.attrs[k] !== v.slice(1, -1)) return false
      }
    }
    return true
  }
  class El extends Node_ {
    constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.dataset = {}; this.style = {}; this.className = ''; this.parent = null; this.scrollTop = 0 }
    get tagName() { return this.tag.toUpperCase() }
    setAttribute(k, v) { this.attrs[k] = v; if (k.startsWith('data-')) this.dataset[k.slice(5)] = v }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f) }
    append(...k) { for (const c of k) if (c instanceof El) c.parent = this; this.children.push(...k) }
    replaceChildren(...k) { this.children = []; this.append(...k) }
    get firstChild() { return this.children[0] || null }
    contains(n) { return n === this || this.children.some((c) => c.contains && c.contains(n)) }
    get isConnected() { let n = this; while (n.parent) { if (!n.parent.children.includes(n)) return false; n = n.parent } return n === rootRef.el }
    querySelectorAll(selector) {
      const chains = selector.split(',').map((x) => x.trim().split(/\s+/))
      const out = []
      const walk = (el) => {
        for (const c of el.children) {
          if (!(c instanceof El)) continue
          if (chains.some((chain) => matchesChain(c, chain, this))) out.push(c)
          walk(c)
        }
      }
      walk(this)
      return out
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
    focus() { document.activeElement = this }
    getBoundingClientRect() { return { right: 10, bottom: 10 } }
    get text() { return this.children.map((c) => (c instanceof Text ? c.textContent : c.text)).join('') }
    all(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) if (c instanceof El) c.all(pred, out); return out }
  }
  // The last simple selector matches the element, each earlier one an ancestor (up to the scope).
  function matchesChain(el, chain, scope) {
    if (!matchesOne(el, chain[chain.length - 1])) return false
    let i = chain.length - 2
    for (let a = el.parent; i >= 0 && a && a !== scope.parent; a = a.parent) if (matchesOne(a, chain[i])) i--
    return i < 0
  }
  const rootRef = { el: null }
  const root = new El('div')
  rootRef.el = root
  const menuHost = new El('div')
  const docListeners = {}
  const document = {
    createElement: (t) => new El(t),
    createTextNode: (t) => new Text(t),
    getElementById: (id) => (id === 'root' ? root : menuHost),
    addEventListener: (t, f) => { (docListeners[t] ||= []).push(f) },
    activeElement: null,
    visibilityState: 'visible',
  }
  return { document, root, menuHost, docListeners, El, Node_ }
}

function runPage() {
  const vm = require('node:vm')
  const { document, root, menuHost, docListeners, Node_ } = stubDom()
  const posts = []
  let onMessage
  let onConnect
  const timers = []
  const win = { innerWidth: 400, innerHeight: 600, selecting: false }
  win.getSelection = () => ({ isCollapsed: !win.selecting })
  const ctx = {
    document,
    Node: Node_,
    window: win,
    navigator: {},
    // As the real SDK (cc-cockpit src/sdk/panel-core.ts post): a message over 1 MiB as JSON throws, synchronously.
    ccPanel: {
      post: (m) => {
        const text = JSON.stringify(m)
        if (text.length > 1024 * 1024) throw new RangeError(`post: message of ${text.length} chars exceeds ${1024 * 1024}`)
        posts.push(m)
      },
      onMessage: (f) => { onMessage = f },
      onConnect: (f) => { onConnect = f },
    },
    setTimeout: (f, ms) => { timers.push({ f, ms, active: true }); return timers.length },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].active = false },
    setInterval: (f, ms) => { timers.push({ f, ms, interval: true, active: true }); return timers.length },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].active = false },
    console,
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(path.join(panelsDir, 'view-model.js'), 'utf8'), ctx)
  vm.runInContext(fs.readFileSync(path.join(panelsDir, 'team.js'), 'utf8'), ctx)
  const page = {
    root, menuHost, document, posts, timers, win,
    send: (m) => onMessage(m),
    connect: () => onConnect(),
    docFire: (type) => (docListeners[type] || []).forEach((f) => f({ type })),
    /** Run the pending one-shot timers (the log refresh waits 300 ms). */
    runTimeouts: () => { for (const t of timers.filter((x) => !x.interval && x.active)) { t.active = false; t.f() } },
    /** The posts of one type, without their `req`. */
    sent: (type) => posts.filter((m) => m.type === type).map(({ req, ...rest }) => rest),
    /** The last unanswered post of a type, answered with `res`. */
    answer: (post, res) => onMessage({ type: 'result', req: post.req, ...res }),
    flush: () => new Promise((r) => setImmediate(r)),
    find: (pred) => root.all(pred),
    button: (label) => root.all((e) => e.tag === 'button' && e.text === label)[0],
    /** Fire an event on an element, bubbling like the DOM (target stays, currentTarget moves up). */
    fire: (el, type, ev = {}) => {
      let stopped = false
      const e = { type, target: el, key: undefined, preventDefault() {}, stopPropagation() { stopped = true }, ...ev }
      for (let n = el; n && !stopped; n = n.parent) {
        e.currentTarget = n
        for (const f of n.listeners[type] || []) f(e)
      }
    },
  }
  return page
}

const teamState = (over = {}) => ({
  type: 'state',
  exportDir: '',
  teams: [{ roomId: 'r1', title: 'Ship <b>it</b>', createdAt: 1, paused: false, members: 2, waiting: 1, costUsd: 1.5, logSeq: 3 }],
  team: {
    roomId: 'r1', title: 'Ship <b>it</b>', createdAt: 1, paused: false, members: 2, waiting: 1, costUsd: 1.5, logSeq: 3,
    members: [
      { name: 'lead', coordinator: true, in: true, status: 'working', tool: 'Edit', held: 0, costUsd: 1, workingMs: 5000, contextPercent: 10 },
      { name: 'api', coordinator: false, in: true, status: 'waiting', held: 2, costUsd: null, workingMs: 0, contextPercent: null },
    ],
    questions: [{ id: 'q1', from: 'api', text: '<img src=x onerror=alert(1)> ok?', askedAt: 5 }],
    marks: [], stats: null,
  },
  ...over,
})

test('the page renders a state as text, with icons and words, and asks for what it needs', () => {
  const p = runPage()
  p.connect()
  assert.deepEqual(JSON.parse(JSON.stringify(p.posts[0])), { type: 'hello', selected: null })
  assert.ok(p.timers.some((t) => t.interval && t.ms === 30_000), 'pings every 30 s')
  // The first state has no team (nothing selected yet); the page selects and the host answers with it.
  p.send(teamState({ team: null }))
  p.send(teamState())
  const text = p.root.text
  assert.match(text, /Ship <b>it<\/b>/)
  assert.match(text, /waiting for input/)
  assert.match(text, /working/)
  assert.match(text, /★ coordinator/)
  assert.match(text, /<img src=x onerror=alert\(1\)> ok\?/)
  assert.match(text, /2 messages waiting/)
  assert.match(text, /Nothing is waiting|Waiting on you/)
  // The first state selects the newest live team.
  assert.ok(p.posts.some((m) => m.type === 'select' && m.roomId === 'r1'))
})

test('a log move asks nothing while the sections are closed', () => {
  const p = runPage()
  p.connect()
  p.send(teamState({ team: null }))
  p.send(teamState())
  p.runTimeouts()
  assert.equal(p.posts.filter((m) => m.type === 'activity' || m.type === 'docs' || m.type === 'doc').length, 0, 'closed sections ask nothing')
})

test('a state for the wrong team is ignored and a missing state shows the loading line', () => {
  const p = runPage()
  p.send(teamState())
  p.send(teamState({ team: { ...teamState().team, roomId: 'other' } }))
  assert.match(p.root.text, /Loading the team/)
})

test('an ended team offers Delete, a live one End and export', () => {
  const p = runPage()
  p.send(teamState({ team: null }))
  p.send(teamState())
  assert.match(p.root.text, /End and export/)
  assert.doesNotMatch(p.root.text, /Delete…/)
  const s = teamState()
  s.teams[0].endedAt = 9
  s.team.endedAt = 9
  p.send(s)
  assert.match(p.root.text, /Delete…/)
  assert.doesNotMatch(p.root.text, /End and export/)
  assert.match(p.root.text, /ended/)
  // Read-only: the open question is shown with no Reply or Done.
  assert.match(p.root.text, /ok\?/)
  assert.match(p.root.text, /Not answered before the team ended/)
  assert.doesNotMatch(p.root.text, /Reply|Done/)
})

// ---- the protocol, with the page's real code ----

const tick = async (p) => { await p.flush() }
const withLog = (seq, over = {}) => {
  const st = teamState(over)
  st.teams[0].logSeq = seq
  st.team.logSeq = seq
  return st
}
const start = (st = teamState()) => {
  const p = runPage()
  p.connect()
  p.send({ ...st, team: null })
  p.send(st)
  return p
}
const toggle = (p, label, on = true) => {
  const d = p.find((e) => e.tag === 'details' && e.text.startsWith(label))[0]
  d.open = on
  p.fire(d, 'toggle', { target: d })
}
const memberRow = (p, name) => p.find((e) => e.tag === 'li' && e.dataset.key === `member-${name}`)[0]
const clickBtn = (p, label) => p.fire(p.button(label), 'click')
const typeInto = (p, input, value) => { input.value = value; p.fire(input, 'input', { target: input }) }
const entry = (n) => ({ type: 'leave', seq: n, at: n * 10, member: `m${n}`, why: 'removed' })

test('a result is matched to its request: two in flight, an unknown and a duplicate one ignored', async () => {
  const p = start()
  p.fire(memberRow(p, 'lead'), 'click')
  p.fire(memberRow(p, 'api'), 'click')
  const [a, b] = p.posts.filter((m) => m.type === 'focus')
  assert.deepEqual([a.name, b.name], ['lead', 'api'])
  assert.notEqual(a.req, b.req)
  p.answer(b, { ok: false, error: 'tab is gone' })
  await tick(p)
  assert.match(p.root.text, /tab is gone/)
  p.answer(a, { ok: true })
  await tick(p)
  assert.match(p.root.text, /Showing lead's tab\./)
  p.answer({ req: 9999 }, { ok: false, error: 'stray' })
  p.answer(a, { ok: false, error: 'duplicate' })
  await tick(p)
  assert.match(p.root.text, /Showing lead's tab\./)
  assert.doesNotMatch(p.root.text, /stray|duplicate/)
})

test('reply: sends the exact message, a refusal is shown and the box is usable again, then the answer', async () => {
  const p = start()
  const box = p.find((e) => e.tag === 'textarea')[0]
  typeInto(p, box, 'yes please')
  clickBtn(p, 'Reply')
  assert.deepEqual(p.sent('reply'), [{ type: 'reply', roomId: 'r1', id: 'q1', text: 'yes please' }])
  assert.equal(p.find((e) => e.tag === 'textarea')[0].disabled, true, 'busy while in flight')
  p.answer(p.posts.find((m) => m.type === 'reply'), { ok: false, error: 'the question is gone' })
  await tick(p)
  assert.match(p.root.text, /the question is gone/)
  const again = p.find((e) => e.tag === 'textarea')[0]
  assert.ok(!again.disabled)
  assert.equal(again.value, 'yes please', 'the draft is kept')
  clickBtn(p, 'Reply')
  p.answer(p.posts.filter((m) => m.type === 'reply')[1], { ok: true, answers: [{ to: 'api', path: 'delivered' }] })
  await tick(p)
  assert.match(p.root.text, /Answer sent to api\./)
})

test('reply too large to post (ccPanel.post throws over 1 MiB): an error is shown and the box is usable again', async () => {
  const p = start()
  const box = p.find((e) => e.tag === 'textarea')[0]
  typeInto(p, box, 'x'.repeat(1024 * 1024 + 10))
  clickBtn(p, 'Reply')
  await tick(p)
  assert.equal(p.sent('reply').length, 0, 'nothing posted')
  assert.match(p.root.text, /Too large to send/)
  const again = p.find((e) => e.tag === 'textarea')[0]
  assert.ok(!again.disabled, 'the reply controls are enabled again')
  assert.ok(!p.button('Reply').attrs.disabled && !p.button('Reply').disabled)
  assert.equal(again.value.length, 1024 * 1024 + 10, 'the draft is kept')
})

test('reply held (a paused room after a restart): the page says queued and why, never "sent"', async () => {
  const p = start()
  typeInto(p, p.find((e) => e.tag === 'textarea')[0], 'yes please')
  clickBtn(p, 'Reply')
  p.answer(p.posts.find((m) => m.type === 'reply'), { ok: true, answers: [{ to: 'api', path: 'held', why: 'paused' }] })
  await tick(p)
  assert.match(p.root.text, /Answer queued for api, not yet pointed out to it: the room is paused/)
  assert.doesNotMatch(p.root.text, /Answer sent/)
})

test('done, focus, fire and end send their exact messages and show the answer', async () => {
  const p = start()
  clickBtn(p, 'Done')
  assert.deepEqual(p.sent('done'), [{ type: 'done', roomId: 'r1', id: 'q1' }])
  p.answer(p.posts.find((m) => m.type === 'done'), { ok: true })
  await tick(p)
  assert.match(p.root.text, /Question from api marked done\./)

  p.fire(memberRow(p, 'lead'), 'click')
  assert.deepEqual(p.sent('focus'), [{ type: 'focus', roomId: 'r1', name: 'lead' }])
  p.answer(p.posts.find((m) => m.type === 'focus'), { ok: true })
  await tick(p)
  assert.match(p.root.text, /Showing lead's tab\./)

  const actions = p.find((e) => e.dataset.key === 'act-api')[0]
  p.fire(actions, 'click', { currentTarget: actions })
  p.fire(p.menuHost.firstChild.children.find((b) => b.text === 'Fire…'), 'click')
  clickBtn(p, 'Remove')
  assert.deepEqual(p.sent('fire'), [{ type: 'fire', roomId: 'r1', name: 'api' }])
  p.answer(p.posts.find((m) => m.type === 'fire'), { ok: true, name: 'api' })
  await tick(p)
  assert.match(p.root.text, /api removed from the team\./)

  clickBtn(p, 'End and export…')
  typeInto(p, p.find((e) => e.tag === 'input')[0], ' out ')
  clickBtn(p, 'End team')
  assert.deepEqual(p.sent('end'), [{ type: 'end', roomId: 'r1', dir: 'out' }])
  p.answer(p.posts.find((m) => m.type === 'end'), { ok: true, folder: '/x/out' })
  await tick(p)
  assert.match(p.root.text, /Team ended\. Exported to \/x\/out/)
})

test('a failed form shows its error and can be sent again', async () => {
  const p = start()
  clickBtn(p, 'Mark')
  typeInto(p, p.find((e) => e.tag === 'input')[0], 'v1')
  clickBtn(p, 'Add mark')
  assert.equal(p.button('Working…').disabled, true)
  p.answer(p.posts.find((m) => m.type === 'mark'), { ok: false, error: 'refused' })
  await tick(p)
  assert.match(p.root.text, /refused/)
  assert.ok(!p.button('Add mark').disabled)
})

test('a ping goes out every 30 s while shown; hidden stops it, shown again says hello', () => {
  const p = start()
  const live = () => p.timers.filter((t) => t.interval && t.active && t.ms === 30_000)
  assert.equal(live().length, 1)
  live()[0].f()
  assert.deepEqual(p.sent('ping'), [{ type: 'ping', selected: 'r1' }])
  p.document.visibilityState = 'hidden'
  p.docFire('visibilitychange')
  assert.equal(live().length, 0)
  const hellos = p.sent('hello').length
  p.document.visibilityState = 'visible'
  p.docFire('visibilitychange')
  assert.equal(p.sent('hello').length, hellos + 1)
  assert.deepEqual(p.sent('hello').pop(), { type: 'hello', selected: 'r1' })
  assert.equal(live().length, 1)
})

test('select is sent once per team change; a state for another team is ignored', () => {
  const st = teamState()
  st.teams.push({ roomId: 'r2', title: 'Other', createdAt: 0, paused: false, members: 0, waiting: 0, logSeq: 1 })
  const p = start(st)
  assert.equal(p.sent('select').length, 1)
  p.send(st)
  assert.equal(p.sent('select').length, 1, 'no new select for the same team')
  const row = p.find((e) => e.tag === 'li' && e.dataset.key === 'team-r2')[0]
  p.fire(row, 'click')
  p.fire(row, 'click')
  assert.deepEqual(p.sent('select').map((m) => m.roomId), ['r1', 'r2'])
  p.send(st) // r1's team while r2 is selected
  assert.match(p.root.text, /Loading the team/)
})

test('an old app\'s error is drawn with no team, and the New team button is plain while a form is open', () => {
  const p = runPage()
  p.send({ type: 'state', teams: [], team: null, error: 'Update cc-cockpit to 0.19.1' })
  assert.match(p.root.text, /Update cc-cockpit to 0\.19\.1/)
  assert.equal(p.button('New team').className, 'cc-primary')
  clickBtn(p, 'New team')
  assert.notEqual(p.button('New team').className, 'cc-primary')
  assert.equal(p.find((e) => e.className === 'cc-primary').length, 1, 'one primary: Start team')
})

test('open sections: a log move re-asks the activity and the docs list, never a doc text', async () => {
  const p = start()
  toggle(p, 'Activity')
  toggle(p, 'Docs')
  assert.deepEqual(p.sent('activity'), [{ type: 'activity', roomId: 'r1' }])
  assert.deepEqual(p.sent('docs'), [{ type: 'docs', roomId: 'r1' }])
  p.answer(p.posts.find((m) => m.type === 'activity'), { ok: true, entries: [entry(3)], before: null })
  p.answer(p.posts.find((m) => m.type === 'docs'), { ok: true, docs: [{ path: 'a.md', size: 3 }] })
  await tick(p)
  assert.match(p.root.text, /m3 left/)
  p.send(withLog(4))
  p.runTimeouts()
  assert.equal(p.sent('activity').length, 2)
  assert.equal(p.sent('docs').length, 2)
  assert.equal(p.sent('doc').length, 0)
})

test('two reads of the same doc answered out of order: the newer read\'s text stays', async () => {
  const p = start()
  toggle(p, 'Docs')
  p.answer(p.posts.find((m) => m.type === 'docs'), { ok: true, docs: [{ path: 'a.md', size: 3 }] })
  await tick(p)
  p.fire(p.find((e) => e.dataset.key === 'doc-a.md')[0], 'click')
  p.fire(p.find((e) => e.dataset.key === 'doc-a.md')[0], 'click')
  const [first, second] = p.sent('doc').length === 2 ? p.posts.filter((m) => m.type === 'doc') : []
  assert.ok(first && second, 'two reads')
  p.answer(second, { ok: true, text: 'newer text' })
  await tick(p)
  p.answer(first, { ok: true, text: 'older text' })
  await tick(p)
  assert.match(p.root.text, /newer text/)
  assert.doesNotMatch(p.root.text, /older text/)
})

test('a new mark refreshes the open activity with no log move, and a closed one when it is opened again', async () => {
  const p = start()
  p.runTimeouts() // the first state's log refresh (nothing open)
  toggle(p, 'Activity')
  p.answer(p.posts.find((m) => m.type === 'activity'), { ok: true, entries: [entry(3)], before: null })
  await tick(p)
  p.runTimeouts()
  assert.equal(p.sent('activity').length, 1)
  // Marks live outside the Rooms log: the state's logSeq stays 3.
  const st = teamState()
  st.team.marks = [{ at: 40, label: 'design done', by: 'person' }]
  p.send(st)
  p.runTimeouts()
  assert.equal(p.sent('activity').length, 2, 'asked again on the mark')
  p.answer(p.posts.filter((m) => m.type === 'activity')[1], { ok: true, entries: [{ type: 'mark', at: 40, label: 'design done', by: 'person' }, entry(3)], before: null })
  await tick(p)
  // Closed: a second mark asks nothing, reopening asks once.
  toggle(p, 'Activity', false)
  st.team.marks = [...st.team.marks, { at: 50, label: 'api done', by: 'lead' }]
  p.send(st)
  p.runTimeouts()
  assert.equal(p.sent('activity').length, 2, 'a closed section asks nothing')
  toggle(p, 'Activity')
  assert.equal(p.sent('activity').length, 3, 'reopened: asked for the new mark')
  // Nothing changed since: closing and opening again asks nothing.
  p.answer(p.posts.filter((m) => m.type === 'activity')[2], { ok: true, entries: [], before: null })
  await tick(p)
  toggle(p, 'Activity', false)
  toggle(p, 'Activity')
  assert.equal(p.sent('activity').length, 3)
})

test('a filter change during a load is asked at once, and the old answer is not shown', async () => {
  const p = start()
  toggle(p, 'Activity')
  const first = p.posts.find((m) => m.type === 'activity')
  const select = p.find((e) => e.tag === 'select')[0]
  select.value = 'api'
  p.fire(select, 'change', { target: select })
  assert.deepEqual(p.sent('activity')[1], { type: 'activity', roomId: 'r1', member: 'api' }, 'not held behind the running one')
  p.answer(first, { ok: true, entries: [entry(3)], before: null })
  await tick(p)
  assert.doesNotMatch(p.root.text, /m3 left/)
  assert.equal(p.sent('activity').length, 2, 'the stale answer asks nothing more')
})

test('a log move during a load re-asks when it ends (the list is as of when it was asked)', async () => {
  const p = start()
  toggle(p, 'Activity')
  const first = p.posts.find((m) => m.type === 'activity')
  p.send(withLog(4))
  p.runTimeouts() // dropped: one is running
  assert.equal(p.sent('activity').length, 1)
  p.answer(first, { ok: true, entries: [entry(3)], before: null })
  await tick(p)
  assert.equal(p.sent('activity').length, 2)
})

test('a team switch during a load: the old answer is ignored and the new team is asked, with no filter carried over', async () => {
  const st = teamState()
  st.teams.push({ roomId: 'r2', title: 'Other', createdAt: 0, paused: false, members: 0, waiting: 0, logSeq: 1 })
  const p = start(st)
  toggle(p, 'Activity')
  const old = p.posts.find((m) => m.type === 'activity')
  const select = p.find((e) => e.tag === 'select')[0]
  select.value = 'api'
  p.fire(select, 'change', { target: select })
  p.fire(p.find((e) => e.tag === 'li' && e.dataset.key === 'team-r2')[0], 'click')
  p.send({ ...st, team: { roomId: 'r2', title: 'Other', createdAt: 0, paused: false, members: 0, waiting: 0, logSeq: 1, members: [], questions: [], marks: [], stats: null } })
  p.runTimeouts()
  p.answer(old, { ok: true, entries: [entry(3)], before: null })
  await tick(p)
  assert.doesNotMatch(p.root.text, /m3 left/)
  const asks = p.sent('activity')
  assert.deepEqual(asks[asks.length - 1], { type: 'activity', roomId: 'r2' }, 'asked for r2, no member filter')
})

test('a refresh keeps the older pages that were loaded', async () => {
  const p = start()
  toggle(p, 'Activity')
  p.answer(p.posts.find((m) => m.type === 'activity'), { ok: true, entries: [entry(10), entry(9)], before: { seq: 9, at: 90 } })
  await tick(p)
  clickBtn(p, 'Load older')
  const older = p.posts.filter((m) => m.type === 'activity')[1]
  assert.deepEqual(older.before, { seq: 9, at: 90 })
  p.answer(older, { ok: true, entries: [entry(8), entry(7)], before: null })
  await tick(p)
  p.send(withLog(4))
  p.runTimeouts()
  p.answer(p.posts.filter((m) => m.type === 'activity')[2], { ok: true, entries: [entry(11), entry(10), entry(9)], before: { seq: 9, at: 90 } })
  await tick(p)
  const text = p.root.text
  for (const n of [11, 10, 9, 8, 7]) assert.match(text, new RegExp(`m${n} left`))
  assert.ok(text.indexOf('m11 left') < text.indexOf('m10 left') && text.indexOf('m9 left') < text.indexOf('m8 left'))
  assert.equal((text.match(/m10 left/g) || []).length, 1)
})

test('a filter change while "Load older" runs: the old filter\'s page is never shown or merged into the new one', async () => {
  const p = start()
  toggle(p, 'Activity')
  p.answer(p.posts.find((m) => m.type === 'activity'), { ok: true, entries: [entry(10), entry(9)], before: { seq: 9, at: 90 } })
  await tick(p)
  clickBtn(p, 'Load older')
  const older = p.posts.filter((m) => m.type === 'activity')[1]
  const kind = p.find((e) => e.tag === 'select' && e.dataset.key === 'act-kind')[0]
  kind.value = 'join'
  p.fire(kind, 'change', { target: kind })
  // The old filter's older page answers first, then the new filter's first page.
  p.answer(older, { ok: true, entries: [entry(8), entry(7)], before: null })
  await tick(p)
  const asks = p.posts.filter((m) => m.type === 'activity')
  const fresh = asks[asks.length - 1]
  const { req, ...asked } = fresh
  assert.deepEqual(asked, { type: 'activity', roomId: 'r1', kind: 'join' })
  const join = (n) => ({ type: 'join', seq: n, at: n * 10, member: `j${n}` })
  p.answer(fresh, { ok: true, entries: [join(6), join(5)], before: null })
  await tick(p)
  const text = p.root.text
  for (const n of [10, 9, 8, 7]) assert.doesNotMatch(text, new RegExp(`m${n} left`), `m${n} is the old filter's`)
  assert.match(text, /j6 joined/)
  assert.match(text, /j5 joined/)
  assert.equal(p.posts.filter((m) => m.type === 'activity').length, asks.length, 'no further ask')
})

test('a state that changed nothing renders nothing; focus and the scroll of the doc and the answer survive a render', async () => {
  const p = start()
  const rows = p.root.children.length
  const before = p.root.children.map((c) => c)
  p.send(teamState())
  assert.deepEqual(p.root.children, before, 'same tree')
  assert.equal(p.root.children.length, rows)

  toggle(p, 'Docs')
  p.answer(p.posts.find((m) => m.type === 'docs'), { ok: true, docs: [{ path: 'a.md', size: 3 }] })
  await tick(p)
  p.fire(p.find((e) => e.dataset.key === 'doc-a.md')[0], 'click')
  p.answer(p.posts.find((m) => m.type === 'doc'), { ok: true, text: 'long text' })
  await tick(p)
  p.find((e) => e.className === 'doc-text')[0].scrollTop = 77
  p.find((e) => e.tag === 'textarea')[0].scrollTop = 33
  const hire = p.button('Hire…')
  hire.focus()
  // The elapsed time moves: the page may render (nothing is being typed), and everything stays where it was.
  const st = teamState()
  st.team.stats = { elapsedMs: 5000, totals: { costUsd: 0, workingMs: 0, waitingMs: 0, idleMs: 0, sent: 0, received: 0, docReads: 0, docWrites: 0 }, personActiveMs: 0, questions: { asked: 0, answered: 0, open: 0 }, spans: [] }
  p.send(st)
  st.team.stats = { ...st.team.stats, elapsedMs: 10000 }
  p.send(st)
  const now = p.document.activeElement
  assert.ok(now.isConnected && now.text === 'Hire…', 'focus on a button without a key is restored')
  assert.equal(p.find((e) => e.className === 'doc-text')[0].scrollTop, 77)
  assert.equal(p.find((e) => e.tag === 'textarea')[0].scrollTop, 33)
  const member = memberRow(p, 'lead')
  member.focus()
  st.team.stats = { ...st.team.stats, elapsedMs: 15000 }
  p.send(st)
  assert.equal(p.document.activeElement.dataset.key, 'member-lead')
  assert.ok(p.document.activeElement.isConnected)
})

test('while the person types, selects text or has a select focused, a time-only state waits; a real change renders', () => {
  const p = start()
  const timeOnly = (n) => {
    const st = teamState()
    st.team.members[0].workingMs = n
    return st
  }
  const box = p.find((e) => e.tag === 'textarea')[0]
  box.focus()
  const kept = p.root.children.slice()
  p.send(timeOnly(6000))
  assert.deepEqual(p.root.children, kept, 'typing: not rebuilt')
  p.send(teamState({ ...{}, team: { ...teamState().team, questions: [] } }))
  assert.notDeepEqual(p.root.children, kept, 'a question went: rendered')
  // A deferred render goes ahead when the person is done.
  const p2 = start()
  p2.win.selecting = true
  const kept2 = p2.root.children.slice()
  p2.send(timeOnly(7000))
  assert.deepEqual(p2.root.children, kept2, 'selecting: not rebuilt')
  p2.win.selecting = false
  p2.docFire('selectionchange')
  assert.notDeepEqual(p2.root.children, kept2, 'rendered once the selection ended')
})

test('Enter on the actions button does not also show the tab; Enter on a team row does select it', () => {
  const p = start()
  const actions = p.find((e) => e.dataset.key === 'act-lead')[0]
  p.fire(actions, 'keydown', { key: 'Enter' })
  assert.equal(p.sent('focus').length, 0)
  p.fire(memberRow(p, 'lead'), 'keydown', { key: 'Enter' })
  assert.equal(p.sent('focus').length, 1)
})

test('a confirm focuses Cancel; Enter in the End form\'s folder field does not end the team', () => {
  const p = start()
  clickBtn(p, 'End and export…')
  assert.equal(p.document.activeElement.text, 'Cancel')
  const input = p.find((e) => e.tag === 'input')[0]
  p.fire(input, 'keydown', { key: 'Enter' })
  assert.equal(p.sent('end').length, 0)
  const s = teamState()
  s.teams[0].endedAt = 9
  s.team.endedAt = 9
  const q = start(s)
  clickBtn(q, 'Delete…')
  assert.equal(q.document.activeElement.text, 'Cancel')
})

test('the menu gives the focus back to the actions button even after a render replaced it', () => {
  const p = start()
  const actions = p.find((e) => e.dataset.key === 'act-lead')[0]
  p.fire(actions, 'click', { currentTarget: actions })
  p.send(teamState({ team: { ...teamState().team, questions: [] } })) // a real change while the menu is open
  const menu = p.menuHost.firstChild
  p.fire(menu, 'keydown', { key: 'Escape' })
  assert.ok(p.document.activeElement.isConnected)
  assert.equal(p.document.activeElement.dataset.key, 'act-lead')
})

// ---- page state bound to a team: a team change (click, auto-select after a delete or an end) closes it ----

/** Two live teams, r1 (selected, with a member menu) and r2 with a member of the same name and a question q1 too. */
const twoTeams = () => {
  const st = teamState()
  st.teams.push({ roomId: 'r2', title: 'Other', createdAt: 0, paused: false, members: 2, waiting: 1, logSeq: 1 })
  return st
}
const r2State = (teams) => ({
  type: 'state', exportDir: '', teams,
  team: {
    roomId: 'r2', title: 'Other', createdAt: 0, paused: false, members: 2, waiting: 1, logSeq: 1,
    members: [{ name: 'lead', coordinator: true, in: true, status: 'idle', held: 0, costUsd: 0, workingMs: 0, contextPercent: 0 },
      { name: 'api', coordinator: false, in: true, status: 'idle', held: 0, costUsd: 0, workingMs: 0, contextPercent: 0 }],
    questions: [{ id: 'q1', from: 'api', text: 'other team?', askedAt: 6 }],
    marks: [], stats: null,
  },
})
/** The ways the selection moves off r1: a click on r2, or a state where r1 is gone (deleted elsewhere). */
const switches = {
  click: (p) => p.fire(p.find((e) => e.tag === 'li' && e.dataset.key === 'team-r2')[0], 'click'),
  'auto-select after a delete': (p, st) => p.send({ ...st, teams: st.teams.filter((t) => t.roomId !== 'r1'), team: null }),
}

for (const [how, move] of Object.entries(switches)) {
  test(`a member menu is closed by a team change (${how}); its stale Fire never reaches the new team`, async () => {
    const st = twoTeams()
    const p = start(st)
    const actions = p.find((e) => e.dataset.key === 'act-api')[0]
    p.fire(actions, 'click', { currentTarget: actions })
    const fire = p.menuHost.firstChild.children.find((b) => b.text === 'Fire…')
    const show = p.menuHost.firstChild.children.find((b) => b.text === 'Show tab')
    move(p, st)
    assert.equal(p.menuHost.firstChild, null, 'the menu is closed')
    p.send(r2State(st.teams.filter((t) => how === 'click' || t.roomId !== 'r1')))
    // A click on an item of the old menu (held from before) does nothing: no form for r2's api, no post.
    p.fire(fire, 'click')
    p.fire(show, 'click')
    assert.equal(p.button('Remove'), undefined)
    assert.equal(p.sent('focus').length, 0)
    assert.equal(p.sent('fire').length, 0)
  })

  test(`every team form and confirm is closed by a team change (${how}); New team stays`, async () => {
    for (const [open, marker] of [['Hire…', 'Hire a member'], ['Mark', 'Add mark'], ['Copy invite…', 'Create invite'], ['End and export…', 'End team'], ['fire', 'Remove'], ['invite-result', 'Copy line']]) {
      const st = twoTeams()
      const p = start(st)
      if (open === 'fire' || open === 'invite-result') {
        const actions = p.find((e) => e.dataset.key === 'act-api')[0]
        p.fire(actions, 'click', { currentTarget: actions })
        p.fire(p.menuHost.firstChild.children.find((b) => b.text === (open === 'fire' ? 'Fire…' : 'Copy invite…')), 'click')
        if (open === 'invite-result') {
          typeInto(p, p.find((e) => e.tag === 'input')[0], 'qa')
          clickBtn(p, 'Create invite')
          p.answer(p.posts.find((m) => m.type === 'invite'), { ok: true, name: 'qa', line: 'ccc room join X' })
        }
      } else clickBtn(p, open)
      await tick(p)
      assert.match(p.root.text, new RegExp(marker), `${open} is open`)
      move(p, st)
      p.send(r2State(st.teams.filter((t) => how === 'click' || t.roomId !== 'r1')))
      assert.doesNotMatch(p.root.text, new RegExp(marker), `${open} is closed (${how})`)
    }
    // The New team form is no team's: it stays.
    const st = twoTeams()
    const p = start(st)
    clickBtn(p, 'New team')
    move(p, st)
    assert.match(p.root.text, /Start team/)
  })

  test(`a reply in flight on r1 does not disable r2's question of the same id (${how}); its answer is r1's`, async () => {
    const st = twoTeams()
    const p = start(st)
    typeInto(p, p.find((e) => e.tag === 'textarea')[0], 'yes')
    clickBtn(p, 'Reply')
    assert.equal(p.sent('reply')[0].roomId, 'r1')
    move(p, st)
    p.send(r2State(st.teams.filter((t) => how === 'click' || t.roomId !== 'r1')))
    assert.match(p.root.text, /other team\?/)
    assert.ok(p.button('Reply') && !p.button('Reply').disabled, 'r2\'s Reply is usable')
    assert.ok(!p.button('Done').disabled)
    clickBtn(p, 'Done')
    assert.deepEqual(p.sent('done'), [{ type: 'done', roomId: 'r2', id: 'q1' }])
    // r1's answer arriving now is told as r1's reply; r2's question stays as it was.
    p.answer(p.posts.find((m) => m.type === 'reply'), { ok: true, answers: [{ to: 'api', path: 'delivered' }] })
    await tick(p)
    assert.match(p.root.text, /Answer sent to api\./)
    assert.match(p.root.text, /other team\?/)
  })
}

test('the delete confirm closes when an end elsewhere auto-selects another team; a form posts the team it was opened for', async () => {
  const st = twoTeams()
  st.teams[0].endedAt = 9
  st.team.endedAt = 9
  // r2 is live, so it is picked first: the person selects the ended r1.
  const p = start(st)
  p.fire(p.find((e) => e.tag === 'li' && e.dataset.key === 'team-r1')[0], 'click')
  p.send(st)
  clickBtn(p, 'Delete…')
  assert.match(p.root.text, /Delete team/)
  // Deleted elsewhere: r1 is gone, r2 is picked.
  p.send({ ...st, teams: st.teams.slice(1), team: null })
  assert.doesNotMatch(p.root.text, /Delete team/)
  // A confirm submitted on r1 whose answer comes after a switch: the post named r1.
  const q = start(twoTeams())
  const actions = q.find((e) => e.dataset.key === 'act-api')[0]
  q.fire(actions, 'click', { currentTarget: actions })
  q.fire(q.menuHost.firstChild.children.find((b) => b.text === 'Fire…'), 'click')
  clickBtn(q, 'Remove')
  switches.click(q)
  assert.deepEqual(q.sent('fire'), [{ type: 'fire', roomId: 'r1', name: 'api' }])
  q.answer(q.posts.find((m) => m.type === 'fire'), { ok: true, name: 'api' })
  await tick(q)
  assert.equal(q.sent('fire').length, 1)
})
