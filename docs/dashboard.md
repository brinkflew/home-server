# The dashboard

Lifted whole from `CLAUDE.md` on 2026-08-19. Nothing here was rewritten.

## The dashboard

**Since 2026-08-15 there is somewhere to look that is not an ssh session.** A Vue 3 application at
`home.avanserv.com`, behind the same passkey sign-on as everything else, built from
`apps/dashboard/` and served by its own container. It closes the last roadmap item: `status.json`
for what is true now, Prometheus for when it stopped being true.

```bash
systemctl --user start home-server-dashboard-build.service   # the deploy; see below
cd apps/dashboard && npm run dev                             # fixtures, no server needed
```

**All seven pages are built.** System and Services were the first cut, on 2026-08-15; **Home and
Library landed 2026-08-17** and needed a data layer before they needed a design. **Network split out
of Services on 2026-08-18**, and needed a measurement that did not exist - see below.

**The token layer was rebuilt on 2026-08-29, and Agents was rebuilt on top of it.** The design
system at claude.ai/design project `60a0f67c-53ab-4a0a-92c0-fdbf0761934d` is this dashboard's own
language revised - it read the codebase, so its arguments name this application rather than
dashboards in general - and four of them moved real code:

- **Dense became legible.** The first pass had transcribed a 9.5px floor and a 22px ceiling
  verbatim, and both were judged wrong: 9.5px is below what any screen carries, and a 22px ceiling
  *"left a page with no voice at all - every line the same size, so nothing told you where you
  were."* The scale is 11px to 32px, and `--t-ui` went 12px to 13px.
- **A BAND IS EITHER FULL WIDTH OR N EQUAL COLUMNS.** This replaced a bento, and the System page is
  the one it names: a 12-column grid running 7/5 then 4/4/4, *"every panel a different width for
  reasons that were true of its content and invisible to a reader, so the page had no organisation
  to learn."* `Band.vue` makes the rule structural rather than a convention. **A band that wants a
  grid AND a full-width panel under it is two bands.**
- **A LIST OF RECORDS IS A TABLE, NEVER A GRID OF CARDS.** One global `.tbl` in `base.css`: one
  horizontal rule per row, no vertical rules, no zebra, no outer border, and severity as a 2px
  inside edge on the first cell (`td.rail` with `--rail`), so the colour reads down the left
  without a wash on every row. `table-layout: fixed` is in that recipe and is not cosmetic - with
  auto layout `width: 100%` is a FLOOR, and one nowrap cell grows the table past its container.
- **The panel lost its border.** `--border-card` is `transparent` on purpose: the surface steps are
  about 0.03 L apart, which is enough to separate a panel from the page on its own, and *"twenty
  bordered boxes on a near-black ground read as a wireframe."*

**Two numeric voices, split by KIND rather than by "is it a number".** `.mono` is for anything you
would copy, grep or type and for any value carrying a unit; `.count` is for a bare count. The old
rule put `12 units` and `/var/mnt/media` in the same voice, which made a page of counts read like a
config file. Both are tabular, so neither reflows its column as it ticks - which was the only real
argument for mono here and holds either way. The sweep is scoped to Agents; the other six pages keep
`.mono` until each has its own pass.

**The Agents page became three views behind one nav tab.** `AgentsPage.vue` had reached 1,476 lines
and nine panels, plus `RoundDetail.vue`'s 365 in an expander under the board, and it answered at
least three different questions at once. A person watching for a gate to answer had to scroll past
four panels about the machinery to reach it.

| Route | Answers |
|---|---|
| `/agents/rounds` | is the fleet working, and does it need me? |
| `/agents/rounds/<key>` | what did this round do? |
| `/agents/fleet` | what is the machinery doing, and what does it cost? |

`router.ts` gained its first nested record for it, and `pages/agents/AgentsLayout.vue` carries the
sub-navigation and the toolbar note. **The sub-nav is `WindowPicker`'s own box**, because a
segmented control already means "pick one of these" here and a second segmented idiom that looked
slightly different would be a new thing to learn for nothing. It is in the page body rather than a
second row of tabs in `NavBar`, which every one of the other six pages would have paid for in
height.

**Splitting the page cannot restart a freshness clock, and that is why it was safe.** All three
stores are instantiated in `App.vue` for the reason its own comment gives - `usePoll` resets
`lastOk` on unmount - so moving between these three views does not touch `fleet.json`'s clock.
The **Prometheus** polls are per view and deliberately so: `useMetricsStale()` reads the host store
rather than those polls, so each view asks for only the numbers it draws. The single page fetched
24 instant queries and 5 ranges on every poll; the board now asks for 8, the fleet view for 15 and
3. **Three of the old queries were fetched and drawn nowhere at all** - `markerPresent`, `lastOk`
and `slicePids` - and are not carried over.

**`WindowPicker` moved to `/agents/fleet` alone.** It is the only one of the three with a chart on a
time axis, and on the single page it sat above five panels that ignored it - *"a picker that changes
nothing on screen is a lie about a control."*

**THE BOARD'S HEADER LEADS WITH ONE READING, SINCE 2026-08-29.** It was five equal columns -
conduct, phase, quota, worktrees, intake - each handed a fifth of 1360 to hold about 150px of
content, so the band read as a sparse row of unrelated numbers with no primary and a great deal of
air. Every fact it carried is still there; what changed is that they stopped being peers. The phase
state is the headline in `--t-mono-xl`, which `tokens.css` describes as *"the one headline
reading"* and which nothing consumed until now. The conditions - intake, quota, worktrees - pack
left at content width under a hairline, which is also the whole of their phone layout.

**One panel with internal hierarchy is not a bento.** The band rule governs panels *within* a band,
full width or N equal columns; this is a single full-width panel and the rule is untouched.

**It is no longer labelled `Fleet`.** That label sat directly under a sub-nav whose other segment is
also `Fleet`, so the page announced itself with the name of the view beside it. It says `Right now`.

**The conduct heartbeat moved to the band's aside, and that is a claim about what it is.** It is the
provenance of every reading in the panel rather than a sixth fact among them: if conduct has stopped
polling, nothing below it is a current statement. It keeps its own tone, so stale is still amber and
never-run still grey.

**AND `idle` NO LONGER DRAWS A BARE PROGRESS TRACK.** The tile rendered an empty track and a dash,
which is the encoding this whole store reserves for *"in progress, ratio unknown"*. Nothing is
running, which is a different claim. `ProgressBar`'s contract was never wrong - null is a bare
track and zero is a zero-width fill, deliberately - the call site was. The bar renders only while a
phase is in flight, and the line under the reading says which nothing it is: `no phase running`
against `no phase has started on this host`.

