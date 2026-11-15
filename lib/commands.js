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

const { TeamError } = require('./teams.js')
const { readKickoff } = require('./kickoff.js')
const { formatStats } = require('./stats.js')
const { createEnding } = require('./export.js')

/** The `end` export's time budget: a `ccc` call is cut at 30 s (types.ts cli.register); the rest is for the end. */
const END_EXPORT_BUDGET_MS = 20_000

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

// Rooms' member-name rule (cc-cockpit src/shared/room-names.ts, ROOM_NAME and checkRoomName's texts). Checked here
// only where a bad name would otherwise be written somewhere first: `start` (before the room is created) and `hire`
// (before the kickoff doc is seeded, whose path is built from the name). Rooms checks it again on open and invite.
const RESERVED_NAMES = ['all', 'plugin', 'person', 'user', 'system']
const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/
function checkName(name) {
  if (RESERVED_NAMES.includes(name)) throw new TeamError('name', `name "${name}" is reserved`)
  if (!NAME_RE.test(name)) throw new TeamError('name', 'name must be a lower-case letter then up to 30 of a-z, 0-9 and -')
}

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

/** A finite epoch ms as an ISO time, for invite expiries. */
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown')

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
 * Hiring, shared by `ccc team hire` and the panel's Hire and New team (the host builds one instance, so the per-name
 * lock covers both). `metrics` (optional) is told each hire's model and effort.
 */
