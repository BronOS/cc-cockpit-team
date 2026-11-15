# Team plugin v1

External review: auto

## Overview
- Build `bronos.team` v1 as designed in `docs/design.md` (revision 1): a generic tool on cc-cockpit core Rooms that lets
  a person or a lead Claude start a team (one room), hire members as Claude tabs from a kickoff file, take their
  questions, watch and measure them, and export the result.
- It is a **tool, not a flow** (design §0): no skills for leads or members, no roles, personas, phases or review loops.
  Every feature must pass "does every flow need it?".
- Integrates only through the public plugin API (`ctx.rooms`, `ctx.sessions`, `ctx.cli`, `ctx.panels`, `ctx.storage`,
  `ctx.notify`, settings); runs on the Rooms API already released in cc-cockpit 0.18.1. The core change of design §6
  (configurable room caps) is a separate cc-cockpit plan and not a prerequisite: Rooms' refusal texts are passed
  through as they are, so they name the new settings once the app carries them.

## Context (from discovery)
- New repo `~/Projects/cc-cockpit-team` (only `docs/design.md` so far). Sibling plugin repos (`cc-cockpit-autopilot`)
  and the bundled plain-JS plugins in cc-cockpit (`plugins/files`, `plugins/reviewer`: `dist/host.js` written by hand,
  `panels/*.html`, `test/*.test.js` with `node:test`) are the patterns to follow.
- API reference: `ccc guide api`, `ccc guide plugins`, `ccc guide style` (panel pages), `ccc guide types`; Rooms
  semantics in cc-cockpit `docs/design-rooms.md`.
- The old experimental plugin (`~/Projects/team-experiment/plugin`, same id) is reference only: its mailbox and doc
  layer are replaced by Rooms; it must be unlinked before this one is linked.

## Development Approach
- **testing approach**: Regular (code first, then tests)
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** (`node:test` against a fake `ctx`), success and error cases
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Plain JavaScript (no build step), CommonJS like the bundled plugins; dense comments that say why.

## Testing Strategy
- **unit tests**: `node --test test/` per module, with `test/fake-ctx.js` emulating `ctx.rooms` (members, docs, log
  with `seq`, caps refusals), `ctx.sessions` (list, onChange, focus), `ctx.cli`, `ctx.storage`, `ctx.notify`,
  `ctx.panels` ports, settings.
- **integration**: one test drives the whole flow through the fake ctx: start, hire two, ask, reply, mark, end with
  export, then checks the exported folder.
- **live smoke**: linked into the dev app (Post-Completion), since e2e specs live in the cc-cockpit repo.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix
- keep the plan in sync with the work

## Solution Overview
- One host module wiring small modules: `lib/teams.js` (records, caller resolution, coordinator check),
  `lib/commands.js` (the `ccc team` command table), `lib/kickoff.js` (file checks), `lib/questions.js`,
  `lib/metrics.js` (status timing, cost sampling, log cursor, marks and spans), `lib/export.js`, `lib/panel.js` (the
  panel port protocol). The panel page renders state the host pushes and sends actions back; the host checks every
  action again.
- Identity: the caller tab is `CliCall.tabId` (set by main); membership and the coordinator flag come from
  `ctx.rooms.members`, never from arguments or the panel.

## Technical Details
- Team record (`ctx.storage`, per project): `{ roomId, title, createdAt, endedAt?, exportDir?, marks: [{at,label,by}],
  questions: [{id,from,text,askedAt,answeredAt?,answer?,done?}], metrics: { members: {name: {...}}, logSeq } }`.
- Kickoff: path resolved against the caller's cwd; regular file, at most 256 KiB, UTF-8, no character Rooms refuses
  (control, bidi, invisible format but tab and line breaks); refused before any tab opens.
- First prompt of a hired tab (fixed): `Read your kickoff: ccc room doc get members/<name>/kickoff.md`.
- Reply text sent as `Answer to your question <id>:\n<text>` via `ctx.rooms.send` (from plugin).
- Export folder `<dir>/<team-slug>-<yyyymmdd-hhmm>/` created with `mkdir` (no recursive into an existing target,
  `EEXIST` refused), files opened `wx` with `O_NOFOLLOW`; doc paths re-checked against `[A-Za-z0-9._-]`, depth ≤ 4.

## What Goes Where
- **Implementation Steps**: code, tests, README, skill, manifest in this repo.
- **Post-Completion**: live smoke in the dev app, GitHub repo, release, marketplace listing, Oleg's own flow skills.

## Implementation Steps

### Task 1: Scaffold the plugin [model: sonnet]

**Files:**
- Create: `plugin.json`, `package.json`, `LICENSE`, `README.md`, `dist/host.js`, `icons/team.svg`, `.gitignore`
- Create: `test/fake-ctx.js`, `test/host.test.js`