**The intake switch is still drawn twice, deliberately, and the split made that cleaner rather than
harder.** The board's tile answers *"is the fleet armed"*; the fleet view's panel answers *"who said
so, and why"*, and only that one carries the note. `useIntake()` is new and is what keeps them one
derivation: the state word, the tone, the chip's label, the command it sends and whether an ask is
still outstanding all come off it, so a chip reading `arm` on one view cannot send `intake_off` from
the other. `src/roundboard.ts` does the same job for the row: the board and the round page both
need to say how far a round has got and how long it has been going, and two copies of *"elapsed
leads, the estimate is usually absent"* would be two copies of a rule already got wrong once.

**IT WORKS ON A PHONE SINCE 2026-08-29, AND IT NEVER HAD FOR A REASON WORTH WRITING DOWN.** There
were eight layout media queries in the app and every one of them was between 1100 and 1400; the
narrowest thing declared anywhere was a one-column fold at 1180. Nothing in `docs/` said a word
about viewport, breakpoints, touch or small screens, and the design system's own readme names
**1360x860** as the reference viewport and stops there - so this extends the system into a case it
never addressed rather than contradicting it. The reference viewport is unchanged and still decides
what the design is drawn against.

It was never hypothetical. `index.html` has carried `width=device-width` from the start and
`public/site.webmanifest` declares `display: standalone` with 192/512 rasters and an Apple touch
icon, so **the app has been installable on a phone the whole time** - and what it installed was a
desktop layout in a 375px window.

**THE SHELL HEADER ALONE WAS THE HORIZONTAL SCROLLBAR.** `.left` is `flex: none` and its intrinsic
width is about 583px - a seven-tab nav of roughly 452px plus the 113px lockup - so at 375px the
document's scroll width was at least 649px **before any page contributed a pixel**. Every page had
~275px of bare `--bg` beside it and a scroll axis nobody asked for. That is why the nav became a
drawer rather than the pages being fixed one at a time: it is one element and it was most of the
problem.

**AND THE OVERFLOW WAS SILENT, ON EXACTLY THE DEVICES IT AFFECTED.** Touch draws overlay
scrollbars, so a page running off the right edge shows nothing at all until somebody swipes. This
is the same shape as everything else in this document - a fault whose only symptom is the absence
of a symptom - which is why the fix is a check rather than a suppression. **`overflow-x: hidden` on
`body` was refused deliberately**: it conceals this class of defect instead of removing it, and it
breaks `position: sticky` in some engines. `fixtures/shoot.mjs` asserts `scrollWidth` against
`clientWidth` at three viewports instead, on nine routes.

**Three rungs, and they are literals because a media query cannot read a custom property.** 1180 is
the existing `Band` fold. **900** is where the racks gain a scroller, N-up grids fold, tables drop
their lowest-priority columns, and the nav becomes a drawer. **640** is where the header sticks,
the page gutter tightens to 14px and tables drop to their essential columns. `1100`, `1280` and
`1400` still exist on three pages, each doing a real job at a real width; normalising them would
have been a desktop behaviour change made for tidiness. The ladder is in
`docs/repo-conventions.md`.

**THE DRAWER'S RUNG IS 900 AND IT WAS MEASURED, NOT CHOSEN.** Seven tabs are ~452px, the lockup
113px, the verdict pill up to 229px and the gutters 66px: the header needs **776px** before a page
has teleported anything into it. It was first written at 640, and the tablet viewport reported 44px
of overflow on all nine routes within a minute - which had been true all along and invisible,
because `overflow: hidden` on the old header wrapper was eating it. The alternative was a fourth
breakpoint at 780 existing for one element.

**That clip was also removing the wrong thing.** The wrapper was `justify-content: flex-end` with
`overflow: hidden`, and an overflow in a flex-end row accumulates on the **start** edge - so the
first casualties were the verdict's StatusDot and then the front of its sentence. A status pill
with no status light is the one rendering this header must never produce. The clip belongs to the
toolbar, which has its own; the tally truncates and the dot and the age are `flex: none`.

**A page's toolbar gets a row of its own below 900 rather than being clipped to nothing.** That
required flattening `#toolbar` out of its wrapper and into the bar directly - nested, a
`flex-basis: 100%` sized the *wrapper*, which put the verdict on a line by itself and left the
toolbar indented under it, three rows for two things. There is still exactly **one** `#toolbar`
element: eight pages teleport into it and a second target would be two answers to one question.

**A LIST OF RECORDS IS STILL A TABLE ON A PHONE.** Six columns do not fit 375px, so `.tbl` gained
**column priority**: `.p3` drops at 900, `.p2` at 640, and `.fold3` / `.fold2` are lines inside the
surviving cell that appear only once their own column has gone. Nothing is lost, it relocates -
and on the round board the row still links to the round's own page, which holds all of it either
way. `display: none` on a `th`/`td` removes the column outright under `table-layout: fixed`, which
is what makes this one global rule rather than a width recalculation per table.

**The four hand-rolled racks are panned instead, and that is repair rather than design.** Services
floors at ~784px, CI at ~748px, Library at ~666px and the System timeline at 320px before its chart
track; none can shed a column without being rebuilt as a `.tbl`, which is still the follow-up each
of them has. CI's rack has **no header row at all** - its eleven column labels live only in
tooltips - and that is a real limitation of stopping at repair depth. What makes them reachable is
that `Tooltip` gained a tap-elsewhere dismiss: a tap has always *opened* one, there was simply no
way to shut it.

**The network drawing is panned for the opposite reason: it does not reflow, it shrinks.** It is
1498x856 and aspect-preserving, so a 390px panel renders it at a 0.197 factor - 13px node names at
2.6px, 11px rail labels at 2.2px, and the hairlines surviving intact because they carry
`non-scaling-stroke`. A grey smear of rules connecting things nobody can read. 900px of min-width
is where its smallest type is still above the 11px floor.

**NOTHING SHRINKS TO FIT.** The type floor is 11px at every width. A phone is read closer than a
wall panel, not further away, so the answer to a narrow screen is fewer columns and never smaller
type. What does move is two chrome insets: `--pad-chip` and `--pad-control` grow under
`@media (pointer: coarse)`, taking a chip from a ~23px target to ~31px. The tokens move, not the
call sites - one edit rather than forty, and it lands on a desktop touchscreen too, which is right.

**Two media queries were folds that got WORSE as the screen narrowed.** `SystemPage`'s
`.right-column` and `NetworkPage`'s `.side` both flip from a column to a row when they can no
longer sit beside their sibling - correct at 1200, and still in force at 375, where it left two
panels in ~160px each. `.bottom` stopped at two columns for want of a rung below its own. All three
have one now. This is the shape to look for in any breakpoint written for a single viewport: it is
not that the rule is wrong, it is that it has no floor.