function createHiring(ctx, metrics) {
  // Hires in flight (`roomId/name`), in memory only.
  const busy = new Set()

  /** The part of a hire that writes: kickoff checks, the doc, the open (the caller holds the name's lock). */
  async function seedAndOpen(roomId, name, opts, base) {
    // Every kickoff check runs before the doc is seeded and the tab opened. The panel's New team reads the file before
    // it creates the room and hands the text over (`kickoffText`), so it is not read twice.
    let text = opts.kickoffText
    if (text === undefined && opts.kickoff !== undefined) text = await readKickoff(opts.kickoff, base)
    const docPath = `members/${name}/kickoff.md`
    let previous = ''
    if (text !== undefined) {
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
      ...(text !== undefined ? { prompt: `Read your kickoff: ccc room doc get ${docPath}` } : {}),
      ...(opts.coordinator ? { coordinator: true } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      // Resolved against the base like the kickoff path, so `--cwd ../wt` means what it says in the caller's shell
      // (the project folder for the panel); Rooms then checks it is inside the project folder.
      ...(opts.cwd !== undefined ? { cwd: path.resolve(base, opts.cwd) } : {}),
    }
    let tabId
    try {
      ;({ tabId } = await ctx.rooms.open(roomId, open))
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
    return { tabId, docPath: text !== undefined ? docPath : undefined }
  }

  return {
    /**
     * Hire `name` into the room: `members` is main's member list of it now, `base` the folder `kickoff` and `cwd`
     * resolve against (the caller's cwd, or the project folder for the panel). `opts`: kickoff (a path) or
     * kickoffText (already checked), model, effort, cwd, coordinator. Returns `{ tabId, docPath }`.
     */
    async hire(roomId, members, name, opts, base) {
      checkName(name)
      // Before anything is written: seeding over a current member's kickoff would change what it was told.
      if (members.some((m) => m.name === name)) throw new TeamError('name-taken', `${name} is already in the team`)
      // Two hires of one name would race on its kickoff doc (the member that opened could read the other's text).
      // No await sits between the members check and the add, so the set is the lock.
      const lock = `${roomId}/${name}`
      if (busy.has(lock)) throw new TeamError('hire-pending', `${name} is already being hired`)
      busy.add(lock)
      try {
        return await seedAndOpen(roomId, name, opts, base)
      } finally {
        busy.delete(lock)
      }
    },
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
  if (!hiring) hiring = createHiring(ctx, metrics)
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

  // In-memory only, like the host's state: the room each tab started whose coordinator invite may still be unused
  // (tabId -> { roomId, name }).
  const pendingStarts = new Map()

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
      await callerSession(call)
      // A second start before the first invite was used would strand a room (live, no members, one of the plugin's
      // room slots, no `ccc team` command can reach it): hand out a fresh invite for the room already started.
      const pending = pendingStarts.get(call.tabId)
      if (pending) {
        pendingStarts.delete(call.tabId)
        const info = (await ctx.rooms.list()).find((r) => r.id === pending.roomId)
        if (info && info.endedAt === undefined && info.members === 0) {
          const again = await ctx.rooms.invite(pending.roomId, { name: pending.name, coordinator: true })
          pendingStarts.set(call.tabId, pending)
          return {
            stdout:
              `this tab already started team "${info.title}" and has not joined it yet (the title and --as stay as they were). ` +
              `Run this in this tab to join it as ${pending.name} (coordinator):\n` +
              `  ccc room join ${again.code}\n` +
              `(one use, expires ${iso(again.expiresAt)})\n`,
          }
        }
      }
      const { id } = await ctx.rooms.create({ title: pos[0] })
      let invite
      try {
        const team = await teams.add({ id })
        invite = await ctx.rooms.invite(id, { name, coordinator: true })
        pendingStarts.set(call.tabId, { roomId: id, name })
        return {
          stdout:
            `team "${team.title}" started. Run this in this tab to join it as ${name} (coordinator):\n` +
            `  ccc room join ${invite.code}\n` +
            `(one use, expires ${iso(invite.expiresAt)})\n`,
        }
      } catch (err) {
        // No invite, no coordinator: a room nobody can join would only hold one of the plugin's room slots. End and
        // delete it (best effort) and pass the first refusal through.
        await ctx.rooms
          .end(id)
          .then(() => ctx.rooms.delete(id))
          .then(() => teams.remove(id))
          .catch((e) => ctx.log.warn(`team start: cleaning up room ${id}: ${e && e.message}`))
        throw err
      }
    },

    async hire(args, call) {
      const found = await teams.requireCoordinator(call)
      const flags = { kickoff: 'value', model: 'value', effort: 'value', cwd: 'value', coordinator: 'bool' }
      const { opts, pos } = parseArgs(args, flags, 1)
      const name = pos[0]
      if (opts.kickoff === undefined) throw new UsageError('hire needs --kickoff <file>')
      const base = typeof call.cwd === 'string' && call.cwd !== '' ? call.cwd : ctx.projectDir
      const { docPath } = await hiring.hire(found.team.roomId, found.members, name, opts, base)
      return { stdout: `hired ${name}: its tab opened in the room and reads ${docPath}\n` }
    },

    async invite(args, call) {
      const found = await teams.requireCoordinator(call)
      const { opts, pos } = parseArgs(args, { coordinator: 'bool' }, 1)
      const name = pos[0]
      const inv = await ctx.rooms.invite(found.team.roomId, { name, coordinator: opts.coordinator === true })
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
      await ctx.rooms.remove(found.team.roomId, pos[0])
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
      const m = await requireMetrics().mark(found.team.roomId, pos[0], found.member.name)
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
        return { name: m.name, coordinator: m.coordinator, status: s ? s.status : 'no-tab', held: m.held }
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
        const base = typeof call.cwd === 'string' && call.cwd !== '' ? call.cwd : ctx.projectDir
        dir = path.resolve(base, opts.export)
      }
      // 20 s for the export, so a big team fails (and keeps running) inside the 30 s ccc cut, never ends unseen.
      const { folder } = await ending.endTeam(found.team.roomId, { dir, budgetMs: END_EXPORT_BUDGET_MS })
      const where = folder ? `exported to ${folder}\n` : 'not exported (no --export and no Export folder setting)\n'
      return {
        stdout:
          where +
          `team "${found.team.title}" ended: its members are out of the room (their tabs stay); its docs and log stay until it is deleted\n`,
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
