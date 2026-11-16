'use strict'
// A fake plugin `ctx` for every test of this plugin. It follows the real API of cc-cockpit's
// src/sdk/types.ts (the release with Rooms) and its guide (`ccc guide rooms`, `api`): method names,
// arguments, return shapes and which calls reject. It records what the host did so a test can assert on
// it. What it cannot know is main's exact refusal text: a refusal here rejects with an Error naming the
// method and the rule (as the real one does), so tests match on the rule, never on a whole message.
//
// Covered: ctx.rooms (create/list/end/delete/open/invite/members/remove/send/docs/log with `seq` and `at`, log pages
// bounded by bytes as well as count (`logPageBytes`),
// the caps and checks types.ts documents), ctx.sessions (full SessionInfo, onChange with the whole list,
// open/focus, the shared 5 opens a minute), ctx.cli (declared names only, one handler per name),
// ctx.storage, ctx.notify, ctx.panels, ctx.settings, ctx.schedule. Not modelled: the delivery gate's
// timing (Stop pointers, the 5-stops cap, auto-pause) and the 30 s abort: a test sets a session's
// status, `typed` or the room's `paused` to choose a send's path, and passes its own `signal`.
// Log entries carry main's fields (cc-cockpit src/main/rooms: room-registry.ts, room-docs.ts, room-delivery.ts):
// create { title, pluginId }, join { member, coordinator, via: 'open' | 'invite' }, leave { member, why, dropped },
// end { why }, invite { member, coordinator, expiresAt }, send { from, to, text, delivery }, the person's held-badge
// click as a send with no `delivery` (`badgeClick`), and doc-read / doc-write { by, path, bytes } for every plugin
// read and write (`by: 'plugin'`).

const fs = require('node:fs')
const path = require('node:path')

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'))

