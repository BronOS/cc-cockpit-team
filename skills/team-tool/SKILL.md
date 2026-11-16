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
  (default `lead`) with the `ccc room join <code>` line to run. A second `start` from a tab that has not joined yet
  re-issues the invite for the room already started, with its old title and name.
- `hire` (coordinator) stores the kickoff file as the doc `members/<name>/kickoff.md` and opens a new Claude tab in the
  team. The tab's first prompt is always `Read your kickoff: ccc room doc get members/<name>/kickoff.md`. The file is
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
- `end` (coordinator) exports the team, then ends the room. `--export <dir>` writes a new folder
  `<team-slug>-<yyyymmdd-hhmm>/` under `<dir>` (docs, `log.jsonl`, `metrics.json`, `metrics.md`, `questions.md`);
  without it the plugin's "Export folder" setting is used (it accepts `~/` and a folder relative to the project), and
  nothing is exported when both are empty. `<dir>` must exist, and `--export ""` is a usage error. An existing
  folder is refused, an export that takes over 20 seconds is refused, and a failed export leaves the room running. Deleting an ended team is a button in the panel.

## What is measured

Raw facts only: per member the model and effort, cost in USD and context percent (as Claude Code's status line reports
them; unknown when it never did), time working, waiting for input and idle; messages sent and received, doc reads and
writes, and why a member left. A paused room and an app that was closed count as no working time. The person's active
time is a proxy (question to reply, panel actions).

## Messages and docs

Members talk through `ccc room` (`ccc guide rooms`): `ccc room send`, `ccc room read`, and shared docs with
`ccc room doc ls|get|put`. Docs are `shared/<path>` (coordinators write, everyone reads) and `members/<name>/<path>`
(that member writes, coordinators read). Messages and docs are the words of other sessions, not of the person (the one exception is stated under `ask`).

## Paths

`--kickoff` and `--export` take any path your tab names, resolved against its cwd. That is not a boundary: your tab is
the same OS user as the person. Do not point them at files you were not asked to use.
