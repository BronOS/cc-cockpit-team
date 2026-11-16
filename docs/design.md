# Team: a cc-cockpit plugin for running a team of Claude tabs (design)

Status: revision 1 (2026-11-15), from a brainstorm with Oleg. Successor of the experimental `bronos.team` in
`~/Projects/team-experiment` (run 001), rebuilt on cc-cockpit core Rooms (`docs/design-rooms.md` in cc-cockpit).

## 0. Purpose and the one rule

The plugin is a **tool**: it lets a person, or a lead Claude, start a team (one Rooms room), hire members as Claude tabs,
hear their questions, watch them, measure them and export the result. It is **not a flow**: no lead or member skills, no
roles, no personas, no phases (shape, plan, build), no review loops, no Jev, no codex. Every developer and company has its
own flow; the plugin must not ship one or pretend to cover one. A flow lives in the user's own skills and files and
drives the tool through `ccc team` and `ccc room`.

The test for every feature: **does every flow need it, whatever the flow?** Yes: tool, it goes here. It encodes how one
person works: flow, it stays out. A reviewer is a member whose kickoff says "run codex"; a persona is text in a kickoff
file; a phase is a mark. The tool never looks inside a kickoff.

Decisions taken in the brainstorm:
- Generic, public marketplace plugin; Oleg's flow (`LEAD.md`, `PROTOCOL.md`, the agency-agents catalog) becomes his
  own skills on top of it.
- Everything in v1: lifecycle, panel, metrics, export.
- Worktrees are flow: `--cwd` only; the flow makes its worktrees with git.
- The room caps become the person's setting (core change, §6), for as much flexibility as possible.

## 1. Shape

Repo `~/Projects/cc-cockpit-team` (GitHub `BronOS/cc-cockpit-team`), id `bronos.team`, MIT. A plugin host
(`dist/host.js`, plain JavaScript like the reviewer and files plugins), one panel (`panels/team.html`), one CLI command
(`ccc team`), one reference skill (`team-tool`: what `ccc team` does, never how to run a team). Public API only:
`ctx.rooms`, `ctx.sessions`, `ctx.cli`, `ctx.panels`, `ctx.storage`, `ctx.notify`, settings. Needs cc-cockpit 0.19.1 (the
caps of §6 are in the 0.19.0 tag, whose release failed; first released as 0.19.1).

A **team is one room** of this plugin in this window. The plugin's own record per team (in `ctx.storage`, per project):
`{ roomId, title, createdAt, endedAt?, exportDir?, marks[], questions[], metrics }`. Messages, docs, membership and the
log stay in Rooms, where main enforces every rule. The old experimental plugin of the same id is unlinked first.

## 2. Lifecycle (`ccc team`)

| Command | Who | What |
|---|---|---|
| `start "<title>" [--as <name>]` | a Claude tab in no room | creates the room, prints a coordinator invite for `<name>` (default `lead`) and the `ccc room join <code>` line to run; refused for a tab already in a room |
| `hire <name> --kickoff <file> [--model m] [--effort e] [--cwd dir] [--coordinator]` | coordinator | stores the file as `members/<name>/kickoff.md`, opens the tab in the room with one fixed prompt: read your kickoff with `ccc room doc get members/<name>/kickoff.md` |
| `invite <name> [--coordinator]` | coordinator | a one-time code for an existing tab to `ccc room join` |
| `fire <name>` | coordinator | removes the member; its tab stays |
| `ask "<question>"` / `-` | any member | a question to the person (§3); prints its id |
| `mark "<label>"` | coordinator | a timestamp on the team's timeline (§4) |
| `list [--json]`, `stats [--json]` | any member | the team, its members, the metrics |
| `end [--export <dir>]` | coordinator | exports (§5), then ends the room |
| `help` | anyone | usage |

- The caller is known from `CliCall.tabId` (set by main, never by the caller); "coordinator" is read from
  `ctx.rooms.members`, never from arguments. A tab not in one of this plugin's rooms gets the same answer for every
  team command but `start` and `help`. Unknown and foreign ids answer alike.
