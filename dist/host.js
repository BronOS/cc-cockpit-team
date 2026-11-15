'use strict'
// Team for cc-cockpit: a tool for running a team (one Rooms room) of Claude tabs. Not a flow: no roles,
// phases or personas (docs/design.md §0). This file only wires the pieces; each later module owns one
// concern (lib/teams.js, lib/commands.js, ...).

const { createTeams } = require('../lib/teams.js')
const { createCommands, USAGE } = require('../lib/commands.js')

const OLD_APP = 'Team needs cc-cockpit 0.18.1 or newer (Rooms): update the app.'

let disposers = []

exports.activate = (ctx) => {
  // An app without Rooms has no ctx.rooms: register a handler that says so, rather than throwing on
  // every later call. `help` still works.
  if (typeof ctx.rooms !== 'object' || ctx.rooms === null) {
    ctx.log.warn(OLD_APP)
    disposers.push(
      ctx.cli.register('team', async (argv) => {
        const sub = argv[0]
        if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') return { stdout: USAGE }
        return { stderr: `${OLD_APP}\n`, code: 1 }
      }),
    )
    return
  }
  const teams = createTeams(ctx)
  // Load the records at once (dropping those whose room is gone) rather than on the first command; a failure
  // is only logged: every later call loads again.
  teams.load().catch((err) => ctx.log.warn(`team records: ${err && err.message}`))
  disposers.push(ctx.cli.register('team', createCommands(ctx, teams)))
}

exports.deactivate = () => {
  for (const d of disposers) d()
  disposers = []
}

exports.USAGE = USAGE
