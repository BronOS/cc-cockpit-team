'use strict'
// Questions to the person (docs/design.md §3).
//
// A member cannot send to `person` in Rooms (reserved name), so `ccc team ask` is the tool's way: the plugin records
// `{ id, from, text, askedAt }` on the team's record, raises a notice, and the person answers from the panel. Reply
// sends the text to the asker as a room message from the plugin; Done closes the question with no reply. The panel
// (task 8) calls `reply` and `done` with the room id and question id, never trusting what a member typed.
//
// A question's text is a member's: untrusted. It is checked by Rooms' message rules before it is stored (the same
// length and character rules a room send has), and it only ever leaves here as plain text (a notice, the panel).

const { TeamError } = require('./teams.js')
const { badTextChar } = require('./kickoff.js')
const { foldOut } = require('./stats.js')

/** Rooms' message limit (ctx.rooms.send): longer text goes in a doc. */
const TEXT_MAX = 20000
/**
 * Open questions (waiting on the person) a team may have: their count and their total text. Answering or closing
 * one frees its share, so the refusal can send the person to the panel and mean it.
 */
const OPEN_MAX = 50
const OPEN_TEXT_MAX = 100000
/**
 * Every question of a team, open and closed: their count and their total text. A record is one `ctx.storage` value
 * of at most 1 MiB, and questions are never refused for their history: past these, the oldest closed questions are
 * compacted on the next ask (their text cut to a glance, `trimmed: true`, then the oldest dropped), so a long-lived
 * team keeps asking. Open ones are never touched (they are bounded above). 200,000 characters is at most 600 KB of
 * JSON (3 bytes a character; control characters are refused, so no 6-byte escapes).
 */
const KEPT_MAX = 300
const STORED_TEXT_MAX = 200000
/** The notice shows the question's first line only, this long (a notice is a glance, the panel has the rest). */
const NOTICE_MAX = 140

/** A question still waiting for the person: neither answered nor closed. */
const isOpen = (q) => q.answeredAt === undefined && q.doneAt === undefined

/**
 * The next id: `q<n>` above every id kept. Only the oldest closed questions are ever dropped (`compact`), never the
 * newest, so the highest id stays and ids are never reused.
 */
function nextId(questions) {
  let max = 0
  for (const q of questions) {
    const n = /^q(\d+)$/.exec(q.id)
    if (n) max = Math.max(max, Number(n[1]))
  }
  return `q${max + 1}`
}

/** One line of at most `max` characters of `text`, for a notice. */
function glance(text, max) {
  const line = text.trim().split(/\r?\n/)[0]
  const chars = [...line]
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : line
}

/** The reply's first line; the whole message must fit Rooms' limit, so the person's text gets the rest. */
const replyPrefix = (id) => `Answer to your question ${id}:\n`

/**
 * Make room in `questions` for the one just pushed (design: questions are kept, but a record has a size limit). The
 * oldest closed questions are compacted first (text cut to a glance), then dropped. The newest question is open, so
 * the highest id survives and `nextId` never goes back. Kept even when the save that follows fails: it only loses
 * history of closed questions that the next save would compact anyway. What is dropped is folded into the record's
 * stored counters first (stats.js `foldOut`), so the question counts and the person's active time never go down.
 */
function compact(rec, t) {
  const questions = rec.questions
  let total = questions.reduce((sum, q) => sum + q.text.length, 0)
  for (const q of questions) {
    if (total <= STORED_TEXT_MAX) break
    if (isOpen(q) || q.trimmed) continue
    const short = glance(q.text, NOTICE_MAX)
    total -= q.text.length - short.length
    q.text = short
    q.trimmed = true
  }
  const dropped = []
  for (let i = 0; questions.length > KEPT_MAX && i < questions.length; ) {
    if (isOpen(questions[i])) i++
    else dropped.push(...questions.splice(i, 1))
  }
  if (dropped.length) foldOut(rec, dropped, [], t)
}

