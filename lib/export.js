'use strict'
// End and export (docs/design.md §5): `end [--export <dir>]` and the panel's End and export write the team into a
// NEW folder `<dir>/<team-slug>-<yyyymmdd-hhmm>/`, then end the room; Delete removes an ended team.
//
// The folder is made with a plain (non-recursive) `mkdir`, so an existing one is refused (EEXIST), never written
// into; every file is opened `wx` with O_NOFOLLOW, so nothing is written through a symlink planted in its place, and
// every folder below it is checked by realpath before each write (exportTeam), so not through a swapped folder either.
// Files are 0600 and folders 0700: a member's private docs and the log's messages stay the owner's. Doc
// paths come from Rooms, already restricted to `[A-Za-z0-9._-]` parts and depth 4, and are checked again here before
// any of them becomes a file path: the export is the one place a room's names touch the file system.
//
// `<dir>` itself is any folder the calling tab names (or the setting): not a boundary, since the coordinator is a
// Claude tab of the same OS user that can write there anyway (design §8). The checks above keep an export from
// landing somewhere other than where it says, not a tab from writing.
//
// A failed export leaves the room running (nothing is ended before the folder is complete) and removes what it
// wrote: only the files and folders it created itself, one by one, never a recursive delete.

const fsp = require('node:fs/promises')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { TeamError, NAME_RE, STARTING } = require('./teams.js')
const { statsOf, fmtDuration, fmtCost, foldedOf, iso } = require('./stats.js')

// Rooms' doc path rule (cc-cockpit src/main/rooms/room-docs.ts parseDocPath, src/shared/room-names.ts isPathPart):
// `shared/...` or `members/<name>/...`, 1-4 parts below the area, each 1-128 of `[A-Za-z0-9._-]`, never `.` or `..`.
const DOC_DEPTH_MAX = 4
const PART_MAX = 128
const PART_RE = /^[A-Za-z0-9._-]+$/
/** Log pages read per export at most (1000 entries each): Rooms trims a log at 20 MiB, far below this. */
const LOG_PAGES_MAX = 10_000

const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW

/** The parts of a doc path when it passes Rooms' rule again, else null. */
function checkDocPath(p) {
  if (typeof p !== 'string') return null
  const all = p.split('/')
  let below
  if (all[0] === 'shared') below = all.slice(1)
  else if (all[0] === 'members' && typeof all[1] === 'string' && NAME_RE.test(all[1])) below = all.slice(2)
  else return null
  if (below.length === 0 || below.length > DOC_DEPTH_MAX) return null
  for (const part of below) {
    if (part === '.' || part === '..' || part.length > PART_MAX || !PART_RE.test(part)) return null
  }
  return all
}

/** The title as a folder name: lower-case a-z, 0-9 and single dashes, at most 40; `team` when nothing is left. */
function slugOf(title) {
  let out = ''
  for (const ch of String(title).toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) out += ch
    else if (out !== '' && !out.endsWith('-')) out += '-'
    if (out.length >= 40) break
  }
  while (out.endsWith('-')) out = out.slice(0, -1)
  return out || 'team'
}

