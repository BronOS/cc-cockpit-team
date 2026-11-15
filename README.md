# Team

A cc-cockpit plugin (`bronos.team`) for running a team of Claude tabs on core Rooms. A tool, not a flow: it starts a
team, hires members from a kickoff file, takes their questions, measures them and exports the result. Needs
cc-cockpit 0.18.1.

`ccc team end --export <dir>` (or the "Export folder" setting) writes the team into a new folder
`<dir>/<team-slug>-<yyyymmdd-hhmm>/` before the room ends: `docs/`, `log.jsonl`, `metrics.json`, `metrics.md`,
`questions.md`. An existing folder is refused, files are never written through a symlink (a file or a folder of the
export swapped for one stops it), the files are readable by their owner only (0600, folders 0700), and a failed
export leaves the team running. From `ccc` the export has 20 s (a `ccc` call is cut at 30 s); a team too big for that
is ended from the panel.

Not a boundary: `hire --kickoff` reads, and `end --export` writes, any path the calling tab names. The coordinator is a
Claude tab of the same OS user, which can read and write those files anyway.

Design: `docs/design.md`. Work in progress (v0.1.0 scaffold).

```
npm test
```
