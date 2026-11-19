---
worth: yes
added: 2026-11-19
---
# stars for team members, carried into the retrospective

Oleg's idea (guest-invite run, 2026-11-19): he tells the lead "give <member> a star for <why>" (a job well done),
and the team keeps it.

- The lead records it with a new command, e.g. `ccc team star <name> "<reason>"` (coordinator only, like `fire`;
  refused for guests, as every Team action is). A member can get several stars.
- The member is told through the room ("Oleg gave you a star: <reason>").
- The Team panel shows a star badge with the count next to the member (`panels/team.js`, `view-model.js`), the
  reasons in its tooltip; a fired member keeps its stars in the list.
- The stars and their reasons are in the team state and in the `ccc team end` export (`lib/export.js`), so the
  retrospective (team-lead skill, `phases/7-retro.md`, and the `retro` skill in claude-config) reads them as a
  signal of what worked: which role, model, effort and Code Mode setting the starred member had.