/** yyyymmdd-hhmm in local time (the person reads the folder name in their own clock). */
function stampOf(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** A table cell: one line, `|` escaped (mark labels, titles and names are a member's or the person's text). */
const cell = (x) => String(x ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')

/** metrics.md: the totals, the spans (the table split at marks) and the members. */
function metricsMarkdown(s, exportedAt) {
  const t = s.totals
  const out = []
  out.push(`# ${s.title}: metrics`, '')
  out.push(`Exported ${iso(exportedAt)}. Started ${iso(s.createdAt)}, ${fmtDuration(s.elapsedMs)} elapsed.`, '')
  out.push('## Totals', '')
  out.push('| cost | working | waiting | idle | sent | received | doc reads | doc writes |')
  out.push('|---|---|---|---|---|---|---|---|')
  out.push(
    `| ${fmtCost(t.costUsd)} | ${fmtDuration(t.workingMs)} | ${fmtDuration(t.waitingMs)} | ${fmtDuration(t.idleMs)} | ` +
      `${t.sent} | ${t.received} | ${t.docReads} | ${t.docWrites} |`,
  )
  out.push('')
  out.push(
    `The person: ${fmtDuration(s.personActiveMs)} active (a proxy: question to answer, plus panel actions). ` +
      `Questions: ${s.questions.asked} asked, ${s.questions.answered} answered, ${s.questions.open} open.`,
  )
  out.push('', 'Working time is summed over members (effort, not elapsed time). Cost covers the members\' tabs only.', '')
  if (Number.isInteger(s.logSeq)) {
    out.push(
      `The counts and log.jsonl cover the room log up to entry ${s.logSeq}, where these stats were taken. What the room ` +
        'logged after it, before its end (a message sent while the export ran), is in neither; it stays in the room\'s log until Delete.',
      '',
    )
  }
  out.push('## Spans (split at marks)', '')
  out.push('| from | to | started | time | cost | working |')
  out.push('|---|---|---|---|---|---|')
  for (const sp of s.spans) {
    out.push(`| ${cell(sp.from)} | ${cell(sp.to)} | ${iso(sp.fromAt)} | ${fmtDuration(sp.ms)} | ${fmtCost(sp.costUsd)} | ${fmtDuration(sp.workingMs)} |`)
  }
  out.push('', '## Members', '')
  out.push('| name | model | effort | hired | left | cost | context | working | waiting | idle | sent | received | doc reads | doc writes | asked |')
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const m of s.members) {
    const left = m.leftAt !== undefined ? `${iso(m.leftAt)} (${m.leftWhy})` : ''
    out.push(
      `| ${cell(m.name)}${m.coordinator ? ' (coordinator)' : ''} | ${cell(m.model ?? 'default')} | ${cell(m.effort ?? 'default')} | ` +
        `${m.hiredAt !== undefined ? iso(m.hiredAt) : 'unknown'} | ${cell(left)} | ${fmtCost(m.costUsd)} | ` +
        `${m.contextPercent === null ? 'unknown' : m.contextPercent + '%'} | ${fmtDuration(m.workingMs)} | ${fmtDuration(m.waitingMs)} | ` +
        `${fmtDuration(m.idleMs)} | ${m.sent ?? 0} | ${m.received ?? 0} | ${m.docReads ?? 0} | ${m.docWrites ?? 0} | ${m.questionsAsked} |`,
    )
  }
  if (s.members.length === 0) out.push('', '(no members seen)')
  if (s.membersFolded > 0) out.push('', `${s.membersFolded} earlier former members are not listed: their numbers are in the totals.`)
  return out.join('\n') + '\n'
}

/**
 * questions.md: every question the record keeps, oldest first, its text quoted. The answer's text is not stored
 * (only its time: it went to the asker as a room message, which is in log.jsonl); very old closed questions may have
 * been cut to a glance (`trimmed`) or dropped and folded into the counts.
 */
function questionsMarkdown(rec, s) {
  const out = [`# ${rec.title}: questions`, '']
  out.push(`${s.questions.asked} asked, ${s.questions.answered} answered, ${s.questions.open} open.`)
  const kept = Array.isArray(rec.questions) ? rec.questions.filter((q) => q && typeof q === 'object' && typeof q.text === 'string') : []
  const dropped = foldedOf(rec).asked
  if (dropped > 0) out.push(`${dropped} older closed question${dropped === 1 ? ' was' : 's were'} dropped from the record (counted above).`)
  out.push('The answers went to the askers as room messages: see log.jsonl.')
  for (const q of kept) {
    const state = Number.isFinite(q.answeredAt) ? 'answered' : Number.isFinite(q.doneAt) ? 'closed without a reply' : 'open'
    out.push('', `## ${cell(q.id)} from ${cell(q.from)}: ${state}`, '')
    let when = `Asked ${iso(q.askedAt)}`
    if (Number.isFinite(q.answeredAt)) when += `, answered ${iso(q.answeredAt)} (${fmtDuration(q.answeredAt - q.askedAt)})`
    else if (Number.isFinite(q.doneAt)) when += `, closed ${iso(q.doneAt)}`
    out.push(when + '.')
    if (q.trimmed) out.push('(Text shortened in the record.)')
    out.push('')
    for (const line of q.text.split(/\r?\n/)) out.push(line === '' ? '>' : `> ${line}`)
  }
  return out.join('\n') + '\n'
}

/**
 * Two doc paths that cannot both be files of one export, or null: Rooms keeps `shared/Notes.md` and `shared/notes.md`
 * apart, but a case-insensitive volume (APFS, NTFS by default) has one file for both (the second `wx` open fails with
 * EEXIST); and a doc `shared/a` next to `shared/a/b` needs `a` as a file and a folder. Compared in lower case: a
 * case-sensitive volume would take the first pair, but the export must not depend on the volume.
 */
function docClash(paths) {
  const files = new Map() // lower-case path -> the doc
  const dirs = new Map() // lower-case folder -> a doc under it
  for (const p of paths) {
    const k = p.toLowerCase()
    if (files.has(k)) return [files.get(k), p]
    if (dirs.has(k)) return [p, dirs.get(k)]
    const parts = k.split('/')
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/')
      if (files.has(d)) return [files.get(d), p]
      if (!dirs.has(d)) dirs.set(d, p)
    }
    files.set(k, p)
  }
  return null
}