**And one defect the drawer surfaced that had nothing to do with layout**: a function `ref` on a
`RouterLink` is handed the **component instance**, not its element, so `.focus()` threw - inside a
watcher, where nothing on the page showed it. The drawer opened perfectly for anyone using a mouse
and not at all for anyone using a keyboard. `shoot.mjs` reports `pageerror`, which is how it was
found; it is a `querySelector` now.

**The design project's `templates/dashboard-page/` is STALE against its own README** and should not
be followed. It still shows a 12-column bento with bespoke spans and still says *"nothing above
22px"* - both of which the README explicitly replaced. The README and `tokens/` are authoritative.

**It READS, and since 2026-08-28 it can ask the fleet for three things.** The design has restart,
pull, approve and terminate buttons, and no container here can have them: `container_t ->
unconfined_t : unix_stream_socket connectto` is DENY and is not fixable by relabelling. Nothing here
restarts a unit, pulls an image or terminates a stream, and every one of those chips is still a deep
link into the owning application - `src/links.ts` holds the mapping, derived from
`window.location.hostname` so no build-time variable is involved.

**The three that act do not breach that rule, they route around it.** A host-side listener was the
refused shape, in five files and always in the same sentence: it spends real containment to give an
internet-facing container an RPC that spawns `claude`. So a command goes the way work already goes -
the browser POSTs to Caddy, Caddy rewrites it to one literal Windmill path and adds a token the
bundle never sees, and conduct answers the resulting suspended step on its next 60-second poll. The
browser writes to a container; the host polls. **`paths.ts` still carries `conduct` as outbound-only,
and `bin/lint-repo.sh` now enforces that** rather than only asserting it in prose.

**THE ONE CALL HERE WHOSE ANSWER IS NOT JSON IS THE ONE THAT ACTS.** Windmill's run endpoint replies
`201 text/plain` with a bare 36-byte job id, and `fetchJson` parsed it until 2026-08-28 - so a
command Windmill carried out, conduct recorded and a round acted on printed `failed` on the button.
`fetchText` reads it now, over the same shared `request()`, so the sign-in trap that file exists for
still applies to it. **`fetchJson` stays strict**: its six other callers really do answer JSON, and a
lenient parse there would turn a corrupt document into silence.

**THE INTAKE SWITCH IS DRAWN TWICE, AND THAT IS THE FIX RATHER THAN THE PROBLEM.** It shipped in the
Intake panel alone, at the foot of the Agents page below six other panels, where it was correct,
enabled and *missed* - the first thing asked of it after it shipped was where it was. It is now also
a tile in the fleet header, beside conduct, phase, quota and worktrees, because it is the one
control that decides whether any of the rest of that page has anything to describe. The panel keeps
its copy: **the header answers "is the fleet armed", the panel answers "who said so, and why"**, and
only the panel's sentence carries the note.

**What must not be drawn twice is the decision**, which is why `control.ts` gained `intakeSwitch()`.
The state word, the tone, the chip's label and the command it sends all come off one branch there,
so a chip reading `arm` cannot send `intake_off` - the same defect as the findings strip and the
list disagreeing about a tone, with a far worse consequence than a colour. `fixtures/smoke.mjs`
asserts the pairing across all three states, including the `as shipped` case no fixture carries.

**THE SWITCH IS DRAWN FROM `control.json`, NOT `fleet.json`, AND THAT IS A CADENCE FIX.** The fleet
document is on the collector's five-minute slow tier and the browser polls it every five minutes, so
the board could be ten minutes behind a command conduct now applies in about fifteen seconds - a
person presses disarm, watches the tile go on saying `armed`, and presses it again. `control.json`
is one SELECT on the thirty-second fast tier. **`fleet.json` still carries `control` and the store
treats the fast file as a PRECEDENCE rather than a second drawing**: exactly one value reaches
`intakeSwitch()`. It is preferred only when its own `conduct_db` source answered - a locked database
is a live writer doing its job, and preferring its empty default would flip the tile to `as shipped`
and tell a reader nobody had ever set the switch. The fallback is not defensive habit either: the
collector and the bundle deploy separately, so the file does not exist until the collector half
lands.

**AND THE CHIP REMEMBERS WHAT THIS BROWSER ASKED FOR, ACROSS A RELOAD.** `asked` was component state
and died with the mount, so a refresh offered the command again as though it had never been sent.
It is in `sessionStorage` - one person's own click, not a fact about the fleet, and nothing on the
host records that a command was sent. **It is cleared by derivation and never by a timer**:
`askAge()` compares what was asked with what the chip would send *now*, so the moment the fleet is
seen doing the thing they differ and the memory retires itself. The ceiling only catches a flow that
timed out unanswered and will therefore never move the state.

**The run board's time column carries two clocks.** It held the ETA alone and so read `-` on most
rows most of the time, because the collector withholds an estimate below five samples of any
remaining phase - while a round had visibly been running half an hour. Elapsed leads, the phase in
flight is under it against this host's own median for that phase, and a closed round says what it
took. `opened N ago` under the progress bar stays: it answers *when*, this answers *how long*, and
on a finished round they are different numbers.

**And the Agents page no longer teleports `read only` into the toolbar**, because it is not: intake,
hold, release and restart all act. It says `asks the fleet`, which is the weaker claim the chips
themselves make - conduct applies a command on its next cycle, so the board asks and never does. The
other four pages keep `read only`, correctly.

**Six sources, and the split is the point:**

| Source | Carries |
|---|---|
| **Prometheus**, proxied same-origin at `/api/prom` | every number and every history, including `home_server_container_info{container,unit,image,pod}` - podman's own identity join, so the pod rack needs no lookup table |
| **`status.json`**, served as a file at `/data/status.json` | the **prose** of the findings. The metric carries the verdict and deliberately not the message; the id is the join |
| **`activity.json`**, every 30s | what is playing and what is in flight, **with titles** - sessions, downloads, transcodes, torrents |
| **`library.json`**, every 5 minutes | requests, recently added, recent completions, stalled and queued files, the subtitle backlog |
| **`fleet.json`**, every 5 minutes | what the agent fleet is doing, read out of `conduct.db`: rounds with their task, attempt, progress, ETA and pull request, publications pending, the last runs **with what they cost**, and why the intake last declined |
| **`apps/dashboard/src/topology.ts`**, compiled in | the segment rails and the published-port table. The topology *is* static - it is `stacks/`, in git - and only the node colouring is live |
| **`apps/dashboard/src/paths.ts`**, compiled in | who talks to whom. Half of it lives in an application's own database, so it is **validated** rather than derived |

