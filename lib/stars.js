'use strict'
// Stars (docs/design.md §4): the person's "well done" for a member, given through a coordinator with
// `ccc team star <name> "<reason>"` and kept on the team's record (`rec.stars`) for the retrospective.
//
// A star is told to the member as a room message from the plugin, then kept. Each one carries a snapshot of the
// member as it was when starred (coordinator or not, model, effort, Code Mode): a name can be fired and hired again
// with other settings, and its metrics row can be folded away (stats.js foldFormer), but the star stays about the
// stint it was given for. The reason is a coordinator's text relaying the person: plain, one line, bounded.

const { TeamError, isNoRoom, NOT_IN_TEAM, NOT_COORDINATOR } = require('./teams.js')
const { badTextChar } = require('./kickoff.js')

/** A reason: one line, a tooltip line and a table cell in the export. */
const REASON_MAX = 300
/** Stars per team: the record is one 1 MiB value (200 of 300 characters is at most about 180 KB of JSON). */
const STARS_MAX = 200

/**
 * The room message a starred member gets. The reason is one line (checked), so it cannot open a second line that
 * reads like another message of the plugin's (`Answer to your question ...`).
 */
const starMessage = (reason, by) => `The person gave you a star: ${reason} (recorded by ${by})`

/** The reason, trimmed, or a refusal. */
function checkReason(reason) {
  if (typeof reason !== 'string') throw new TeamError('bad-reason', 'a star needs a reason')
  const text = reason.trim()
  if (text === '') throw new TeamError('bad-reason', 'the star\'s reason is empty')
  if ([...text].length > REASON_MAX) throw new TeamError('bad-reason', `a star's reason is at most ${REASON_MAX} characters`)
  if (badTextChar(text) || /[\t\r\n]/.test(text)) throw new TeamError('bad-reason', 'a star\'s reason is one line with no control, bidi or invisible format character')
  return text
}

/**
 * `names` is the host's one set of name locks (teams.js createNameLocks, shared with questions and hiring), so a fire
 * of the starred member or of the coordinator giving the star is refused while the star is on its way.
 */
function createStars(ctx, teams, names) {
  if (!names || typeof names.hold !== 'function') throw new TypeError('createStars: pass the host\'s name locks (questions.names)')

  /**
   * The part that decides, sends and writes (the caller holds the guard and both names). THE RULE (teams.js
   * createTeamGuard): every precondition is decided here, after the last await before the send.
   */
  async function starHeld(roomId, name, text, by, tabId) {
    let members
    try {
      members = await ctx.rooms.members(roomId)
    } catch (err) {
      if (isNoRoom(err)) throw new TeamError('ended', 'the team has ended: no more stars')
      throw err
    }
    await teams.guard.refresh()
    let rec
    try {
      rec = teams.guard.live(roomId)
    } catch (err) {
      if (err && err.code === 'ended') throw new TeamError('ended', 'the team has ended: no more stars')
      throw err
    }
    // The giver, as `mark` checks its caller: still in the team under the same tab, and a coordinator there.
    const me = members.find((x) => x.name === by && (tabId === undefined || x.tabId === tabId))
    if (!me) throw new TeamError('not-in-team', NOT_IN_TEAM)
    if (!me.coordinator) throw new TeamError('not-coordinator', NOT_COORDINATOR)
    const to = members.find((x) => x.name === name)
    if (!to) throw new TeamError('not-member', `${name} is not in the team (a star goes to a current member)`)
    if (rec.stars.length >= STARS_MAX) throw new TeamError('too-many', `a team has at most ${STARS_MAX} stars`)
    // Told first, kept after (as a reply): a star the member never got (`gone`, `refused`) is not recorded. Rooms'
    // own refusal (its send rate) passes through as it is.
    const answers = await ctx.rooms.send(roomId, name, starMessage(text, by))
    const a = Array.isArray(answers) ? answers[0] : undefined
    if (a && a.path === 'gone') throw new TeamError('gone', `${name} left the team: no star given`)
    if (a && a.path === 'refused') throw new TeamError('refused', `${name} cannot take the message now (${a.why}): no star given`)
    const m = rec.metrics.members[name]
    const row = m && typeof m === 'object' ? m : {}
    const star = {
      at: Date.now(),
      name,
      reason: text,
      by,
      coordinator: to.coordinator === true,
      ...(typeof row.model === 'string' ? { model: row.model } : {}),
      ...(typeof row.effort === 'string' ? { effort: row.effort } : {}),
      ...(typeof row.codeMode === 'boolean' ? { codeMode: row.codeMode } : {}),
    }
    rec.stars.push(star)
    try {
      await teams.save(rec)
    } catch (err) {
      // The message is out: the star stays in memory (the truth) and the next reconcile writes it again (teams.js
      // persist), as a reply's answer time does. Telling the member twice would be worse.
      ctx.log.warn(`team star: saving the star for ${name}: ${err && err.message}`)
    }
    return { star, count: rec.stars.filter((s) => s.name === name).length, delivery: a && a.path, why: a && a.why }
  }

  return {
    /**
     * Give `name` a star from the coordinator `by` (`ccc team star`; `tabId` is the caller's tab, from main). The
     * reason is checked first; then, under the export guard and both names' locks, the decision and the send.
     * Returns `{ star, count, delivery, why }`: `delivery` is Rooms' path (`delivered`, `held`).
     */
    async star(roomId, name, reason, by, { tabId } = {}) {
      const text = checkReason(reason)
      return teams.guard.change(roomId, () =>
        names.hold(roomId, by, 'star', () => (name === by ? starHeld(roomId, name, text, by, tabId) : names.hold(roomId, name, 'star', () => starHeld(roomId, name, text, by, tabId)))),
      )
    },
    names,
  }
}

module.exports = { createStars, starMessage, checkReason, REASON_MAX, STARS_MAX }
