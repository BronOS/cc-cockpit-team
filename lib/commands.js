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
  list: 'list [--json]',
  end: 'end',
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

function createCommands(ctx, teams) {
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

  /** The part of `hire` that writes: kickoff checks, the doc, the open (the caller holds the name's lock). */
  async function seedAndOpen(found, name, opts, call) {
    const base = typeof call.cwd === 'string' && call.cwd !== '' ? call.cwd : ctx.projectDir
    // Every kickoff check runs before the doc is seeded and the tab opened.
    const text = await readKickoff(opts.kickoff, base)
    const roomId = found.team.roomId
    const docPath = `members/${name}/kickoff.md`
    // A doc of that path can be left from an earlier member of the same name (fired, or its tab closed): Rooms has
    // no doc delete, so a failed open puts that text back, or an empty doc where there was none (the tombstone).
    // `get` answers missing and refused alike (one error), so existence comes from `list`; a failure of either call
    // refuses the hire before anything is written, never a guess of "missing" that a restore would then overwrite.
    let previous = ''
    if ((await ctx.rooms.docs.list(roomId)).some((d) => d.path === docPath)) {
      previous = await ctx.rooms.docs.get(roomId, docPath)
    }
    await ctx.rooms.docs.put(roomId, docPath, text)
    const open = {
      name,
      prompt: `Read your kickoff: ccc room doc get ${docPath}`,
      ...(opts.coordinator ? { coordinator: true } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      // Resolved against the caller's cwd like the kickoff path, so `--cwd ../wt` means what it says in the
      // caller's shell; Rooms then checks it is inside the project folder.
      ...(opts.cwd !== undefined ? { cwd: path.resolve(base, opts.cwd) } : {}),
    }
    try {
      await ctx.rooms.open(roomId, open)
    } catch (err) {
      try {
        await ctx.rooms.docs.put(roomId, docPath, previous)
      } catch (e) {
        throw new TeamError('open-failed', `${err.message}\n(and ${docPath} could not be restored: ${e && e.message})`)
      }
      throw err
    }
    return { stdout: `hired ${name}: its tab opened in the room and reads ${docPath}\n` }
  }

  // In-memory only, like the host's state: hires in flight (`roomId/name`), and the room each tab started whose
  // coordinator invite may still be unused (tabId -> { roomId, name }).
  const hiring = new Set()
  const pendingStarts = new Map()

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
      checkName(name)
      // Before anything is written: seeding over a current member's kickoff would change what it was told.
      if (found.members.some((m) => m.name === name)) throw new TeamError('name-taken', `${name} is already in the team`)
      // Two hires of one name would race on its kickoff doc (the member that opened could read the other's text).
      // No await sits between the members check and the add, so the set is the lock.
      const lock = `${found.team.roomId}/${name}`
      if (hiring.has(lock)) throw new TeamError('hire-pending', `${name} is already being hired`)
      hiring.add(lock)
      try {
        return await seedAndOpen(found, name, opts, call)
      } finally {
        hiring.delete(lock)
      }
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
      parseArgs(args, {}, 0)
      await ctx.rooms.end(found.team.roomId)
      // The record takes the room's endedAt from Rooms (one source of the time); a storage failure there is logged
      // and retried by the next reconcile, it does not undo an end that happened.
      try {
        await teams.refresh()
      } catch (err) {
        ctx.log.warn(`team end: refreshing the record: ${err && err.message}`)
      }
      return {
        stdout: `team "${found.team.title}" ended: its members are out of the room (their tabs stay); its docs and log stay until it is deleted\n`,
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

module.exports = { createCommands, parseArgs, UsageError, USAGE }