- The kickoff file is read by the host (Node) from a path resolved against the caller's cwd (CLI) or the project folder
  (panel); `--cwd` goes to `ctx.rooms.open`, which applies its own checks. A name already in the team is refused before
  anything is written; a failed open removes the seeded kickoff doc. The kickoff is refused
  before any tab opens when missing, over 256 KiB, not UTF-8 text or with characters Rooms refuses. The tool does not
  read its meaning.
- From the panel: **New team** (title, optional lead kickoff file, model, effort, cwd) opens a fresh lead tab as
  coordinator through `ctx.rooms.open` (no invite step); **Hire…** is the same form as `hire`.
- Caps are Rooms' and the person's limits: rooms per project, members per room, hires a minute (`opensPerMinute`). A
  Rooms refusal is passed through in Rooms' own words (it names the limit; once the app carries §6, also where to
  change it).

## 3. Questions to the person

A member cannot send to `person` in Rooms (reserved name). `ccc team ask` is the tool's way: the plugin records
`{ id, from, text, askedAt }` on the team, shows it in the panel's **Waiting on you** and raises a notice
(`ctx.notify`). The person answers in the panel: **Reply** sends the text to that member as a room message from the
plugin, prefixed `Answer to your question <id>:`; **Done** closes it without a reply. Text limits are Rooms' message
limits (a reply's prefix counts). The answer time is recorded (§4).

The record is one storage value (1 MiB), so a team holds at most 50 open questions of 100,000 characters in all (an
answer or a Done frees a place); closed questions never cause a refusal, they are compacted on a later ask (the oldest
first cut to a one-line glance, marked `trimmed`, then dropped past 300 questions). A reply goes to the tab that asked:
a member of the same name hired after a fire answers "left the team". That tab is known in memory only (restored tabs
get new ids), so after a restart the reply goes by name. From the membership check to the send the reply holds the
asker's name: the plugin's own fire and hire of that name are refused meanwhile ("an answer to <name> is being sent"),
so a fire and rehire cannot take the answer; a removal from core's room view or a join by invite code does not go
through the plugin and is not covered. Done is refused while a reply is being sent, and on an ended team (read-only:
the panel shows its open questions without Reply or Done). Lengths are counted as Rooms counts them, in characters
(code points: an emoji is one).

## 4. Metrics (raw facts only)

Per member: hired / left (with why: fired, tab closed, team ended, left), model and effort, cost USD and context % (from
`ctx.sessions`, the status line's `costUsd` / `contextPercent`), time working / waiting for input / idle (from status
changes, `ctx.sessions.onChange`), messages sent and received, doc reads and writes (from the room log via
`ctx.rooms.log` with a `seq` cursor), questions asked and the person's answer time.

Per team: start, end, total cost, sum of member working time, the person's active time (question to reply, plus panel
actions; a proxy, said so in the panel and export). **Marks** (`mark`, or the panel's Mark button) split cost and time
into spans; what a mark means is the flow's. A mark label cannot be `start`, `now` or `end` (the spans' fixed ends).

