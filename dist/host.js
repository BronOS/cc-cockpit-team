'use strict'
// Team for cc-cockpit: a tool for running a team (one Rooms room) of Claude tabs. Not a flow: no roles,
// phases or personas (docs/design.md §0). This file only wires the pieces; each later module owns one
// concern (lib/teams.js, lib/commands.js, ...).

const { createTeams } = require('../lib/teams.js')
const { createQuestions } = require('../lib/questions.js')
const { createCommands, createHiring, USAGE } = require('../lib/commands.js')
const { createMetrics } = require('../lib/metrics.js')
const { createEnding } = require('../lib/export.js')
const { createPanel } = require('../lib/panel.js')

const OLD_APP = 'Team needs cc-cockpit 0.18.1 or newer (Rooms): update the app.'

let disposers = []
let metrics = null
let instances = null

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
    // The declared Team panel still opens: tell its page why it is empty, and answer every request so none waits.
    if (ctx.panels && typeof ctx.panels.onMessage === 'function') {
      disposers.push(
        ctx.panels.onMessage('team', (m, from) => {
          if (!m || typeof m !== 'object' || typeof m.type !== 'string') return
          const view = from && typeof from.view === 'string' ? from.view : 'desktop'
          const message =
            m.type === 'hello' || m.type === 'select' || m.type === 'ping'
              ? { type: 'state', teams: [], team: null, exportDir: null, error: OLD_APP }
              : { type: 'result', action: m.type.slice(0, 40), req: typeof m.req === 'string' || Number.isSafeInteger(m.req) ? m.req : undefined, ok: false, error: OLD_APP }
          try {
            ctx.panels.post('team', message, { view })
          } catch (err) {
            ctx.log.warn(`team panel: ${(err && err.message) || err}`)
          }
        }),
      )
    }
    return
  }
  const teams = createTeams(ctx)
  // Load the records at once (dropping those whose room is gone) rather than on the first command; a failure
  // is only logged: every later call loads again.
  teams.load().catch((err) => ctx.log.warn(`team records: ${err && err.message}`))
  // One questions instance for the `ccc team` handler and the panel (task 8): the reply lock and the askers' tabs
  // live in it, so a second instance would let a Reply and a Done race. createCommands refuses to build its own.
  const questions = createQuestions(ctx, teams)
  // One metrics instance too: it owns the in-memory status intervals and the throttled saves of every team.
  metrics = createMetrics(ctx, teams)
  // End (with its export) and Delete: one instance too, its per-team lock refuses an End from the CLI and the panel at once.
  const ending = createEnding(ctx, teams, metrics)
  // Hiring too: its per-name lock covers `ccc team hire` and the panel's Hire and New team.
  const hiring = createHiring(ctx, metrics)
  instances = { teams, questions, metrics, ending, hiring }
  metrics.start().catch((err) => ctx.log.warn(`team metrics: ${err && err.message}`))
  disposers.push(ctx.cli.register('team', createCommands(ctx, teams, questions, metrics, ending, hiring)))
  // The panel's backend on the same instances (design §7): it checks every action again.
  const panel = createPanel(ctx, instances)
  panel.start()
  instances.panel = panel
  disposers.push(() => panel.stop())
}

exports.deactivate = () => {
  for (const d of disposers) d()
  disposers = []
  // Saves what is pending: the open status intervals and the throttled saves. The promise is returned because the
  // host's loader awaits it (up to 5 s, then the host is killed regardless): left unreturned, the final save would
  // race the teardown on every window close, quit and plugin reload.
  const m = metrics
  metrics = null
  instances = null
  if (m) return m.stop().catch(() => {})
}

/** The live shared instances (the panel's backend builds on them; tests drive a reply through them). */
exports.instances = () => instances
exports.USAGE = USAGE
