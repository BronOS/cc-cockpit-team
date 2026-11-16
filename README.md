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

- `start` (a Claude tab in no room) makes the team and prints a coordinator invite to run with `ccc room join <code>`.
- `hire`, `invite`, `fire`, `mark`, `end` are for coordinators; `ask`, `list`, `stats` for any member. The caller is
  known by main from its tab, never from an argument; a tab outside a team gets the same refusal for all but `start`
  and `help`.
- A kickoff is a UTF-8 text file of at most 256 KiB (no symlink, not empty, no control, bidi or invisible
  characters). It is stored as the room doc `members/<name>/kickoff.md`, and the new tab's first prompt only says to
  read it.
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
never did), time working, waiting for input and idle, messages sent and received, doc reads and writes, and why a
member left. Marks cut the team's time into spans, with cost and time per span. A paused room and a closed app count as
no working time. Your active time is a proxy (question to reply, plus a fixed window per panel action).

## Export

`ccc team end --export <dir>`, or the "Export folder" setting (`~/` and a project-relative folder are accepted), writes
a new folder `<dir>/<team-slug>-<yyyymmdd-hhmm>/` before the room ends: `docs/`, `log.jsonl`, `metrics.json`,
`metrics.md`, `questions.md`. An existing folder is refused, files are never written through a symlink, files are 0600
and folders 0700, and a failed export leaves the team running. From `ccc` the export has 20 s (a `ccc` call is cut at
30 s); a team too big for that is ended from the panel.

## Limits

- Not a boundary: `hire --kickoff` reads, and `end --export` writes, any path the calling tab names. A coordinator is
  a Claude tab of the same OS user, which can do that anyway.
- A question is at most 20000 characters; a team keeps at most 50 open questions and 100000 characters waiting;
  closed questions are shortened and eventually dropped from the record. Marks: 200 per team, label one line of at most
  200 characters.
- Question answers are not stored by the plugin (only when they were answered); the answer text is in the room log.
- Time is measured from polls (about 5 s) and checkpoints (60 s): an app crash can lose about a minute.

## Not verified

Written against the Rooms API of cc-cockpit 0.19.1 and its source, with a fake `ctx` in the tests. It has not been run
against the live app beyond loading (`ccc plugin list` shows it ok, `ccc team help` answers). The room log's field
names the metrics read (`send`, `join`, `leave`, `doc-read`, `doc-write`, `end` and their members) come from the
source and may not match every entry in practice; the panel, a real ask and reply, the export folder and a restart
with a paused room have not been tried.

Design: `docs/design.md`.

```
npm test
```