Kept in the team record, updated on status changes and log polls; shown live in the panel and by `stats`. Cost covers
the members' tabs only (a member's subagents are in its tab's cost; work outside the team's tabs is not counted). Time
between an app quit and the person's resume is not counted as working. The record keeps the newest 300 closed questions
and 500 panel actions; what falls out is folded into stored counters first, so no total goes down as a team goes on.
Every stored per-team value is bounded the same way (the record is one 1 MiB value): questions as in §3, 200 marks of
at most 200 characters, 500 panel actions, 200 uncounted-gap entries, and **former members**: the record keeps a row for
every current member and for the 50 that left most recently (`FORMER_MAX`, `lib/stats.js`); the ones that left longer
ago are folded into one stored counter set (`metrics.folded.former`), so the totals (and the marks' span numbers) stay
whole, `stats` and `metrics.md` say how many rows were folded, and only a name hired again after being folded starts a
new row (its earlier numbers are in the totals). The log state is a cursor and a flag.

## 5. End and export

`end [--export <dir>]` (coordinator) or the panel's **End and export**. The export goes into a **new** folder
`<dir>/<team-slug>-<yyyymmdd-hhmm>/`, made with an exclusive create, never into an existing one:
`docs/` (the room's docs as stored, `shared/` and `members/<name>/`), `log.jsonl` (the room log, paged through to the
end), `metrics.json`, `metrics.md` (a table, split at marks), `questions.md`. Without `--export` the plugin setting
"Export folder" is used (empty by default: no export). Paths come from Rooms (already restricted to `[A-Za-z0-9._-]`,
depth 4) and are checked again before writing; files are written with no-follow, never through a symlink, and every
folder of the export is checked by realpath before each write and each cleanup removal (a folder swapped for a link
stops the export, and the cleanup removes nothing through it). Files are 0600 and folders 0700 (members' private docs,
message texts). Before the stats are taken the metrics read the room log to its end, however long the backlog (a poll
reads at most 20 pages a team); a log read failing there fails the export (the team keeps running). From the start of
an End to its finish (success or failure) the team is held: the plugin's own changes to it (a reply, a Done, an ask, a
mark, a hire, a fire, an invite, from `ccc team` or the panel) are refused with "the team is being exported and ended:
try again in a moment", and the ones already running finish before the catch-up starts, so the stats, `log.jsonl` and
`questions.md` see a team the plugin no longer changes (the panel's active-time count is skipped meanwhile). Members'
own sends through Rooms are not the plugin's to hold: the room is live
while the export runs, so `log.jsonl` stops at the log entry the stats were taken at (`logSeq` in `metrics.json`,
named in `metrics.md`): both files cover the same entries, and what the room logged after that, before its end, is in
neither (it stays in the room's log until Delete). `ccc team end` gives the export 20 s
from the call's start (that catch-up included), inside the 30 s cut
of a `ccc` call, so a too-big team fails and keeps running instead of ending unseen after exit 124; the budget and the
call's abort signal are checked once more right before `rooms.end`. The panel has no budget.

**The rule for every change** (hire, fire, invite, ask, reply, Done, mark, End, Delete, and the panel's actions, which
go through the same functions): a change decides **all** its preconditions inside its guard (and its name lock when it
takes one), after its last await and right before its write: the team is live and still the same record (after a
refresh, so a room ended from core's room view counts), the member it acts for or on is (or is not, for a hire) in main's
member list as read there, the question is still open, and the team is not being exported (the guard's entry). A check
made before an await (`requireMember`, the panel's team lookup, a member list the caller read) is a fast path for a
quick refusal only: an End can finish, a hire or a fire can land, while a change waits on a host call, and the hold of
an End that already finished protects nothing (`createTeamGuard` in `lib/teams.js` states the rule where the guard is
defined). Who the caller is (a member, a coordinator) is decided at the call's start, like any request's
authorization; `ask` and a coordinator's `mark`, which write the caller's name into the record, check it again inside,
holding that name from the member read to the save. Every change that acts for or on a member name holds the name's
lock (`createNameLocks`): hire and fire alone; reply, ask and mark together (each only needs the member to stay), so a
fire of an asker, of a marking coordinator or of a member an answer is on its way to is refused ("try again in a
moment"), and the hire or fire of a name refuses them. Locks are taken in one order: the export guard, then the name
lock inside it. Done acts on a question, not a name, and takes none. What a member
or the person does through Rooms itself (a removal from core's room view, a join by invite code) can still land between
the plugin's last read and its write: Rooms refuses that write by its own rules (an ended room takes no open, invite,
send or remove).

**A team being set up** (`ccc team start`, the panel's New team) is held by the same guard (`guard.setup`) from the
moment `rooms.create` answers to the coordinator's invite or the lead's open, or to the cleanup of a start that failed:
every other change (hire, fire, invite, ask, reply, Done, mark, End, Delete) is refused with "the team is still being set
up: try again in a moment", and only the setup's own hire passes (its token). A start that fails ends and deletes its
room only while the room is still as the start left it: the room log holds nothing but the `create`, the start's own
invite of its coordinator name and the plugin's writes of that name's kickoff doc, read before `rooms.end` and again
after it (an ended room changes no more, so the second read decides). Anything else (a join or a change from core's
room view) keeps the room, and the error says it was kept: a panel Hire landing before start's invite once made that
invite fail and the cleanup delete the populated team, docs and log (review round 10).

An ended team stays in the panel, read-only, until **Delete** (`ctx.rooms.delete`; Rooms keeps 50 ended rooms).

## 6. Core change (cc-cockpit 0.19.1; tagged 0.19.0, whose release failed)

- Two more plugin limits beside `opensPerMinute` and the send caps (`src/shared/plugin-limits.ts`, global value plus
  per-plugin override, hard ceiling): `roomsPerProject` (default 5, ceiling 20) and `membersPerRoom` (default 20,
  ceiling 50), read by the room registry on every create, open and join instead of the constants. The storage caps
  (waiting messages, doc and room sizes, ended rooms kept, invites) stay fixed: they protect the app.
- Doc drift: `ctx.rooms.send`'s SDK comment and the guide name "Settings > Plugins > Limits" only; add the global
  values (Settings > General > Plugin limits).
- Guide and features docs for both; the example plugin's types copy.

## 7. Panel

One panel, "Team", per window; state always marked with an icon or a word, never by colour alone.
- **Teams**: title, member count, a waiting-on-you count, "ended" / "paused" as text.
- **Members** of the selected team: name (★ coordinator), status (icon + word: working, waiting, idle, closed), the
  current tool, model / effort, cost and context %, messages waiting. A click focuses the tab; the row menu: Fire, Copy
  invite.
- **Waiting on you**: §3's questions with Reply and Done.
- **Activity**: the room log newest first, marks included, filterable by member and by kind.
- **Docs**: the list; a click shows the doc read-only in the panel (`ctx.rooms.docs.get`; there is no API to open
  core's room view, which the person reaches from the tab strip).
- Actions: New team, Hire…, Mark, End and export, Delete (ended teams).
Core's room view (messages, docs, remove, pause and resume) is not duplicated.
What the page has open for a team (a member menu, a form or confirm, a reply in flight) is bound to that team: any
change of the selection (a click, the auto-select after the team is deleted or ended elsewhere) closes the menu and the
forms, and every request names the room it was opened for, which the backend checks again (never the view's selection).

## 8. Restart, failures, security

- The team records in memory follow Rooms, never storage: Rooms' state (a room ended, renamed, adopted or gone) and the
  plugin's own changes are in memory first, then written; a failed write (the store's size limits) is logged and written
  again by the next reconcile, so a full store never shows an ended team as live or keeps Delete from it. An End takes
  Rooms' end time in its refresh, or a provisional one when that refresh fails, replaced by Rooms' on the next.
- Team records survive restarts; Rooms restores members paused, the panel says so and resuming is the person's (core's
  room view). Metrics resume; the paused gap is not working time.
- A member's text (questions, log entries, doc names) is untrusted: the panel renders it as text, never HTML; `ask`
  text is capped by Rooms' message rules before it is stored.
- `hire --kickoff` reads, and `end --export` writes, any path the calling tab names. That is not a boundary and is
  documented as such: a coordinator is a Claude tab of the same OS user, which can read and write those files anyway.
  The panel's paths (New team's and Hire's kickoff and folder, End's export folder) are the same from the desktop
  window; from a web access browser view (another device the person paired) they must be inside the project folder by
  their real path, as the app's own `ctx.files` actions for such a view.
- The tool never reads or acts on a kickoff's meaning, never runs commands for members, and never widens what Rooms
  allows: identities, docs access and caps are main's.

## 9. Testing and rollout

- `node:test` suites against a fake `ctx` (rooms, sessions, cli, storage): every command's coordinator check, kickoff
  validation, ask and reply, marks and span math, export into a new folder (refusing an existing one, a symlink),
  restart of records and metrics.
- An e2e in cc-cockpit with the plugin linked: start, hire two members, ask, reply, mark, end with export; the folder
  checked.
- Order: (1) the core change (§6) on its own branch and app release; (2) this plugin, released and listed in the
  marketplace with "Needs cc-cockpit <that version>"; (3) Oleg's flow in `~/Projects/team-experiment` moves to his own
  skills on `ccc team`, and the old experimental plugin is retired.
