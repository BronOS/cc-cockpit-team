'use strict'
// The `ccc team` command table (docs/design.md §2).
//
// Who the caller is comes only from `CliCall.tabId` (set by main) and `ctx.rooms.members` (main's membership and
// coordinator flag), through lib/teams.js; no argument names a team or says "I am the coordinator". Every team
// command but `start` and `help` checks membership before it parses anything, so a tab in none of this plugin's
// rooms gets the one not-in-a-team answer whatever it typed.
//
// Rooms enforces its own rules (names, caps, rates, cwd, model, effort) and its refusal is printed as it is, in its
// own words: it names the limit, and once the app has the configurable caps (design §6) also where to change it.

const path = require('node:path')

const { TeamError, abandonStart, checkName, createNameLocks, createTeamGuard, isNoRoom } = require('./teams.js')
const { readKickoff, kickoffPrompt } = require('./kickoff.js')
const { formatStats, iso } = require('./stats.js')
const { createEnding } = require('./export.js')

/** The `end` export's time budget: a `ccc` call is cut at 30 s (types.ts cli.register); the rest is for the end. */
const END_EXPORT_BUDGET_MS = 20_000
/**
 * Told to the coordinator at `start`: its tab is the one the person types in, and Rooms never auto-delivers to a typed
 * tab (design-rooms.md §2), so the members' reports wait, held, until it reads them (a live run: a coordinator waiting
 * for reports that sat held behind its badge).
 */
const HELD_NOTE =
  'The person types in this tab, so Rooms holds room messages to it instead of pasting them in: run `ccc room read` ' +
  'when you expect answers (after members report).\n'

const USAGE = `ccc team: run a team of Claude tabs (one room)

  start "<title>" [--as <name>]      create the team; prints the coordinator's join line
  hire <name> --kickoff <file> [--model m] [--effort e] [--cwd dir] [--coordinator]
  invite <name> [--coordinator]      a one-time code for an existing tab
  fire <name>                        remove a member (its tab stays)
  ask "<question>" | ask -           a question to the person; prints its id
  mark "<label>"                     a timestamp on the team's timeline
  list [--json]                      the team and its members
  stats [--json]                     the metrics
  end [--export <dir>]               export, then end the team
  help                               this text
`

/** The one usage line of each command, printed with a usage error. */
const LINES = {
  start: 'start "<title>" [--as <name>]',
  hire: 'hire <name> --kickoff <file> [--model m] [--effort e] [--cwd dir] [--coordinator]',
  invite: 'invite <name> [--coordinator]',
  fire: 'fire <name>',
  ask: 'ask "<question>" | ask -',
  mark: 'mark "<label>"',
  stats: 'stats [--json]',
  list: 'list [--json]',
  end: 'end [--export <dir>]',
}

// Rooms' member-name rule (teams.js checkName) is checked here only where a bad name would otherwise be written
// somewhere first: `start` (before the room is created) and `hire` (before the kickoff doc is seeded, whose path is
// built from the name). Rooms checks it again on open and invite.

class UsageError extends Error {}

/**
 * Split `args` into options and positionals. `flags` maps a long option to `'value'` (takes the next argument, or
 * `--x=value`) or `'bool'`. `--` ends the options, so a title starting with a dash can be given. An unknown or
 * repeated option, a missing value and the wrong number of positionals are usage errors (exit 2).
 */