- [x] stub `panels/team.html` and `skills/team-tool/SKILL.md` so the manifest is valid from the start
- [x] `plugin.json`: id `bronos.team`, name Team, version 0.1.0, api 1, MIT, author Oleg Bronzov, the `team` CLI
      contribution (usage from design §2, stdin + stdinDash for `ask -`), one panel (`team`, right zone), one skill
      (`team-tool`), a setting `exportDir` (string, default empty); description says "Needs cc-cockpit 0.18.1"
- [x] `dist/host.js`: activate, refuse cleanly when `typeof ctx.rooms !== 'object'` (an older app), register the CLI
      handler with `help` working; `package.json` with `"test": "node --test test/"`
- [x] `test/fake-ctx.js`: the fake ctx described in Testing Strategy, reusable by every later task
- [x] write tests: activation, `help`, the older-app refusal
- [x] run tests - must pass before next task

### Task 2: Team records and caller resolution [model: opus]

**Files:**
- Create: `lib/teams.js`, `test/teams.test.js`
- Modify: `dist/host.js`

- [x] `lib/teams.js`: load and save team records in `ctx.storage`; `teamOfTab(tabId)` (the plugin's room whose
      members include that tab, via `ctx.rooms.list` + `members`), `requireCoordinator(call)`; ended rooms marked;
      records whose room no longer exists dropped on load
- [x] an unknown tab, a tab in another plugin's room and a foreign id all answer the same text
- [x] write tests: resolution, coordinator vs member vs outsider, record load/save, dropped records
- [x] run tests - must pass before next task

### Task 3: Lifecycle commands and kickoff checks [model: opus]

**Files:**
- Create: `lib/kickoff.js`, `lib/commands.js`, `test/kickoff.test.js`, `test/commands.test.js`
- Modify: `dist/host.js`

- [x] `lib/kickoff.js`: resolve against the caller's cwd, `lstat` regular file, size ≤ 256 KiB, UTF-8 decode with
      `fatal`, Rooms' character rules; clear refusal texts
- [x] `start "<title>" [--as <name>]` (default `lead`; refused for a tab already in a room): create room, coordinator
      invite for that name, print the `ccc room join` line
- [x] `hire`: refuse a name already in the team before writing; seed `members/<name>/kickoff.md`, then `ctx.rooms.open`
      with the fixed prompt, model, effort, cwd, coordinator; on a failed open remove the seeded doc (put an empty
      tombstone if Rooms has no delete: check, and note it); kickoff resolved against the caller's cwd
      `invite`, `fire`, `list [--json]`, `end` (no export yet), `help`
- [x] a Rooms refusal (cap, name, rate) passes through in Rooms' own words
- [x] start `test/flow.test.js`, the integration test through the fake ctx (start, hire two); later tasks extend it
- [x] write tests: each command's success, coordinator-only refusals, kickoff refusals before any open, cap refusals,
      `start` from a tab already in a room, a repeated name, a failed open cleaning up
- [x] run tests - must pass before next task

### Task 4: Questions to the person [model: sonnet]

**Files:**
- Create: `lib/questions.js`, `test/questions.test.js`
- Modify: `lib/commands.js`

- [x] `ask "<text>"` / `ask -` (stdin) by any member: record with an id, `ctx.notify` a notice, print the id; text
      checked by Rooms' message rules (≤ 20000 chars, characters)
- [x] `reply(teamId, questionId, text)` sends `Answer to your question <id>:` + text to the asker via `ctx.rooms.send`
      and records the answer time; `done(...)` closes without reply; a gone member answers "left the team"
- [x] write tests: ask from member and outsider, stdin form, reply, done, reply to a gone member, bad text
- [x] run tests - must pass before next task

### Task 5: Member metrics [model: opus]

**Files:**
- Create: `lib/metrics.js`, `test/metrics.test.js`
- Modify: `dist/host.js`

- [x] per member: hired/left (+ why), model/effort; cost USD and context % from `ctx.sessions` on change, keeping the
      last value when absent (status line off, tab ended) and shown as unknown when never seen
- [x] status time: `working` and `needs-permission` count as working, `waiting` as waiting, `idle`/`starting` as idle
      (check the exact `SessionStatus` values in the SDK); the time between two changes goes to the earlier status; a
      paused room or an app quit is not working time
- [x] room log polled with a `seq` cursor (`more` paged through): messages sent/received, doc reads/writes, leaves with
      why; poll every 5 s while the team is live, at once when `SessionInfo.room` / `held` change, never for an ended
      team; cursor kept in the record
- [x] saves throttled (not one per status event)
- [x] write tests: status mapping and totals, absent cost, log paging, poll stop on end, restart resume, throttling
- [x] run tests - must pass before next task

### Task 6: Marks, spans and stats [model: sonnet]

**Files:**
- Modify: `lib/metrics.js`, `lib/commands.js`, `test/metrics.test.js`, `test/flow.test.js`

