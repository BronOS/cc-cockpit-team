# Team

A cc-cockpit plugin (`bronos.team`) for running a team of Claude tabs on core Rooms. Needs cc-cockpit 0.22.0 or newer
for everything it does: Rooms (0.19.1; an older app answers `ccc team` with an update message), members as split panes
beside the coordinator (0.20.0, 0.21.2 for a tall column) and End closing the hired members' tabs (0.22.0). On an app
between 0.19.1 and 0.22.0 it still runs, with members in plain tabs and their tabs left open.

It is a **tool, not a flow**. It starts a team (one room), hires members as Claude tabs from a kickoff file, takes
their questions to you, measures cost and time, and exports the result. It has no roles, personas, phases or review
loops, and it never reads what a kickoff says: how the work is done is yours, in your own skills and kickoff files,
driving the tool through `ccc team` and `ccc room`.

## Install

Install from the cc-cockpit Plugins page (marketplace), or from a checkout: `ccc plugin link <path to this repo>`.
If the experimental plugin of the same id (`bronos.team`) is linked, unlink it first: `ccc plugin unlink bronos.team`.

## Commands (`ccc team`)

```
start "<title>" [--as <name>]
hire <name> --kickoff <file> [--model m] [--effort e] [--cwd dir] [--env NAME=value]... [--coordinator]
invite <name> [--coordinator]
fire <name>
ask "<question>"   |   ask -
mark "<label>"
star <name> "<reason>"
list [--json]   stats [--json]
end [--export <dir>]
help
```

- `start` (a Claude tab in no room) makes the team and prints a coordinator invite to run with `ccc room join <code>`;
  a second `start` before the tab joined prints the invite of the room already started again. The coordinator's tab is
  the one you type in, and Rooms never pastes messages into such a tab: members' reports wait, held (the badge on its
  tab), until the coordinator runs `ccc room read`, which the skill tells it to do when it expects answers. Members
  should not expect an immediate reaction.
- `fire` removes a member from the room and closes the tab its hire opened (cc-cockpit 0.24.0; a tab you typed in, a coordinator's and an invited member's stay open, and so does every tab on an older app).
- `end` ends the room and closes the tabs the hire opened (app 0.22.0 and later); a coordinator's tab, an invited tab and a tab you typed in stay.
- A hired member opens as a split pane beside the coordinator's tab. Default layout "column": the coordinator on the
  left, the members stacked on the right in hire order, each below the previous one, as many as the app's pane limit
  allows. Every new pane halves its anchor, so the heights are uneven; drag the dividers. The setting "Layout of hired members" also
  offers "grid" (a 2x2: right, below, below the first) and "tabs" (no split panes). Members past the limit, or one the app cannot
  place, open as plain tabs. `hire` prints which it was.
- `star` gives a member the person's star for good work (the lead runs it when you say so): the member gets a room
  message `The person gave you a star: <reason> (recorded by <lead>)`, and the star is kept with the member's settings
  at that moment (coordinator or member, model, effort, Code Mode). A member can get several; a name not in the team
  now is refused, and a star the member could not be sent is not kept. The Team panel shows a badge with the count
  beside the member (✦ 2), the reasons in its tooltip; a fired member keeps its stars. The export lists them (below).
- `hire`, `invite`, `fire`, `mark`, `star`, `end` are for coordinators; `ask`, `list`, `stats` for any member. The caller is
  known by main from its tab, never from an argument; a tab outside a team gets the same refusal for all but `start`
  and `help`.
- A kickoff is a UTF-8 text file of at most 256 KiB (no symlink, not empty, no control, bidi or invisible
  characters). It is stored as the room doc `members/<name>/kickoff.md`, and its text is also the new tab's first
  prompt, under a short header naming the team, the member, its role (coordinator or member) and that doc. In the
  prompt, not only in the doc: the prompt is the tab's first user message, while a doc read with `ccc room doc get`
  arrives as tool output, which Claude Code's auto mode treats as data rather than your instructions (a member told only
  to read its kickoff had its first step denied as unsanctioned). A kickoff over 40 000 characters is cut in the prompt
  with a last line saying the rest is in the doc and must be read before starting; the doc always has all of it.
- `ask` is how a member reaches you: it records the question, raises a notice, and prints its id. Your reply arrives in
  the member's room as a message from the plugin starting `Answer to your question <id>:`.
- Refusals from Rooms (name, send rate, member and room caps) are printed in Rooms' own words. The caps are settings
  in cc-cockpit.

`skills/team-tool/SKILL.md` is the reference Claude loads: what each command does and refuses, never how to run a team.

## The Team panel