const TOO_LONG = 'the export took too long (a ccc call is cut at 30 s): end it from the panel, or without --export'
const CANCELLED = 'the ccc call was cancelled (Ctrl+C, its 30 s cut, or the plugin stopped): the team was not ended'

/** Throw once the absolute `deadline` (ms of `now`) has passed or the caller's `signal` is aborted. */
function checkBudget(deadline, signal, now) {
  if (signal && signal.aborted) throw new Error(CANCELLED)
  if (deadline !== undefined && now() > deadline) throw new Error(TOO_LONG)
}

/**
 * `p`, or a rejection as soon as `signal` aborts: a step with no bound of its own (the metrics catch-up) cannot hold a
 * cancelled call's handler, which would then go on to end the room unseen. The step itself runs on.
 */
function untilAborted(p, signal) {
  if (!signal) return p
  // The step runs on after a cancel, and its own failure then (the catch-up's budget check throws on the aborted
  // signal) has nobody left to hear it: handled here, never an unhandled rejection.
  Promise.resolve(p).catch(() => {})
  if (signal.aborted) return Promise.reject(new Error(CANCELLED))
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error(CANCELLED))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([p, aborted]).finally(() => signal.removeEventListener('abort', onAbort))
}

/** A step of the export found its folder changed under it (a folder swapped for a link, a file replaced). */
const changed = (p) => new Error(`${p} changed during the export (a folder or file replaced, a link planted): stopped`)

/**
 * Write `rooms.docs`, the log, the metrics and the questions of a team into a new folder under `dir`. `stats` is the
 * team's stats object (lib/stats.js statsOf) as of the export; `rec` its record as of the same instant (a copy: the
 * live record would show a reply made during the export, which the counts and log.jsonl do not have). `stats.logSeq` (when given) is the
 * last log entry the stats count: log.jsonl stops there too, since the room is live while the export runs and a
 * member's send after the stats were taken would be in the log and not in the counts. `deadline` (optional, a time in ms
 * of `now`) fails the export once passed, and `signal` (optional, the `ccc` call's) once aborted: both are checked
 * before each Rooms call and after the last write (a failure there still removes the folder). Returns its path.
 *
 * Every path is built from `realpath(dir)`, so a path's parent is known exactly; before each mkdir and open, and
 * after each write, the parent's realpath must still be that path (no folder of ours swapped for a link meanwhile:
 * O_NOFOLLOW guards only the last part of a path), and an entry made must be the one at its path (dev and inode).
 * The same check runs before each unlink or rmdir of the cleanup, so it never removes what another process put
 * there. Not atomic (a swap between the check and the call is still possible, as in Rooms' room-docs.ts write);
 * it keeps a swap made while the export runs from sending a write or a delete elsewhere.
 */
