'use strict'
// The Team panel page (docs/design.md §7). It only renders what the host pushes and asks for things; the host
// (lib/panel.js, see its protocol comment) checks every action again. Member text (questions, log entries, doc names
// and texts) is untrusted and only ever reaches the page as `textContent`: nothing here builds HTML from a string.
// A state is always an icon and a word (TeamView.statusInfo), never a colour alone.
;(function () {
  const V = globalThis.TeamView
  const root = document.getElementById('root')
  const menuHost = document.getElementById('menu-host')
  // A coordinator is usually a tab the person types in, where Rooms never pastes messages: they wait, held, until it
  // runs `ccc room read` (the skill tells it to when it expects answers).
  const COORDINATOR_TITLE = 'Coordinator. Its tab is usually the one you type in, so members\' messages wait (held) until it runs ccc room read.'

  // ---- page state ----
  let teams = []
  let team = null
  let exportDir = ''
  let stateError = null
  let selected = null
  let notice = null // { text, error }
  let form = null // { kind, roomId, values, error, busy, result }: roomId is the team it was opened for (null: New team)
  let lastLogSeq
  let lastActKey // V.activityKey of the last state: the log position plus the marks (the activity's own "as of")
  let logTimer = null
  // What the last state looked like (whole, and without the running numbers), and whether a render waited for the
  // person to finish something (see `busy`).
  let lastFull = null
  let lastSig = null
  let deferred = false
  /** The tab shown (kept across renders and team switches: a render rebuilds the elements). */
  const TABS = ['members', 'activity', 'docs', 'stats']
  let tab = 'members'
  const activity = { roomId: null, entries: [], before: null, loading: false, error: null, member: '', kind: '', seq: undefined, gen: 0, more: false, dirty: false, paged: false }
  const docs = { roomId: null, list: [], more: false, loading: false, error: null, seq: undefined, gen: 0, dirty: false }
  let openDoc = null // { path, text, loading, error }
  const drafts = new Map() // `${roomId}:${id}` -> reply text typed so far
  const replying = new Set() // `${roomId}:${id}` of the questions with a reply or done in flight (ids repeat across teams)

  // ---- requests ----
  let reqN = 0
  const pending = new Map()
  const REQ_TIMEOUT_MS = 5 * 60 * 1000

  /**
   * Post a request and resolve with the host's `result` (a missing answer resolves as a refusal, never hangs). A
   * post the SDK refuses (it throws for a message over 1 MiB as JSON: a pasted reply, a long form field) resolves as a
   * refusal too: a rejection here skipped the caller's cleanup and left its controls (`replying`, a form's `busy`)
   * disabled until a reload.
   */
  function request(message) {
    const req = ++reqN
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(req)
        resolve({ ok: false, error: 'no answer from the host' })
      }, REQ_TIMEOUT_MS)
      pending.set(req, (res) => {
        clearTimeout(timer)
        resolve(res)
      })
      try {
        ccPanel.post({ ...message, req })
      } catch (err) {
        clearTimeout(timer)
        pending.delete(req)
        const big = err && err.name === 'RangeError'
        resolve({
          ok: false,
          error: big ? 'Too large to send to the plugin (at most 1 MiB): shorten it.' : `Could not send to the plugin: ${(err && err.message) || err}`,
        })
      }
    })
  }

  /**
   * A guest of the owner's (cc-cockpit guest invites) looks at this page: `ccPanel.view.access` is 'read' or 'write'
   * (an older app has none: the owner). A hint only, to leave out what the host refuses a guest anyway (every action);
   * the host decides from main's tag, never from this page.
   */
  const guest = () => {
    const a = ccPanel.view && ccPanel.view.access
    return a === 'read' || a === 'write'
  }
  const hello = () => ccPanel.post({ type: 'hello', selected })
  let pingTimer = null
  function startPing() {
    stopPing()
    if (document.visibilityState === 'hidden') return
    // Main never says a view left: the host forgets one silent for 75 s, so a shown page pings every 30 s.
    pingTimer = setInterval(() => ccPanel.post({ type: 'ping', selected }), V.PING_SECONDS * 1000)
  }
  function stopPing() {
    if (pingTimer !== null) clearInterval(pingTimer)
    pingTimer = null
  }

  // ---- DOM helpers (text only) ----
  function h(tag, props, ...kids) {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue
      if (k === 'class') el.className = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'open' || k === 'readOnly') el[k] = v
      else el.setAttribute(k, v === true ? '' : String(v))
    }
    const add = (c) => {
      if (c === null || c === undefined || c === false) return
      if (Array.isArray(c)) c.forEach(add)
      else el.append(c instanceof Node ? c : document.createTextNode(String(c)))
    }
    kids.forEach(add)
    return el
  }
  const btn = (label, onclick, props) => h('button', { type: 'button', onclick, ...props }, label)

  function say(text, error) {
    notice = { text, error: error === true }
    render()
  }

  // ---- state in ----
  function resetPerTeam() {
    lastLogSeq = undefined
    lastActKey = undefined
    lastFull = null
    // A request of the old team may still be running: a new generation makes its answer stale, and `loading` is
    // cleared here so the new team's first load is not dropped behind it.
    activity.gen++
    activity.loading = false
    activity.dirty = false
    activity.paged = false
    activity.entries = []
    activity.before = null
    activity.error = null
    activity.seq = undefined
    activity.more = false
    // The filters belong to the team: B's member select has no option for A's member (it would show "All members"
    // over an empty list).
    activity.member = ''
    activity.kind = ''
    activity.roomId = selected
    docs.gen++
    docs.loading = false
    docs.dirty = false
    docs.list = []
    docs.more = false
    docs.error = null
    docs.seq = undefined
    docs.roomId = selected
    openDoc = null
    // Everything open for the old team goes with it, whatever moved the selection (a click, the auto-select after a
    // delete or an end): a member menu left open over the new team sent its Fire there (a member of the same name).
    // Every request still carries the team it was opened for (form.roomId, the menu's and the questions' roomId).
    if (form && form.kind !== 'new-team') form = null
    closeMenu()
  }

  function select(roomId) {
    if (roomId === selected) return
    selected = roomId
    team = null
    resetPerTeam()
    ccPanel.post({ type: 'select', roomId })
    render()
  }

  /** The state without the numbers that run with the clock or the meter (they change on every host tick). */
  const sigOf = (msg) => JSON.stringify([msg.teams, msg.team, msg.exportDir, msg.error], (k, v) => (k === 'ms' || k.endsWith('Ms') || k === 'costUsd' || k === 'contextPercent' ? undefined : v))

  function applyState(msg) {
    const full = JSON.stringify([msg.teams, msg.team, msg.exportDir, msg.error])
    const sig = sigOf(msg)
    let reselected = false
    teams = Array.isArray(msg.teams) ? msg.teams : []
    exportDir = typeof msg.exportDir === 'string' ? msg.exportDir : ''
    stateError = typeof msg.error === 'string' ? msg.error : null
    const next = V.pickSelected(teams, selected)
    if (next !== selected) {
      selected = next
      team = null
      resetPerTeam()
      ccPanel.post({ type: 'select', roomId: selected })
      reselected = true
    } else {
      // A state answering an older selection is not this team's.
      team = msg.team && msg.team.roomId === selected ? msg.team : null
    }
    if (team && V.logMoved(lastLogSeq, team.logSeq)) {
      lastLogSeq = team.logSeq
      scheduleLogRefresh()
    }
    // A new mark is no log entry (it moves no logSeq) but is in the activity: the activity alone is asked again.
    const actKey = team ? V.activityKey(team) : lastActKey
    if (actKey !== lastActKey) {
      lastActKey = actKey
      scheduleLogRefresh()
    }
    // The host pushes a state every few seconds (the elapsed time moves), and a render rebuilds the page: a scroll
    // position, a text selection, an open select and a half-typed answer would be lost. So a state that changed
    // nothing renders nothing, and one that changed only the running numbers waits while the person is in the middle of
    // something (the next real change, or the end of that, renders it).
    if (!reselected) {
      if (full === lastFull && !deferred) return
      if (sig === lastSig && busy()) {
        lastFull = full
        deferred = true
        return
      }
    }
    lastFull = full
    lastSig = sig
    render()
  }

  /** The person is typing, choosing or selecting text: a render now would take it away. */
  function busy() {
    if (menuHost.firstChild) return true
    const ae = document.activeElement
    if (ae && root.contains(ae) && ['SELECT', 'TEXTAREA', 'INPUT'].includes(ae.tagName)) return true
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null
    return Boolean(sel && !sel.isCollapsed)
  }
  /** A render of what came in by itself (a push, a refresh), which waits while `busy`. */
  function softRender() {
    if (busy()) deferred = true
    else render()
  }
  function flushDeferred() {
    if (deferred && !busy()) render()
  }

  /**
   * The room log moved, or a mark was added: ask again what is open and not as of now (the activity by its key, the
   * docs list by the log position). Never a doc's text: a read is logged.
   */
  function scheduleLogRefresh() {
    if (logTimer !== null) return
    logTimer = setTimeout(() => {
      logTimer = null
      refreshLog()
    }, 300)
  }
  function refreshLog() {
    if (!selected) return
    if (tab === 'activity' && activity.seq !== lastActKey) loadActivity(false, true)
    if (tab === 'docs' && docs.seq !== lastLogSeq) loadDocs(true)
  }

  /** A held entry is newer than another: by seq when both have one (marks have none), else by time. */
  const isNewer = (e, than) => (Number.isSafeInteger(e.seq) && Number.isSafeInteger(than.seq) ? e.seq > than.seq : e.at > than.at)

  /**
   * Ask for the activity (the first page, or the next older one). A call made while one runs is not lost: it marks
   * `dirty` and the running one re-asks when it ends (a log refresh). A filter change does not wait: it starts a new
   * generation, so the running request's answer (the old filter's) is dropped.
   * The log position the list is "as of" is the one when it was ASKED (an entry logged during the request is newer).
   */
  async function loadActivity(older, quiet) {
    const roomId = selected
    if (!roomId) return
    if (activity.loading) {
      activity.dirty = true
      return
    }
    const gen = ++activity.gen
    const askedAt = team ? V.activityKey(team) : lastActKey
    activity.loading = true
    activity.dirty = false
    activity.roomId = roomId
    if (!quiet) render()
    const res = await request(V.activityRequest(roomId, { member: activity.member, kind: activity.kind, before: older ? activity.before : undefined }))
    if (gen !== activity.gen || roomId !== selected) return // superseded (a team switch): the new load owns `loading`
    activity.loading = false
    const rerun = activity.dirty
    activity.dirty = false
    if (rerun && !older) return loadActivity(false, quiet)
    if (!res.ok) activity.error = res.error
    else {
      activity.error = null
      const got = Array.isArray(res.entries) ? res.entries : []
      if (older) {
        activity.entries = activity.entries.concat(got)
        activity.paged = true
        activity.before = res.before || null
        activity.more = Boolean(res.before)
      } else {
        // A refresh keeps the older pages the person loaded and adds only what is newer than the first held entry
        // (all of the page newer: the entries in between are unknown, so start over).
        const first = activity.entries[0]
        const fresh = activity.paged && first ? got.filter((e) => isNewer(e, first)) : null
        if (fresh && fresh.length < got.length) activity.entries = fresh.concat(activity.entries)
        else {
          activity.entries = got
          activity.paged = false
          activity.before = res.before || null
          activity.more = Boolean(res.before)
        }
      }
      activity.seq = askedAt
    }
    quiet ? softRender() : render()
    if (rerun) loadActivity(false, quiet)
  }

  async function loadDocs(quiet) {
    const roomId = selected
    if (!roomId) return
    if (docs.loading) {
      docs.dirty = true
      return
    }
    const gen = ++docs.gen
    const askedAt = team ? team.logSeq : lastLogSeq
    docs.loading = true
    docs.dirty = false
    docs.roomId = roomId
    if (!quiet) render()
    const res = await request({ type: 'docs', roomId })
    if (gen !== docs.gen || roomId !== selected) return
    docs.loading = false
    const rerun = docs.dirty
    docs.dirty = false
    if (!res.ok) docs.error = res.error
    else {
      docs.error = null
      docs.list = res.docs || []
      docs.more = res.more === true
      docs.seq = askedAt
    }
    quiet ? softRender() : render()
    if (rerun) loadDocs(quiet)
  }

  async function readDoc(path) {
    const roomId = selected
    // Each read owns its own object: two reads of the same path (a double click, Refresh) can answer out of order,
    // and a path check alone let the older answer overwrite the newer text.
    const mine = { path, text: null, loading: true, error: null }
    openDoc = mine
    render()
    const res = await request({ type: 'doc', roomId, path })
    if (openDoc !== mine || roomId !== selected) return
    openDoc.loading = false
    if (res.ok) openDoc.text = typeof res.text === 'string' ? res.text : ''
    else openDoc.error = res.error
    render()
  }

  // ---- actions ----
  async function simple(message, done) {
    const res = await request(message)
    if (res.ok) say(done(res), false)
    else say(res.error, true)
    return res
  }

  /** Reply to question `q` of team `roomId` (the team it was drawn for, never the selection at the time of the click). */
  async function reply(roomId, q) {
    const key = `${roomId}:${q.id}`
    const built = V.replyRequest(roomId, q.id, drafts.get(key))
    if (built.error) return say(built.error, true)
    replying.add(key)
    render()
    const res = await request(built.message)
    replying.delete(key)
    if (res.ok) {
      drafts.delete(key)
      // A held answer is in the member's queue but nobody pointed it there (a paused room after a restart, a typed
      // tab): said as such, shown like a warning so it is not read as "sent".
      const out = V.replyOutcome(q.from, res.answers)
      say(out.text, out.held)
    } else say(res.error, true)
  }

  async function done(roomId, q) {
    const key = `${roomId}:${q.id}`
    replying.add(key)
    render()
    const res = await request({ type: 'done', roomId, id: q.id })
    replying.delete(key)
    if (res.ok) say(`Question from ${q.from} marked done.`, false)
    else say(res.error, true)
  }

  const focusMember = (roomId, m) => simple({ type: 'focus', roomId, name: m.name }, () => `Showing ${m.name}'s tab.`)

  /** Forms that cannot be undone: Enter in one of their fields must not submit it. */
  const CONFIRMS = new Set(['end', 'delete', 'fire'])

  /** Open a form; every one but New team is bound to the team selected now (`roomId`, what its request names). */
  function openForm(kind, values) {
    notice = null
    form = { kind, roomId: kind === 'new-team' ? null : selected, values: values || {}, error: null, busy: false, result: null }
    render()
    // A confirm has no field worth typing in: focus goes to Cancel, the safe choice (a button the click replaced took
    // the focus with it). A form with fields focuses the first one.
    const target = CONFIRMS.has(kind) ? root.querySelector('[data-key="form-cancel"]') : root.querySelector('.form input, .form textarea')
    if (target) target.focus()
  }
  const closeForm = () => {
    form = null
    render()
  }

  /** The form's request, for the team it was opened for (`f.roomId`), never the selection now. */
  function buildRequest(f) {
    const v = f.values
    const roomId = f.roomId
    if (f.kind !== 'new-team' && (!roomId || roomId !== selected)) return { error: 'This form was for another team: open it again.' }
    switch (f.kind) {
      case 'new-team':
        return V.newTeamRequest(v)
      case 'hire':
        return V.hireRequest(roomId, v)
      case 'invite':
        return V.inviteRequest(roomId, v)
      case 'mark':
        return V.markRequest(roomId, v.label)
      case 'end':
        return V.endRequest(roomId, v.dir)
      case 'delete':
        return { message: { type: 'delete', roomId } }
      case 'fire':
        return { message: { type: 'fire', roomId, name: f.values.name } }
      default:
        return { error: 'unknown form' }
    }
  }

  async function submit() {
    const f = form
    if (!f || f.busy) return
    const built = buildRequest(f)
    if (built.error) {
      f.error = built.error
      render()
      return
    }
    f.busy = true
    f.error = null
    render()
    const res = await request(built.message)
    f.busy = false
    if (!res.ok) {
      f.error = res.error
      render()
      return
    }
    if (f.kind === 'invite') {
      // Stays open: the code is shown to copy.
      f.result = res
      render()
      return
    }
    if (form === f) form = null
    if (f.kind === 'new-team') {
      selected = null
      select(res.roomId)
      say(`Team started; ${res.name} is open in its own tab.`, false)
    } else if (f.kind === 'hire') say(`${res.name} hired.`, false)
    else if (f.kind === 'mark') say(`Mark "${res.label}" added.`, false)
    else if (f.kind === 'end') {
      // `closed`: the member tabs the app closed with the team (an app before 0.22.0 closes none and says nothing).
      const tabs = Number.isInteger(res.closed) && res.closed > 0 ? ` ${res.closed} member tab${res.closed === 1 ? '' : 's'} closed.` : ''
      say((res.folder ? `Team ended. Exported to ${res.folder}.` : 'Team ended.') + tabs, false)
    }
    else if (f.kind === 'delete') say(`Team "${res.title}" deleted.`, false)
    else if (f.kind === 'fire') say(`${res.name} removed from the team.`, false)
    else render()
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text)
      say('Copied.', false)
    } catch {
      say('Copy was blocked here: select the text and copy it.', true)
    }
  }

  const FOCUSABLE = 'button, input, textarea, select, summary, [tabindex]'
  const focusables = () => Array.from(root.querySelectorAll(FOCUSABLE))
  const findByKey = (key) => (key ? focusables().find((el) => el.dataset && el.dataset.key === key) || null : null)

  // ---- menu (a member row's actions) ----
  function closeMenu() {
    const had = menuHost.firstChild
    menuHost.replaceChildren()
    return had
  }
  /**
   * A member row's menu, bound to the team selected now: a team change closes it (resetPerTeam), and an item of a
   * menu that is no longer the open one, or of a team no longer selected, does nothing.
   */
  function openMenu(anchor, label, items) {
    closeMenu()
    const roomId = selected
    const rect = anchor.getBoundingClientRect()
    // A render may have replaced the anchor while the menu was open: focus goes back to its successor.
    const refocus = () => {
      const el = anchor.isConnected ? anchor : findByKey(anchor.dataset.key)
      if (el) el.focus()
    }
    const menu = h('div', { class: 'cc-menu', role: 'menu', 'aria-label': label })
    const buttons = items.map((it) =>
      h('button', { role: 'menuitem', class: it.danger ? 'cc-danger' : '', onclick: () => {
        const current = menuHost.firstChild === menu && roomId === selected
        closeMenu()
        if (!current) return
        refocus()
        it.run(roomId)
      } }, it.label),
    )
    menu.append(...buttons)
    menu.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(document.activeElement)
      if (e.key === 'ArrowDown') buttons[(i + 1) % buttons.length].focus()
      else if (e.key === 'ArrowUp') buttons[(i - 1 + buttons.length) % buttons.length].focus()
      else if (e.key === 'Home') buttons[0].focus()
      else if (e.key === 'End') buttons[buttons.length - 1].focus()
      else if (e.key === 'Escape') {
        closeMenu()
        refocus()
      } else return
      e.preventDefault()
    })
    menu.addEventListener('focusout', (e) => {
      if (!menu.contains(e.relatedTarget)) closeMenu()
    })
    menuHost.append(menu)
    const width = menu.offsetWidth || 160
    menu.style.left = `${Math.max(4, Math.min(rect.right - width, window.innerWidth - width - 4))}px`
    menu.style.top = `${Math.min(rect.bottom + 2, Math.max(4, window.innerHeight - menu.offsetHeight - 4))}px`
    buttons[0].focus()
  }
  document.addEventListener('pointerdown', (e) => {
    if (menuHost.firstChild && !menuHost.contains(e.target)) closeMenu()
  })

  // ---- rendering ----
  function field(key, label, name, opts = {}) {
    const f = form
    const id = `f-${key}`
    const input = h('input', {
      id,
      type: 'text',
      'data-key': id,
      value: f.values[name] || '',
      placeholder: opts.placeholder,
      disabled: f.busy,
      oninput: (e) => {
        f.values[name] = e.target.value
      },
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          if (!CONFIRMS.has(f.kind)) submit()
        } else if (e.key === 'Escape') closeForm()
      },
    })
    return h('div', { class: 'cc-field' }, h('label', { for: id }, label), input, opts.help ? h('span', { class: 'cc-help' }, opts.help) : null)
  }
  function check(key, label, name) {
    const f = form
    const id = `f-${key}`
    return h(
      'label',
      { class: 'row-line' },
      h('input', { id, type: 'checkbox', 'data-key': id, checked: f.values[name] === true, disabled: f.busy, onchange: (e) => { f.values[name] = e.target.checked } }),
      label,
    )
  }

  function formButtons(primaryLabel, danger) {
    return h(
      'div',
      { class: 'buttons' },
      btn(form.busy ? 'Working…' : primaryLabel, submit, { class: danger ? 'cc-danger' : 'cc-primary', disabled: form.busy, 'data-key': 'form-submit' }),
      btn('Cancel', closeForm, { class: 'cc-ghost', disabled: form.busy, 'data-key': 'form-cancel' }),
    )
  }

  function renderForm() {
    if (!form) return null
    const f = form
    const err = f.error ? h('div', { class: 'cc-error-line', role: 'alert' }, f.error) : null
    const extras = () => [
      field(`${f.kind}-model`, 'Model (optional)', 'model', { placeholder: 'default' }),
      field(`${f.kind}-effort`, 'Effort (optional)', 'effort', { placeholder: 'default' }),
      field(`${f.kind}-cwd`, 'Folder (optional)', 'cwd', { placeholder: 'the project folder' }),
    ]
    switch (f.kind) {
      case 'new-team':
        return h('div', { class: 'cc-card form' }, h('h3', { class: 'cc-card-title' }, 'New team'),
          field('title', 'Title', 'title'),
          field('lead', 'Lead name', 'name', { placeholder: 'lead' }),
          field('kickoff', 'Kickoff file (optional)', 'kickoff', { help: 'A path to the lead\'s first instructions. Without one the lead starts with no prompt.' }),
          ...extras(), err, formButtons('Start team'))
      case 'hire':
        return h('div', { class: 'cc-card form' }, h('h3', { class: 'cc-card-title' }, 'Hire a member'),
          field('name', 'Name', 'name'),
          field('kickoff', 'Kickoff file', 'kickoff', { help: 'A path to the member\'s instructions; it is read once and stored in the team\'s docs.' }),
          check('coord', 'Coordinator', 'coordinator'), ...extras(), err, formButtons('Hire'))
      case 'invite':
        if (f.result) {
          return h('div', { class: 'cc-card form' }, h('h3', { class: 'cc-card-title' }, `Invite for ${f.result.name}`),
            h('p', { class: 'cc-muted' }, 'Run this line in a Claude tab to join the team (valid for a short time, for this name only):'),
            h('code', { class: 'mono text' }, f.result.line),
            h('div', { class: 'buttons' }, btn('Copy line', () => copy(f.result.line), { class: 'cc-primary' }), btn('Close', closeForm, { class: 'cc-ghost' })))
        }
        return h('div', { class: 'cc-card form' }, h('h3', { class: 'cc-card-title' }, 'Invite'),
          h('p', { class: 'cc-muted' }, 'An invite is for a new name: a name already in the team is refused.'),
          field('invite-name', 'New member name', 'name'), check('invite-coord', 'Coordinator', 'coordinator'), err, formButtons('Create invite'))
      case 'mark':
        return h('div', { class: 'cc-card form' }, h('h3', { class: 'cc-card-title' }, 'Mark'),
          field('mark', 'Label', 'label', { help: 'One line. Marks split the team\'s time and cost into spans.' }), err, formButtons('Add mark'))
      case 'end':
        return h('div', { class: 'cc-card form confirm', role: 'alertdialog', 'aria-label': 'End the team' },
          h('h3', { class: 'cc-card-title' }, `End "${team ? team.title : 'the team'}"?`),
          h('p', {}, 'Every member is removed and their tabs stop being part of the team. This cannot be undone.'),
          field('end-dir', 'Export folder (optional)', 'dir', { placeholder: exportDir || 'no export', help: exportDir ? `Empty: a new folder in ${exportDir}.` : 'Empty: no export (set one in the plugin settings).' }),
          err, formButtons('End team', true))
      case 'delete':
        return h('div', { class: 'cc-card form confirm', role: 'alertdialog', 'aria-label': 'Delete the team' },
          h('h3', { class: 'cc-card-title' }, `Delete "${team ? team.title : 'the team'}"?`),
          h('p', {}, 'The team\'s record and its room are removed. An export folder stays.'), err, formButtons('Delete team', true))
      case 'fire':
        return h('div', { class: 'cc-card form confirm', role: 'alertdialog', 'aria-label': 'Fire a member' },
          h('h3', { class: 'cc-card-title' }, `Remove ${f.values.name} from the team?`),
          h('p', {}, 'Their tab stays open but is no longer in the team.'), err, formButtons('Remove', true))
      default:
        return null
    }
  }

  function renderTeams() {
    const sorted = V.sortTeams(teams)
    const chipFocus = (from, by) => {
      const chips = root.querySelectorAll('.chip')
      const next = chips[from + by]
      if (next) next.focus()
    }
    const chips = sorted.map((t, i) => {
      const st = V.teamState(t)
      const on = t.roomId === selected
      return h('div', {
        class: `chip chip-${st.key}` + (on ? ' on' : ''),
        role: 'option',
        tabindex: 0,
        title: V.teamMeta(t),
        'data-key': `team-${t.roomId}`,
        'aria-selected': on ? 'true' : 'false',
        onclick: () => select(t.roomId),
        onkeydown: (e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            select(t.roomId)
          } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault()
            chipFocus(i, e.key === 'ArrowRight' ? 1 : -1)
          }
        },
      },
      // The symbol is the state's shape (live dot, ended square, paused bars); the word is in the tooltip and the label.
      h('span', { class: 'sym', 'aria-hidden': 'true' }, st.symbol),
      h('span', { class: 'chip-title' }, t.title),
      h('span', { class: 'sr' }, ` ${st.label.toLowerCase()}`),
      t.waiting > 0 ? h('span', { class: 'ask', title: `${t.waiting} waiting on you` }, `? ${t.waiting}`) : null)
    })
    return h('section', {},
      // Whatever the selection: an old app's answer ("update the app") must not wait for a failed submit.
      stateError ? h('div', { class: 'cc-error-line', role: 'alert' }, stateError) : null,
      // No heading row of its own: the panel's title bar says "Team" and carries New team as its + action (lib/panel.js).
      chips.length
        ? h('div', { class: 'teams', role: 'listbox', 'aria-label': 'Teams' }, chips)
        : h('div', { class: 'cc-empty' }, h('p', {}, 'No teams yet. Start one with + in the panel\'s title bar, or run `ccc team start "<title>"` from a Claude tab.')))
  }

  /** Switch tab; Activity and Docs ask for their list when it is not as of now (what opening their group did). */
  function setTab(name) {
    if (!TABS.includes(name)) return
    tab = name
    if (name === 'activity' && activity.seq !== lastActKey) return loadActivity(false)
    if (name === 'docs' && docs.seq !== lastLogSeq) return loadDocs()
    render()
  }

  function renderTabs() {
    const counts = { members: team.members.length, docs: docs.roomId === selected && docs.seq !== undefined ? docs.list.length : null }
    const labels = { members: 'Members', activity: 'Activity', docs: 'Docs', stats: 'Numbers' }
    const buttons = TABS.map((name) =>
      h('button', {
        type: 'button', role: 'tab', class: 'tab' + (tab === name ? ' on' : ''), id: `tab-${name}`, 'data-key': `tab-${name}`,
        'aria-selected': tab === name ? 'true' : 'false', 'aria-controls': 'tabpanel', tabindex: tab === name ? 0 : -1,
        onclick: () => setTab(name),
        onkeydown: (e) => {
          const move = { ArrowRight: 1, ArrowLeft: -1 }[e.key]
          const edge = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null
          if (move === undefined && edge === null) return
          e.preventDefault()
          const to = TABS[edge !== null ? edge : (TABS.indexOf(name) + move + TABS.length) % TABS.length]
          setTab(to)
          const el = findByKey(`tab-${to}`)
          if (el) el.focus()
        },
      }, labels[name], counts[name] !== undefined && counts[name] !== null ? h('span', { class: 'n' }, ` ${counts[name]}`) : null))
    return h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Team sections' }, buttons)
  }

  /** Enter sends the answer, Shift+Enter is a new line (and an IME's Enter, which picks a candidate, is left alone). */
  function questionsBlock() {
    const qs = team.questions
    if (qs.length === 0) return null
    // An ended team is read-only: its open questions are shown, with nothing to answer or close them with, and the
    // block loses its amber edge (nothing waits on the person any more).
    const ended = team.endedAt !== undefined
    const now = Date.now()
    const cards = qs.map((q) => {
      const roomId = team.roomId
      const key = `${roomId}:${q.id}`
      const busy = replying.has(key)
      const who = h('div', { class: 'who' }, h('b', {}, q.from), h('span', { class: 'cc-muted small' }, [V.fmtTime(q.askedAt), V.fmtAge(q.askedAt, now)].filter(Boolean).join(' · ')))
      const text = h('div', { class: 'text' }, q.text)
      if (ended) return h('div', { class: 'q' }, who, text, h('p', { class: 'cc-muted' }, 'Not answered before the team ended.'))
      // A guest sees what waits on the owner, with nothing to answer it with.
      if (guest()) return h('div', { class: 'q' }, who, text)
      return h('div', { class: 'q' }, who, text,
        h('div', { class: 'reply' },
          h('textarea', {
            rows: 1, 'data-key': `reply-${q.id}`, 'aria-label': `Answer to ${q.from}`, placeholder: `Answer ${q.from}… (Enter sends)`, value: drafts.get(key) || '', disabled: busy,
            oninput: (e) => drafts.set(key, e.target.value),
            onkeydown: (e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
              e.preventDefault()
              if (typeof e.target.value === 'string') drafts.set(key, e.target.value)
              if (!replying.has(key)) reply(roomId, q)
            },
          }),
          // Send as well as Enter: a phone's keyboard in a browser view has no Enter that reaches keydown reliably.
          btn(busy ? 'Working…' : 'Send', () => reply(roomId, q), { disabled: busy, title: 'Send the answer (Enter)' }),
          btn('Done', () => done(roomId, q), { class: 'cc-ghost', disabled: busy, title: 'Close it without an answer' })))
    })
    return h('section', { class: 'attn' + (ended ? ' muted' : ''), 'aria-label': 'Waiting on you' },
      h('div', { class: 'attn-h' }, h('span', { 'aria-hidden': 'true' }, '? '), `Waiting on you · ${qs.length}`), cards)
  }

  function memberRow(m) {
    const roomId = team.roomId
    const s = V.statusInfo(m.status)
    const shape = V.stateShape(m.status)
    // A guest neither acts on a member nor shows its tab (the host refuses both).
    const live = team.endedAt === undefined && m.in === true && !guest()
    const ctx = V.contextLevel(m.contextPercent)
    const actionsBtn = live
      ? h('button', { type: 'button', class: 'cc-icon more', 'data-key': `act-${m.name}`, title: `Actions for ${m.name}`, 'aria-haspopup': 'menu', onclick: (e) => {
          e.stopPropagation()
          openMenu(e.currentTarget, `${m.name} actions`, [
            { label: 'Show tab', run: (rid) => focusMember(rid, m) },
            { label: 'Copy invite…', run: () => openForm('invite', {}) },
            { label: 'Fire…', danger: true, run: () => openForm('fire', { name: m.name }) },
          ])
        } }, '⋯')
      : null
    const modelEffort = [m.model, m.effort].filter(Boolean).join(' / ')
    const attention = m.status === 'needs-permission'
    return h('li', {
      class: 'm' + (live ? ' live' : ''), tabindex: live ? 0 : null, 'data-key': live ? `member-${m.name}` : null, title: live ? 'Show this member\'s tab' : null,
      onclick: live ? () => focusMember(roomId, m) : null,
      // Only the row's own Enter: the actions button's Enter bubbles up here and would also show the tab.
      onkeydown: live ? (e) => { if (e.target === e.currentTarget && e.key === 'Enter') focusMember(roomId, m) } : null,
    },
    h('span', { class: `ic ic-${shape.shape}`, 'aria-hidden': 'true' }, shape.glyph),
    h('span', { class: 'name' },
      h('span', { class: 'nm' }, m.name),
      m.coordinator ? h('span', { class: 'star', title: COORDINATOR_TITLE }, '★', h('span', { class: 'sr' }, ' coordinator')) : null,
      h('span', { class: 'word' + (attention ? ' attn-word' : '') }, s.word + (m.tool ? ` · ${m.tool}` : ''))),
    h('span', { class: 'right' }, h('b', {}, V.fmtCost(m.costUsd)), h('span', { class: 'cc-muted small' }, V.fmtDuration(m.workingMs))),
    h('span', { class: 'more-slot' }, actionsBtn),
    h('span', { class: 'line2' },
      m.status === 'left' ? h('span', {}, V.leftText(m)) : null,
      modelEffort ? h('span', {}, modelEffort) : null,
      ctx
        ? h('span', { class: 'ctx' + (ctx.high ? ' hi' : ''), title: `context ${ctx.pct}%` }, h('i', { style: `--p:${ctx.pct}%` }), h('span', { class: ctx.high ? 'hi-text' : '' }, `${ctx.pct}%`))
        : h('span', {}, 'context unknown'),
      m.held > 0 ? h('span', { class: 'held' }, `✉ ${m.held} held`) : null))
  }

  function membersBody() {
    return h('div', {},
      team.membersUnknown ? h('div', { class: 'notice' }, '? The member list could not be read just now; this is the last list read.') : null,
      team.members.length
        ? h('ul', { class: 'members' }, team.members.map(memberRow))
        : h('div', { class: 'cc-empty' }, h('p', {}, 'No members yet. Hire one with the button above.')),
      team.members.length
        ? h('div', { class: 'legend' }, [['filled', '▶', 'working'], ['ring', '✓', 'waiting for input'], ['square', '!', 'needs permission'], ['dashed', '', 'idle'], ['gone', '✕', 'left']].map(([sh, g, w]) =>
            h('span', {}, h('span', { class: `ic ic-${sh} tiny`, 'aria-hidden': 'true' }, g), w)))
        : null)
  }

  function statsBody() {
    const st = team.stats
    if (!st) return h('div', { class: 'cc-empty' }, h('p', {}, 'No numbers yet.'))
    const t = st.totals
    const tile = (k, v) => h('div', { class: 'tile' }, h('dt', {}, k), h('dd', {}, v))
    return h('div', {},
      h('dl', { class: 'tiles' },
        tile('Elapsed', V.fmtDuration(st.elapsedMs)), tile('Cost', V.fmtCost(t.costUsd)),
        tile('Working', V.fmtDuration(t.workingMs)), tile('Waiting', V.fmtDuration(t.waitingMs)), tile('Idle', V.fmtDuration(t.idleMs)),
        tile('Messages', `${t.sent} sent, ${t.received} received, ${t.held ?? 0} held`), tile('Docs', `${t.docReads} read, ${t.docWrites} written`),
        tile('You', `about ${V.fmtDuration(st.personActiveMs)} (a proxy)`),
        tile('Questions', `${st.questions.asked} asked, ${st.questions.answered} answered, ${st.questions.open} open`)),
      h('div', { class: 'scroll-x' }, h('table', { class: 'spans' },
        h('thead', {}, h('tr', {}, ['Span', 'Time', 'Cost', 'Working'].map((c) => h('th', {}, c)))),
        h('tbody', {}, st.spans.map((sp) => h('tr', {}, h('td', {}, `${sp.from} → ${sp.to}`), h('td', {}, V.fmtDuration(sp.ms)), h('td', {}, V.fmtCost(sp.costUsd)), h('td', {}, V.fmtDuration(sp.workingMs))))))))
  }

  function activityBody() {
    const names = team.members.map((m) => m.name)
    // A filter change makes every running activity request stale, a "Load older" above all: its page is the old
    // filter's, and appended (then kept by the refresh's merge) it showed wrong-kind entries and hid matching ones. A
    // new generation drops its answer, as a team switch does, and the new filter's first page is asked at once.
    const change = () => {
      activity.gen++
      activity.loading = false
      activity.dirty = false
      activity.paged = false
      activity.entries = []
      activity.before = null
      activity.more = false
      activity.error = null
      loadActivity(false)
    }
    const filters = h('div', { class: 'cc-toolbar' },
      h('select', { 'aria-label': 'Filter by member', 'data-key': 'act-member', onchange: (e) => { activity.member = e.target.value; change() } },
        h('option', { value: '', selected: activity.member === '' }, 'All members'),
        names.map((n) => h('option', { value: n, selected: activity.member === n }, n))),
      h('select', { 'aria-label': 'Filter by kind', 'data-key': 'act-kind', onchange: (e) => { activity.kind = e.target.value; change() } },
        h('option', { value: '', selected: activity.kind === '' }, 'All kinds'),
        V.KINDS.map((k) => h('option', { value: k, selected: activity.kind === k }, k))))
    const entries = activity.entries.map((e) =>
      h('div', { class: 'entry' }, h('time', {}, V.fmtTime(e.at)), h('span', { class: 'kind' }, e.type), h('span', { class: 'grow text' }, V.describeEntry(e) + (e.cut ? ' … (cut)' : ''))))
    return h('div', {}, filters,
      activity.error ? h('div', { class: 'cc-error-line', role: 'alert' }, `Could not load the activity: ${activity.error}`) : null,
      entries.length ? entries : activity.loading || activity.error ? null : h('div', { class: 'cc-empty' }, h('p', {}, 'No activity matches.')),
      activity.loading ? h('span', { class: 'cc-spinner', role: 'status', 'aria-label': 'Loading' }) : null,
      activity.more && !activity.loading ? btn('Load older', () => loadActivity(true)) : null)
  }

  function docsBody() {
    const list = docs.list.map((d) =>
      h('li', { class: 'cc-row', tabindex: 0, 'data-key': `doc-${d.path}`, 'aria-selected': openDoc && openDoc.path === d.path ? 'true' : 'false', onclick: () => readDoc(d.path),
        onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); readDoc(d.path) } } },
      h('div', { class: 'cc-row-main' }, h('span', { class: 'cc-row-title mono' }, d.path), h('span', { class: 'cc-row-meta' }, `${d.size} bytes`))))
    return h('div', {},
      docs.error ? h('div', { class: 'cc-error-line', role: 'alert' }, `Could not load the docs: ${docs.error}`) : null,
      list.length ? h('ul', { class: 'cc-list' }, list) : docs.loading || docs.error ? null : h('div', { class: 'cc-empty' }, h('p', {}, 'No docs in this team yet.')),
      docs.more ? h('p', { class: 'cc-muted' }, 'More docs exist than are listed here; core\'s room view lists them all.') : null,
      docs.loading ? h('span', { class: 'cc-spinner', role: 'status', 'aria-label': 'Loading' }) : null,
      openDoc ? h('div', {},
        h('div', { class: 'head' }, h('strong', { class: 'mono text' }, openDoc.path),
          h('span', { class: 'actions' }, btn('Refresh', () => readDoc(openDoc.path), { class: 'cc-ghost' }), btn('Close', () => { openDoc = null; render() }, { class: 'cc-ghost' }))),
        openDoc.loading ? h('span', { class: 'cc-spinner', role: 'status', 'aria-label': 'Loading' })
          : openDoc.error ? h('div', { class: 'cc-error-line', role: 'alert' }, openDoc.error) : h('pre', { class: 'doc-text', tabindex: 0, 'data-key': `doc-text-${openDoc.path}` }, openDoc.text)) : null)
  }

  function summaryCard() {
    const ended = team.endedAt !== undefined
    const st = V.teamState(team)
    return h('section', { class: 'hero' },
      h('div', { class: 'head' },
        h('h2', { title: team.title }, team.title),
        // The state is a symbol and a word with its own border, never only a colour.
        h('span', { class: `state state-${st.key}` }, h('span', { 'aria-hidden': 'true' }, `${st.symbol} `), st.label)),
      h('dl', { class: 'kpis' }, V.kpis(team).map((k) => h('div', { class: 'kpi' }, h('dt', {}, k.label), h('dd', {}, k.value)))),
      guest() ? null : h('div', { class: 'bar' },
        ended
          ? btn('Delete…', () => openForm('delete'), { class: 'cc-danger' })
          : [btn('+ Hire', () => openForm('hire', {}), { class: 'cc-primary' }), btn('Mark', () => openForm('mark', {})), btn('Invite', () => openForm('invite', {})),
              h('span', { class: 'grow' }), btn('End…', () => openForm('end', {}), { class: 'cc-danger' })]))
  }

  function renderDetail() {
    if (!selected) return null
    if (!team) {
      return stateError
        ? null // shown with the teams list
        : h('div', { class: 'cc-empty' }, h('span', { class: 'cc-spinner', role: 'status', 'aria-label': 'Loading' }), h('p', {}, 'Loading the team…'))
    }
    const body = { members: membersBody, activity: activityBody, docs: docsBody, stats: statsBody }[tab]
    return h('div', { class: 'detail' },
      summaryCard(),
      form && form.kind !== 'new-team' ? renderForm() : null,
      questionsBlock(),
      renderTabs(),
      h('div', { id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${tab}` }, body()))
  }

  function render() {
    deferred = false
    const ae = document.activeElement
    const inRoot = ae && root.contains(ae)
    const before = focusables()
    // The focused element is found again by its key, else by its place among the focusable ones.
    const focus = inRoot ? (ae.dataset && ae.dataset.key ? { key: ae.dataset.key } : before.indexOf(ae) >= 0 ? { index: before.indexOf(ae), tag: ae.tagName } : null) : null
    const sel = inRoot && typeof ae.selectionStart === 'number' ? [ae.selectionStart, ae.selectionEnd] : null
    // The scroll of the open doc and of the answer boxes (a render rebuilds them at 0).
    const scrolls = new Map()
    for (const el of root.querySelectorAll('.doc-text, textarea')) if (el.dataset && el.dataset.key && el.scrollTop) scrolls.set(el.dataset.key, el.scrollTop)
    const noticeEl = notice
      ? h('div', { class: notice.error ? 'cc-error-line' : 'notice', role: notice.error ? 'alert' : 'status' },
          notice.error ? '! ' : '✓ ', notice.text, ' ', btn('Dismiss', () => { notice = null; render() }, { class: 'cc-ghost' }))
      : null
    root.replaceChildren(
      ...[noticeEl, renderTeams(), form && form.kind === 'new-team' ? renderForm() : null, renderDetail()].filter(Boolean),
    )
    if (focus) {
      const now = focusables()
      const el = focus.key ? findByKey(focus.key) : now[focus.index] && now[focus.index].tagName === focus.tag ? now[focus.index] : null
      if (el) {
        el.focus()
        if (sel) {
          try {
            el.setSelectionRange(sel[0], sel[1])
          } catch {}
        }
      }
    }
    if (scrolls.size) for (const el of root.querySelectorAll('.doc-text, textarea')) if (el.dataset && scrolls.has(el.dataset.key)) el.scrollTop = scrolls.get(el.dataset.key)
  }

  // ---- wiring ----
  ccPanel.onMessage((msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'state') applyState(msg)
    // The title bar's + (ctx.panels.onAction, lib/panel.js), as the old in-page button: it replaces another form, but a
    // New team form already open keeps what was typed in it.
    else if (msg.type === 'new-team' && !guest()) {
      if (!form || form.kind !== 'new-team') openForm('new-team')
    } else if (msg.type === 'result') {
      const cb = pending.get(msg.req)
      if (cb) {
        pending.delete(msg.req)
        cb(msg)
      }
    }
  })
  ccPanel.onConnect(() => {
    hello()
    startPing()
  })
  // A render that waited for a selection or a focus goes ahead when that ends.
  document.addEventListener('selectionchange', flushDeferred)
  document.addEventListener('focusout', () => setTimeout(flushDeferred, 0))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopPing()
    else {
      hello()
      startPing()
    }
  })
  render()
})()