const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/
const RESERVED_NAMES = new Set(['all', 'plugin', 'person', 'user', 'system'])
const MODELS = new Set(['haiku', 'sonnet', 'opus', 'fable'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const DOC_PART_RE = /^[A-Za-z0-9._-]+$/
const DOC_MAX = 256 * 1024
const ROOM_DOCS_MAX = 20 * 1024 * 1024
const SEND_MAX = 20000
const STORAGE_VALUE_MAX = 1024 * 1024
const STORAGE_TOTAL_MAX = 16 * 1024 * 1024
const PANEL_MESSAGE_MAX = 1024 * 1024
const VIEW_ID_RE = /^web:[1-9][0-9]{0,11}$/
const LOG_MAX = 1000
const MINUTE = 60_000
// Rooms' character rules, as cc-cockpit's src/shared/session-name.ts has them: CONTROL (C0, DEL, C1, bidi marks and
// controls, line/paragraph separators, invisible operators, BOM); a doc or message also refuses every other format
// character (Unicode Cf) but ZWNJ and ZWJ (HIDDEN_TEXT), with tab, LF and CRLF allowed. A title (room-names.ts)
// refuses CONTROL and quotes and brackets, typographic ones included.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/
const HIDDEN_TEXT = new RegExp(`${CONTROL.source}|(?![\\u200c\\u200d])\\p{Cf}`, 'u')
const badDocText = (text) => {
  for (const ch of text.replace(/\r\n/g, '\n')) if (ch !== '\t' && ch !== '\n' && HIDDEN_TEXT.test(ch)) return true
  return false
}
const TITLE_FORBIDDEN = new Set([...'"\'`'+String.fromCharCode(0x201c, 0x201d, 0x201e, 0x201f, 0x2018, 0x2019, 0x201a, 0x201b, 0xab, 0xbb, 0x2039, 0x203a)+'()[]{}<>'])
/** Rooms' checkRoomTitle (room-names.ts): each character checked, then trimmed, 1-60 code points. The reason or null. */
const titleRefusal = (title) => {
  if (typeof title !== 'string') return 'title must be a string'
  for (const ch of title) {
    if (CONTROL.test(ch)) return 'title may not contain control, bidi or invisible format characters'
    if (TITLE_FORBIDDEN.has(ch)) return 'title may not contain quote or bracket characters'
  }
  const value = title.trim()
  if (value === '') return 'title must not be empty'
  if ([...value].length > 60) return 'title is longer than 60 characters'
  return null
}

function fakeCtx(opts = {}) {
  const projectDir = opts.projectDir || '/proj'
  const handlers = new Map()
  const store = new Map()
  const notices = [] // { text, options }
  const posts = []
  const schedules = []
  const opens = [] // every rooms.open / sessions.open, with the options the host passed
  const panelListeners = new Map()
  const actionListeners = new Map()
  const headers = new Map()
  const shownPanels = []
  const sessionListeners = new Set()
  const settingsListeners = new Set()
  const sessions = new Map() // tabId -> SessionInfo
  // roomId -> { id, title, createdAt, endedAt?, paused, members: Map(name -> { name, coordinator, tabId?, held }),
  //            invites: Map(code -> { name, coordinator, expiresAt }), docs: Map(path -> text), log: [], seq, sends: [] }
  const rooms = new Map()
  const caps = {
    rooms: opts.maxRooms ?? 5,
    endedRooms: 50,
    members: opts.maxMembers ?? 20,
    invites: 20,
    opensPerMinute: opts.opensPerMinute ?? 5,
    roomSendsPerMinute: opts.roomSendsPerMinute ?? 60,
    heldPerMember: 100,
  }
  // Bytes of JSON lines in one ctx.rooms.log page (main bounds a page under the 1 MiB RPC cap); small to test paging.
  const logPageBytes = opts.logPageBytes ?? 512 * 1024
  const clock = { t: opts.now ?? 1_700_000_000_000 }
  const now = () => clock.t
  const openTimes = []
  let nextRoom = 1
  let nextTab = 1
  let nextCode = 1

  const refuse = (method, rule) => new Error(`${method}: ${rule}`)
  const room = (method, id) => {
    const r = rooms.get(id)
    if (!r) throw refuse(method, 'no such room')
    return r
  }
  const live = (method, id) => {
    const r = room(method, id)
    if (r.endedAt !== undefined) throw refuse(method, 'the room ended')
    return r
  }
  const log = (r, entry) => {
    r.log.push({ seq: ++r.seq, at: now(), ...entry })
  }
  const checkName = (method, name) => {
    if (typeof name !== 'string' || !NAME_RE.test(name) || RESERVED_NAMES.has(name)) {
      throw refuse(method, 'name must match ^[a-z][a-z0-9-]{0,30}$ and not be all, plugin, person, user or system')
    }
  }
  const emitSessions = () => {
    const list = [...sessions.values()].map((s) => structuredClone(s))
    for (const fn of sessionListeners) fn(list)
  }
  const setSessionRoom = (tabId, r, m) => {
    const s = sessions.get(tabId)
    if (!s) return
    if (r && m) {
      s.room = { title: r.title, name: m.name, coordinator: m.coordinator }
      if (m.held > 0) s.held = m.held
      else delete s.held
    } else {
      delete s.room
      delete s.held
    }
  }

  /** ctx.sessions.open's checks and its 5 opens a minute, shared with rooms.open. */
  const openTab = (method, o = {}) => {
    if (o.prompt !== undefined && (typeof o.prompt !== 'string' || /^[/!#&]/.test(o.prompt))) {
      throw refuse(method, 'prompt may not start with "/", "!", "#" or "&"')
    }
    if (o.model !== undefined && !MODELS.has(o.model)) throw refuse(method, `unknown model: ${o.model}`)
    if (o.effort !== undefined && !EFFORTS.has(o.effort)) throw refuse(method, `unknown effort: ${o.effort}`)
    const cwd = o.cwd === undefined ? projectDir : path.resolve(projectDir, o.cwd)
    if (cwd !== projectDir && !cwd.startsWith(projectDir + path.sep)) {
      throw refuse(method, 'cwd must be inside the project folder')
    }
    while (openTimes.length && openTimes[0] <= now() - MINUTE) openTimes.shift()
    if (openTimes.length >= caps.opensPerMinute) {
      throw refuse(method, `at most ${caps.opensPerMinute} tabs a minute (opensPerMinute)`)
    }
    openTimes.push(now())
    const tabId = `tab${nextTab++}`
    sessions.set(tabId, { tabId, status: 'starting', cwd, notes: [], files: [], typed: false })
    return { tabId, cwd }
  }

  const checkDocPath = (method, p) => {
    const parts = typeof p === 'string' ? p.split('/') : []
    let below
    if (parts[0] === 'shared') below = parts.slice(1)
    else if (parts[0] === 'members' && parts.length >= 2 && NAME_RE.test(parts[1])) below = parts.slice(2)
    if (!below || below.length < 1 || below.length > 4 || below.some((x) => x === '.' || x === '..' || !DOC_PART_RE.test(x))) {
      throw refuse(method, `bad doc path: ${p} (shared/... or members/<name>/..., at most four parts of [A-Za-z0-9._-])`)
    }
  }

  /** The path a real send would take for one member, from the state a test set up. */
  const deliver = (r, m) => {
    if (m.held >= caps.heldPerMember) return { to: m.name, path: 'refused', why: 'queue full' }
    m.held++
    if (r.paused) return { to: m.name, path: 'held', why: 'paused' }
    const s = m.tabId && sessions.get(m.tabId)
    if (!s) return { to: m.name, path: 'held', why: 'no-tab' }
    if (s.typed) return { to: m.name, path: 'held', why: 'typed' }
    if (s.status !== 'waiting') return { to: m.name, path: 'held', why: 'not-waiting', status: s.status }
    return { to: m.name, path: 'delivered' }
  }

  const roomsApi = {
    async create(options) {
      const why = titleRefusal(options && options.title)
      if (why) throw refuse('rooms.create', why)
      // Stored trimmed, as Rooms does.
      const title = options.title.trim()
      const all = [...rooms.values()]
      if (all.filter((r) => r.endedAt === undefined).length >= caps.rooms) {
        throw refuse('rooms.create', `at most ${caps.rooms} rooms (roomsPerProject)`)
      }
      if (all.filter((r) => r.endedAt !== undefined).length >= caps.endedRooms) {
        throw refuse('rooms.create', `at most ${caps.endedRooms} ended rooms kept: delete one first`)
      }
      const id = `room${nextRoom++}`
      rooms.set(id, {
        id,
        title,
        createdAt: now(),
        paused: false,
        members: new Map(),
        invites: new Map(),
        docs: new Map(),
        log: [],
        seq: 0,
        sends: [],
      })
      log(rooms.get(id), { type: 'create', title, pluginId: MANIFEST.id })
      return { id }
    },
    async list() {
      return [...rooms.values()].map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt,
        ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
        paused: r.paused,
        members: r.members.size,
      }))
    },
    async end(id) {
      // Main's endRoom is a no-op on an ended room (it resolves), and the members stay in the record as who took part
      // (their tabs are unbound: `members` answers them with no `tabId`).
      const r = room('rooms.end', id)
      if (r.endedAt !== undefined) return
      for (const m of r.members.values()) {
        if (m.tabId) setSessionRoom(m.tabId, null)
        delete m.tabId
      }
      r.invites.clear()
      r.endedAt = now()
      log(r, { type: 'end', why: 'ended' })
      emitSessions()
    },
    async delete(id) {
      const r = room('rooms.delete', id)
      if (r.endedAt === undefined) throw refuse('rooms.delete', 'only an ended room can be deleted')
      rooms.delete(id)
    },
    async open(id, options = {}) {
      const r = live('rooms.open', id)
      checkName('rooms.open', options.name)
      if (r.members.has(options.name)) throw refuse('rooms.open', `${options.name} is already a member`)
      if (r.members.size >= caps.members) throw refuse('rooms.open', `at most ${caps.members} members a room (membersPerRoom)`)
      const { tabId, cwd } = openTab('rooms.open', options)
      const m = { name: options.name, coordinator: options.coordinator === true, tabId, held: 0 }
      r.members.set(m.name, m)
      setSessionRoom(tabId, r, m)
      opens.push({ via: 'rooms.open', roomId: id, tabId, ...structuredClone(options), cwd })
      log(r, { type: 'join', member: m.name, coordinator: m.coordinator, via: 'open' })
      emitSessions()
      return { tabId }
    },
    async invite(id, options = {}) {
      const r = live('rooms.invite', id)
      checkName('rooms.invite', options.name)
      if (r.members.has(options.name)) throw refuse('rooms.invite', `${options.name} is already a member`)
      for (const [c, inv] of r.invites) if (inv.expiresAt <= now()) r.invites.delete(c)
      if (r.invites.size >= caps.invites) throw refuse('rooms.invite', `at most ${caps.invites} invites waiting`)
      const code = `inv${nextCode++}`
      const expiresAt = now() + 10 * MINUTE
      r.invites.set(code, { name: options.name, coordinator: options.coordinator === true, expiresAt })
      log(r, { type: 'invite', member: options.name, coordinator: options.coordinator === true, expiresAt })
      return { code, expiresAt }
    },
    async members(id) {
      const r = room('rooms.members', id)
      return [...r.members.values()].map((m) => ({
        name: m.name,
        coordinator: m.coordinator,
        ...(m.tabId ? { tabId: m.tabId } : {}),
        held: m.held,
      }))
    },
    async remove(id, name) {
      const r = live('rooms.remove', id)
      const m = r.members.get(name)
      if (!m) throw refuse('rooms.remove', `no member ${name}`)
      r.members.delete(name)
      if (m.tabId) setSessionRoom(m.tabId, null)
      log(r, { type: 'leave', member: name, why: 'removed', dropped: m.held })
      emitSessions()
    },
    async send(id, to, text) {
      const r = live('rooms.send', id)
      // Rooms counts code points (room-registry.ts isMessageText): an emoji is one character.
      if (typeof text !== 'string' || [...text].length > SEND_MAX) throw refuse('rooms.send', `at most ${SEND_MAX} characters`)
      if (text.trim() === '') throw refuse('rooms.send', 'a message is non-empty text of at most 20000 characters')
      if (badDocText(text)) throw refuse('rooms.send', 'a message is text with no control, bidi or invisible format character but tab and line breaks')
      const recipients = to === 'all' ? [...r.members.values()] : [r.members.get(to)].filter(Boolean)
      // The room's 60 sends a minute, `all` once per recipient.
      while (r.sends.length && r.sends[0] <= now() - MINUTE) r.sends.shift()
      if (r.sends.length + recipients.length > caps.roomSendsPerMinute) {
        throw refuse('rooms.send', `at most ${caps.roomSendsPerMinute} sends a minute in a room`)
      }
      for (let i = 0; i < recipients.length; i++) r.sends.push(now())
      const answers = to !== 'all' && recipients.length === 0 ? [{ to, path: 'gone' }] : recipients.map((m) => deliver(r, m))
      for (const m of recipients) if (m.tabId) setSessionRoom(m.tabId, r, m)
      log(r, { type: 'send', from: 'plugin', to, text, delivery: structuredClone(answers) })
      emitSessions()
      return answers
    },
    docs: {
      async list(id) {
        const r = room('rooms.docs.list', id)
        return [...r.docs.entries()].map(([p, text]) => ({ path: p, size: Buffer.byteLength(text, 'utf8') }))
      },
      async get(id, p) {
        const r = room('rooms.docs.get', id)
        checkDocPath('rooms.docs.get', p)
        // Refused equals missing: one answer for both, never undefined.
        if (!r.docs.has(p)) throw refuse('rooms.docs.get', `no such doc: ${p}`)
        const text = r.docs.get(p)
        log(r, { type: 'doc-read', by: 'plugin', path: p, bytes: Buffer.byteLength(text, 'utf8') })
        return text
      },
      async put(id, p, text) {
        const r = room('rooms.docs.put', id)
        checkDocPath('rooms.docs.put', p)
        if (typeof text !== 'string' || badDocText(text)) {
          throw refuse('rooms.docs.put', 'a doc is text with no control, bidi or invisible format character but tab and line breaks')
        }
        const size = Buffer.byteLength(text, 'utf8')
        if (size > DOC_MAX) throw refuse('rooms.docs.put', 'a doc is at most 256 KiB')
        let total = size
        for (const [q, t] of r.docs) if (q !== p) total += Buffer.byteLength(t, 'utf8')
        if (total > ROOM_DOCS_MAX) throw refuse('rooms.docs.put', 'a room holds at most 20 MiB of docs')
        r.docs.set(p, text)
        log(r, { type: 'doc-write', by: 'plugin', path: p, bytes: size })
      },
    },
    async log(id, options = {}) {
      const r = room('rooms.log', id)
      const limit = Math.max(1, Math.min(LOG_MAX, options.limit ?? LOG_MAX))
      // A page is bounded by its JSON lines' bytes too (main's room-log.ts `maxBytes`: at least one entry, `more` says
      // to page on), so a caller cannot assume `limit` entries came back.
      const fits = (list) => {
        let bytes = 0
        let n = 0
        for (const e of list) {
          const b = Buffer.byteLength(JSON.stringify(e), 'utf8') + 1
          if (n > 0 && bytes + b > logPageBytes) break
          bytes += b
          n++
        }
        return n
      }
      if (options.since !== undefined) {
        // The OLDEST entries after `since`; `more` when newer ones remain.
        const rest = r.log.filter((e) => e.seq > options.since)
        const n = fits(rest.slice(0, limit))
        return { entries: structuredClone(rest.slice(0, n)), more: rest.length > n }
      }
      // Without `since`: the NEWEST `limit` (newest kept first when the bytes run out); `more` when older ones were left out.
      const n = fits(r.log.slice(-limit).reverse())
      return { entries: structuredClone(r.log.slice(r.log.length - n)), more: r.log.length > n }
    },
  }

  const declaredPanel = (method, panelId) => {
    if (!(MANIFEST.contributes.panels || []).some((p) => p.id === panelId)) throw new Error(`${method}: undeclared panel ${panelId}`)
  }

  const ctx = {
    api: 1,
    pluginId: MANIFEST.id,
    projectDir,
    dataDir: opts.dataDir || `/data/plugin-data/p1/${MANIFEST.id}`,
    settings: { project: opts.project || {}, app: opts.app || {} },
    onSettingsChange(fn) {
      settingsListeners.add(fn)
      return () => settingsListeners.delete(fn)
    },
    log: { info() {}, warn() {}, error() {} },
    // As the real store (cc-cockpit src/shared/plugin-storage.ts): a value is kept as its JSON text (so `undefined`
    // fields vanish and a Date becomes a string, as on disk), at most 1 MiB of it, and 16 MiB of keys plus values in
    // all; a value that is not JSON or passes a cap is a rejection and changes nothing.
    storage: {
      get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : undefined),
      async set(k, v) {
        if (typeof k !== 'string' || k === '') throw new TypeError('storage key must be a non-empty string')
        if (k.length > 200) throw new RangeError('storage key is longer than 200 characters')
        let text
        try {
          text = JSON.stringify(v)
        } catch {
          text = undefined
        }
        if (text === undefined) throw new TypeError('storage value must be JSON')
        if (text.length > STORAGE_VALUE_MAX) throw new RangeError(`storage value is larger than ${STORAGE_VALUE_MAX} characters`)
        let total = k.length + text.length
        for (const [key, val] of store) if (key !== k) total += key.length + JSON.stringify(val).length
        if (total > STORAGE_TOTAL_MAX) throw new RangeError(`storage would exceed ${STORAGE_TOTAL_MAX} characters in total`)
        store.set(k, JSON.parse(text))
      },
      delete: async (k) => void store.delete(k),
      keys: async () => [...store.keys()],
    },
    async notify(text, options) {
      // The host's parseNotifyOptions (src/shared/notify.ts): a title is 1 to 80 UTF-16 units after the control
      // characters go (longer rejects, which a plugin's notice must survive); the text is cut at 500, never rejected.
      if (options !== undefined) {
        if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('notify: options must be an object')
        if (options.title !== undefined) {
          if (typeof options.title !== 'string') throw new TypeError('notify: title must be a string')
          // eslint-disable-next-line no-control-regex
          const t = options.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()
          if (t === '') throw new TypeError('notify: title must not be empty')
          if (t.length > 80) throw new TypeError('notify: title is over 80 characters')
        }
      }
      notices.push({ text, options })
      return { clicked: false }
    },
    schedule(seconds, fn) {
      const entry = { seconds, fn }
      schedules.push(entry)
      return () => {
        const i = schedules.indexOf(entry)
        if (i >= 0) schedules.splice(i, 1)
      }
    },
    cli: {
      register(name, fn) {
        if (!(MANIFEST.contributes.cli || []).some((c) => c.name === name)) {
          throw new Error(`cli.register: ${name} is not declared in contributes.cli`)
        }
        if (handlers.has(name)) throw new Error(`cli.register: ${name} already has a handler`)
        handlers.set(name, fn)
        return () => handlers.delete(name)
      },
    },
    sessions: {
      list: async () => [...sessions.values()].map((s) => structuredClone(s)),
      // The real listener gets the whole list (at most 4 times a second; the fake does not throttle).
      onChange(fn) {
        sessionListeners.add(fn)
        return () => sessionListeners.delete(fn)
      },
      focus: async (tabId) => sessions.has(tabId),
      async open(options = {}) {
        const { tabId, cwd } = openTab('sessions.open', options)
        opens.push({ via: 'sessions.open', tabId, ...structuredClone(options), cwd })
        emitSessions()
        return { tabId }
      },
    },
    panels: {
      // As the real one (cc-cockpit src/host/ctx/ui.ts): a `view` must be 'desktop' or a browser view id
      // (`web:<n>`, src/shared/views.ts) or it throws; a message over 1 MiB of JSON throws. A well-formed view that
      // has no page (left, hidden) drops the message silently, which the fake does not model.
      post(panelId, message, options) {
        declaredPanel('panels.post', panelId)
        const view = options && options.view
        if (view !== undefined && view !== 'desktop' && !VIEW_ID_RE.test(view)) {
          throw new TypeError(`panels.post: view must be the \`view\` a panels.onMessage listener got, not ${JSON.stringify(view)}`)
        }
        const text = JSON.stringify(message)
        if (text === undefined) throw new TypeError('panels.post: the message is not JSON')
        if (text.length > PANEL_MESSAGE_MAX) throw new RangeError(`panels.post: message of ${text.length} chars exceeds ${PANEL_MESSAGE_MAX}`)
        posts.push([panelId, JSON.parse(text), options])
      },
      onMessage(panelId, fn) {
        declaredPanel('panels.onMessage', panelId)
        panelListeners.set(panelId, fn)
        return () => panelListeners.delete(panelId)
      },
      show(panelId) {
        declaredPanel('panels.show', panelId)
        shownPanels.push(panelId)
      },
      header(panelId, header) {
        declaredPanel('panels.header', panelId)
        headers.set(panelId, header)
      },
      onAction(panelId, fn) {
        declaredPanel('panels.onAction', panelId)
        actionListeners.set(panelId, fn)
        return () => actionListeners.delete(panelId)
      },
    },
  }
  if (opts.rooms !== false) ctx.rooms = roomsApi

  const cliEntry = (MANIFEST.contributes.cli || []).find((c) => c.name === 'team') || {}

  return {
    ctx,
    handlers,
    notices,
    posts,
    schedules,
    opens,
    headers,
    shownPanels,
    panelListeners,
    actionListeners,
    settingsListeners,
    rooms,
    sessions,
    store,
    caps,
    clock,
    /** Move the fake clock (rate caps, `at`, invite expiry). */
    advance(ms) {
      clock.t += ms
    },
    /**
     * Run `ccc team ...` as the app would. `call.tabId` absent: a shell tab or outside any tab. Stdin
     * reaches the handler as the app passes it: only with the manifest's `stdin`, and with `stdinDash`
     * only when an argument is `-` (else `''`).
     */
    async run(argv, call = {}) {
      const h = handlers.get('team')
      if (!h) throw new Error('team handler not registered')
      let stdin = call.stdin ?? ''
      if (!cliEntry.stdin || (cliEntry.stdinDash && !argv.includes('-'))) stdin = ''
      return h(argv, { cwd: projectDir, signal: new AbortController().signal, ...call, stdin })
    },
    /** Change a session (status, typed, ...) and tell onChange listeners the whole list, as the app does. */
    emitSession(info) {
      sessions.set(info.tabId, {
        ...(sessions.get(info.tabId) || { status: 'idle', cwd: projectDir, notes: [], files: [], typed: false }),
        ...info,
      })
      emitSessions()
    },
    /** A tab joining with an invite code, as `ccc room join <code>` run in that tab would. */
    join(code, tabId) {
      for (const r of rooms.values()) {
        const inv = r.invites.get(code)
        if (!inv) continue
        r.invites.delete(code)
        if (inv.expiresAt <= now() || r.endedAt !== undefined) throw new Error('invite expired')
        const m = { name: inv.name, coordinator: inv.coordinator, tabId, held: 0 }
        r.members.set(m.name, m)
        setSessionRoom(tabId, r, m)
        log(r, { type: 'join', member: m.name, coordinator: m.coordinator, via: 'invite' })
        emitSessions()
        return
      }
      throw new Error('no such invite')
    },
    /**
     * A message from the panel's page in `view` ('desktop' or `web:<n>`), as the app hands it to the host's
     * `ctx.panels.onMessage` listener (JSON round trip, `{ view }` second). Returns the listener's promise.
     */
    page(message, view = 'desktop', panelId = 'team') {
      const fn = panelListeners.get(panelId)
      if (!fn) throw new Error(`no listener on panel ${panelId}`)
      return fn(JSON.parse(JSON.stringify(message)), { view })
    },
    /** Pause or resume a room, as the person (or the loop guard) would. */
    setPaused(roomId, paused) {
      const r = rooms.get(roomId)
      r.paused = paused
      log(r, { type: paused ? 'pause' : 'resume' })
    },
    /**
     * The person clicks a member's held badge (main's RoomDelivery.deliverHeld): the pointer is pasted when the tab
     * waits, and the click is logged as a send with no `delivery` (no message moved). Returns whether it pasted.
     */
    badgeClick(roomId, name) {
      const r = rooms.get(roomId)
      const m = r && r.members.get(name)
      if (!m || m.held === 0 || r.endedAt !== undefined) return false
      const s = m.tabId && sessions.get(m.tabId)
      const delivered = !r.paused && !!s && !s.typed && s.status === 'waiting'
      log(r, { type: 'send', from: 'person', to: name, via: 'badge', pointer: m.held, delivered })
      return delivered
    },
    /** Append a log entry as Rooms would (for metrics tests): `type` is required, `at` defaults to the clock. */
    pushLog(roomId, entry) {
      if (!entry || typeof entry.type !== 'string') throw new Error('pushLog: an entry needs a type')
      const r = rooms.get(roomId)
      r.log.push({ at: now(), ...entry, seq: ++r.seq })
    },
  }
}

module.exports = { fakeCtx }