async function exportTeam(ctx, { rec, stats, dir, at, deadline, signal, now = Date.now }) {
  const roomId = rec.roomId
  const checkTime = () => checkBudget(deadline, signal, now)
  // Every check that can refuse runs before anything is written.
  let st
  try {
    st = await fsp.stat(dir)
  } catch (err) {
    throw new Error(err && err.code === 'ENOENT' ? `no such folder: ${dir}` : `cannot use ${dir}: ${err && err.message}`)
  }
  if (!st.isDirectory()) throw new Error(`not a folder: ${dir}`)
  // `dir` may itself be (or pass through) a link: the person named it, so it is resolved once, here.
  const base = await fsp.realpath(dir)
  checkTime()
  const docs = await ctx.rooms.docs.list(roomId)
  for (const d of docs) {
    if (!checkDocPath(d && d.path)) throw new Error(`a doc path Rooms should not have given: ${JSON.stringify(d && d.path)}`)
  }
  const clash = docClash(docs.map((d) => d.path))
  if (clash) {
    throw new Error(
      `the docs ${clash[0]} and ${clash[1]} cannot both be written to a folder (one name in two cases, or a doc that is ` +
        "another's folder): rename one in the room (ccc room doc), or end without an export",
    )
  }

  const folder = path.join(base, `${slugOf(rec.title)}-${stampOf(at)}`)
  const created = [] // { p, parent, isDir, dev, ino }, in creation order, for the cleanup

  /** The parent is still the folder it was when the path was built (none of its parts swapped for a link). */
  async function sameParent(parent) {
    let real
    try {
      real = await fsp.realpath(parent)
    } catch {
      return false
    }
    return real === parent
  }
  /** The entry at `p` is still the one made (`lstat` never follows a link, so a planted link differs). */
  async function sameEntry(p, entry) {
    let s
    try {
      s = await fsp.lstat(p)
    } catch {
      return false
    }
    return s.dev === entry.dev && s.ino === entry.ino && (entry.isDir ? s.isDirectory() : s.isFile())
  }

  async function mkdirOwn(p, parent) {
    if (!(await sameParent(parent))) throw changed(parent)
    // Owner-only: a member's private docs and the log's message texts are not for other users of the machine.
    await fsp.mkdir(p, 0o700)
    // A plain folder of our own, else refused (and left alone: what is there now may not be ours).
    const s = await fsp.lstat(p)
    if (!s.isDirectory() || !(await sameParent(parent))) throw changed(p)
    created.push({ p, parent, isDir: true, dev: s.dev, ino: s.ino })
  }
  /** Open `p` for a new file (exclusive, no-follow, owner-only) and check it landed at `p`. */
  async function openOwn(p, parent) {
    if (!(await sameParent(parent))) throw changed(parent)
    const fh = await fsp.open(p, WRITE_FLAGS, 0o600)
    try {
      const s = await fh.stat()
      const entry = { p, parent, isDir: false, dev: s.dev, ino: s.ino }
      // A parent swapped between the check and the open put the file elsewhere: not recorded (the cleanup would
      // look for it at `p`, where it is not), and the export stops.
      if (!(await sameParent(parent)) || !(await sameEntry(p, entry))) throw changed(p)
      created.push(entry)
      return { fh, entry }
    } catch (err) {
      await fh.close().catch(() => {})
      throw err
    }
  }
  /** After a write: the file at `p` is still the one written, in the same folder. */
  async function checkOwn(entry) {
    if (!(await sameParent(entry.parent)) || !(await sameEntry(entry.p, entry))) throw changed(entry.p)
  }
  async function writeOwn(p, parent, text) {
    const { fh, entry } = await openOwn(p, parent)
    try {
      await fh.writeFile(text, 'utf8')
    } finally {
      await fh.close()
    }
    await checkOwn(entry)
  }

  try {
    await fsp.mkdir(folder, 0o700)
  } catch (err) {
    if (err && err.code === 'EEXIST') throw new Error(`${folder} already exists: export into a new folder (wait a minute, or name another --export folder)`)
    throw err
  }
  {
    const s = await fsp.lstat(folder)
    if (!s.isDirectory()) throw changed(folder)
    created.push({ p: folder, parent: base, isDir: true, dev: s.dev, ino: s.ino })
  }

  try {
    // docs/: as stored, `shared/...` and `members/<name>/...`. The folders are made one level at a time under our
    // own new folder; a name we made already is fine, anything else (a symlink, a file) is refused by mkdir.
    const docsDir = path.join(folder, 'docs')
    await mkdirOwn(docsDir, folder)
    const made = new Set()
    for (const d of docs) {
      const parts = checkDocPath(d.path)
      let at2 = docsDir
      for (const part of parts.slice(0, -1)) {
        const parent = at2
        at2 = path.join(at2, part)
        if (made.has(at2)) continue
        await mkdirOwn(at2, parent)
        made.add(at2)
      }
      checkTime()
      const text = await ctx.rooms.docs.get(roomId, d.path)
      await writeOwn(path.join(at2, parts[parts.length - 1]), at2, text)
    }

    // log.jsonl: the log paged from the start to the stats' cursor (`logUntil`; to the end when there is none). One
    // cursor for both files rather than holding the room's sends: the export cannot pause members, and blocking their
    // sends for its length would be worse than a closing note that later entries are in neither.
    const logUntil = Number.isInteger(stats.logSeq) ? stats.logSeq : undefined
    const { fh, entry } = await openOwn(path.join(folder, 'log.jsonl'), folder)
    try {
      let since = 0
      for (let page = 0; page < LOG_PAGES_MAX; page++) {
        if (logUntil !== undefined && since >= logUntil) break
        checkTime()
        const { entries, more } = await ctx.rooms.log(roomId, { since })
        const kept = logUntil === undefined ? entries : entries.filter((e) => e && Number.isInteger(e.seq) && e.seq <= logUntil)
        if (kept.length) await fh.writeFile(kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
        const last = entries.length ? entries[entries.length - 1].seq : since
        // A page that does not move the cursor would loop for ever: stop there.
        if (!more || !Number.isInteger(last) || last <= since) break
        since = last
      }
    } finally {
      await fh.close()
    }
    await checkOwn(entry)

    await writeOwn(path.join(folder, 'metrics.json'), folder, JSON.stringify({ exportedAt: at, ...stats }, null, 2) + '\n')
    await writeOwn(path.join(folder, 'metrics.md'), folder, metricsMarkdown(stats, at))
    await writeOwn(path.join(folder, 'questions.md'), folder, questionsMarkdown(rec, stats))
    // The last Rooms call and the writes took time too: an export that ran out here is not one the caller still
    // waits for, so it is removed like any failed one and the room keeps running.
    checkTime()
  } catch (err) {
    // Remove only what this export created, newest first, and only while it is still that entry in that folder; a
    // folder that is not empty then (something else wrote into it meanwhile) stays, and so does the rest above it.
    for (const entry of created.reverse()) {
      try {
        if (!(await sameParent(entry.parent)) || !(await sameEntry(entry.p, entry))) {
          ctx.log.warn(`team export: not removing ${entry.p}: it changed during the export`)
          continue
        }
        if (entry.isDir) await fsp.rmdir(entry.p)
        else await fsp.unlink(entry.p)
      } catch (e) {
        ctx.log.warn(`team export: cleaning up ${entry.p}: ${e && e.message}`)
      }
    }
    throw err
  }
  return folder
}

/**
 * End and Delete for the `ccc team` handler and the panel (one instance in the host: the per-team lock lives here).
 * `metrics` (optional) gives the stats with the running intervals credited and is polled after an end or a delete.
 */
function createEnding(ctx, teams, metrics, opts = {}) {
  const now = opts.now || Date.now
  const busy = new Set()

  /** The `exportDir` setting as a folder path, or null when empty. `~/` is the home folder; relative is the project's. */
  function settingDir() {
    const v = ctx.settings && ctx.settings.app && ctx.settings.app.exportDir
    if (typeof v !== 'string' || v.trim() === '') return null
    const s = v.trim()
    if (s === '~') return os.homedir()
    if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2))
    return path.resolve(ctx.projectDir, s)
  }

  async function withLock(roomId, fn) {
    if (busy.has(roomId)) throw new TeamError('busy', 'the team is already being ended or deleted')
    busy.add(roomId)
    try {
      return await fn()
    } finally {
      busy.delete(roomId)
    }
  }

  const api = {
    settingDir,

    /**
     * Export (to `dir`, else the setting, else no export), then end the room. Returns `{ folder }` (undefined when
     * nothing was exported). A failed export ends nothing. `budgetMs` bounds the export and `signal` cancels it: the
     * CLI passes both, since a `ccc` call is cut at 30 s (exit 124) while the handler would go on and end the room
     * unseen; the panel has no such cut and passes neither. The budget is absolute, from the call's start (the
     * metrics catch-up and the lookups count), and both are checked once more right before `rooms.end`.
     */
    async endTeam(roomId, { dir, budgetMs, signal } = {}) {
      const deadline = budgetMs !== undefined ? now() + budgetMs : undefined
      // The team is held from here to the end of this call, failed or not (teams.js createTeamGuard): a reply, a Done,
      // an ask, a mark, a hire or a fire starting meanwhile is refused, so the catch-up, the snapshot and `rooms.end`
      // below read a team the plugin no longer changes. Members' own sends go on: the one log cursor covers those.
      return withLock(roomId, () => teams.guard.exclusive(roomId, (settled) => endHeld(roomId, { dir, deadline, signal }, settled)))
    },

    /** Delete an ended team: its room (docs and log) through Rooms, then its record. */
    async deleteTeam(roomId) {
      return withLock(roomId, async () => {
        await teams.refresh()
        const rec = await teams.get(roomId)
        if (!rec) throw new TeamError('no-team', 'no such team')
        if (rec.endedAt === undefined) throw new TeamError('live', 'only an ended team can be deleted: end it first')
        // A start that failed is deciding whether this room is its own to delete (teams.js abandonStart): never both.
        if (teams.guard.starting(roomId)) throw new TeamError('starting', STARTING)
        await ctx.rooms.delete(roomId)
        await teams.remove(roomId)
        if (metrics) metrics.poll()
        return { title: rec.title }
      })
    },
  }

  /** endTeam's body, with the team held. `settled` (the guard's) waits for the changes that started before the hold. */
  async function endHeld(roomId, { dir, deadline, signal }, settled) {
    // A change that started before the hold (a reply waiting on its send) finishes, or fails, before anything is
    // read: one landing after the catch-up marked a question answered with its answer past the log cursor. Each is
    // bounded by its own host calls; a cancel stops the wait (the team then keeps running).
    try {
      await untilAborted(settled(), signal)
      checkBudget(deadline, signal, now)
    } catch (err) {
      throw new TeamError('cancelled', err.message)
    }
    await teams.refresh()
    const rec = await teams.get(roomId)
    if (!rec) throw new TeamError('no-team', 'no such team')
    if (rec.endedAt !== undefined) throw new TeamError('ended', 'the team has already ended')
    const target = dir !== undefined ? dir : settingDir()
    let folder
    if (target) {
      // The log read to its end first: the metrics lag the room by up to a poll (5 s), so a message sent just
      // before the end would be in the log and not the counts. A failing log read there is a failure of the
      // export (the team keeps running): stats short of the log are not exported.
      // The catch-up reads the whole backlog (a poll alone reads at most 20 pages a team): it counts against the
      // budget, checked between its rounds, and a cancel stops the wait for it.
      try {
        if (metrics) await untilAborted(metrics.catchUp(roomId, () => checkBudget(deadline, signal, now)), signal)
        const at = now()
        // The stats as if the team ended now: its last span runs to "end" (the room ends right after). With them
        // the log cursor they were taken at, where log.jsonl stops, and a copy of the record as of the same
        // instant for questions.md (the room is live until rooms.end below, but the team is held: the plugin changes
        // nothing of it now, and a member's send after the cursor is in neither file).
        const snap = metrics
          ? await metrics.exportSnapshot(roomId, { endAt: at })
          : { stats: statsOf({ ...rec, endedAt: at }, at), rec: structuredClone(rec) }
        folder = await exportTeam(ctx, { rec: snap.rec, stats: snap.stats, dir: target, at, deadline, signal, now })
      } catch (err) {
        throw new TeamError('export-failed', `export failed, the team is still running: ${(err && err.message) || err}`)
      }
    }
    // The last check before the one step that cannot be undone. A folder written just before a cancel stays (it
    // is a complete export) and is named.
    try {
      checkBudget(deadline, signal, now)
    } catch (err) {
      throw new TeamError('cancelled', `${err.message}${folder ? `\n(the export was written to ${folder})` : ''}`)
    }
    try {
      await ctx.rooms.end(roomId)
    } catch (err) {
      if (folder) throw new TeamError('end-failed', `${err.message}\n(the export was written to ${folder})`)
      throw err
    }
    // The record takes the room's endedAt from Rooms (one source of the time); a storage failure there is logged
    // and retried by the next reconcile, it does not undo an end that happened. Memory takes it either way (teams.js
    // reconcile): a refresh that failed outright leaves a provisional time (`teams.ended`) that the next reconcile
    // replaces with Rooms', so the record never stays live once Rooms ended the room: a change waiting on a host call
    // through this End checks `live` after it and is refused (THE RULE, teams.js createTeamGuard).
    try {
      await teams.refresh()
    } catch (err) {
      ctx.log.warn(`team end: refreshing the record: ${err && err.message}`)
    }
    await teams.ended(roomId, now())
    // The last log drain and the closing of the members' intervals.
    if (metrics) metrics.poll()
    return { folder, title: rec.title }
  }

  return api
}

module.exports = { exportTeam, createEnding, checkDocPath, docClash, slugOf, stampOf }