function parseArgs(args, flags, positionals) {
  const opts = {}
  const pos = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      pos.push(...args.slice(i + 1))
      break
    }
    if (!a.startsWith('--') || a === '-') {
      pos.push(a)
      continue
    }
    let name = a.slice(2)
    let value
    const eq = name.indexOf('=')
    if (eq >= 0) {
      value = name.slice(eq + 1)
      name = name.slice(0, eq)
    }
    const kind = Object.hasOwn(flags, name) ? flags[name] : undefined
    if (!kind) throw new UsageError(`unknown option --${name}`)
    if (Object.hasOwn(opts, name)) throw new UsageError(`--${name} given twice`)
    if (kind === 'bool') {
      if (value !== undefined) throw new UsageError(`--${name} takes no value`)
      opts[name] = true
      continue
    }
    if (value === undefined) {
      if (i + 1 >= args.length) throw new UsageError(`--${name} needs a value`)
      value = args[++i]
    }
    opts[name] = value
  }
  if (pos.length !== positionals) {
    throw new UsageError(pos.length > positionals ? `unexpected argument: ${pos[positionals]}` : 'missing argument')
  }
  return { opts, pos }
}

/**
 * `text` without its trailing line breaks. A loop, not a regex: stdin is a member's (up to 256 KiB), and
 * `/(\r?\n)+$/` backtracks quadratically on a run of newlines that does not end the text (256 KiB of them then one
 * character held the host's event loop for over a minute).
 */
