# Team

A cc-cockpit plugin (`bronos.team`) for running a team of Claude tabs on core Rooms. Needs cc-cockpit 0.19.1 or newer
(Rooms, and the room caps as settings). An older app answers `ccc team` with an update message.

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
hire <name> --kickoff <file> [--model m] [--effort e] [--cwd dir] [--coordinator]
invite <name> [--coordinator]
fire <name>
ask "<question>"   |   ask -
mark "<label>"
list [--json]   stats [--json]
end [--export <dir>]
help
```

- `start` (a Claude tab in no room) makes the team and prints a coordinator invite to run with `ccc room join <code>`;
  a second `start` before the tab joined prints the invite of the room already started again. The coordinator's tab is
  the one you type in, and Rooms never pastes messages into such a tab: members' reports wait, held (the badge on its
  tab), until the coordinator runs `ccc room read`, which the skill tells it to do when it expects answers. Members
  should not expect an immediate reaction.
- `fire` removes a member from the room; its tab stays open.
- `end` ends the room and closes the tabs the hire opened (app 0.22.0 and later); a coordinator's tab, an invited tab and a tab you typed in stay.
- A hired member opens as a split pane beside the coordinator's tab. Default layout "column": the coordinator on the
  left, the members stacked on the right in hire order, each below the previous one, as many as the app's pane limit
  allows. Every new pane halves its anchor, so the heights are uneven; drag the dividers. The setting "Layout of hired members" also
  offers "grid" (a 2x2: right, below, below the first) and "tabs" (no split panes). Members past the limit, or one the app cannot
  place, open as plain tabs. `hire` prints which it was.
- `hire`, `invite`, `fire`, `mark`, `end` are for coordinators; `ask`, `list`, `stats` for any member. The caller is
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

Teams list and a team page: members with status, cost and a menu (focus tab, fire, copy invite); open questions with
Reply and Done; Hire, Mark, Copy invite, End and Delete; and the team's activity (the room log, filtered by member and
kind) and docs, shown when opened. New team takes a title, an optional lead kickoff file, model, effort and folder.
Destructive steps ask in the page.

## Metrics

Raw facts per member: model and effort, cost in USD and context percent as Claude Code reports them (unknown when it
never did; a member that joined with an invite, such as the coordinator, counts from its join, not from its session's
earlier total), time working, waiting for input and idle, messages sent, received and held (queued until the member
reads them; Rooms does not log the later read), doc reads and writes, and why a member left. Marks cut the team's time into spans, with cost and time per span. A paused room and a closed app count as
no working time. Your active time is a proxy (question to reply, plus a fixed window per panel action).

## Export

`ccc team end --export <dir>`, or the "Export folder" setting (`~/` and a project-relative folder are accepted), writes
a new folder `<dir>/<team-slug>-<yyyymmdd-hhmm>/` before the room ends: `docs/`, `log.jsonl`, `metrics.json`,
`metrics.md`, `questions.md`. The log and the metrics cover the same entries, up to the one the stats were taken at
(`logSeq` in `metrics.json`); what the room logs after that (a message sent while the export runs, the closing `end`
entry and the members leaving with it) is in neither. While a team is exported and ended, the plugin's own changes to it
(reply, Done, ask, mark, hire, fire, invite) are refused with "try again in a moment". An existing folder is refused, files are never written through a symlink, files are 0600
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
- Question answers are not stored by the plugin (only when they were answered); the answer text is in the room log.
- A team being started (`ccc team start`, New team) takes no other change until its invite or its lead's tab is made
  ("the team is still being set up"). A start that fails deletes its new room, unless something else joined or changed
  it meanwhile: then the room is kept and the error says so.
- Rooms keeps only 50 ended rooms: Delete a finished team to free one. The room caps default to 5 rooms per project
  and 20 members per room; change them in Settings > General > Plugin limits.
- Time is measured from polls (about 5 s) and checkpoints (60 s): an app crash can lose about a minute.

## Not verified

Note: `dist/host.js` is hand-maintained source (there is no build step), not a bundle.

Written against the Rooms API of cc-cockpit 0.19.1 and its source, with a fake `ctx` in the tests. It has not been run
against the live app beyond loading (`ccc plugin list` shows it ok, `ccc team help` answers). The room log's field
names the metrics read (`send`, `join`, `leave`, `doc-read`, `doc-write`, `end` and their members) come from the
source and may not match every entry in practice; the panel, a real ask and reply, the export folder and a restart
with a paused room have not been tried. The panel page is tested against a hand-made DOM stub only, never in a real
browser: focus, scroll and selection kept across a state, `<details>`, `<select>` and the clipboard, and the page under
the app's CSP are unchecked, and so is `ccc plugin link`'s manifest check (the fields were checked by hand). The fake
`ctx` is the tests' only picture of Rooms: refusal texts and log fields beyond `seq`, `at` and `type` are read from
the source, not from a running app.

Design: `docs/design.md`.

```
npm test
```
