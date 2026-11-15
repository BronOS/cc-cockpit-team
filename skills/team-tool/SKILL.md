---
name: team-tool
description: Use when asked to start, run or inspect a team of Claude tabs with the cc-cockpit Team plugin (ccc team).
---

Run `ccc team help` for the commands. This skill is a stub; the full reference comes later.

`ccc team end --export <dir>` writes the team (docs, log, metrics, questions) into a new folder under `<dir>`, then
ends the room; without `--export` the plugin's "Export folder" setting is used, and nothing is exported when it is
empty. `--kickoff` and `--export` take any path the tab names, resolved against its cwd: that is not a boundary (the
tab is the same OS user).