function trimTrailingNewlines(text) {
  let end = text.length
  while (end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--
  return text.slice(0, end)
}

/**
 * The `layout` setting: "column" (default), "grid" or "tabs". A stored `splitPanes: false` of the older plugin still
 * means "tabs" when no `layout` is stored.
 */
function layoutOf(ctx) {
  const app = (ctx.settings && ctx.settings.app) || {}
  if (app.layout === 'column' || app.layout === 'grid' || app.layout === 'tabs') return app.layout
  return app.splitPanes === false ? 'tabs' : 'column'
}

/**
 * Where a new member's tab goes, as `rooms.open`'s `beside` / `side`, or null for a plain tab. The plugin cannot read
 * groups, so the spot is picked from the member list (read under the name's lock, in join order): the coordinator's tab
 * (`anchor`, the CLI caller's, else the first coordinator member with a tab). "column": the coordinator on the left,
 * the 1st other member right of it, each next one below the previous member (hire order top to bottom; every new pane
 * halves its anchor, so the heights are uneven: 1/2, 1/4, 1/4). "grid": the 1st right, the 2nd below the coordinator,
 * the 3rd below the 1st, then plain. Column has no limit of its own: the app's pane limit decides (`placed: false`). A wrong guess (a member fired, a pane closed
 * or moved) costs nothing: main answers `placed: false` and opens a plain tab. Returns `{ place }` or `{ why }`.
 */
function placementFor(members, anchor, layout = 'column') {
  if (layout === 'tabs') return { why: 'off' }
  const withTab = members.filter((m) => typeof m.tabId === 'string' && m.tabId !== '')
  let coord = typeof anchor === 'string' && anchor !== '' ? withTab.find((m) => m.tabId === anchor) : undefined
  if (!coord) coord = withTab.find((m) => m.coordinator)
  if (!coord) return { why: 'no-coordinator' }
  const others = withTab.filter((m) => m !== coord)
  const n = others.length
  const at = (m, side) => ({ place: { beside: m.tabId, side }, anchor: m.name, side, coord: coord.name })
  if (n === 0) return at(coord, 'right')
  if (layout === 'grid') {
    if (n > 2) return { why: 'full' }
    return n === 1 ? at(coord, 'down') : at(others[0], 'down')
  }
  // Column: keep asking below the previous member; the app answers `placed: false` when the group is full (its
  // pane limit is a setting the plugin cannot read) or a pane would be too small; it does not say which.
  return at(others[n - 1], 'down')
}

/** The tail of the hire line: where the tab opened and where the kickoff is. */
function describeHire(placement, docPath) {
  let where = 'its tab opened in the room'
  if (placement) {
    if (placement.placed) where = `its tab opened as a split pane ${placement.side === 'down' ? 'below' : 'right of'} ${placement.anchor}`
    else if (placement.why === 'off') where = 'its tab opened as a plain tab (split panes off)'
    else if (placement.why === 'no-coordinator') where = 'its tab opened as a plain tab (no coordinator tab in this window)'
    else if (placement.why === 'full') where = 'its tab opened as a plain tab (the group is full)'
    else where = 'its tab opened as a plain tab (the app did not place it: the group is full or a pane would be too small)'
  }
  return `${where} (kickoff in its first prompt; also in ${docPath})`
}

/**
 * Hiring, shared by `ccc team hire` and the panel's Hire and New team (the host builds one instance, so the per-name
 * lock covers both). `metrics` (optional) is told each hire's model and effort. `guard` is the teams' export guard
 * (`teams.guard`, teams.js createTeamGuard): a hire or a fire is refused while the team is being exported and ended.
 * The callers check it is the teams' own (a guard of its own would hold nothing).
 */
function createHiring(ctx, metrics, names = createNameLocks(), guard = createTeamGuard()) {

  /** The placement of a hire: `{ place, coord }` or `{ why }` (off, no-coordinator, full). */
  function placement(members, anchor) {
    if (!Array.isArray(members)) return { why: 'no-coordinator' }
    return placementFor(members, anchor, layoutOf(ctx))
  }

  /** The part of a hire that writes: kickoff checks, the doc, the open (the caller holds the name's lock). */
  async function seedAndOpen(roomId, name, opts, base, members) {
    // Every kickoff check runs before the doc is seeded and the tab opened. The panel's New team reads the file before
    // it creates the room and hands the text over (`kickoffText`), so it is not read twice.
    let text = opts.kickoffText
    if (text === undefined && opts.kickoff !== undefined) text = await readKickoff(opts.kickoff, base)
    const docPath = `members/${name}/kickoff.md`
    let previous = ''
    let team = ''
    if (text !== undefined) {
      // The team's title for the prompt's header, read before anything is written: a failed read refuses the hire.
      const room = (await ctx.rooms.list()).find((r) => r.id === roomId)
      if (room && typeof room.title === 'string') team = room.title
      // A doc of that path can be left from an earlier member of the same name (fired, or its tab closed): Rooms has
      // no doc delete, so a failed open puts that text back, or an empty doc where there was none (the tombstone).
      // `get` answers missing and refused alike (one error), so existence comes from `list`; a failure of either call
      // refuses the hire before anything is written, never a guess of "missing" that a restore would then overwrite.
      if ((await ctx.rooms.docs.list(roomId)).some((d) => d.path === docPath)) {
        previous = await ctx.rooms.docs.get(roomId, docPath)
      }
      await ctx.rooms.docs.put(roomId, docPath, text)
    }
    const open = {
      name,
      // No kickoff (the panel's New team without a file): no prompt, the person talks to the lead in its tab.
      // The kickoff text itself (lib/kickoff.js kickoffPrompt: auto mode treats a doc read by a tool as data, not the
      // user's instructions). One builder for `ccc team hire` and the panel's Hire and New team, which all come here.
      ...(text !== undefined ? { prompt: kickoffPrompt({ team, name, coordinator: opts.coordinator === true, docPath, text }) } : {}),
      ...(opts.coordinator ? { coordinator: true } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      // Resolved against the base like the kickoff path, so `--cwd ../wt` means what it says in the caller's shell
      // (the project folder for the panel); Rooms then checks it is inside the project folder.
      ...(opts.cwd !== undefined ? { cwd: path.resolve(base, opts.cwd) } : {}),
    }
    let tabId
    let placed
    let how = placement(members, opts.anchor)
    try {
      const place = how.place
      if (place === undefined) {
        ;({ tabId, placed } = await ctx.rooms.open(roomId, open))
      } else {
        try {
          ;({ tabId, placed } = await ctx.rooms.open(roomId, { ...open, ...place }))
        } catch (err) {
          // The anchor's tab closed (or left this window) between the member read and the open. Main refuses that
          // before the open counts against the opens a minute (host-api.ts `placement`), so one plain retry costs
          // the same single open. Any other refusal is the hire's.
          if (!/beside: no such tab/.test(String(err && err.message))) throw err
          ;({ tabId, placed } = await ctx.rooms.open(roomId, open))
          how = { why: 'no-coordinator' }
        }
      }
    } catch (err) {
      if (text === undefined) throw err
      try {
        await ctx.rooms.docs.put(roomId, docPath, previous)
      } catch (e) {
        throw new TeamError('open-failed', `${err.message}\n(and ${docPath} could not be restored: ${e && e.message})`)
      }
      throw err
    }
    if (metrics) {
      // The hire happened: a metrics failure is logged, never turned into a failed hire.
      try {
        await metrics.hired(roomId, name, { model: opts.model, effort: opts.effort })
      } catch (err) {
        ctx.log.warn(`team hire: metrics for ${name}: ${err && err.message}`)
      }
    }
    // `placed`: true (a split pane), false (a plain tab: why), undefined (an older app, or none asked).
    let placedInfo
    if (placed === true) placedInfo = { placed: true, anchor: how.anchor, side: how.side }
    else if (placed === false || how.place === undefined) {
      // A refusal by the app has no reason in its answer (a full group, a pane too small, a closed anchor): 'refused'.
      if (placed === false || how.why !== undefined) placedInfo = { placed: false, why: how.place === undefined ? how.why : 'refused' }
    }
    return { tabId, docPath: text !== undefined ? docPath : undefined, ...(placedInfo ? { placement: placedInfo } : {}) }
  }

  return {
    /**
     * Hire `name` into the room: `members` is main's member list of it as the caller read it, `base` the folder
     * `kickoff` and `cwd` resolve against (the caller's cwd, or the project folder for the panel). `opts`: kickoff (a
     * path) or kickoffText (already checked), model, effort, cwd, coordinator, setup (the New team's own token while it
     * sets the room up). Returns `{ tabId, docPath }`.
     */
    async hire(roomId, members, name, opts, base) {
      checkName(name)
      // A fast path only (THE RULE, teams.js createTeamGuard): `members` was read before any lock, so a hire of the
      // name that finished meanwhile is not in it. The decision is made again inside, on a list read there.
      if (members.some((m) => m.name === name)) throw new TeamError('name-taken', `${name} is already in the team`)
      // Two hires of one name would race on its kickoff doc (the member that opened could read the other's text), and
      // a hire while an answer to that name is on its way could take the answer (teams.js createNameLocks).
      // `opts.setup`: the token of the panel's New team that is setting this room up (teams.js guard.setup).
      return guard.change(
        roomId,
        () =>
          names.hold(roomId, name, 'hire', async () => {
            // Before anything is written, on a member list read under the lock: a hire of this name that finished
            // while this one waited (a stale list from the caller) would have its kickoff overwritten by this one's
            // seed until this open failed and put it back, and the member could read the wrong instructions.
            const now = await ctx.rooms.members(roomId)
            await guard.refresh()
            guard.live(roomId)
            if (now.some((m) => m.name === name)) throw new TeamError('name-taken', `${name} is already in the team`)
            return seedAndOpen(roomId, name, opts, base, now)
          }),
        opts.setup,
      )
    },

    /** Remove `name` from the room under its lock: never while it is being hired or an answer to it is being sent. */
    async fire(roomId, name) {
      return guard.change(roomId, () =>
        names.hold(roomId, name, 'fire', async () => {
          // The team is live as of now (THE RULE); that `name` is a member is Rooms' own check, in the remove itself.
          await guard.refresh()
          guard.live(roomId)
          return ctx.rooms.remove(roomId, name)
        }),
      )
    },

    /** A one-time invite for `name` (`ccc team invite`, the panel's Invite): a change too (its join lands in the log). */
    async invite(roomId, name, coordinator) {
      return guard.change(roomId, async () => {
        await guard.refresh()
        guard.live(roomId)
        return ctx.rooms.invite(roomId, { name, coordinator: coordinator === true })
      })
    },

    /** The name locks (shared with the questions instance, which must be the same one). */
    names,
    /** The export guard (the teams' own, `teams.guard`). */
    guard,
  }
}

/**
 * The `ccc team` handler. `questions` is required, never built here: the panel answers questions through the same
 * instance (its reply lock and the askers' tabs live in it), so the host builds one and hands it to both. `metrics`
 * (lib/metrics.js, the host's one instance) is told each hire's model and effort, which the room log does not carry;
 * without it nothing is recorded (tests of the commands alone). `ending` (lib/export.js createEnding) is the host's
 * one instance, shared with the panel so an End from both at once is refused by its per-team lock; tests of the
 * commands alone get their own. `hiring` (createHiring) likewise: the panel's Hire and New team take the same per-name
 * lock.
 */
function createCommands(ctx, teams, questions, metrics, ending, hiring) {
  if (!questions || typeof questions.ask !== 'function') throw new TypeError('createCommands: pass the questions instance (createQuestions) the panel shares')
  if (!ending) ending = createEnding(ctx, teams, metrics)
  if (!hiring) hiring = createHiring(ctx, metrics, questions.names, teams.guard)
  // A reply holds the asker's name against a fire and rehire: only if both take the same locks.
  if (hiring.names !== questions.names) throw new TypeError('createCommands: hiring and questions must share their name locks (createHiring(ctx, metrics, questions.names))')
  // A hire or fire during an export and end is refused: only if hiring holds the teams' own guard.
  if (hiring.guard !== teams.guard) throw new TypeError('createCommands: hiring must take the teams\' export guard (createHiring(ctx, metrics, questions.names, teams.guard))')
  /**
   * The caller's own session, or a refusal: `start` needs a Claude tab of this window (it is the tab that joins as
   * coordinator), and one in no room (a tab is in at most one room; `SessionInfo.room` is set by the app for every
   * room, other plugins' included).
   */
  async function callerSession(call) {
    const NEED_TAB = 'run `ccc team start` in the Claude tab that will lead the team (the Team panel\'s New team opens one)'
    if (typeof call.tabId !== 'string' || call.tabId === '') throw new TeamError('no-tab', NEED_TAB)
    const session = (await ctx.sessions.list()).find((s) => s.tabId === call.tabId)
    if (!session) throw new TeamError('no-tab', NEED_TAB)
    if (session.room) {
      throw new TeamError('in-room', 'this tab is already in a room: leave it first (`ccc room leave`) or start the team from another tab')
    }
    return session
  }

  /** The folder a caller's relative paths (kickoff, cwd, export) resolve against: its cwd, else the project's. */
  const baseOf = (call) => (typeof call.cwd === 'string' && call.cwd !== '' ? call.cwd : ctx.projectDir)

  // In-memory only, like the host's state: the room each tab started whose coordinator invite may still be unused
  // (tabId -> { roomId, name }), and the tabs whose `start` is running.
  const pendingStarts = new Map()
  const starting = new Set()

  /**
   * Whether anyone ever joined the room: its log has a `join` (a lead that joined and left leaves an empty room that
   * is still a team, not a start to re-issue). The log of a room nobody joined is a few entries (create, invites).
   */
  async function everJoined(roomId) {
    let since = 0
    for (let page = 0; page < 20; page++) {
      const { entries, more } = await ctx.rooms.log(roomId, { since })
      if (entries.some((e) => e && e.type === 'join')) return true
      const last = entries.length ? entries[entries.length - 1].seq : since
      if (!more || !Number.isInteger(last) || last <= since) return false
      since = last
    }
    // A log this long had something in it; never re-issue an invite for it.
    return true
  }

  /**
   * A fresh coordinator invite for the room a tab started and nobody joined yet: `{ code, expiresAt, title }`, or
   * undefined when the room no longer qualifies (someone is in it or ever joined it, the team ended or is gone), which
   * drops the tab's entry. A change like any invite (its join lands in the log), so it runs in the guard and decides
   * there, after its last await (THE RULE, teams.js createTeamGuard): run outside it, an End holding this never-joined
   * team got an invite minted during its export, and a join between the snapshot and `rooms.end` was in neither the
   * metrics nor log.jsonl (phase 4). An End holding the team refuses it (`exporting`, try again) and the entry is kept:
   * that End may still fail and leave the room live, and the retry then re-issues instead of stranding it.
   */
  async function reissue({ roomId, name }, title) {
    try {
      return await teams.guard.change(roomId, async () => {
        let joined
        try {
          joined = (await ctx.rooms.members(roomId)).length > 0 || (await everJoined(roomId))
        } catch (err) {
          if (isNoRoom(err)) return undefined
          throw err
        }
        await teams.guard.refresh()
        const rec = teams.guard.live(roomId)
        if (joined) return undefined
        const invite = await ctx.rooms.invite(roomId, { name, coordinator: true })
        return { code: invite.code, expiresAt: invite.expiresAt, title: (rec && rec.title) || title }
      })
    } catch (err) {
      if (err instanceof TeamError && (err.code === 'ended' || err.code === 'no-team')) return undefined
      throw err
    }
  }

  /** `start` under the tab's in-flight mark. */
  async function startFrom(call, title, name) {
    await callerSession(call)
    // A second start before the first invite was used would strand a room (live, no members, one of the plugin's
    // room slots, no `ccc team` command can reach it): hand out a fresh invite for the room already started. Only
    // while nobody ever joined it: once the tab joined, the entry is spent (dropped here) and a start is a new team.
    // The entry is dropped only once the room is known not to qualify: a lookup or an invite that fails (a host call
    // timing out) keeps it, so the retry re-issues instead of making a second room and stranding this one.
    const pending = pendingStarts.get(call.tabId)
    if (pending) {
      const info = (await ctx.rooms.list()).find((r) => r.id === pending.roomId)
      // A fast path only: the invite is a change (its join lands in the log), decided again inside the guard (reissue).
      const again = info && info.endedAt === undefined && info.members === 0 ? await reissue(pending, info.title) : undefined
      if (again) {
        return {
          stdout:
            `this tab already started team "${again.title}" and has not joined it yet (the title and --as stay as they were). ` +
            `Run this in this tab to join it as ${pending.name} (coordinator):\n` +
            `  ccc room join ${again.code}\n` +
            `(one use, expires ${iso(again.expiresAt)})\n` +
            HELD_NOTE,
        }
      }
      pendingStarts.delete(call.tabId)
    }
    const { id } = await ctx.rooms.create({ title })
    // Held from here (no await in between) to the invite, or to the cleanup of a start that failed: the record is in
    // the panel once `teams.add` wrote it, and a Hire of `name` landing before the invite made the invite fail and the
    // cleanup delete the room with the hired member in it (round 10). Every other change is refused meanwhile.
    return teams.guard.setup(id, async () => {
      try {
        const team = await teams.add({ id })
        const invite = await ctx.rooms.invite(id, { name, coordinator: true })
        pendingStarts.set(call.tabId, { roomId: id, name })
        return {
          stdout:
            `team "${team.title}" started. Run this in this tab to join it as ${name} (coordinator):\n` +
            `  ccc room join ${invite.code}\n` +
            `(one use, expires ${iso(invite.expiresAt)})\n` +
            HELD_NOTE,
        }
      } catch (err) {
        // No invite, no coordinator: a room nobody can join would only hold one of the plugin's room slots. Ended and
        // deleted while it is still as this start left it (teams.js abandonStart); the first refusal passes through.
        throw await abandonStart(ctx, teams, id, name, err)
      }
    })
  }

  /** Marks and stats are the metrics' (tests of the other commands build no metrics). */
  function requireMetrics() {
    if (!metrics) throw new TeamError('no-metrics', 'metrics are not running')
    return metrics
  }

  const commands = {
    async start(args, call) {
      const { opts, pos } = parseArgs(args, { as: 'value' }, 1)
      const name = opts.as === undefined ? 'lead' : opts.as
      checkName(name)
      // Two starts from one tab at once would both pass the pending check below (awaits in between) and make two
      // rooms, one of them stranded: the tab's in-flight mark is set before the first await, so the set is the lock.
      const tab = typeof call.tabId === 'string' ? call.tabId : ''
      if (tab !== '' && starting.has(tab)) throw new TeamError('start-pending', 'this tab is already starting a team: wait for it')
      if (tab !== '') starting.add(tab)
      try {
        return await startFrom(call, pos[0], name)
      } finally {
        starting.delete(tab)
      }
    },

    async hire(args, call) {
      const found = await teams.requireCoordinator(call)
      const flags = { kickoff: 'value', model: 'value', effort: 'value', cwd: 'value', coordinator: 'bool' }
      const { opts, pos } = parseArgs(args, flags, 1)
      const name = pos[0]
      if (opts.kickoff === undefined) throw new UsageError('hire needs --kickoff <file>')
      // The caller's tab anchors the split panes (lib/commands.js placementFor): the coordinator who ran the command.
      const { docPath, placement } = await hiring.hire(found.team.roomId, found.members, name, { ...opts, anchor: call.tabId }, baseOf(call))
      return { stdout: `hired ${name}: ${describeHire(placement, docPath)}\n` }
    },

    async invite(args, call) {
      const found = await teams.requireCoordinator(call)
      const { opts, pos } = parseArgs(args, { coordinator: 'bool' }, 1)
      const name = pos[0]
      // A change of the plugin's to the team too (its join would land after the export's cursor): under the guard.
      const inv = await hiring.invite(found.team.roomId, name, opts.coordinator === true)
      return {
        stdout:
          `invite for ${name}${opts.coordinator ? ' (coordinator)' : ''}: in the tab to add, run\n` +
          `  ccc room join ${inv.code}\n` +
          `(one use, expires ${iso(inv.expiresAt)})\n`,
      }
    },

    async fire(args, call) {
      const found = await teams.requireCoordinator(call)
      const { pos } = parseArgs(args, {}, 1)
      // Rooms lets a coordinator remove any member; the caller is a coordinator, so firing itself could leave the team
      // with none and no `ccc team` command (hire, invite, end) until the panel acts on it. Firing another
      // coordinator is fine: the caller stays.
      if (pos[0] === found.member.name) throw new TeamError('fire-self', 'you cannot fire yourself: ask another coordinator, or end the team')
      await hiring.fire(found.team.roomId, pos[0])
      return { stdout: `fired ${pos[0]}: its tab stays open, out of the room\n` }
    },

    async ask(args, call) {
      const found = await teams.requireMember(call)
      const { pos } = parseArgs(args, {}, 1)
      // `-` reads the whole stdin (the manifest's stdinDash); a lone `--` before it makes a literal "-" question.
      // Only the trailing newlines the shell adds are dropped.
      const text = pos[0] === '-' && args[0] !== '--' ? trimTrailingNewlines(String(call.stdin ?? '')) : pos[0]
      const q = await questions.ask(found, text)
      return { stdout: `asked ${q.id}: the person sees it in the Team panel; an answer arrives as a message from plugin\n` }
    },

    async mark(args, call) {
      const found = await teams.requireCoordinator(call)
      const { pos } = parseArgs(args, {}, 1)
      // The caller's name is held and checked again inside (metrics.mark): a fire of it while the mark waited on a host
      // call must not leave a mark stamped by a member no longer in the team.
      const m = await requireMetrics().mark(found.team.roomId, pos[0], found.member.name, { names: hiring.names, tabId: found.member.tabId })
      return { stdout: `marked "${m.label}" at ${iso(m.at)}\n` }
    },

    async stats(args, call) {
      const found = await teams.requireMember(call)
      const { opts } = parseArgs(args, { json: 'bool' }, 0)
      const s = await requireMetrics().stats(found.team.roomId)
      return { stdout: opts.json ? JSON.stringify(s, null, 2) + '\n' : formatStats(s) }
    },

    async list(args, call) {
      const found = await teams.requireMember(call)
      const { opts } = parseArgs(args, { json: 'bool' }, 0)
      const info = (await ctx.rooms.list()).find((r) => r.id === found.team.roomId)
      const sessions = new Map((await ctx.sessions.list()).map((s) => [s.tabId, s]))
      const members = found.members.map((m) => {
        const s = m.tabId !== undefined ? sessions.get(m.tabId) : undefined
        // `sessionId` (--json only): the member's Claude session, so a lead can find its transcript after End closed the tab.
        return { name: m.name, coordinator: m.coordinator, status: s ? s.status : 'no-tab', held: m.held, ...(s && s.sessionId ? { sessionId: s.sessionId } : {}) }
      })
      const out = {
        title: found.team.title,
        createdAt: found.team.createdAt,
        paused: Boolean(info && info.paused),
        you: found.member.name,
        members,
      }
      if (opts.json) return { stdout: JSON.stringify(out, null, 2) + '\n' }
      const width = Math.max(...members.map((m) => m.name.length), 4)
      const lines = [`${out.title}${out.paused ? ' (paused)' : ''}: ${members.length} member${members.length === 1 ? '' : 's'}`]
      for (const m of members) {
        const star = m.coordinator ? '*' : ' '
        const you = m.name === out.you ? '  (you)' : ''
        lines.push(`  ${star} ${m.name.padEnd(width)}  ${m.status.padEnd(16)}  ${m.held} waiting${you}`)
      }
      lines.push('  (* coordinator)')
      return { stdout: lines.join('\n') + '\n' }
    },

    async end(args, call) {
      const found = await teams.requireCoordinator(call)
      const { opts } = parseArgs(args, { export: 'value' }, 0)
      let dir
      if (opts.export !== undefined) {
        if (opts.export === '') throw new UsageError('--export needs a folder')
        // Resolved against the caller's cwd like --kickoff: any folder the tab names (not a boundary, design §8).
        dir = path.resolve(baseOf(call), opts.export)
      }
      // 20 s for the export, so a big team fails (and keeps running) inside the 30 s ccc cut, never ends unseen; the
      // call's signal (Ctrl+C, the cut itself) stops it before the end too.
      const { folder, closed } = await ending.endTeam(found.team.roomId, { dir, budgetMs: END_EXPORT_BUDGET_MS, signal: call.signal })
      const where = folder ? `exported to ${folder}\n` : 'not exported (no --export and no Export folder setting)\n'
      const tabs = closed > 0 ? `${closed} member tab${closed === 1 ? '' : 's'} closed, the others stay` : 'their tabs stay'
      return {
        stdout:
          where +
          `team "${found.team.title}" ended: its members are out of the room (${tabs}); its docs and log stay until it is deleted\n`,
      }
    },
  }

  /** The `ccc team` handler (`ctx.cli.register`). */
  return async function handle(argv, call) {
    const sub = argv[0]
    if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') return { stdout: USAGE }
    if (!Object.hasOwn(commands, sub)) return { stderr: `unknown command: ${sub}\n\n${USAGE}`, code: 2 }
    try {
      return await commands[sub](argv.slice(1), call || {})
    } catch (err) {
      if (err instanceof UsageError) return { stderr: `${err.message}\nusage: ccc team ${LINES[sub]}\n`, code: 2 }
      // A TeamError is ours; anything else is Rooms' (or the app's) refusal, printed in its own words.
      return { stderr: `${(err && err.message) || String(err)}\n`, code: 1 }
    }
  }
}

module.exports = { createCommands, createHiring, checkName, parseArgs, UsageError, USAGE, trimTrailingNewlines }
