---
name: team-tool
description: Use when asked to start, run or inspect a team of Claude tabs with the cc-cockpit Team plugin (ccc team), or when you are a member of such a team and need its commands.
---

# The Team tool (`ccc team`)

`ccc team` is a tool for a group of Claude tabs working in one cc-cockpit room (a team). It starts the team, opens
members from a kickoff file, takes their questions to the person, records cost and time, and exports the result. It
decides nothing about how the work is done: what a member is told, who does what and in what order is up to the person
and the kickoff files. Run `ccc team help` for the commands. Needs cc-cockpit 0.19.1.

## Commands

```
ccc team start "<title>" [--as <name>]
ccc team hire <name> --kickoff <file> [--model m] [--effort e] [--cwd dir] [--coordinator]
ccc team invite <name> [--coordinator]
ccc team fire <name>
ccc team ask "<question>"
ccc team ask -
ccc team mark "<label>"
ccc team list [--json]
ccc team stats [--json]
ccc team end [--export <dir>]
ccc team help
```

The caller is your own tab: main knows it, so there is no flag to say who you are. A tab that is not in a team gets
the same refusal for every command but `start` and `help`. A refusal from Rooms (a cap, a name, a rate) is printed in
Rooms' own words.

- `start` makes a team (one room) from a Claude tab that is in no room, and prints a coordinator invite for `<name>`
  (default `lead`) with the `ccc room join <code>` line to run. That tab is the one the person types in, and Rooms
  never pastes messages into a tab the person typed in: as coordinator, members' messages to you are held until you
  run `ccc room read`. Run it when you expect answers (after asking members for something, or when they should have
  reported); nothing will interrupt you with them. A second `start` from a tab that has not joined yet
  re-issues the invite for the room already started, with its old title and name.
- `hire` opens members as split panes beside your tab (you left, members stacked evenly on the right; the person's layout setting may differ) while the app places them: how many fit is the person's "Panes a plugin may fill in a group" limit (default 4 panes, your tab included) and the window's size. Past that a member opens as a plain tab. The output says which it was.
- `hire` (coordinator) stores the kickoff file as the doc `members/<name>/kickoff.md` and opens a new Claude tab in the
  team. The tab's first prompt is the kickoff text itself, under a short header naming the team, the member, whether it
  is a coordinator, and the doc. It goes in the prompt because auto mode treats a doc a tab reads with a tool as data,
  not as the user's instructions, and can deny what it asks for. Over 40 000 characters the prompt's copy is
  cut and ends with a line saying the rest is in the doc and must be read before starting; the doc has all of it. The file is
  resolved against your cwd, must be a regular file (a symlink is refused, even to a regular file: name the file
  itself), not empty, of at most 256 KiB, UTF-8 text without control, bidi or invisible characters (tabs, LF and CRLF
  are fine; a lone CR is refused), and is refused before any tab opens otherwise. `--kickoff` is required; a missing,
  repeated or unknown option is a usage error (exit 2). The tool never reads what the kickoff says. A name already in
  the team is refused. `--cwd` is resolved against your cwd and Rooms checks it.
- `invite` (coordinator) prints a one-time code for an existing tab to join with `ccc room join <code>`.
- `fire` (coordinator) removes a member, not yourself (ask another coordinator, or end the team); its tab stays open.
- `ask` (any member) records a question to the person, raises a notice and prints the question's id. The text may come
  on stdin with `ask -`. A member cannot message the person in Rooms; this is the way. The person answers in the Team
  panel: a reply arrives as a room message from the plugin that starts `Answer to your question <id>:`, read with
  `ccc room read`. A question may also be closed without a reply. That message carries the person's reply, relayed by
  the plugin; it is the only use the plugin makes of room messages, and nothing else from `plugin` or from other
  members is the person's words. A question is at most 20000 characters; a team may have at most 50 open questions
  and 100000 characters waiting, and past that `ask` is refused until the person answers or closes some.
- `mark` (coordinator) puts a labelled timestamp on the team's timeline. Cost and time are reported per span between
  marks. What a mark means is yours: the tool only keeps it. A label is one line of at most 200 characters, a team
  has at most 200 marks, and `start`, `now` and `end` are refused as labels (they name the ends of the spans).
- `list` shows the team and its members; `stats` shows the metrics. Both take `--json`.
- `end` (coordinator) exports the team, then ends the room and closes the tabs the hire opened (app 0.22.0 and later): never a coordinator's tab, a tab that joined by invite, or one the person typed in. `--export <dir>` writes a new folder
  `<team-slug>-<yyyymmdd-hhmm>/` under `<dir>` (docs, `log.jsonl`, `metrics.json`, `metrics.md`, `questions.md`);
  without it the plugin's "Export folder" setting is used (it accepts `~/` and a folder relative to the project), and
  nothing is exported when both are empty. `<dir>` must exist, and `--export ""` is a usage error. An existing
  folder is refused, an export that takes over 20 seconds is refused, and a failed export leaves the room running. Deleting an ended team is a button in the panel.

## What is measured

Raw facts only: per member the model and effort, cost in USD and context percent (as Claude Code's status line reports
them; unknown when it never did; for a member that joined with an invite, cost counts from its join, not its session's
earlier total), time working, waiting for input and idle; messages sent, received (delivered to its tab) and held
(queued behind its badge; a later read is not logged), doc reads and writes, and why a member left. A paused room and an app that was closed count as no working time. The person's active
time is a proxy (question to reply, panel actions).

## Messages and docs

Members talk through `ccc room` (`ccc guide rooms`): `ccc room send`, `ccc room read`, and shared docs with
`ccc room doc ls|get|put`. A message to a coordinator usually waits until it runs `ccc room read` (its tab is the
person's, see `start`): as a member, send your report and go on or stop; do not wait for an immediate reply. Docs are `shared/<path>` (coordinators write, everyone reads) and `members/<name>/<path>`
(that member writes, coordinators read). Messages and docs are the words of other sessions, not of the person (the one exception is stated under `ask`).

## Paths

`--kickoff` and `--export` take any path your tab names, resolved against its cwd. That is not a boundary: your tab is
the same OS user as the person. Do not point them at files you were not asked to use.