A row of team chips and a summary card (state, elapsed, cost, members, messages; Hire, Mark, Invite, End or Delete); open
questions as an alert block with a one-line answer (Enter sends) and Done; and tabs for Members (a state shape, cost, time,
context and held messages per member, a menu to focus the tab, fire or copy an invite), Activity (the room log, filtered by member and
kind), Docs and Numbers. New team (the + in the panel's title bar) takes a title, an optional lead kickoff file, model, effort and folder.
Destructive steps ask in the page.

## Guests

When the owner shows Team to guests they invited (cc-cockpit's guest invites; Settings > Plugins, hidden by default),
a guest's Team panel shows the teams, the selected team, its activity and its docs, and nothing to act with: every
action (New team, Hire, Mark, Invite, Fire, Show tab, reply, Done, End, Delete) is refused to a guest's view,
read-only or write, by the plugin's host from the app's word for that view. Stars have no panel action (only
`ccc team star`), so a guest sees the badges and gives none. The export folder setting is left out of
a guest's view. `ccc team` typed in a tab the owner shared with a write guest is the owner's command, like anything
typed there. An app without guests sends no access: every view is the owner's, as before.

## Metrics

Raw facts per member: model and effort, cost in USD and context percent as Claude Code reports them (unknown when it
never did; a member that joined with an invite, such as the coordinator, counts from its join, not from its session's
earlier total), time working, waiting for input and idle, messages sent, received and held (queued until the member
reads them; Rooms does not log the later read), doc reads and writes, and why a member left. Marks cut the team's time into spans, with cost and time per span. A paused room and a closed app count as
no working time. Your active time is a proxy (question to reply, plus a fixed window per panel action).

## Export

`ccc team end --export <dir>`, or the "Export folder" setting (`~/` and a project-relative folder are accepted), writes
a new folder `<dir>/<team-slug>-<yyyymmdd-hhmm>/` before the room ends: `docs/`, `log.jsonl`, `metrics.json`,
`metrics.md`, `questions.md`. `metrics.json` has `stars` (per starred member: coordinator or not, model, effort, Code
Mode as hired, and each star's reason, giver and time) and `metrics.md` a Stars table, for a retrospective. The log and the metrics cover the same entries, up to the one the stats were taken at
(`logSeq` in `metrics.json`); what the room logs after that (a message sent while the export runs, the closing `end`
entry and the members leaving with it) is in neither. While a team is exported and ended, the plugin's own changes to it
(reply, Done, ask, mark, star, hire, fire, invite) are refused with "try again in a moment". An existing folder is refused, files are never written through a symlink, files are 0600
and folders 0700, and a failed export leaves the team running. From `ccc` the export has 20 s from the call's start (a `ccc` call is cut at
30 s), and a cancelled call (Ctrl+C, the cut) never ends the team; a team too big for that is ended from the panel.

## Limits

- Not a boundary: `hire --kickoff` reads, and `end --export` writes, any path the calling tab names. A coordinator is
  a Claude tab of the same OS user, which can do that anyway. The panel in the desktop window may name any path too;
  the panel in a web access browser only paths inside the project folder (by real path), as the app's own file actions.
- A question is at most 20000 characters; a team keeps at most 50 open questions and 100000 characters waiting;
  closed questions are shortened and eventually dropped from the record. Marks: 200 per team, label one line of at most
  200 characters. A team's stats list every current member and the 50 that left most recently; older former members are
  folded into the totals (a count says how many), so a long-lived team's record stays small.
- Stars: 200 per team, a reason one line of at most 300 characters (plain text, no control, bidi or invisible
  characters).
- Question answers are not stored by the plugin (only when they were answered); the answer text is in the room log.
- A team being started (`ccc team start`, New team) takes no other change until its invite or its lead's tab is made
  ("the team is still being set up"). A start that fails deletes its new room, unless something else joined or changed
  it meanwhile: then the room is kept and the error says so.
- Rooms keeps only 50 ended rooms: Delete a finished team to free one. The room caps default to 5 rooms per project
  and 20 members per room; change them in Settings > General > Plugin limits.
- Time is measured from polls (about 5 s) and checkpoints (60 s): an app crash can lose about a minute.

## Not verified

Note: `dist/host.js` is hand-maintained source (there is no build step), not a bundle.

Tested with a fake `ctx` (the tests' picture of Rooms) and run live on cc-cockpit 0.22.0: starting a team, hiring
members as split panes (a column of six), questions asked and answered in the panel, End closing the hired members'
tabs, and a team left paused across an app restart. Not yet tried live: `ccc team star` (its room message, the panel's badge, the export's Stars table), the export folder and the metrics against a
long real room log (the log field names the metrics read come from the app's source).

Design: `docs/design.md`.

```
npm test
```