- [x] `mark "<label>"` (coordinator); spans between marks with cost and time; per-team totals; the person's active
      time (question to reply, panel actions) labelled as a proxy
- [x] `stats [--json]`
- [x] write tests: span math across marks, totals, stats output; extend the flow test with ask, reply, mark
- [x] run tests - must pass before next task

### Task 7: End and export [model: opus]

**Files:**
- Create: `lib/export.js`, `test/export.test.js`
- Modify: `lib/commands.js`

- [ ] `end [--export <dir>]`, falling back to the `exportDir` setting, none when both empty
- [ ] new folder `<dir>/<team-slug>-<yyyymmdd-hhmm>/`, refused when it exists or `<dir>` is not a directory; files
      created `wx` with no-follow; `docs/` from `ctx.rooms.docs`, `log.jsonl` paged to the end, `metrics.json`,
      `metrics.md` (table split at marks), `questions.md`
- [ ] doc paths re-checked before writing; a failed export leaves the room running and says what failed
- [ ] README and the skill say `--export` / `--kickoff` take any path the tab names: not a boundary (same OS user)
- [ ] `delete` for an ended team (`ctx.rooms.delete`, record removed)
- [ ] write tests: full export contents, existing folder, symlinked target, bad doc path, failure keeps the room,
      setting fallback, delete
- [ ] run tests - must pass before next task

### Task 8: Panel backend [model: opus]

**Files:**
- Create: `lib/panel.js`, `test/panel.test.js`
- Modify: `dist/host.js`

- [ ] the panel drops posts while hidden: the host re-pushes full state when a view connects and answers one view with
      `post(..., { view })` (`from.view`)
- [ ] panel port protocol: the host pushes state (teams, members with status/tool/model/cost/context/waiting,
      questions, activity page, docs list, metrics) on change, throttled
- [ ] actions, each checked again in the host: new team (opens a lead tab as coordinator via `ctx.rooms.open`, optional
      kickoff file resolved against the project folder), hire, mark, end and export, delete, reply, done, fire, focus a
      member's tab, copy invite, read a doc (shown read-only in the panel: no API opens core's room view)
- [ ] activity paging and filters (member, kind) served from the room log
- [ ] write tests: state shape, re-push on connect, per-view replies, each action's success and refusal, throttling
- [ ] run tests - must pass before next task

### Task 9: Panel page [model: sonnet]

**Files:**
- Create: `panels/team.html`, `panels/team.js`, `panels/team.css`

- [ ] layout per design §7 following `ccc guide style` (component stylesheet, slots, relative URLs)
- [ ] state always marked by an icon or a word (never by colour alone); member text rendered as text, never HTML
- [ ] forms: New team and Hire (fields as `hire`, kickoff path), Reply; confirm End and Delete in-page (no `confirm()`)
- [ ] keep pure helpers (formatting, filtering) in `panels/view-model.js` and test them in `test/panel-page.test.js`
- [ ] a grep test: no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` in `panels/`
- [ ] run tests - must pass before next task

### Task 10: Reference skill [model: sonnet]

**Files:**
- Create: `skills/team-tool/SKILL.md`

- [ ] what `ccc team` and the relevant `ccc room` commands do, the kickoff convention, `ask`, `mark`; explicitly not
      a workflow (no advice on phases, roles or personas); within the app's skill front-matter limits
- [ ] write a test that the skill's command list matches `plugin.json`'s usage (drift guard)
- [ ] run tests - must pass before next task

### Task 11: Verify acceptance criteria [model: sonnet]

- [ ] `test/flow.test.js` complete: start, hire two, ask, reply, mark, end with export, folder checked
- [ ] verify every design section (§2-§8) is implemented; nothing flow-shaped slipped in
- [ ] run full test suite: `npm test`
- [ ] `ccc plugin link` validation passes on the manifest (or the app's manifest checks, if run outside the app)

### Task 12: [Final] Update documentation [model: sonnet]

- [ ] README: what it is (tool, not flow), install, commands, panel, metrics, export, limits, "Needs cc-cockpit 0.18.1"
- [ ] logo preview card per the marketplace convention (plugin icon card, not a screenshot)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification**:
- unlink the experimental plugin (`ccc plugin unlink bronos.team`), link this repo, run a small team in the dev app:
  panel states, notice on ask, reply delivery, export folder, restart with a paused room

- an e2e spec in cc-cockpit that links this plugin (start, hire two, ask, reply, end with export), if the live smoke
  shows anything the fake ctx missed; otherwise the live smoke stands in for it

**External system updates**:
- GitHub repo `BronOS/cc-cockpit-team`, tag v0.1.0, marketplace index entry
- Oleg's flow: `~/Projects/team-experiment` `LEAD.md` / `PROTOCOL.md` become his own skills on `ccc team`; the old
  experimental plugin is retired