function createQuestions(ctx, teams) {
  // Replies in flight (`roomId/questionId`): two clicks on Reply must send one message, and a Done must not close a
  // question whose answer is on its way (it would end both answered and closed). No await sits between the open
  // check and the add, so the set is the lock.
  const replying = new Set()
  // The asker's tab at ask time, memory only: names are reusable after a fire, so a reply must not reach a new member
  // of the same name. Not saved, since restored tabs get new ids (design-rooms "Restart"); after a restart the match
  // falls back to the name. A match key only, never a trust input.
  const askerTab = new WeakMap()

  /** The team's record and question, refusing an unknown team or question in one text each. */
  async function find(roomId, questionId) {
    const rec = await teams.get(roomId)
    if (!rec) throw new TeamError('no-team', 'no such team')
    const q = rec.questions.find((x) => x.id === questionId)
    if (!q) throw new TeamError('no-question', `no such question: ${questionId}`)
    return { rec, q }
  }

  const closedText = (q) => `${q.id} is already ${q.answeredAt !== undefined ? 'answered' : 'closed'}`
  const ENDED = 'the team has ended: nobody is left to answer'
  const isNoRoom = (err) => Boolean(err && typeof err.message === 'string' && err.message.includes('no such room'))

  const api = {
    /**
     * Record a question from the member `found` (a `teams.requireMember` answer) and raise a notice. Returns the
     * stored question. The caller's name comes from Rooms' member list, never from the arguments.
     */
    async ask(found, text) {
      if (typeof text !== 'string' || text.trim() === '') throw new TeamError('empty', 'the question is empty')
      if (text.length > TEXT_MAX) throw new TeamError('too-long', `a question is at most ${TEXT_MAX} characters (put more in a doc)`)
      const bad = badTextChar(text)
      if (bad) throw new TeamError('bad-text', `the question has a character Rooms refuses (control, bidi or invisible format): ${bad}`)
      const rec = found.team
      const open = rec.questions.filter(isOpen)
      if (open.length >= OPEN_MAX) {
        throw new TeamError('too-many', `${open.length} questions are already waiting on the person: wait until some are answered or closed`)
      }
      const waiting = open.reduce((sum, q) => sum + q.text.length, 0)
      if (waiting + text.length > OPEN_TEXT_MAX) {
        throw new TeamError(
          'too-many',
          `the questions waiting on the person already hold ${waiting} characters (at most ${OPEN_TEXT_MAX}): wait until some are answered or closed, or put the detail in a doc`,
        )
      }
      const q = { id: nextId(rec.questions), from: found.member.name, text, askedAt: Date.now() }
      rec.questions.push(q)
      if (typeof found.member.tabId === 'string') askerTab.set(q, found.member.tabId)
      compact(rec, q.askedAt)
      try {
        await teams.save(rec)
      } catch (err) {
        // By identity: another ask may have pushed after this one while this save was pending.
        const i = rec.questions.indexOf(q)
        if (i >= 0) rec.questions.splice(i, 1)
        throw err
      }
      // The notice is a courtesy: a failing one must not turn a stored question into a failed command (the member
      // would ask again, twice). Plain text, one line: the title and the name are the room's, the text a member's.
      try {
        await ctx.notify(`${q.from} asks: ${glance(q.text, NOTICE_MAX)}`, { title: glance(`Team: ${rec.title}`, 80) })
      } catch (err) {
        ctx.log.warn(`team ask: notice: ${err && err.message}`)
      }
      return q
    },

    /**
     * Answer a question from the person: a room message from the plugin to the asker, `Answer to your question <id>:`
     * then the text, and the answer time on the question. Rooms' refusal (characters, rate) passes through and leaves
     * the question open. A member that left (or a new member under its name) answers "left the team" and the question
     * stays open (the person can close it with Done).
     */
    async reply(roomId, questionId, text) {
      // The record's endedAt can lag Rooms (a room ended from the room view): bring it in line before deciding.
      await teams.refresh()
      const { rec, q } = await find(roomId, questionId)
      const lock = `${roomId}/${q.id}`
      if (replying.has(lock)) throw new TeamError('reply-pending', `${q.id} is already being answered`)
      if (!isOpen(q)) throw new TeamError('closed', closedText(q))
      if (rec.endedAt !== undefined) throw new TeamError('ended', ENDED)
      if (typeof text !== 'string' || text.trim() === '') throw new TeamError('empty', 'the reply is empty')
      const room = TEXT_MAX - replyPrefix(q.id).length
      if (text.length > room) throw new TeamError('too-long', `a reply is at most ${room} characters (this one has ${text.length}): put more in a doc`)
      replying.add(lock)
      try {
        const gone = new TeamError('gone', `${q.from} left the team: close ${q.id} with Done instead`)
        let members
        try {
          members = await ctx.rooms.members(roomId)
        } catch (err) {
          if (isNoRoom(err)) throw new TeamError('ended', ENDED)
          throw err
        }
        const asker = members.find((m) => m.name === q.from)
        const tab = askerTab.get(q)
        if (!asker || (tab !== undefined && asker.tabId !== undefined && asker.tabId !== tab)) throw gone
        const answers = await ctx.rooms.send(roomId, q.from, replyPrefix(q.id) + text)
        // `send` answers per recipient; one recipient here. `gone`: left between the check and the send. `refused`:
        // its queue is full, nothing was queued. Anything else (delivered, held) is the answer given.
        const a = answers[0]
        if (a && a.path === 'gone') throw gone
        if (a && a.path === 'refused') throw new TeamError('refused', `${q.from} cannot take the answer now: ${a.why}`)
        q.answeredAt = Date.now()
        try {
          await teams.save(rec)
        } catch (err) {
          // The message is out: the time is memory-only until the next save; say so rather than send it twice.
          ctx.log.warn(`team reply: saving ${q.id}: ${err && err.message}`)
        }
        return { answers, question: q }
      } finally {
        replying.delete(lock)
      }
    },

    /** Close a question without a reply; refused while its answer is being sent. */
    async done(roomId, questionId) {
      const { rec, q } = await find(roomId, questionId)
      if (replying.has(`${roomId}/${q.id}`)) throw new TeamError('reply-pending', `${q.id} is already being answered`)
      if (!isOpen(q)) throw new TeamError('closed', closedText(q))
      q.doneAt = Date.now()
      try {
        await teams.save(rec)
      } catch (err) {
        delete q.doneAt
        throw err
      }
      return q
    },

    /** The open questions of a team, oldest first (the panel's "Waiting on you"). */
    async open(roomId) {
      const rec = await teams.get(roomId)
      return rec ? rec.questions.filter(isOpen) : []
    },
  }
  return api
}

module.exports = { createQuestions, isOpen, TEXT_MAX, OPEN_MAX, OPEN_TEXT_MAX, KEPT_MAX, STORED_TEXT_MAX, replyPrefix }