**CI AND AGENTS LANDED 2026-08-28, AND THE TWO FLEETS ARE INVISIBLE FOR OPPOSITE REASONS.** A CI
lane carries `io.home-server.ephemeral`, so both container sources skip it; it is `podman run --rm`,
so no unit fails; and it defines no health check, so nothing reads unhealthy - `docs/ci.md` says a
wedged lane leaves no failed unit and no unhealthy container, which means every other page here
shows a quiet host. So `/ci` is a page about making one marker file legible, and **absence is the
finding**: a lane with no heartbeat is grey and says "never started", never "idle". The agent fleet
has the opposite problem - 41 series, all scalars, none of which can say which task is in flight or
that a pull request has been waiting on a person since last night. That half is `fleet.json`.

**`fleet.json` CARRIES COST, AND THAT IS NOT A REVERSAL OF THE NO-DOLLAR-METRIC RULE.**
`docs/observability.md` refuses a dollar *metric*: the quota is a subscription window, percentages
are the currency, and a spend ceiling would measure nothing that can stop the fleet. All of that
stands - `home_server_agent_quota_status` is still what paces it. `run.cost_usd` is real (it is
`total_cost_usd` from the CLI's own result event, not a price anybody invented), it had no reader at
all, and a document keeps no history - so reporting it cannot turn into a second currency or a
400-day series. If it ever grows one, the refusal has been reversed by accident.

**THE BOARD DRAWS ROUNDS OUT OF THE RUN LOG, BECAUSE `chain` IS NOT A HISTORY AND CANNOT BE MADE
ONE.** The first version read it and drew **one row where there should have been eleven**.
`chain.worktree_id` is a PRIMARY KEY, `chain_open` does `INSERT OR REPLACE`, and **the worktree is
reused for every change** - every task this fleet has ever run went through `upskald-ship` - so each
round overwrites the last one's row and the table holds exactly one. Measured on the live host: 1
row in `chain` against 67 in `run`, covering eleven rounds over six days. "Open rounds plus a capped
tail of closed ones" was a premise about a table that has no tail.

`run` is the durable log - `AUTOINCREMENT`, one row per phase execution, never deleted - and
`source_fleet` groups it: **a `plan` run starts a round**, which is conduct's own definition of an
attempt (`chain.attempts` counts plan phases). `verify` runs on `<worktree>-verify` under its own
lease and is folded back, or every round loses its gate and reads 3/5 for ever. `select` is the
fleet choosing work and `check`/`probe`/`hello` are hand-run diagnostics; none is a step in a task's
journey, and a group with neither a plan nor a task is dropped outright.

**`chain` IS STILL READ, FOR THE ONE THING IT DESCRIBES ACCURATELY**: the round in flight. It
supplies `waiting_on`, the approval link and the tracker id, and only to the latest round on its
worktree - letting an earlier one inherit a live chain row would draw a finished round as though
somebody were waiting on it.

**THE PUBLICATION JOIN HAD TO BECOME WINDOWED IN THE SAME CHANGE.** Matching on `worktree_id` alone
was invisible while `chain` held one row and is wrong the instant history appears: all ten rounds on
`upskald-ship` would have carried the same pull request. A publication belongs to the latest round
that had already started when it opened - the verification push is what opens that row. Measured:
2 of 11 rounds, and the correct two.

**AND A ROUND'S TASK ID CANNOT BE PARSED OUT OF `run.task`.** That column holds the phase's whole
prompt, which happens to contain the words "(task 1251)". `run.odoo_task` is a column on the conduct
side for exactly that reason. It fills in **going forward only**: every round run before it stays
null, renders a disabled chip and hides its attempt line rather than guessing "attempt 1 of 2".

**THE RUN BOARD SHOWS FINISHED ROUNDS, AND EVERY OUTCOME ON IT IS STRUCTURAL.** The first cut read
`chain WHERE closed_at IS NULL`, so a round vanished the moment it closed and `published` and
`stopped` were states the page could never draw. What replaced it does **not** read `closed_why` -
that is prose ("reached the publish path", "the rounds are used up"), and keying a state on those
words is the habit this repository names as a defect everywhere else it appears. **The publication
join says the same thing structurally**: whether a round reached the publish path is a row's
existence, whether it published is a column on that row, and the sentence is shown to a reader
rather than read by the code. `fixtures/smoke.mjs` rewords a `closed_why` and asserts the state does
not move.

**A CLOSED PUBLICATION CARRYING NO PULL REQUEST IS A THIRD OUTCOME**, and collapsing it into either
neighbour loses a real distinction: the flow ended without opening one, which is what a declined
approval and a seven-day timeout both look like. It is not a round still waiting to publish, and it
is not a fleet that gave up before the publish path.

**PROGRESS IS `chain.done`, WHICH IS PER ATTEMPT**, so the row keeps printing "attempt N of 2"
beside it. `chain_restart` clears that list wholesale when a round starts again - a re-plan is the
whole point of another round - so 2/5 on attempt 2 is work being redone rather than work that was
lost, and only the attempt counter says which.

**THE ETA IS A MEDIAN OF THIS HOST'S OWN COMPLETED RUNS, AND IT IS USUALLY A DASH.** conduct records
no expectation anywhere - `flows/ship.py` has prose in its module summaries and nothing
machine-readable - so the number is derived from what this host has actually done, over 30 days,
successful runs only. **It is withheld entirely below five samples** rather than computed from two,
and `phase_stats` travels with the document so the tooltip can name what it rests on. **A round
waiting on a person carries none at all**: the remaining phases sum to a couple of minutes of
`ship`, while the real wait is however long somebody takes to look, bounded only by the seven-day
human timeout. "~1m" over a gate that has been waiting since last night would be the most
confidently wrong number on the page.

**TWO HALVES DEPLOY INDEPENDENTLY, AND THE FIRST VERSION TOOK THE BOARD DOWN BETWEEN THEM.** The
collector arrives by `git pull` and the `publication.pr_url` column does not exist until conduct next
opens the database and runs its own migration. A SELECT naming it raises `no such column: pr_url`,
which `source_fleet` catches and reports as `conduct_db` unreadable - so the whole board would read
"these rows are absent, not zero" over a perfectly healthy fleet for however long the two were out of
step. **Measured against the live database before the migration had run, not reasoned about.** The
columns are asked for on `pragma_table_info`, which is the same discriminator conduct's own `_migrate`
uses.

**AND THE FIX EXPOSED A SECOND ONE THAT WOULD HAVE BEEN PERMANENT.** A row written before those
columns existed holds NULL whether or not it opened a pull request - a migration is a moment in time -
so the one round this fleet has actually merged, `avanserv/upskald#249`, read **"not published"**. That
is a confident lie that no later run would have corrected. `pr_state` is therefore `unknown` for a
publication row this code could not have read a url off at all, and `unknown` outranks the
"not published" claim: **a null only means "opened none" when a url would have been visible had there
been one.** The guard covers **two** cases, and the
second was only found by running the deployed collector against the live database: a row this code
could not read the column off at all, **and a row that closed before conduct started writing it**.
Both existing publication rows on this host predate the columns and one of them is `#249`, so
without the cutover in `FLEET_PR_RECORDED_FROM` the fleet's only merged pull request read
"not published" permanently.

**HIDING A MERGED ROUND REQUIRES POSITIVE EVIDENCE, AND THE GITHUB LEG FAILS OPEN.** The board drops
a round once its pull request is merged and offers the rest behind a toggle that prints its own
count - a filter a reader cannot see is a filter that lies. `pr_state` is `unknown` whenever GitHub
could not be asked, and an unknown round **stays**. A row disappearing because a token expired would
be the same class of error as an empty list reading as an idle fleet, which is what this whole
document exists to prevent. The board says so on screen rather than filtering silently.

**`github` IS THE ONE SOURCE `sourceNotes` DOES NOT SPEAK FOR.** Every other upstream supplies rows,
so "absent, not zero" is exactly right for it; GitHub supplies one *field* on rows that are already
present and can only ever cost a merged state. The generic sentence would send a reader looking for
missing rounds that are on the screen in front of them.

**IT IS ALSO THE FIRST HOST-SIDE NETWORK CALL `bin/collect-metrics.py` MAKES.** Every other outbound
request in that file goes through `podman exec <container> curl`, and this one cannot: the token
must not enter a container, which is the rule `docs/ci.md` already states for the credential that
never enters a lane. `GITHUB_PR_READ_TOKEN` is a *third* GitHub credential and deliberately so -
the Windmill variable is `pull_requests: write` and `GITHUB_RUNNER_PAT` is org-scoped, so widening
either would give a monitor the ability to act. It lives on the monitor rather than in conduct for
the reason `docs/agents.md` already gives: a reconciler that stops is safe and a monitor that stops
is blind.

**AND IT MUST NEVER CARRY A RESUME URL.** Windmill's `jobs_u/resume/{id}/{resume_id}/{signature}`
holds an HMAC in the path and needs no session, which is why `docs/agents.md` refuses it to ntfy.
The same reasoning reaches further than the transport: a link on a page is a link that gets
followed. `source_fleet` therefore constructs no link at all - it carries `notice.link`, which
conduct built pointing at the approval page behind sign-on - and drops anything resembling a resume
URL regardless. `fixtures/smoke.mjs` asserts both halves.

**THE TWO MEDIA DOCUMENTS EXIST BECAUSE A TITLE CANNOT BE A PROMETHEUS LABEL, AND THE SECOND REASON IS THE
ONE THAT MATTERS.** Cardinality is the obvious one. The real one is that `source_playback` refuses to
label a session with the user, the device or the item, because a 400-day series of who watched what
is surveillance of the household rather than monitoring of a machine. Home needs exactly that to draw
a now-playing card, so it travels as a document: **rewritten whole every run, with no history
anywhere.** That difference is the whole justification, and the moment any of it grows a retention
window the refusal has been reversed by accident.

Split by **cadence, not by page** - both pages read both - for the reason `home-server-slow.prom`
already records: a five-minute slice in a thirty-second file blinks out nine ticks in ten and renders
as a sawtooth that looks exactly like a fault. **`sources` is not optional** in either: one
`{ok, at, error}` per upstream consulted, because otherwise "jellyseerr timed out" and "there are no
pending requests" are the same empty list. It is `mode.routes: false` applied to applications.

**POSTERS COME SAME-ORIGIN AND CARRY NO CREDENTIAL, which is measured rather than assumed.** Jellyfin's
`/Items/*/Images/*` answers 200 unauthenticated while every other path on it answers 401 - checked
from inside the Caddy container - so `home.{$DOMAIN}` proxies exactly that, GET and HEAD only,
path-guarded to a 32-hex item id, and a mis-scoped matcher fails closed into Jellyfin's own 401 rather
than opening its API. Not `watch.{$DOMAIN}`: cross-origin, 30-60 images a load through NAT loopback at
the measured 5x, and a poster grid hanging off a route deliberately outside sign-on. Only a **tagged**
request gets a long cache, because the tag is a content hash and an untagged URL is whatever the image
happens to be now. **Test those guards with `curl`, not `caddy validate`** - see the warning that
block already carries.

**An almost-empty Library table is the NORMAL, HEALTHY rendering**, and the page is built for that
rather than for the mock's 47 rows. `queued/` holds no video files because `promote-transcoded.py`
works, and Tdarr's file table drains to zero by design. So there are three empty states saying three
different things, and the important one is that **stale-and-empty reads "no rows as of 8m ago", never
"nothing in flight"** - at eight minutes old that is an assertion nobody is entitled to make. Same
distinction as rendering `mode.routes: false` as "not measured".

**`status.json` is COPIED into a served directory, not mount-mapped, and `:z` cannot fix the
alternative.** The canonical file is written through `sudo`, so it is root-owned inside a `var_lib_t`
directory that `container_t` may not read - and relabelling on a rootless mount is performed by the
*invoking* user, so `chcon` fails `EPERM` because `core` does not own `/var/lib/home-server`. The
mount is accepted and the container gets permission denied. `bin/verify-host.sh` therefore writes
the same bytes a second time, as `core`, into `${DOCKER_VOLUME_CACHE}/dashboard/`. That is the same
shape as node-exporter's textfile drop, which is the one directory here that may safely take a label.

**There is deliberately no log stream**, and the design's slot for one holds Alertmanager instead.
Jellyfin alone emits 2,644 priority-3 lines a day of ffmpeg chatter with no lever to stop it, so a
live tail is noise with a cursor on it. Alertmanager groups, suppresses repeats and reports
resolution - and had no interface at all before this, because its silence endpoint was declined a
public route. It still is: Caddy refuses anything that is not GET or HEAD on that path with a 405.

**`home-server-dashboard-build.timer` IS THE DEPLOY PATH, not just an updater.** This image's
content comes from the checkout rather than an upstream release, and `dist/` is not committed - so a
`git pull` touching `apps/dashboard/src/` deploys **nothing at all** until that timer runs, silently,
while every other change in the same commit takes effect on `daemon-reload`. Nightly rather than
weekly for that reason. `verify-host.sh` asserts it is armed.

**A GUARD THAT ADAPTS, VALIDATES AND DOES NOTHING.** The `home.{$DOMAIN}` block carries two
refusals - 403 on Prometheus' admin API, 405 on Alertmanager's write paths. Written the obvious way,
at the top level of the site block alongside the `handle` directives, **both were dead code**:
Caddy executes directives in *its* order, not source order, and `handle` sorts before `respond`, so
the first matching `handle` terminated the request and neither matcher ever ran. A GET of
`/api/prom/api/v1/admin/tsdb/snapshot` returned **200**. Two things follow, and both are the same
lesson this file keeps rediscovering:

- **The guards live inside their `handle_path` blocks**, where `respond` does sort before
  `reverse_proxy` - which is why the identical construction on `metrics.{$DOMAIN}` has always
  worked. And the matcher there is written against the **stripped** path (`/api/v1/admin/*`), because
  `handle_path` rewrites before the handlers inside it run.
- **`caddy validate` cannot see this class of mistake.** It adapted cleanly both ways. Only a
  request tells them apart, so test the refusals with `curl` after touching that block.

**An expired session is a 302, not a 401, and it is the thing most likely to make this look broken.**
`forward_auth` redirects to `auth.avanserv.com` and `fetch` follows redirects, so an XHR *resolves*
with `res.ok` true and an HTML sign-in page as its body; `JSON.parse` then throws somewhere
unrelated and every panel silently shows nothing. `src/api/http.ts` is the single place that detects
it - a cross-origin redirect, or a `text/html` content type - and it reloads the page, because a
passkey prompt cannot be completed inside an XHR. The reload is rate-limited to once per 30s so a
502 page from a restarting upstream cannot become an infinite refresh.

**A stale dashboard must read as stale, never as healthy**, which is the trap this whole repository
is written around. `src/stores/host.ts` tracks **three independent** freshness primitives, because
each fails in a way the others cannot see: `generated_at` read from the file (not from its
Prometheus mirror, so a dead collector and a dead battery stay distinguishable), the collector's
last success, and `up`. Past threshold the banner appears, panels dim rather than blanking, and the
verdict is `unknown` - **not folded into `fail`**, because "the battery says everything passed" and
"nobody has asked the battery" must not look alike. The same reason `mode.routes: false` is rendered
as "not measured" rather than omitted.

**THE NETWORK PAGE DRAWS WHAT IS MEASURED, WHICH IS NOT WHAT ANYONE WANTS IT TO DRAW.** The obvious
design animates an arrow from container A to container B. **That number does not exist here and
cannot be made to**: `nsenter -n` into a rootless netns is `EPERM` as `core`, and
`/proc/net/nf_conntrack` is root-only, so there is no conntrack view of a netavark bridge at all.

What IS available is a container's bytes on a **segment**, and cheaply, for the exact inverse of the
reason node-exporter's filesystem collector fails. That one cannot read `/proc/1/mountinfo` because
host PID 1 is real root; these are the other way round - rootless podman maps container uid 0 to
`core`, so `ptrace_may_access` passes and every container's `/proc/<pid>/net/dev` is an ordinary file
read from the host. Measured on all 24, not assumed.

So the drawing is **bipartite**: a rail is a segment, a box is a container, and the only line
carrying a rate is the **spoke** between them. Declared routes are a second visual language, shown on
hover, static. **Reachability is asserted by git; motion is asserted by measurement; neither may
borrow the other's credibility.**

**A TWO-MEMBER SEGMENT IS NOT AUTOMATICALLY AN EXACT EDGE**, which was the first rule written and the
first live run disproved it. Every bridge also carries a gateway to the outside. `net-dashboard`
mirrors - `caddy.tx ~ dashboard.rx` and back - so those two really are only talking to each other.
`net-solver` does not: `prowlarr.tx` is 352 KB against `flaresolverr.rx` of **36 MB**, because
FlareSolverr is headless Chrome fetching indexer pages and nearly all of it is internet egress. So
exactness is derived from the data rather than asserted from the topology - and **reconcile on rates,
never on the raw counters**, because containers have different start times and their totals cover
different windows.

**THE TUNNEL IS THE BIGGEST NUMBER ON THE HOST AND THE FIRST IMPLEMENTATION THREW IT AWAY.** gluetun's
`tun0` lives in the torrent pod's namespace carrying **223 MB in and 3.6 GB out** - every byte
qBittorrent and JOAL have moved. It matches no declared subnet because it has no on-link route at
all: gluetun steers traffic onto it with firewall marks and policy routing, so the main table's
default stays on `eth0`. A subnet join therefore drops it silently. It is classified on the kernel's
own `tun*`/`wg*` device naming - not a table of this stack's services - and
`home_server_container_network_unmapped_interfaces` counts anything else that fails to map, written
as an explicit 0 so it can be alerted on.

**Three more things about that collector, each verified rather than reasoned about:**

- **Interface names are not in declaration order.** caddy is `eth0=net-transcode`,
  `eth3=net-ingress`, `eth6=net-media`. Join on the subnet from `/proc/<pid>/net/route`, never on the
  index. And read it **little-endian**: `000A15AC` is `172.21.10.0`, and the obvious byte order
  matches nothing at all, which is silent rather than wrong.
- **The four torrent-pod containers share one netns**, so reading all four reports the same bytes
  four times. `podman ps` reports `Networks: []` for gluetun, qbittorrent and joal and
  `[net-download]` only for the infra container, so emitting only for a non-empty `Networks` list
  attributes the pod once - from podman's own answer rather than a rule in a script.
- **The pod's container is `torrent-infra` while `topology.ts` calls the node `torrent`**, and
  `home_server_container_info{pod}` is **empty for all 24 containers**, so that label cannot bridge
  it. The `unit` label can: `torrent-pod.service`. (Which also means `ServicesPage`'s
  `pod {{ row.pod }}` branch has always been dead code.)

**`apps/dashboard/src/paths.ts` is the second hand-maintained duplicate and the more dangerous one**,
because it cannot be derived in full: `sonarr -> torrent`, `prowlarr -> flaresolverr` and nine others
live in an application's own database, which is gitignored runtime state. So `bin/lint-repo.sh`
**validates** rather than diffs - both endpoints must exist and must **share a segment**, since every
bridge is `isolate=true` and an edge between two isolated bridges draws a route that cannot exist. It
proves a path is *possible*, never that it is *used*, and the module header says so. Proven by
adding `flaresolverr -> sonarr` and watching it fail.

**It could not live in `topology.ts`.** That leg derives segment names with
`re.findall(r'id:\s*"([^"]+)"', topo)` over the **whole file**, so any new object literal there
carrying an `id:` field is read as a tenth network and fails the lint - a booby trap rather than a
check.

**`via` is derived, not declared, because the intersection is often larger than one.** caddy and
sonarr share `net-arr` **and** `net-download`; caddy and jellyseerr share `net-arr` and `net-media`.
Which one podman's DNS resolves at connect time is observable nowhere, so a hand-written `via` would
be a claim nothing supports. Six of the 42 edges are ambiguous this way, and the drawing renders them
as ambiguous.

**Two terminals, not one.** `wan` is inbound and `internet` is outbound, and collapsing them into a
single node is a modelling bug rather than a simplification: `duckdns -> wan` and `wan -> caddy` then
join up, and a path walk cheerfully reports `duckdns -> wan -> caddy -> sonarr` - two real routes
spliced at a place no packet crosses. A terminal also absorbs, so no chain passes through one.

**Motion stops when the data is stale, and dimming alone would not be enough** - the eye reads
movement long before it reads opacity, so a dimmed animation still asserts liveness. Under
`prefers-reduced-motion` the flow is **replaced** by a static magnitude tick rather than paused:
`tokens.css` kills animations with `animation-duration: 0.001ms !important`, which would leave a dash
pattern frozen mid-cycle and indistinguishable from the dotted "not measured" style. That tick is
drawn in both modes anyway, because `fixtures/shoot.mjs` takes still PNGs and is the only visual
review this repo has - an animation-only encoding would be invisible to it.

**Animate by the dash period, never by `getTotalLength()`.** A long spoke and a short one at the same
rate would otherwise travel at visibly different apparent speeds, which is decoration pretending to
be data. For the same reason the graph's viewBox preserves its aspect where `MetricChart`'s does not:
a stretched viewBox advances `stroke-dashoffset` at different apparent speeds on horizontal and
vertical spokes, and `vector-effect` cannot rescue it.

**Tooltips are a component, not the `title` attribute**, because the one that matters most cannot be
an attribute: `MetricChart`'s crosshair already snapped to the nearest real sample and computed its
value, then rendered no readout of either - its own comment promises "the rule, the dot and the
readout all name the same instant" about a readout that did not exist. The component carries three
typed slots, and the third is the point: `caveat` is where "this number is not what it looks like"
goes, so a grey LED meaning *nobody is checking* and a spoke showing an endpoint's total rather than
an edge both say so on screen instead of only in a source file. Native `title` stays for truncation
recovery, where a styled box would be worse than the one the OS positions.

****`src/topology.ts` duplicates what `stacks/` already declares**, which is the shape this file calls
the most driftable thing it has a name for when it rejects split-horizon DNS. It is allowed to exist
only because `bin/lint-repo.sh` parses both and fails on any difference. Discovering it at run time
is not available - no container may run `podman network inspect` - and these files are the authority
anyway, so reading git is more honest than re-deriving it.

**No chart library, and the reason is the gap.** The design is hand-drawn SVG throughout, so
matching it exactly costs less than bending a library into it. What that arithmetic has to get right
is that a Prometheus range query returns *nothing* for a timestamp where the series did not exist,
and `polyline` cannot express a break - it would draw a straight line across an outage, which reads
as "steady" when it means "absent". Lines are built as a `path` with a fresh `M` after every gap.

**Fonts are vendored, not fetched.** `@fontsource-variable/*` self-hosts Spline Sans and Spline Sans
Mono in the bundle, for the reason `apps/jellyfin/custom.css` records at length about the sixteen
`@import` URLs it used to carry. They replaced Geist and Azeret Mono on 2026-08-29, and the reason
is in the design system's own README: the mono is the sans's metric sibling, so a label and its
value sit on the same x-height, and every size and leading in `tokens.css` was chosen against those
metrics. **The family name carries `Variable`** - fontsource's variable packages declare
`Spline Sans Variable`, so a stack naming plain `Spline Sans` matches nothing and falls silently
through to `system-ui` with no error anywhere. `wght.css` rather than `index.css`, because the mono
ships an italic axis this design never sets and `index.css` would pull both: four woff2 files,
latin and latin-ext, one per face rather than three.

**A round is a page now, and the expander is gone.** It was a full-width sibling row - not a child,
because `.row` WAS the grid and anything inside it became an eighth cell and shifted the seven
beside it - and inside that row sat the approval card, the phase transcripts and the event log. The
card alone is around 7,500 bytes of prose, which is the text somebody is actually approving, and it
was rendering inside a table row. `/agents/rounds/<key>` is what replaced it, and being a route
gives it the one thing an expander could never have: **a URL a person can send themselves before
they answer a gate.** It still carries `run.error` and `chain.closed_why`, both **displayed and
never parsed**. The whole row is the link; the key is `roundKey()`'s, which is the collector's own
filename key.

**A deep link makes three absences reachable that the expander could not**, and they are three
different sentences. `fleet.json` has not been read yet, which is *"reading"* and not *"absent"*.
The round is not on the board at all - swept, or a merged round the board hides - in which case the
document still renders and the header says why the row is missing. And the document itself 404s,
which is *"not yet"*, unchanged. `fixtures/fleet.ts` had to gain a **clock anchored at module load**
for the second of those to be testable: a round's key is its start time, so a fixture re-stamped on
every fetch handed out a different key every second, and every deep link in dev landed on *"not on
the board"* however fresh it was. Clicking a row always worked, because the row and the lookup read
the same document - so the fault only ever showed on a hand-typed URL or a reload.

**The refusal this replaced was right when it was written, and is amended rather than contradicted.**
It read: *"it names the gate log rather than linking it: the log is ten megabytes on the host,
outside anything this container can serve, so a link would be an offer the page cannot keep."* All
three clauses are still true - a gate log measured 10.9 MB and 197,160 lines on 2026-08-29, the
container reaches none of it, and it is 0600 precisely because *"if a run ever prints its
environment, the runner's token lands here durably"*. **So nothing links a log. The host renders,
and what it renders is an allowlist**: the prompt, assistant turns, tool calls with their input, the
permission denials and the `result` event's scalars, plus the last 64 KB of a gate log. **Tool
results are dropped**, which is where file contents and command output land - and dropping them is
what makes the redaction affordable, `DOCKER_VOLUME_CACHE` appearing 3,920 times in the raw logs and
17 times in what survives. Every `.env` value of twelve characters or more is then replaced by
`${ITS_NAME}`, and `agents.round_detail` measures that hourly against the files actually written,
because reading the code is not evidence. **An unreadable `.env` skips the render entirely**: a
redactor built from an empty environment looks exactly like one that found nothing to redact.

**The gate used to be "did this round fail", and lifting it was the point.** Keying the opener on
`roundState(r).tone` was right while the panel held only a failure sentence - conduct writes
`closed_why` on every round it closes, "reached the publish path" included, so keying on that field
would have put an opener on every finished row leading to a reason nothing had gone wrong. The
page now holds the approval card, the events and the transcripts, and **a round that went well is
exactly the one whose work somebody wants to read before approving it**. `roundError` still keys on
the tone, so the sentences appear only where there are sentences; the two sources also overlap -
`closed_why` is built as `"the flow failed: <the refusal>"` - and `roundError` prints it once.

**A round's document is fetched when its page is opened, and it is the only non-polled read here.**
~400 KB each and forty on the board: polling would be sixteen megabytes a tick to render a panel
that is usually closed, and `usePoll` could not do it anyway - it fires on construction, so a handle
per row would fetch every round the moment the board rendered. **A 404 is the ordinary state**, not
a failure: the collector writes these on its five-minute tier under a per-run log budget, so a round
can be on the board minutes before its document exists and a round past the sweep's horizon has had
its removed on purpose. `DocumentNeverWritten` already distinguishes it and the panel says "not
yet". The same rule governs a phase inside a document: `rendered: false` carries a reason, because a
phase waiting its turn must not read as a phase that said nothing.

**The key is built twice and the two halves have to agree.** `roundKey()` here and `_round_key()` in
`bin/collect-metrics.py` name the same file from `worktree_id` and `started_at`; a disagreement is a
404 the panel reports as "not yet" for ever, which looks exactly like a collector that has stopped.
`fixtures/smoke.mjs` asserts the shape both produce.

**The approval card is a different text from the one the board has always shown.** `notice.summary`
is the *phone* copy - rendered a phase earlier, hard-bounded at 3500 bytes and then cut to 240
characters on its way into `fleet.json`. The card a person is actually being asked to approve is the
ship-stage rendering, ~7.5 KB, and it was in `conduct.db` the whole time: `report.body["card"]`, and
`dispatch.payload` for `conduct_ship`. **The dispatch copy is preferred** because it is keyed per
flow job, so it survives the next round on the same worktree overwriting `report`, which is keyed on
`worktree_id` alone and holds exactly one row.

**And the card can be answered where it is read.** Approve and Decline post to `/api/approve/*`,
which is the control route's shape for the control route's reason: Caddy discards the client's path
and substitutes one literal, so **the job id travels in the body** - putting it in the URL would be
that guard given away for a convenience. `smoke.mjs` asserts the id never appears in the URL. The
chips key on `control.approve_available`, a **separate** flag from `control.available`: the two
routes are scoped to one flow each, so one token being minted says nothing about the other, and
inferring these chips from the control token would offer a button that answers 401 at the moment it
is most needed. See `docs/agents.md` for the lock that had to be removed to make any of it possible.

**The pull-request column holds the branch until there is a pull request.** conduct pushes it at the
end of dev, minutes into a round that then spends fifteen to thirty in `make check`, so for most of
a round's life that column would otherwise be empty at exactly the moment somebody wants to look.
The `agents/` prefix is dropped for display - `publish.branch_name` refuses a name outside it, which
is the whole boundary keeping a phase off `main`, so it is on every branch and distinguishes none of
them.

**The branch is deliberately not also an action.** The action column answers "what is owed to a
person" and the pull-request column answers "where is the code"; the same destination twice on one
row is the row saying it does not know which of them matters. A merged round is never sent to its
branch either - the history is on `main` now.

**`AGENTS_REPO_SLUG` is a second copy of a fact conduct already has**, because the collector cannot
import a Python module from another repository. **The drift is closed by measurement**: whenever a
round also carries a pull request, that URL contains the real slug, and a disagreement withholds
every branch link rather than following it. The symptom is then a branch name that will not click,
and the collector names both slugs on stderr where the journal keeps it. It is not a `sources` entry
- that vocabulary means "this upstream did not answer, so its rows are absent rather than zero", and
nothing failed to answer; one string in `.env` is wrong.

**The attempt line renders only above one.** "attempt 1 of 3" is on every round that went through
once, which is a line on every row saying nothing. The guard is `typeof === "number" && > 1`, and
the type check is not decoration: `!== null` was what shipped, the collector and the bundle deploy
separately, and `undefined !== null` is true - so a document written by an older collector rendered
literally `attempt  of 3`.

**Four custom properties this page used did not exist.** `--ink`, `--ink-dim`, `--ink-faint` and
`--t-micro` are in no stylesheet, so every declaration naming one was invalid-at-computed-value-time
and the sub-lines silently inherited the row's font and colour. The scale is `--fg` through
`--fg-dim` and `--t-mono-xs`. Nothing failed and nothing warned; the page just quietly looked wrong.

**The mark is design option 1c, and it is raspberry rather than teal, 2026-08-29.** The header
carried a placeholder until then - a 20x20 rounded square filled with `var(--ok)`, sitting in the
same bar as the teal verdict pill, where it read as a second status light rather than a logo. What
replaced it is the house reduced to its roof pitch over two rack units: three stroked paths on a 32
unit grid, so every edge lands on a whole pixel when it halves to 16. It is drawn inline in
`NavBar.vue`, the way `ChipLink` and `PosterTile` already draw theirs, because the ASCII lint rules
out a unicode glyph and an icon package would be a dependency carrying two icons. 20px against the
11px wordmark is the design's own small lockup, so nothing in the header's metrics moved.

**`--brand` became `--accent` on 2026-08-29, and that reversed the paragraph that stood here for a
day.** It said the mark was the ONE element allowed a colour of its own, that teal still meant
healthy AND still meant focus, and that `--brand` had exactly two consumers. The design system the
dashboard was rebuilt on rejects the middle clause outright, and its argument is about this
codebase rather than about dashboards in general: teal did two jobs here, so *"this container is
fine"* and *"you can click this"* were the same colour, and a reader had no way to tell a health
reading from an affordance. The split is by **who is speaking**. Teal says the machine measured
something. Raspberry says a person can act - links, focus, the active tab, the selected filter, the
window picker's pick, the chart crosshair and its readout, and the mark.

**The mark's own hue did not move**, so no raster was re-cut: `#df5d8c` and `#962558` are the same
values under the new names. What changed is that the mark stopped being the only consumer.
`public/favicon.svg` still carries them as hex literals, because a favicon is fetched by the
browser outside the page and can resolve no custom property, and `tokens.css` and the SVG's own
header still each name the other - that duplication is the drift to watch: change one and re-cut
the other.

**The rule that survived is the one about quantity.** One point of emphasis per view, inherited
verbatim: if a screen has more than three raspberry elements, remove two. Teal is still never
sprinkled; it simply no longer means two things at once.

**There was no favicon at all before this.** `index.html` carried no `<link rel="icon">`, so a
browser's `/favicon.ico` fell through the container Caddyfile's `try_files` and was answered with
the SPA shell as `text/html` - a 200, which is why it never looked like a fault.
`apps/dashboard/public/` is new and is vite's static root: copied to the `dist` root verbatim and
unfingerprinted, so the icons land in the Caddyfile's `@entry` bucket at `no-cache`, which is right
for files that are not content-addressed. It holds the first binary assets this repository has ever
tracked, and the ASCII lint's `grep -I` skips them exactly as its own comment anticipated.

**Every raster is cut from `favicon.svg` and nothing else.** One source, four outputs - the `.ico`
at 16/32/48, a 180px opaque touch icon, and 192/512 for the manifest - with the commands recorded in
the SVG's header so a colour change is a re-cut rather than a redraw. The touch icon is opaque
because iOS composites transparency unpredictably, and square because iOS applies its own corner
mask; rounding it here would round it twice.
