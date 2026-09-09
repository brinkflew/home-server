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
left at content width under a hairline.

**THAT WAS ALSO CLAIMED TO BE THE WHOLE OF THEIR PHONE LAYOUT, AND IT WAS NOT.** Measured across
eight widths on 2026-08-29: the three conditions sit on **one line from 1360 all the way down to
760**, and at 640 they break **2 + 1** - intake and quota side by side, worktrees alone underneath.
That is not a layout, it is where the row happened to run out. The two columns are different
widths, the three labels stop aligning, and there is no column left to read down at the width where
reading down matters most.

**So below 640 the label moves to the left of its value.** Three rows, one condition each, labels
in a column of their own, captions indented under their value rather than spanning back under the
label - full width would save the worktrees caption a line and would also put a caption where the
eye is hunting for the next label. It costs about 16px of height against the ragged version and
reads like a readout instead of an accident. Above 640 nothing changed: packed-left wrapping is the
right answer at every width where the row still fits on one line, which is every width above ~660.

**The label column is `max-content` through a `subgrid`, with a measured literal behind it.**
`WORKTREES` is 73px at `--t-label`, so the fallback track is 82px and all three rows share it -
they align on the literal even where subgrid is unavailable. Subgrid is what keeps that true if the
type scale ever moves, which is precisely the failure mode a lone literal has here and which
`fitRole`'s hardcoded 5.9 already cost once.

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

**THE QUOTA CONDITION GAINED A CHIP ON 2026-08-29, AND IT IS A THRESHOLD RATHER THAN A SWITCH.**
`conduct` holds the fleet at the API's `allowed_warning` so that what is left is left for your own
sessions; `spend` says there are no sessions to leave it for, for the life of that window only.
`src/composables/useQuotaHold.ts` is the `useIntake()` of it - one derivation behind the label, the
command and the outstanding-ask memory, so a chip reading `spend` cannot send `quota_pace`.

**The pill still reports what the API said, because that is the reading.** An override does not
change the status; it changes whether the fleet *stops* on it. So the difference is stated in the
line underneath, and that line had to change: `clears in 2d` on its own read as a countdown to when
the fleet resumes, which is exactly what it meant until an override could exist. It now reads
`spending the headroom - clears in 2d`, or - the combination that surprises people -
`spending, but the API is refusing`, because lifting the warning moves the level to `rejected` and
no further.

**No absolute stamp anywhere in it.** The host runs UTC and the household does not, so a rendered
`2026-08-31T14:00:00Z` is a number a person has to convert before it means anything. Every other
clock on this page is a duration for the same reason.

**AND THE RESET TIME NOW GRADES THE READING RATHER THAN ONLY CAPTIONING IT, from 2026-08-31.** The
status describes one model call; the API says in the same breath when the window it was answered
against comes back, which is why `docs/observability.md` removed the staleness arm instead of tuning
it. `agents.quota_headroom` clears on `now >= resets_at` and `AgentQuotaRejected` will not fire past
it - and `quotaTone` read the status alone, so a reading taken at 13:38Z on 2026-08-30 drew amber
all through the following day against a marker whose own `resets_at` said 14:00:00Z, on a fleet that
had gone back to work. **Both halves were already on this page** and nothing put them together. The
pill reads `cleared` once the window has rolled over - including after a rejection, because that
refusal was an answer inside a window that has since ended - and the line under it says
`rolled over 4h ago` where it used to say **"no window recorded"**, about a window whose reset time
was rendered in the tooltip immediately below.

**It could not have corrected itself, either**, which is what makes it worth more than a colour.
Only a model phase rewrites the status in the marker, and the fleet was holding at `REVIEW_CAP` with
three changes waiting to be read - so nothing was going to run, and the amber would have stood until
a person cleared the review queue.

**`quotaWindow` is a pure function for the reason `src/fleet.ts` opens with.** It was a four-line
computed inside `RoundsPage.vue`, which `fixtures/smoke.mjs` structurally cannot reach, so neither
direction of it had ever been asserted - and the composable had never been loaded by the smoke test
at all. The same blind spot as `roundboard.ts` the day before, and the same repair.

**That takes the header to two accent chips**, which is inside the *"more than three raspberry
elements, remove two"* budget and worth restating rather than rediscovering: `disarm`, `spend`, and
the active nav tab.

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
`clientWidth` at four viewports instead, on thirteen routes.

**Three rungs, and they are literals because a media query cannot read a custom property.** 1180 is
the existing `Band` fold. **900** is where the racks gain a scroller, N-up grids fold, tables drop
their lowest-priority columns, and the nav becomes a drawer - **and where the header wraps and
sticks**, which two places said was 640 for as long as the rung had been 900. **640** is where the
page gutter tightens to 14px and tables drop to their essential columns. `1100`, `1280` and
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
element: ten sites in ten files teleport into it and a second target would be two answers to one
question.

**That row had no declared height until 2026-09-09**, so it was a function of what a page teleported
into it - see *The header was a function of its pages* below.

**A LIST OF RECORDS IS STILL A TABLE ON A PHONE.** Six columns do not fit 375px, so `.tbl` gained
**column priority**, one tier per rung: `.p4` drops at 1180, `.p3` at 900, `.p2` at 640, and
`.fold4` / `.fold3` / `.fold2` are lines inside the surviving cell that appear only once their own
column has gone. Nothing is lost, it relocates -
and on the round board the row still links to the round's own page, which holds all of it either
way. `display: none` on a `th`/`td` removes the column outright under `table-layout: fixed`, which
is what makes this one global rule rather than a width recalculation per table.

**DROPPING TWO COLUMNS AT 900 WAS NOT ENOUGH ON THE ROUND BOARD, AND THE TABLET IS WHERE THAT
SHOWED.** The four that remain are `168 + 282 + 140` of **fixed** width, so on an 834px tablet the
task column - the only flexible one - was left **162px**, which is about twenty characters of a
sentence: the same reading the phone had, at more than twice the width. Narrowing the two widest is
what actually hands the width over; `168 + 200 + 112` leaves the task 272px at 834. The phase
cell's own sub line truncates at 200px where it did not at 282, which is the trade, and it carries
a `title`. The alternative was dropping the progress bar, which is the round's only picture of
itself.

**And at 640 the state column was 156px of a 328px table - 48% for one word**, with about 70px of
it empty, while the task itself had 158px. That width was measured twice and both measurements were
right *about the pill*; what neither asked was whether the **column** was still worth its width
once only two of them were left. It folds now: the pill moves into the task cell keeping its left
edge, its dot, its tone and its link to the round, so scanning down for `waiting on you` is
unchanged and the task takes all 328px. The rail moves with it - `--rail` is set on the row rather
than the cell, so whichever cell is first can draw it. The header row goes too: `TASK` over one
column names nothing, and that column no longer holds only the task.

**THE CELL LEADS WITH THE TASK, WHICH IT DID NOT.** It opened with the tracker chip, and that chip
falls back to the **worktree id** when the collector has no task id - see the finding below. The
title is the line that tells one row from another, so it goes first, and everything else is one
wrapping meta line under it: the chip, then whatever the dropped columns handed over. At 640 the
title gets a two-line clamp, which is `FindingsPanel`'s - the only other place here that has to fit
prose into a table cell.

**An absent value arrives as nothing, not as a dash.** Under a column header `-` reads as *"no cost
recorded"*; on an unlabelled meta line it is a dash between two chips, which is how a round with no
pull request rendered `- $2.47` on a phone. `opened none` stays, because that is a claim rather
than an absence. The items carry no separator at all - every one of them is self-labelling
(`ship 4/5`, `took 2h`, `$8.28`), and a separator that has to hide together with its own neighbour
is how the dash got there in the first place.

**The four hand-rolled racks were panned instead, and that was repair rather than design.** Services
floored at ~784px, CI at ~748px, Library at ~666px and the System timeline at 320px before its chart
track; none could shed a column without being rebuilt as a `.tbl`, which was the follow-up each of
them carried. **All four have now had it**: the System timeline and CI on 2026-09-07, Services on
2026-09-08 and Library on 2026-09-09, every one on the `.p4`/`.p3`/`.p2` ladder with a fold under the
surviving column. **This paragraph said "CI and Library still pan" for a day after CI had stopped**,
which is the drift the rule about comments naming "the only section that is" exists to catch - the
sentence was true when it was written and nothing rewrites prose when the code under it moves.
What made the panned racks reachable while they lasted was `Tooltip` gaining a tap-elsewhere
dismiss: a tap has always *opened* one, there was simply no way to shut it.

**The network drawing was panned for the opposite reason: it did not reflow, it shrank.** It was
1498x856 and aspect-preserving, so a 390px panel rendered it at a 0.197 factor - 13px node names at
2.6px, 11px rail labels at 2.2px, and the hairlines surviving intact because they carry
`non-scaling-stroke`. A grey smear of rules connecting things nobody can read. The repair at the
time was a 900px min-width and a pan, which is where its smallest type is still above the 11px
floor - except that it is not: 900/1498 is a 0.60 factor and a 13px name renders at 7.8.

**Closed 2026-09-08, by making the column count an argument.** `layout()` takes one and returns a
different drawing for each, so a narrow panel gets fewer columns and a taller canvas rather than the
same canvas smaller. The fold is derived from the layout's own constants - `gridWidth(c)` is what
three, two and one columns actually need - rather than borrowed from the table ladder: 900 would
leave an 834px tablet drawing ONE column beside 448px of empty canvas, because a table's columns are
priorities and a drawing's groups are not. Scaling UP to fill is safe in a way scaling down is not,
the type floor being a floor; `min-width` on the SVG is where it stops, and below that the panel
scrolls.

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

**THE BOARD DROPS ONLY WHAT NOTHING CAN REACH, SINCE 2026-09-07.** `isSettled` was the whole
filter - closed AND merged - so a lane's entire dead history stayed: eleven rounds on one worktree,
most of them stopped, with the live one somewhere in the list. `roundOutcome` in `src/fleet.ts` puts
a round in one of five classes and the toggle says `show N finished`, still printing its count
whether or not it is on.

**A ROUND IS FINISHED WHEN GITHUB HAS ANSWERED, AND THERE ARE TWO ANSWERS - AND THE FIRST VERSION
OF THIS EMPTIED THE LIVE BOARD.** It called every closed state but `stopped` finished, which is
wrong in the direction that hides the thing a person is meant to act on: `in review` is a pull
request open on GitHub waiting for somebody. Measured on the live host the day it shipped - **19
rounds, of which the only one on the current lane was in review** - so the page drew an empty table
and offered `show 19 finished` over a fleet with two pull requests outstanding.

**`isSettled` HAD THE RULE RIGHT ALL ALONG** and its own comment says why: hiding requires POSITIVE
EVIDENCE. `pr_state` is `unknown` whenever GitHub could not be asked, so a round nobody could confirm
stays - which is why `published` is on the board. It is not a claim that the work landed; it is
nobody having asked.

**`merged` IS ONE ANSWER AND `pr closed` IS THE OTHER, SINCE 2026-09-07.** Both are the question
having been asked and something having come back, which is what `unknown` is the absence of. This
was not a tidy-up: `_control_cancel` ends by PATCHing the pull request shut, so from the day the
board grew a cancel button **every round anybody cancelled landed in `unmerged` and stayed there** -
on the board, with nothing to press, for ever. The class the button fills had no floor.

**`not published` DELIBERATELY DID NOT JOIN THEM**, and that is the next question a reader asks. It
has two causes and `roundState` cannot tell them apart: a person declining is a decision, but
conduct's seven-day `HUMAN_TIMEOUT` is a miss nobody chose. Once the round closes,
`agents.approvals_pending` stops warning and the phone stops reminding, so the row is the last
visible trace of an approval that went unanswered - and hiding an absence of a decision is exactly
what the positive-evidence rule refuses. `fixtures/smoke.mjs` asserts the asymmetry rather than
leaving it to be tidied into consistency later.

**IT CAN TELL THEM APART SINCE 2026-09-09, AND THE ANSWER WAS BEING THROWN AWAY.** conduct's
`_publication` holds the finished Windmill job and asked it one question - *is there a url* - so a
declined approval and a timeout both closed the row with the same two NULLs. Windmill had recorded
the decision all along: measured on `upskald-ship`'s `01a07cbd` of 2026-09-07, `canceled: true`,
`canceled_by: "avs"`, `canceled_reason: "declined from the dashboard"`. `publication.outcome` is
where it goes now - **a closed vocabulary and never a sentence**, which is what makes it readable
here at all: `closed_why` beside it is prose written in another repository, and `roundOutcome`
refuses to branch on that for exactly the reason this column exists.

`declined`, `cancelled` and `settled` are DECISIONS and fold behind `show N finished`, in grey. A
person answering is the strongest positive evidence there is. `published`, `ended`, `abandoned` and
`unknown` are not: `ended` covers a gate timeout and a failed flow, which Windmill reports
identically - `canceled` false, `success` false - so conduct does not claim to know which. **NULL is
"nobody recorded" and never "nobody decided"** - conduct not yet migrated, a backfill that has not
reached the row, a job Windmill has forgotten - so it keeps the amber row, which is the same
fail-open rule `pr_state`'s `unknown` already follows.

**AND THE CLASS WAS WRONG EVEN WHERE THE VISIBILITY WAS RIGHT.** `unmerged` is defined as the class
`roundControls` offers nothing on, and the argument for that is a restart force-pushing over a
branch an open pull request points at - **which was never true of a round that opened no pull
request**. One word was answering two different questions, "keep this row" and "nothing can be done
about it", and the row a person most wanted to act on was the one it silenced. `not published` is
`recoverable` now.

**NO FIXTURE HAD EVER CARRIED `pr_state: "closed"`.** The state was in `roundState` from the
beginning and nothing had ever rendered it, so the class it belonged in was never a decision
anybody made. There is one now, on its own worktree, so `shoot.mjs` draws it.

**TWO EXCEPTIONS, AND NEITHER CONTRADICTS IT.** A `superseded` round's work is on the board under
the round that carried it, so drawing both is the defect that made one task render twice, once
asking for attention nobody owed. And a `stopped` round that is not its lane's current one is
history nothing can reach - conduct keeps one row per worktree, so no control can address it.

**IT DERIVES FROM `roundState` RATHER THAN FROM ITS CONDITIONS AGAIN, and the first version proved
why twice.** Re-testing `pr_url`, `superseded` and the rest got two of eleven states wrong on its
first live rendering. Eleven states in one function and a subset of its conditions in another is a
drift no fixture can see. **This is not the `closed_why` habit**: that rule refuses conduct's PROSE,
written in another repository; this asks this application's own vocabulary, which is derived
structurally two functions down.

**NOTHING IS OFFERED ON A ROUND THAT OPENED A PULL REQUEST.** `unmerged` is on the board - that pull
request is the thing a person acts on - but it is not a round the fleet can take up again: a restart
would force-push over the branch an open pull request points at, which is the hazard the stable
task-shaped branch name already carries. What to do about one of these is on GitHub, and the row
links straight there. So `roundControls` returns nothing for `unmerged` and `finished` alike, and
`fixtures/smoke.mjs` asserts that no hidden round has a button on it.

**`settle` IS THE ONE ACTION THAT DOES NOT NAME ITS ROUND BY THE LANE, and that is the whole reason
it works.** Every other chip reaches conduct's `chain`, which holds ONE row per worktree and moves
to whichever change ran last - so conduct refuses them on the task id and the board offers them only
on a lane's newest round. Task 1640's round was declined on 2026-09-07, the work went in by hand as
a different pull request, and the lane then ran three other tasks: all four chips answered *"this
lane now holds task 1249, not task 1640"*, and the class it sat in offered none of them anyway. A
`publication` row is keyed per flow job and is never reused, so `settle` names one round exactly
however long ago it ran. It cancels no flow, starts no phase, touches no worktree and writes no
tracker stage - it sets one field.

**THE LANE TEST MOVED FROM `roundOutcome` TO `roundControls` WITH IT.** It used to be free: a
non-current round was folded into `finished` and this function never saw one. Now a `not published`
round stays actionable whatever its lane has done since, so the test has to sit where it can disable
four chips and leave the fifth alone. Absence still reads as "not the latest" rather than "probably
this one" - `undefined !== null` is the trap that once rendered `attempt  of 3`, and guessing in
front of a button that closes a pull request is what it guards.

**A ROUND CAN BE ACTED ON FROM THE ROW NOW, AND A STOPPED ONE COULD NOT BE AT ALL.**
`roundControls` returned an empty list for anything closed, so the row a person most wants to act on
was the one with nothing to press; recovery meant moving the task in Odoo by hand and running
`conduct ship --task N --resume` over ssh. `resume`, `restart`, `cancel` and `cancel+requeue` are
new control actions - see `docs/agents.md` for what each does on the host and what closing a pull
request costs.

**EVERY ACTIONABLE ROW OFFERS EXACTLY THREE PRIMARY CHIPS, AND THAT NUMBER IS THE COLUMN'S WIDTH.**
At 132px four of them wrapped onto four lines and made every row of the table 130px tall, which is a
list nobody can scan. `ControlOffer.primary` is a **declared property rather than two lists** - the
board's row and the round's own page still read one derivation, because the last time this
application derived one control two ways the two drawings disagreed, and here the disagreement would
be a chip reading `cancel` that sent `restart`. `cancel+requeue` is non-primary everywhere:
everything it does `cancel` does too except the one tracker write, and somebody deciding to put work
back has gone to read the round first.

**AND `resume` GIVES WAY TO `settle` ON THE ONE STATE THAT OFFERS BOTH**, because the three is a
width and not a preference. It is not an arbitrary choice between them: a round that reached the
publish path finished EVERY phase, so a resume there skips all five and re-runs only the gate and
the squash - it asks the same question about the same commits again, which is the rare intent after
a decline, with `restart` beside it for the common one. On a `stopped` round `resume` is primary
exactly as it was, because half its phases are unfinished and skipping them is the whole point.

**A ROUND WAITING FOR YOUR ANSWER WILL NOT BE RESTARTED BY ONE CLICK.** conduct would accept it,
which is exactly why the board must not offer it as though it were the obvious move: a restart
cancels the flow that is holding the question. `resume` and `restart` are drawn **disabled with a
sentence** rather than dropped - a control that vanishes teaches nothing, and somebody really may
want to restart a round whose card they do not like. `cancel` stays enabled, because it is a decline
that also cleans up.

**THE RESTART FLOOR WAS MEASURED AGAINST THE WRONG CLOCK AND COULD NOT HAVE BEEN MEASURED AGAINST
THE RIGHT ONE.** `src/control.ts` compared `round.started_at` against `restart_floor_sec`; conduct
debounces on its own `restart:<worktree>` control row. So a round started three hours ago and
restarted sixty seconds ago offered an **enabled** chip that conduct then refused. The row reached
no reader at all - `_fleet_control` dropped it under a comment saying nothing on the board drew it -
so the board was answering a different question rather than getting this one wrong. It arrives as
`control.stamps`, and `lastStartedAgo` is the one reader.

**THE WHOLE ROW LEADS TO THE ROUND, WHICH ITS OWN COMMENT HAD CLAIMED SINCE THE PAGE WAS SPLIT.**
Only the ~110px state pill was a link while the `<tr>` carried `.hov`, so the row took a hover
background across its full width and then did nothing for most of it. The link stays - it is the
keyboard path, the middle-click path and what `fixtures/shoot.mjs` reads to find a deep link - and
a click handler covers the rest, skipping anything inside `a, button, input, label, [data-noclick]`.
The disabled chips render as spans and match none of those, which is what `data-noclick` is for.

**THE PROGRESS BAR BECAME A RAIL OF NAMED STEPS.** `done 5/5` was already the line above it, so the
bar drew the same number as a shape and added nothing; a round has named steps in a fixed order and
which one it is on is what a reader is looking for. `ProgressBar` stays - four other call sites are
genuine ratios, and its null-versus-zero contract is right. The names print above the 900 rung and
are dropped below it, where the cell is 200px; each node keeps its own `title`.

**AND THE RAIL HAS SIX STEPS, BECAUSE conduct RUNS FIVE AND A CHANGE TAKES SIX.** The fifth ends
with a pull request; what settles the change is somebody merging it, and until `merge` was on the
rail a round whose work was still sitting on a branch read `done 5/5` - the same reading as one that
had landed. **The step is added in `roundSteps` and never in the collector**: `FleetRound.phases` is
conduct's own declared sequence, and writing a step into it that no `conduct_*` handler exists for
would be the document claiming the fleet runs something it does not.

**IT IS DONE ONLY ON POSITIVE EVIDENCE**, the same rule as the filter one panel up: `pr_state`
`unknown` draws it as not-yet rather than as landed, and a round that will never merge - stopped,
declined, timed out - leaves it hollow, which is what happened. **The word is dropped once conduct's
five are behind it**, because no phase is running: `r.phase` is the last one that ran and `ship 5/6`
reads as a ship phase in flight. `awaiting merge` was the obvious replacement and is worse - it is a
claim, and false on every round that was declined or stopped after publishing. So the fraction
stands alone and the state pill beside it says which nothing it is.

**BOTH HALVES COME FROM THE RUN LOG AND NOTHING ELSE MAY SUPPLY THEM.** `phase` is the phase in
flight and `done` is what is behind it, and neither is a field conduct maintains: `chain.phase` is
the flow's `phase` ARGUMENT - `"ship"`, written once by `chain_open` - and `chain.done` belongs to
the one chain row a reused worktree holds. Reading the first of those blinked the `ship` node
through plan, dev, verify and review for as long as the rail existed, and it read as a phase because
it spells one. **A run row opens at the START of a phase**, so `done` counts only rows whose
`result` is not NULL - conduct's own in-flight predicate - which is also what makes the `at` state
reachable at all. A KILLED run is still done: `abandon_runs` closes it as `killed`, and those are
the steps a stopped round got through. `bin/lint-repo.sh` leg 10 asserts all of it against the same
contract `fixtures/fleet.ts` states, because the fixture stated it correctly and nothing had ever
compared the producer with it.

**AND THE `Right now` CONDITIONS ARE THREE EQUAL COLUMNS AT AND ABOVE 900.** The argument against
that was about a different panel: the header it replaced WAS five facts - conduct, phase, quota,
worktrees, intake - each handed a fifth of 1360 with no primary among them, and the complaint was
never the geometry but that nothing led. The headline has led since 2026-08-29. What packing left
actually produced on a laptop was all three crowded into about 600px of a 1360-1600px panel with the
rest empty - the band's own measurement said they sit on one line from 1360 down to 760, which is a
description of where the row ran out rather than of a layout. Below 900 it packs left again; below
640 the label-left readout takes over unchanged.

**THE ROUND'S PAGE READS WHAT THE HOST RECORDED, WHERE IT USED TO PRINT IT.** Three panels, three
raw dumps:

- **The card is markdown and was a `<pre>`** - ~7,500 bytes of headings, bullets and links shown as
  source, in the one panel on that page whose whole job is to be read. `src/markdown.ts` returns a
  token tree and `MarkdownBody.vue` draws it through ordinary elements, so **there is no `v-html`
  anywhere on a path model output takes**. That is the deciding argument rather than the house
  no-library preference: `marked` returns an HTML string, which means a sanitiser beside it and a
  page behind the household's passkey that is one mistake away from executing whatever a phase
  wrote. The link filter is an **allowlist** of `http` and `https` - `JaVaScRiPt:`, a leading tab
  and `data:text/html` are three ways past a denylist - and a refused scheme keeps its text, because
  dropping the node would hide a destination somebody is being asked to trust.
- **The verdict is a JSON string and was a `<pre>`**, under a heading promising an account of the
  run. `conduct/card.py` already renders the same string and `src/verdict.ts` **mirrors** it rather
  than inventing a second reading: absent gets a sentence, an answer outside the schema is kept
  verbatim because the pinned CLI can retract structured output, and a key this bundle has never
  heard of is drawn under its own name because the four schemas live in another repository.
  `types.ts`'s *"do not parse it"* forbids branching fleet STATE on it, which nothing here does.
- **A transcript was a `kind` label and its payload as itself.** `src/transcript.ts` reads each
  shape: the prompt is the other side of the conversation, clamped to six lines; assistant prose
  goes through the same markdown renderer; a tool call is one line with its input behind a
  disclosure; an `Edit` shows at most five diff lines with what it did not show counted beside them;
  and a refusal names the tool and the reason, keeping the one colour that page already gave it. The
  `result` event - what it cost, how long it took, and the `subtype` that is the only thing telling
  a spent budget from a broken `make install` - was fetched and drawn nowhere at all.

**NOTHING IN ANY OF THE THREE RE-REDACTS.** The host already dropped every tool result and replaced
every `.env` value; a guard in a browser is one an attacker has already got past.

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
| **`apps/dashboard/src/topology.ts`**, compiled in | what `stacks/` DECLARES: segment membership, pod membership and the published ports. It is no longer the only source for any of the three - see the 2026-09-08 section below - but it is still the authority on what was *intended*, which is the half a running host cannot supply |
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

**WHICH ATTEMPT A ROUND IS COMES FROM conduct, AND COUNTING THE GROUPS IS THE WRONG QUANTITY.** The
first version numbered a task's rounds 1, 2, 3... in the order they appear in the window, and the
board drew that against `FLEET_MAX_ATTEMPTS`. The ceiling bounds a CHAIN: `chain_open` selects on
`closed_at IS NULL`, so a task re-picked after its chain closed - a stopped round, a failed flow, a
publication - starts again at 1. Task 1264 was picked three separate times and the round that
shipped it read **"attempt 5 of 3"**. `_fleet_number_rounds` reads `chain_open`'s own count instead,
off `dispatch.payload` for the `conduct_plan` module - durable, keyed per flow job, and unlike
`chain.attempts` not overwritten by the next round, which is the same reason `_round_card` prefers
the dispatch copy of the approval card. Measured over the whole live history: 30 `conduct_plan`
rows, 6 of them a repair or a resume marked `skipped`, and the remaining 24 pairing one-to-one and
in order with the 24 `plan` run rows - though three of those predate the key, so the pairing is
one-to-one and the numbering is not.

**TWO JOINS, AND THE FIRST IS EXACT.** The same payload carries the plan phase's `log` path and
`run.log` is the same string, so where both exist the two are matched by identity. `run.log` is a
migration rather than an original column, so older rounds fall through to the timestamp join - whose
ordering is guaranteed by CONSTRUCTION and not by the measured second: `poll._conduct_steps` commits
the dispatch row before it calls the handler that opens the run row. The floor is the previous RUN
on the lane rather than the previous round, because a plan run with no dispatch of its own - a hand
run, a payload older than the key, a row `reconcile` forgot - would otherwise inherit a stranger's
number off a reused worktree.

**SO A GAP IN THE NUMBERS IS INFORMATION.** A repair re-runs dev and the gate on the tree as it
stands, costs an attempt and runs no planning phase - so it is no row on this board, and task 1254
reads attempt 1 then attempt 3. Excluding those dispatches by the `skipped` key they carry, rather
than by taking the latest row, is what makes the pairing exact: on today's data the two agree, and
they stop agreeing the moment a round's own dispatch is missing. `bin/lint-repo.sh` leg 10 asserts
all four shapes, and the leg beside it is what keeps `FLEET_MAX_ATTEMPTS` in step with conduct's
`MAX_ATTEMPTS` - a copy that stayed at 2 for as long as nothing compared them.

**`chain` IS STILL READ, FOR THE ONE THING IT DESCRIBES ACCURATELY**: the round in flight. It
supplies the approval link and the tracker id, and only to the latest round on its worktree -
letting an earlier one inherit a live chain row would draw a finished round as though somebody were
waiting on it.

**BUT IT CANNOT SUPPLY `waiting_on`, AND BELIEVING IT COULD COST A ROUND 26 HOURS IN RED.** conduct
sets `chain.closed_at` the moment it reaches the publish path - its own work IS done - while the
flow stays suspended on the human gate for as long as nobody looks. Reading the flow job id only off
an OPEN chain therefore made every round waiting for an approval match no notice at all:
`waiting_on`, `link` and `kind` null, the approval summary replaced by the task title, and the open
publication reading `published: false`, so `roundState` fell through to **"stopped"**. `boardRow`'s
`waiting` was gated the same way, so the one round that could be answered showed no way to answer
it. This was true of every approval this fleet has ever asked for; it only became visible when task
1254's was left unanswered long enough to look at. **The host had it right throughout** -
`agents.approvals_pending` warned at 26h and `agents.intake` named it as why the fleet was holding.

**A ROUND'S OWN DISPATCH ROWS CANNOT NAME ITS JOB EITHER, AND THE REASON IS ONE SECOND.** conduct
writes the `dispatch` row about a second before the run row it opens - 12:38:16 against 12:38:17,
on all six rounds of 2026-08-30 - and a round's window ends where the next round on the worktree
BEGINS, measured on the run log. So the last dispatch inside any window belongs to the *next* round,
and reading it made the superseded round claim the live approval. `_round_job` is safe only because
it takes the first match. **`publication.job_id` is the exact answer**, is already joined to the
right round, and always exists when an approval is open - conduct opens that row at the verification
push, and only then can a gate suspend.

**SO `waiting_on: "person"` IS INDEPENDENT OF `closed_at` AND `"conduct"` IS NOT.** A person owing
an answer outranks every other state on the row, open or closed, in `roundState`, `roundAction` and
`byUrgency` alike. A closed round *conduct* owns is history, and drawing that as a live step would
be the mirror error - which is also why `boardRow.moving` keeps its `closed_at` clause: the two look
symmetrical and ask different questions, one about the machine and one about a person.

**THE PUBLICATION JOIN HAD TO BECOME WINDOWED IN THE SAME CHANGE.** Matching on `worktree_id` alone
was invisible while `chain` held one row and is wrong the instant history appears: all ten rounds on
`upskald-ship` would have carried the same pull request. A publication belongs to the latest round
that had already started when it opened - the verification push is what opens that row. Measured:
2 of 11 rounds, and the correct two.

**AND A ROUND'S TASK ID CANNOT BE PARSED OUT OF `run.task`.** That column holds the phase's whole
prompt, which happens to contain the words "(task 1251)". `run.odoo_task` is a column on the conduct
side for exactly that reason. It fills in **going forward only**: every round run before it stays
null and renders a disabled chip. The ATTEMPT line is independent of it: the number is
conduct's own count, read off the plan step's payload, so a round with no task id can still
carry one.

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

**PROGRESS IS `chain.done`, WHICH IS PER ATTEMPT**, so the row keeps printing "attempt N of 3"
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
  `pod {{ row.pod }}` branch has always been dead code. **Closed 2026-09-08**: `svc.topologyFor()`
  resolves a pod's infra container through its unit, and pod membership is read from `topology.ts`
  rather than from a label the collector cannot fill - podman answers `PodName` empty and puts the
  id in `Pod`.)

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

**`/agents/fleet` GOT THE ROUND BOARD'S PASS ON 2026-09-07, AND IT WAS THE SHAPE THAT BOARD WAS
FIXED FOR.** The two views sit one sub-nav tab apart and read as two applications: `RoundsPage.vue`
was rebuilt three times between 2026-08-29 and 2026-09-07, and this one still opened on
`<Band label="Capacity and cost" :cols="3">` - three equal panels about three unrelated things, each
handed a third of 1360 with no primary among them. That is the complaint that produced the Rounds
headline, one rung down. It consumed `--t-mono-xl`, *"the one headline reading"*, nowhere at all.

**The lead is `6 phase runs today` with a live dot, and the band is `Today`.** Not `Right now`,
which is the Rounds band one tab over and would announce this page with the name of the one beside
it - the same reason that header stopped being labelled `Fleet`. Three of the four readings in the
band are gauges conduct resets at UTC midnight, so `Today` names what it holds; memory is the
exception and says its own scope in its caption. **No `ProgressBar`**: there is no denominator for
"runs today", and a bare track is the encoding this store reserves for *"in progress, ratio
unknown"* - the exact defect `idle` cost the board. The conditions under the hairline are cost,
tokens and memory, on the board's `.conds` recipe unchanged, `subgrid` readout and all.

**AND THE HEADLINE HAS A FOURTH STATE, WHICH IS THE ONLY ONE THAT NEEDED WRITING.** `fmt.number(NaN)`
is `-`, so the obvious spelling renders `- phase runs today` on a host the store has no sample for:
a headline claiming a dash ran. Absence gets its own sentence at the largest type on the page, and
`phaseInFlight`'s `undefined` - a branch that had existed since the page was split and that nothing
read - is what keeps *never run* from reading as *idle*.

**SIX TILES AND A CONTAINMENT TABLE BECAME ONE TABLE OF TEN ROWS.** `Windmill and git` drew six
records as a 3x2 grid of cards, which is the thing this document already says a list of records must
never be; `Containment` reproduced `FindingsPanel`'s markup - `c-rail`/`c-id`/`.p2`/`.fold2` against
`rail-head`/`id-head`/`.p2`/`.fold2` - directly above a `FindingsPanel` that already carried those
same three checks, and its own note admitted it. **It is not sorted worst-first**, and that is what
keeps it a different object from the findings below rather than the same table drawn twice: sorted
by kind, the two split the way Prometheus and `status.json` already do - **this one carries the
value, that one carries the prose**, and the id is the join.

**It has a band to itself, which is the band rule rather than a preference.** Beside `Intake` in a
two-column band it was the taller panel by about 450px: a dense ten-row table clamped to two lines a
cell in half the page, with the other half empty below a short one. `Band.vue` states the remedy in
its own docblock - if a panel needs more width than its siblings, give it its own band - and every
finding fits one line at 1360 now.

**The two fourteen-day strips are one panel under one axis.** They were the same fourteen UTC days
from `dailyPeaks`, and only one of them had an axis at all.

**`src/machine.ts` IS THE THIRD TIME THIS REPAIR HAS BEEN MADE AND THE REASON IS UNCHANGED.**
`leadReading` and `preconditionRows` were computeds in a `.vue` file, which `fixtures/smoke.mjs`
structurally cannot reach - the same blind spot as `quotaWindow` and `roundboard.ts`, and both of
these decisions have a wrong answer that renders perfectly. One of them **was** wrong: the
containment tone was hand-rolled and mapped a `fail` check to amber, so the one finding on this page
that pages a phone drew as a warning. `checkTone()` in `src/health.ts` had been right all along.

**And the check ids are asserted against the battery rather than against a second list.** `smoke.mjs`
reads `bin/verify-host.sh` and requires every id the page keys on to be one it actually emits.
`agents.mirror_age` and `agents.checkout_clean` are both plausible and neither exists; the assertion
was proved to fail on both before it was trusted. An id that does not resolve renders grey and *"not
measured"* silently and for ever - which is how the `checkout` caption came to name the wrong
repository for as long as it did. See `docs/known-state.md`.

**Three defects the screenshots found and no build could.** A scoped `.msg` compiles to
`.msg[data-v-x]` - class plus attribute - which outranks `base.css`'s `.fold2 { display: none }`, so
every row carried its finding twice at every width: the same specificity trap the board pays for on
a `ChipLink`, one layer in, and this time the more specific rule was this file's own. `display:
-webkit-box` on a `<td>` replaces `display: table-cell`, so the clamp has to sit on an inner `div`
the way `FindingsPanel` already nests it. And under `table-layout: fixed` the column widths come
from the **first row**, so hiding the `thead` at 640 - which is right, a header over one column names
nothing - moved that to the first body row, which carries no widths: the two surviving columns split
50/50 and every finding wrapped inside half a phone. The `th` hints still govern above the rung.

**AND THE PICKER ON THAT PAGE WAS DRIVING HALF A BAND, WHICH IS THE COMPLAINT `FleetPage.vue`'S OWN
DOCBLOCK HAD ALREADY WRITTEN DOWN.** *"A picker that changes nothing on screen is a lie about a
control"* sat eight lines above two `ActivityBars` strips on a hardcoded fourteen UTC days, beside a
memory chart that did answer it - so moving the window moved one card of two, and the band was
labelled `Fourteen days`, which names a timeframe the picker is supposed to own. Fixed 2026-09-07,
with the strips, the reading order and the register of the prose.

**THE STRIPS BECAME TWO CHART LANES, AND THE ENCODING HAD TO CHANGE RATHER THAN THE SPAN.**
`runs_today` and `tokens_today` are gauges conduct resets at UTC midnight with **no cumulative
counter behind them anywhere**, which is what made the fourteen-bar strip right: a day's peak *is* a
day's total. Tie that to a picker whose shortest rung is an hour and it collapses - one bucket at
1h - and a per-bucket "increment" at any rung would be client-side reset arithmetic reported as a
measurement. So the lanes draw **the gauge itself** over the picker's window: the sawtooth is the
metric, and at 7d each tooth's peak is still that day's total. `dailyPeaks` and `utcDayStarts` went
with their one consumer; `dailyRatios` and `dayStarts`, which bucket into LOCAL days for the
container availability bars, stay and are a different question.

**Three things came with the lane, and the third is the one worth having.** A crosshair readout,
which the strips could not have - `ActivityBars` says of itself that it is *"deliberately not a
chart: it has no axis and no scale, and it is not meant to be read as a number"*, which is right for
sixteen rows of a pod rack and wrong for the only history panel on a page. The window. And
**`useCrosshair` is module-level**, so hovering the runs lane marks the same instant on tokens *and*
on slice memory in the card beside it: a memory spike can finally be read against the run that
caused it. That is why all four ranges are fetched on **one** `options` - a lane on a different
window would draw its cursor at a different instant while looking exactly as correct.

The lane is the shared timeline unchanged - `pages/system/LoadPage.vue`'s now - a name, a plot, a reading with the
window's peak - with two things it does not do. **Only the last lane passes `x-axis`**, so the one
axis per card is rendered by the same component as the memory chart beside it, phone rung included,
rather than by a hand-rolled row needing its own copy of the alternate-tick rule. And **the runs
lane draws failures as a second series** at `opacity: 1` against the brightness ramp, because
dimming them would say a failure matters less than the run it is a subset of. It is the first time
the page says *when* a run failed rather than that one did.

**`Over time`, and the span in the aside.** The label names the axis and not the length of it, so
the picker cannot make it false; the span is `last {win.label}`, derived from the picker itself,
which is the one place it can be stated without being able to drift.

**`Band` gained `stretch`, and it is off by default because a stretched panel is dead air.** Two
panels of genuinely different length must not be equalised - the band rule's answer to that is to
give the taller one its own band, which is what the preconditions table got a week earlier, and
stretching would have hidden that it wanted one. It is for panels of the SAME shape differing by a
line of chrome: two charts on one axis, where a ragged bottom edge reads as one of them having
failed to finish drawing. Here it absorbs 29px. If it is closing more than that, the band is wrong.

**Intake is second on the page and was fifth.** It is the one thing on this view a person can act
on, and it sat under a ten-row table and above a findings panel, buried in a stack of records. The
order is the reading, the control that decides whether there will be another one, the history, then
the evidence.

**FULL CAPS IS THE COMMENTS' VOICE, NOT THE PAGE'S, AND THAT IS A RULE.** In a source file it is an
author arguing with the next one and it earns its place; in a string a reader sees it is shouting at
someone who asked a question. `AN INTAKE THAT HAS STOPPED LOOKS EXACTLY LIKE AN EMPTY BACKLOG`,
`A CEILING IS NOT USAGE`, `THIS IS /var/agents, NOT THIS CHECKOUT` - eight of them on this page and
one on `/ci`, all rewritten in sentence case with the argument unchanged. **Only acronyms and
identifiers keep it**: UTC, SQL, PAT, UI, USD, FETCH_HEAD, WORKER_TAGS, MemoryMax.

**`fmt.compact` is new, and the tokens condition is why.** It printed `289113220` - nine digits
nobody reads and the widest thing in the row. Base 1000 rather than 1024, four lines from
`fmt.bytes`, which does the opposite: these are counts, and a token count divided by 1024 is a
quantity no source publishes. The exact figures moved into the tooltip, where a number you would
quote belongs.

**The two things a fixture could not see, and one it was actively hiding.** No fixture can move a
picker or hover a plot, so both were driven by hand in a browser: the aside going `last 6h` ->
`last 7d`, all four lane paths redrawing, three crosshair rules on screen at once and exactly one
readout naming both series. That run is also what found the third: **the fixture ramp fell off a
cliff at the right-hand edge of every window.** `dayRamp` computes `daysAgo` against a `now` frozen
when the table is built and cached, while the page keeps asking for a range ending later than that -
so every sample past it read `daysAgo = -1`, took another day's factor, and drew the run counter
dropping from 7 to 3 for no reason. It had been there since the ramp was written and was invisible,
because the only consumer was a strip reduced with `max`: a low tail inside today's bucket lost to
the day's peak and the bar was right anyway. `src/uptime.ts` documents the same clamp for the same
reason one function over. The headline and the lane's own reading disagreed on screen the whole time.

**`/ci` GOT THE SAME PASS ON 2026-09-07, HAVING HAD NEITHER OF THE TWO `/agents/fleet` GOT.** What
that page opened on was all here too, in a slightly different arrangement and for longer: no headline
at all, six records as a grid of cards, and a `Containment` panel reproducing `FindingsPanel`'s markup
directly above a `FindingsPanel` carrying the same three ids. It did not use `Band` anywhere - two raw
`<section class="grid-2">` and a hand-rolled head row - so `Band.vue` had exactly one adopter, which is
how a layout rule stops being one.

**The lead is `108 jobs today`, and it was already on the page in column five.** Three `.num mono`
cells a reader had to add up, inside an eleven-column rack, on a host where that is the one number
saying the fleet is doing its job. The sub-line is the tally and what is running; the tone is **the
worst lane's, never the counter's**, because a number of jobs is not itself a fault and a lane that has
stopped reporting is. Grey outranks amber there, on this page's own premise. The conditions under the
hairline are the worst lane's disk, the slice, and the artifact store - where **zero baselines is the
loud case**, since upskald's gate passes on an absent baseline and fails only on an unavailable one.

**The headline's four states are the same four, and the third and fourth are different facts.**
`marker_present == 0` is a host with CI switched off, which every `ci` check reports as a *note* rather
than a finding; a marker present with no counter behind it is a measurement that did not happen.
Collapsing them tells somebody their lanes are fine when nothing is looking, or that their host is
broken when it simply has no CI.

**THE RACK BECAME A TABLE, WHICH ITS OWN COMMENT HAD ASKED FOR.** Eleven columns and 622px of fixed
tracks meant a 748px floor and a sideways pan below it, with the column labels living only in tooltips
- *"a real limitation on a phone and is not fixed here"*, it said, naming the `.tbl` conversion as *"its
own follow-up"*. The shared recipe brings a header row, the `p4`/`p3`/`p2` ladder and a phone rung that
folds into the lane cell rather than scrolling. The eleventh column went with it: `mint fail` was empty
on every healthy lane and `laneTone` already renders `mint failing` in the state pill.

**Two widths were measured in the browser and both first drafts were wrong.** `heartbeat stale` is the
widest label `laneTone` can return and needs 143px with the cell's padding, against a first draft of
104 that truncated *every* state at *every* rung; `3 networks, 0 stray` needs 176 against 136. And
**neither meter has a width**, which is what makes them comparable: under `table-layout: fixed` the
unwidened columns split what is left, so a specified `store` took 104px while `disk` took 526 - two
readings of the same kind, one five times the other, for no reason a reader could see.

**On a phone the health verdict outranks the throughput.** `today` moves behind `.p2` and into the
folded line so `state` can afford its pill: rail, lane and state is 173px of a 330px table, leaving the
lane 157px; keeping the count as a fourth column left 91, which is not `lane 1`.

**Two live bugs came out of it, and both had already been found somewhere else.** The containment tone
was a hand-rolled `status === 'pass' ? 'ok' : 'warn'`, so a *failing* containment check drew amber on
the page somebody opens after `CiContainmentLost` has paged them - and `ci.lane_headroom` and
`ci.runtime_dir` both reach `bad`, so it was reachable. It had been fixed on `/agents/fleet` hours
earlier the same day, with `checkTone()` named as the answer - and this copy was found only because
that page's treatment was applied here, not because anything went looking. An idle lane drew a bare
`ProgressBar` track, which is this store's encoding for *"in progress, ratio unknown"* - the same
call-site defect `idle` cost the round board. **Finding one instance of a call-site defect is not
evidence about the others**, and both of these were the second instance.

**`src/lanes.ts` is the fourth time this extraction has been made**, and `/ci` had had *no* logic under
test at all: `fixtures/smoke.mjs` carried zero `ci.` references while every decision on the only page
this fleet is visible from was a computed in a `.vue` file. Both new assertions were **proved to fail
before they were trusted** - the old ternary fails exactly two of them, `fail` and `note`, and a
plausible-but-absent id fails the battery check. That second proof needed a fix of its own first: a
missing row threw a `TypeError` and took the battery assertion down with it, so the run reported a
crash instead of the drift.

**Four series were collected and drawn nowhere, and one was being fetched twice a minute to be thrown
away.** `slice_pids` was `range()`d on every poll, assigned into the result and never read by the
template; `slice_present`, `slice_memory_peak` and `slice_pids_max` were defined, fixtured and unread.
So `Over time` is one band of four charts on one window and therefore **one cursor** - hover the disk
chart and the same second is marked on jobs, memory and processes. `slice_present` is the guard the
page could not previously build: an absent ceiling means *unlimited* when the slice is live and *empty*
when it is not, and those look identical in every other reading.

**AND THE FIXTURE CLOCK STOPPED WHILE THE PAGE'S DID NOT, ON EIGHT ROWS.** `() => now - 12` **defers
nothing**: `now` is captured once, the table is cached for the life of the process, and the arrow is
already holding a number - so the timestamp is frozen and its *age* grows in real time. Every one of
the eight crossed a threshold a page grades on: the CI rack read `heartbeat stale` on both lanes after
five minutes of `npm run dev`, conduct read stale after nine, intake after fifty-six, and the quota
window rolled over after seventy-two and turned a rejection into *cleared*. It was found by reviewing a
screenshot that contradicted one taken minutes earlier. Same family as the `dayRamp` clamp above, same
cause, and the `() =>` is exactly what made it look correct. Ages nothing grades on - a 41-day boot
time, a container's uptime - keep the captured `now` deliberately.

**The legend named lines it did not match, and it had been right on the only chart it was written
for.** Reported off the live `/ci`: three lanes drawn teal, orange and red under three faint teal
swatches, listed `lane 3 / lane 2 / lane 1`. Three symptoms, one cause. The swatch bound
`background: stroke`, which is the CHART's tone, where a line is drawn at the SERIES' own; it took its
brightness from `bandOpacity` - `0.42 / 0.30 / 0.20` - where a line uses `Math.max(0.5, 1 - i * 0.3)`
- `1.0 / 0.7 / 0.5`; and it ended in `.reverse()`, which the crosshair readout does not, so one
component listed one set of series in two orders. **All three are stacked-chart assumptions.** The
prop's own docblock says where they came from - *"Name the bands under the chart. A stack whose bands
are unlabelled is four shades of teal"* - and on that stack every band shares the chart's tone and
`bandOpacity` really is the ramp, so **none of the three could fail until the prop was reused**. The
correct derivation was in the same file the whole time, three functions away, in the readout.

**`seriesStyle()` in `charts.ts` is the repair, and the point of it is that there is one copy.** The
drawing, the stacked bands, the stacked crosshair dots and the key all call it; `stroke` survives only
for the area gradient and now carries a comment saying so. Two rules it has to encode that reading
either half alone would miss: **a per-series tone is not drawn on a stack**, so the key must not
invent one, and **its `index` is the BAND index there, not the series index** - `stackedAreaPaths`
drops a series with no finite point at all and renumbers, so a host with no swap device would have
shifted every remaining band's brightness. That second one was a live bug, unreachable today only
because all four memory bands are always present.

**Underneath it was a hue that should not have existed.** `LANE_TONES = ["ok", "warn", "fail"]` made
lane 3 red permanently - hue as identity, on a dashboard where hue is status - and fixing only the
legend would have printed that as a formal key. `charts.ts` states the rule in capitals one function
above the ramp, `/system` follows it for the two GPU cards, and `/agents/fleet` shows what hue is
actually for: `runs` teal, `runsFailed` **red because they are failures**. The cost was on screen two
bands up on the same page - the lanes table draws a healthy lane 3's rail teal from `laneTone()`. The
lanes now carry no tone at all and the brightness ramp separates them; **it floors at 0.5**, so a
fourth lane would be indistinguishable from the third and only the legend would name it. The driver
creates three.

**`charts.ts` had never been loaded by `fixtures/smoke.mjs`** - the drawing is a computed in a `.vue`
file, which is the reason `machine.ts`, `roundboard.ts`, `control.ts` and `lanes.ts` all exist, and
nobody had noticed that the module those computeds call was reachable all along. Ten assertions now,
and all four planted defects were **proved to fire** before any of them was trusted: the chart tone in
the fill reproduces `var(--warn)` for a `fail` series, and `bandOpacity` in the line branch reproduces
`0.42 / 0.30 / 0.20` - which are the exact values off the screenshot. Confirmed in a browser
afterwards, because no fixture hovers a plot: the legend, the drawn `stroke`/`opacity` and the readout
now report the same two pairs in the same order, on four plots sharing one cursor and one readout.

## The System page, given the pass the other three had, 2026-09-07

`/agents/rounds`, `/agents/fleet` and `/ci` each had the same pass between 2026-08-29 and this day -
lead with one reading, racks and card grids become tables, the decisions leave the `.vue` file, the
evidence goes last - and **`/system` had none of it**. It was also the page `Band.vue`'s docblock
names as the bento the band rule replaced, still running the twelve-column 7/5 over 4/4/4 grid it
describes, over a `.bottom` of `1fr 1fr 340px` whose third column held two more panels stacked
inside it. It was the largest page in the application, at 1369 lines.

**Seven bands, and the reading order is the one the other three settled on.** Right now, Over time,
Pressure, Hardware, GPU and playback, Alerts, History, then the findings: the reading, the history,
then the evidence. The findings panel was **first** here - a fixed-height scroller clipping its
seventh row mid-height as the page's opening statement - and it is unfiltered, deliberately, because
`/system` is the one place all ninety-four checks live. The tables carry the value; it carries the
prose.

**The lead is `up 41d 06h`, and the tone is the worst condition's rather than the number's** - /ci's
rule verbatim, because a count of days is not itself a fault and a full disk is. It was in the shell
toolbar, in a span capped at `max-width: 210px`, so the live string clipped to `uCore 44.2026...`
and the uptime was never on screen at all; the OS line is the band's aside now and the whole string
fits. Three conditions under the hairline on the `.conds` recipe unchanged - cpu, memory, storage -
and **they follow the crosshair**, which is new: hovering the CPU chart moves the headline's
conditions, all four chart asides and all three lane readings to the same instant.

**THE STAGED-DEPLOYMENT CHIP HAD BEEN DEAD ON THE LIVE HOST AND PERFECT IN EVERY SCREENSHOT.** The
page read `host.fact("staged_version")`. `bin/verify-host.sh` emits `next_version` and the comment at
the rename says which reader it meant - *"the old name was only ever right for half of the states it
was read in. A consumer keying on staged_version wants this."* Nobody updated the consumer. Read from
the live host: `next_version` `44.20260817.3.2`, `staged_version` `null`. **The fixture is the other
half of the bug**: `fixtures/model.ts` emitted `staged_version`, because it was written from the page
rather than from the battery - *a fixture derived from its consumer cannot contradict the consumer* -
so the amber chip appeared in every capture ever taken and on no real machine. `smoke.mjs` asserts
every fact key the page reads against the battery now, the way `PRECONDITION_IDS` is asserted; the
assertion **failed the moment it was written**, on exactly that key, which is the only proof it
needed. The backup keys are built by concatenation - `fact "backup_$key"` - so the extraction matches
the prefix from `check_backup_age`'s own call, which is the trap `lint-repo.sh` leg 9 already paid
for.

**Absence read as healthy in one function and as a failure in the next, four lines apart.**
`fsTone` returned `"ok"` for a ratio that is not a number, so a mount whose size or avail series did
not come back drew a **teal** bar at a NaN width - an unreadable mount as a healthy empty one, against
the rule `tokens.css` states in capitals. `smartLine` read `healthy: health.get(device) === 1`, so a
drive enumerated by `disk_info` and absent from `disk_health_ok` collapsed to `false` and fired the
first branch: **"SMART reports the drive as failing", in red, at the loudest tone on the page**.
Reachable - smartctl can name a model without returning a verdict. `backupTone`, sitting between the
two in the same file, had the right answer all along. `healthy` is `boolean | null` now and both
answer `off`.

**`LANES` carried `tone: "warn"` as a literal on both pressure lanes**, so they were drawn amber at
every value including zero and their readings were coloured with them. That is `LANE_TONES` on `/ci`,
**fixed one page over the day before**, and CLAUDE.md's entry on that one says why this survived:
*"Fixing one instance of a call-site defect is not evidence about the others."* Pressure is graded
from the value now; a saturated encoder stays green, because two NVENC sessions pinning the block at
100% is this host doing its job.

**Four `SYSTEM.*` queries had no consumer**, the same finding the `/ci` pass made. `load1` is drawn -
it catches what `cpuBusy` cannot, since a host stalled on IO has every core idle waiting - and
`diskMediaErrors` joins the SMART line, whose fallback said *"no reallocated or pending sectors"* on
an NVMe while never reading the counter that matters there. `memoryUsedRatio` and `bootTime` were a
second spelling of a number already on the page and were deleted.

**The rack became a table, which `docs/dashboard.md` had already named as its follow-up.** It was
`160px 1fr 128px` - a 320px floor - panned from 900 at a 620px `min-width`, so **on a phone the
Reading column was simply off screen**, which is the entire point of that band. It has the `.p3`
ladder and a fold now, so the peak relocates rather than disappearing, and the reading survives every
rung. The axis lives in the plot column's own `<th>`, which under `table-layout: fixed` is the only
place it stays aligned to it; it goes with the header at 640, where seven ticks in ~94px would be a
grey smear below the type floor and the four charts one band up carry their own x-axis.

**And every one of the measured widths was inert at 640 until the cells carried them too.** With the
thead hidden the width source is the first *body* row, and `table-layout: fixed` then split the
remainder evenly - measured at 390: `[30, 99, 99, 99]`, so `CPU pressure` wrapped inside a column
tuned to 116. The rail had been given this treatment on /ci and nothing else had. Six widths were
measured in the browser rather than chosen, and three first drafts were wrong: `.c-lane` at 150
wrapped two of three subs, `.c-read` at 96 wrapped `0% / 89%`, and `.c-mount` at 108 broke
`/var/lib/containers` mid-path.

**Three tables do not fit in one 1360px band**, which the band rule says to answer by giving one its
own band rather than by squeezing. Hardware is two - mounts and drives - and the GPU table got its
own, **transposed**: it was a metric-per-row grid with a column per card, which is a table drawn
sideways. The record is a card. Reading it the other way is what made `Jellyfin sessions` a row
spanning columns it has nothing to do with; it is the band's aside now, where a fact belonging to no
card belongs. Alerts is full width, which is not indulgence - at a third of the page every
description truncated mid-sentence into a `title` nobody hovers.

**`.bottom`, `.right-column` and the `@media (max-width: 1280px)` block are gone.** That rung was an
invented fourth on a three-rung ladder, and `.right-column` is the fold with no floor this document
already named: a column that became a ROW when it could no longer sit beside the cards, and stayed
one at 375. `Band`'s own 1180 replaces the whole arrangement.

`src/system.ts` is the fifth and last of these extractions. Every new assertion was **proved to fire**
on the defect it names before it was trusted, and each reproduced the original symptom exactly -
including `up -`, which is what the obvious spelling of the headline renders on a host with no facts:
a headline claiming a dash was measured.

## The System page became three views, and its charts stopped disagreeing, 2026-09-08

**`SystemPage.vue` had reached 1,553 lines**, which made it the largest file in the application -
longer than the 1,476-line `AgentsPage.vue` whose split one week earlier is the precedent. It carried
the same defect that commit names: seven bands answering three different questions, so somebody
opening it because their phone had buzzed scrolled past four bands of machinery to reach the alert
that had sent them.

| Route | Answers |
|---|---|
| `/system/health` | is anything wrong? |
| `/system/load` | what is it working on? |
| `/system/storage` | will the disks hold? |

`router.ts` gained its second nested record, and its comment saying Agents "IS THE ONLY SECTION THAT
IS" was rewritten rather than left to rot. `pages/system/SystemLayout.vue` carries the sub-navigation
and the toolbar note; the three children are bare fragments. **The name `system` stays on the default
child** and the parent has none - a record that only redirects is not a destination.

**The alerts are band two on the view `/system` lands on**, under a lead that is one line and three
conditions and costs about 90px. They were band six of seven. The lead keeps its place because it is
what tones the page; everything with detail in it comes after. The list also lost its `max-height:
320px` inner scroller, which existed only because six bands sat below it.

**Splitting cost no freshness and saved most of the fetching.** The stores stay in `App.vue` for the
reason `AgentsLayout` gives - `usePoll` resets `lastOk` on unmount - and only the Prometheus polls are
per view. The single page fetched sixteen range queries and eighteen instants on every pass; health
asks for nine instants and **no ranges at all**, load for sixteen ranges, storage for ten instants.
Health has no chart, so it has no cursor and reads "now" without qualification - and `src/system.ts`
did not change to allow that, because `conditionRows` takes a struct and does not care whether the
numbers came from a range or an instant. That is the return on having extracted it.

**Two more leads, on the one rule already established: one reading, toned by the worst thing on the
view.** `loadLead` reads CPU busy and grades on the worst of the CPU condition and the three pressure
lanes, because the encoder can sit at 100% while the aggregate reads 12%. `storageLead` reads the
fullest mount and grades on it, every drive's `smartLine` and every backup age, because a half-empty
disk that is failing must not headline teal. Both can make `hostLead`'s original mistake -
`fmt.percent(NaN)` is `-`, so the obvious spelling headlines `- busy` the way the first draft
headlined `up -` - and both are asserted in all their absence states.

**Three sibling views cannot all open on the same word.** The lead bands are `Right now`, `Working`
and `Headroom`, and the `storage` condition is labelled `disk` while keeping its id, because it sits
one rung under a sub-nav whose third segment is Storage. This document already records the same
correction for the Fleet band.

### The four charts shared one window, one cursor, and no axis at all

Every axis parameter was a hand-picked literal per call site:

| | height | x-ticks | |
|---|---|---|---|
| CPU | 104 | **5** | ticks 6h apart |
| Memory | 104 | **4** | ticks 8h apart |
| Network | 88 | **3** | 12h apart, `mirror` |
| Disk I/O | 88 | **3** | 12h apart, `mirror` |

So `10:58` under the CPU chart was above nothing at all on the memory chart beside it, and the two
rows were different depths. `/ci` draws the identical 2x2 band at `:height="132"` with **no** tick
override and reads even because of it. The overrides are deleted; the component's default of five is
odd, which matters below.

**`stretch` is only defensible now that the heights match.** `Band.vue`'s docblock sets the test - "it
absorbs a few tens of pixels, not a few hundred - if it is closing a large gap, the band is wrong" -
and it was hiding about 70px of mismatch, which is the failure that sentence describes. What is left
is the memory panel's legend and swap meter, about 45.

### Five defects in `MetricChart`, three of which no screenshot at any width could show

**THE PHONE RULE'S OWN GUARANTEE HELD ONLY FOR THE COUNT IT WAS WRITTEN AGAINST.** Below 640 it hides
`.x-tick:nth-child(even)` under a comment promising it "leaves first and last - the two that anchor
the axis - in place". With **four** ticks it hides the 2nd and the 4th, and the 4th *is* the last:
the memory chart here and the lane axis on `/agents/fleet`, both passing 4, lost their right-hand
anchor on a phone and nowhere else. `:not(.last)` restores the claim for every count, and the class
was already on the element.

**THE Y LABELS WERE LEAVING THE GUTTER AND THEN THE CARD.** `Y_GUTTER` was 46px under a comment
claiming "a label like `14.2 GB` still fits at `--t-mono-xs`". It does not - measured in the browser,
`14.2 GB` is 49px and `16.0 MB/s` is 63. On a desktop the disk chart's axis sat 23px outside its
gutter and **6px past the panel's own left edge**; on a phone, 18px past it, and even `12 GB` spilled
7px. Two charts on every screenshot of this page ever taken had their axis printed on the page
background, which is the defect the redesign was asked for. The ceiling is a rate at three
significant figures - `fmt.bytes` drops its decimal at 100, so `99.9 GB/s` at 63px is the widest
string any format on any page can produce - and the gutters are 70 and 66 against it. The CPU chart
pays 42px of empty gutter for the disk chart's label; that is the trade a fixed gutter exists to
make, and it was simply sized wrong. **The axis and the readout share one `format` deliberately**, so
coarsening the axis to save width would have coarsened the hover value with it.

**THE MIRROR PRINTED THE SAME STRING TWICE WITH NOTHING BETWEEN THEM.** Three deliberate decisions
compose into it: `symmetricExtent` gives every tick a twin, `tickLabel` strips the sign, and the zero
tick was filtered out because "the zero rule labels itself, so a `0` in the gutter is a third thing
saying the same one". **A rule is not a label** - without it, `4.0 MB/s` above and `4.0 MB/s` below
have no anchor at all, on an axis whose whole claim is that it runs in two directions. The label is
kept; the duplicate *rule* is still suppressed, which is what that sentence was actually about.

**THE STACK'S GRIDLINES WERE PAINTED OVER.** Rules are emitted before the bands, at
`oklch(1 0 0 / 0.05)`, under four fills at 0.42/0.3/0.2/0.12 - so the memory chart drew four y labels
pointing at nothing while the CPU chart beside it was fine. A line cannot cover a hairline the way a
fill does. They are drawn after the bands when `stacked`, and brighter, because they cross a fill.

**A FIXED CEILING THAT NO TICK LANDS ON NOW GETS A LABEL.** `niceTicks` never emits above the extent
and a fixed `yMax` is never padded, both deliberate; together they leave a pinned chart with an
unlabelled top edge its own data is welded to. This host's MemTotal is 15.46 GiB, the binary ladder
resolves to a 4 GiB step, so the gutter read 0/4/8/12 and the stack filled to a number the axis never
named. CPU escapes it only because 1.0 sits on the ladder. `ceilingTick` lives in `charts.ts` rather
than the SFC, for the reason every one of these extractions exists, and `/ci` gained the same fix for
free - its lane-disk chart now names the `20.0 GB` budget its own aside always claimed.

**AND THE FIXTURE WAS AGAIN THE OTHER HALF OF THE BUG.** `MEM_TOTAL` was `16 * GB`, which lands
*exactly* on that ladder, so the ceiling was always the top label and this defect could not appear in
any capture at any width. It is the host's own `16208128 * 1024` now. A machine "with 16 GB" never
reports 16 GiB, and **a round number is the numeric spelling of a fixture that cannot contradict its
consumer** - the same failure as `staged_version`, one commit later, in a different type.

### Two more found by looking at the result

**The mountpoint wrapped mid-path on a phone**, as `/var/lib/contai / ners` - the exact failure
`.c-mount`'s measured 176px exists to prevent, one rung down where the rule set it to `auto`. It is
`.p2` with a `.fold2` line now, which is what the priority ladder is for: the column goes and the
fact it carried relocates.

**The shared cursor survived a route change, for keyboard users only.** `useCrosshair` is
module-level and the only thing that clears it is `pointerleave` on a plot - so a mouse user can
never strand it, because reaching the sub-nav moves the pointer off the chart on the way. A keyboard
user does not. Measured both ways: focus the Health segment, press Enter, come back, and without the
`onUnmounted` clear the band aside reads `7 Sep 19:48` instead of `last 6h`, with every value slot on
the view reporting that instant rather than now. The same family as the drawer that opened for a
mouse and not for a keyboard, and only reachable at all because `/system` is three routes now.

Nine defect families, each **proved to fire** by planting the original back before the assertion was
trusted, and each reproducing the original symptom.

## The Services page, and the state it could not draw, 2026-09-08

`/services` was the last page still on the first cut - a hand-rolled 784px rack panned sideways, one
band, no lead, and eight anonymous label/value pairs under it. It got the pass the other five have
had: lead with one reading, the rack becomes a `.tbl`, the decisions leave the `.vue` file, the
evidence goes last. **But the layout was the smallest thing wrong with it.**

**THE PAGE WHOSE JOB IS "IS ANYTHING DOWN" COULD NOT SHOW A SERVICE THAT WAS DOWN.** Every row came
from `home_server_container_info`, the collector builds that from `podman ps`, and **`podman ps`
lists RUNNING containers** - so `home_server_container_running` is 1 for all 28 rows on this host and
can be nothing else, `containerTone`'s `stopped` branch was unreachable in production, and a service
that stopped did not turn red on the rack: **it vanished from it.** The rack was at its emptiest at
the exact moment it mattered most. CLAUDE.md has the outage this shape produced, from the other
side - *"Caddy was down for 35 minutes and three checks looked straight at it: a dependency failure
is `inactive`, not `failed`, and a container that never started is absent rather than unhealthy."*

**`source_units` already knew, and no page in this application had ever read it.** It enumerates the
**quadlet generator directory** rather than podman, in its own words because *"deriving the unit list
from running containers would make this source blindest at the moment it matters most"*. So the rack
is built from `home_server_unit_state{kind=~"container|pod"}` now and a container is joined **onto**
a unit; a unit with no container is a row that says so. The `kind` selector is in the query rather
than in the page, because the fourteen `.build` and `.network` units rest INACTIVE when everything is
well and a rack that drew them would report fourteen healthy networks as fourteen dead services.

**The RESTARTS column read the one counter on this host that cannot be non-zero.**
`home_server_container_restarts_total` is podman's per-container field, a quadlet recreates the
container on every restart, and the collector's own docstring says what that costs: *"Pocket ID
restarted 6,224 times between 00:20 and 09:55 on 2026-08-19 and that gauge read 0 for the whole
outage"*. systemd's `NRestarts` survives, because the unit outlives its containers. The column is
`home_server_unit_restarts_total` now; podman's is kept as a second line **only when the two
disagree**, since that is the one thing it can say the other cannot - a container restarting without
its unit restarting. The memory rule had the same dead clause: `ratio >= 0.98 && (thrashing ||
restarts > 0)` was reading podman's number, so that arm had never once fired.

**Three LEDs with no legend anywhere, and the leftmost had a state nobody can guess.** The page's own
comment said so in capitals. There is **one** dot now, and the state is a **word** in the row at
every width - `healthy`, `unhealthy`, `starting`, `running, unchecked`, `restarting`, `not running`,
`unit failed`, `oom-killed`. The grey-is-not-green caveat survives as the tooltip on the word, which
is the only fact on the row a reader cannot recover from what is drawn.

**"Needs attention" is a FILTER over the array the rack draws**, never a second reading of the same
series - the trap the System page paid for when two surfaces disagreed about what `note` meant. What
it adds is the half a rack has no room for: one sentence saying what is wrong, and **a command**.
Every remedy is a `status` or a `journalctl`, and that is not timidity: this dashboard cannot restart
anything, and a command that changes the host is a decision for the person holding the keyboard
rather than a string a panel prints.

**The applications' own health is drawn for the first time.** An *arr with a dead indexer is healthy
by every container-level signal here - active unit, passing probe - and `home_server_arr_health_issues`
and `home_server_arr_queue_errors` had been collected since the collector existed with **no consumer
at all**. The Applications band reads both, and **names the indexers Prowlarr is backing off** rather
than counting them: `13 of 15` was the whole of what the page could say and which two is the only
part anybody can act on. It sends the reader to Prowlarr's log rather than suggesting a fix, because
CLAUDE.md's measurement stands - six zeros were a dead mirror, its duplicate, two entries sharing one
refusing API host, a 502 and a 403, and not one of them was local.

**Two ordering defects, both invisible in a screenshot until they were looked for.** `.dim` is a
GLOBAL utility in `base.css` meaning *stale* - "opacity 0.42, and desaturating as well as dimming is
load-bearing" - so a scoped `.dim { color: var(--fg-5) }` does not replace it, it **adds** to it: the
two rows with no health check rendered at 42% opacity under a saturation filter, which is this
application's one visual claim that a reading is out of date. It is `.dull` here. And the tone classes
sat **above** the table rules, at equal specificity, so `.num` beat `.warnish` and a unit with nine
restarts printed its nine in the body colour, while `.areading` beat `.bad` and Prowlarr's two errors
read as an ordinary sentence beside a red rail. The rail was right and the value was not, on the page
whose job is making a fault easy to find. They go last now.

**And the fixture was the other half of it, twice.** `fixtures/model.ts` gave all three torrent-pod
members `torrent-pod.service`, where the host gives each its own `.container` quadlet - measured:
`gluetun.service`, `qbittorrent.service`, `joal.service`, with only the infra container on the pod's
unit. A fixture where four containers share one unit is a shape production does not have. And **no
fixture had ever carried a stopped service**, which is precisely why nothing could see that the page
had no way to draw one: `duckdns` is absent from `CONTAINERS` now and present in `UNITS` at
`state: 4`, so the missing row is on screen in dev. `containers.units_active` fails beside it and
`containers.failed_units` **passes**, which is the finding rather than a contradiction.

`src/services.ts` is the fourth extraction of this kind after `machine.ts`, `lanes.ts` and
`system.ts`, and `fixtures/smoke.mjs` covers it in 81 assertions.

## The memory rule reproduced the cry-wolf it was written to prevent, 2026-09-08

The Services page shipped on the 8th and the question that came back the same day was why almost
every service on the rack read **memory starved**. Nothing on the host was, and the reason is one
line.

`memoryTone` ended:

```ts
const thrashing = Number.isFinite(row.refault) && row.refault > 0;
if (ratio >= 0.98 && (thrashing || row.unitRestarts > 0)) return "fail";
if (thrashing) return "warn";
```

**A floor of zero on a rate.** The test was "did this cgroup fault back one single page in five
minutes", and `serviceRows` then escalated the row and rewrote its state word, while `memoryIssue`
printed *"this one is starved rather than merely holding cache"* beside a byte count saying the
opposite. Measured against the host's own Prometheus: a mean of **9 of 27** containers escalated at
any instant over six hours, peaking at **25 of 27**, while the worst working set on the host was
**58%** of its watermark, the worst in six hours **91%**, and there were **zero OOM kills and zero
`max` events host-wide**. tdarr-node-01 was drawn starved at **0.0037 pages per second**.

**The nineteen lines of docblock directly above that line argue against exactly this** - *"a
container at its MemoryHigh is not news, and colouring it amber is the single most likely way this
page would cry wolf"* - and the `ratio >= 0.98` arm they were written for is right. It simply cannot
fire here: it needs a ratio this host has never reached, so **every amber row came from the one
clause with no ratio term in it at all.** The argument was made and then discarded one line lower.

### Refault is file I/O, and it is blind to the shape that matters

`workingset_refault_file` counts a file page re-read after eviction **at any time**, global reclaim
included. On a 15.8 GB host serving a 7.3 TB library that is ordinary work: **eight of the nine
containers the expression selected in one sample had a pgscan rate of zero**, having reclaimed
nothing themselves. Jellyfin refaults 1.14 pages/s with lifetime `pgsteal` tracking `pgscan` to 98% -
the container CLAUDE.md spends a section explaining is fine.

**And no floor on it would have caught the one memory incident this host has had.** A cgroup pinned
by tmpfs refaults nothing: those pages are charged to it and, with no swap, are never reclaimed, so
there is no file cache left to evict. `docs/known-state.md` records what that cost - *"`memory.events
max` and `oom_kill` both stayed 0 for the whole run - `MemoryHigh` throttles, it does not kill - so
no unit failed, no container went unhealthy, no check fired and no alert reached the phone."*

The docblock on the query said the opposite of all this: *"Real starvation, as opposed to a cgroup
doing ordinary file I/O."* That sentence is what made a floor of zero look reasonable.

### The arbiter was published, named as such, and read by nothing

`bin/collect-metrics.py` emits `container_pressure_memory_{waiting,stalled}_seconds_total` under its
own words - *"The arbiter: real starvation shows here, and a cgroup merely holding cache does not"* -
for all 28 containers, since the collector existed. No page had ever queried either.
`docs/known-state.md` names four signals for real starvation: a large `anon`, `pgsteal` falling short
of `pgscan`, a climbing `workingset_refault_file`, **and nonzero pressure**. The rule implemented one
of the four.

PSI is the gate now. Nothing below it is reached without a stall, `full` carries the fail arm and
takes no corroboration, and refault survives only inside the watermark arm - where it separates a
cgroup at its ceiling because of reclaim thrash from one holding anon.

### The floors are the fleet's own thirty days, checked in both directions

Per-container maxima of `rate(container_pressure_memory_waiting_seconds_total[5m])` over 30 days:

| container | 30-day max |
|---|---|
| qbittorrent | 0.01225 |
| bazarr | 0.01031 |
| flaresolverr | 0.00229 |
| jellyfin | 0.00153 |
| tdarr-node-01 | 0.00071 |

So `STALL_WARN` at 0.05 is **four times** the worst reading this host has taken and `STALL_FAIL` at
0.10 is eight, both an order of magnitude below the tens of percent real thrash produces. **The new
expression selected nothing at every ten-minute sample across that whole window**, where the one it
replaces was selecting nine at that moment.

`some` and `full` are two signals rather than one scaled: they diverged in **1,707** of the 30-day
samples, by up to **2,837x**. They coincide at the 30-day peak only because qbittorrent's runnable
set is effectively one task - a property of that container, not of the metric, which is exactly why
both are asked for.

### Three more the same reading turned up

**Absence was being read as health.** `memoryHigh` is a gauge and the PSI series are rates, so a
container in its first minute has a ceiling and no reading - and an absent refault made `thrashing`
false and returned `ok`. It answers `off` now. `serviceRows` still refuses to let memory grey a row,
so the sub-line is the only surface that state has: `memorySubline()` says *"stall not read"*
there instead of the hard-limit ratio. It is one short line rather than a suffix, because `.c-mem` is
132px measured for `100% of high` and a fixed column clips rather than wraps.

**`memoryLimit` had been defined in `queries.ts` since the collector existed with no consumer**, so
the page could not say that every unit here has another 33-50% of headroom above the watermark the
ratio is taken against. It is the second caption line now: `58% of high` over `39% of max`.

**Nothing paged on real container memory trouble.** `apps/prometheus/rules/home-server.yml` had
`AgentSliceOOM` and `CiSliceOOM` and nothing per-container, so an OOM kill inside a service reached
nobody unless the survivor also failed its probe. `ContainerOOMKilled` and `ContainerMemoryStarved`
are new, and the second shares its expression and its floor with the page deliberately - two surfaces
reading one measurement and drawing it differently is a failure this file already records for `note`.

### The fixture could not contradict its consumer, twice over

`fixtures/prometheus.ts` hardcoded the refault series to **840 for bazarr and 0 for the other
twenty-six**, so in dev exactly one row went amber and the rule looked correct at every viewport.
And `fixtures/smoke.mjs` **restated the identical literal independently** - the two files whose job is
to check each other agreed by being the same sentence typed twice. Both read the model now.

`MEM_HIGH` had drifted from `stacks/` under a docblock claiming it matched: bazarr 512 MiB against
1536M, prowlarr 512 MiB against 1G, qbittorrent 1 GiB against 2G, twelve more on a 256 MiB default
while their units declare 64M to 1G. Harmless only while `ratio >= 0.98` was dead code.
**Correcting it exposed a second fiction underneath**: every row carried a flat 64 MiB working set,
which put ntfy-alertmanager at a ratio of exactly **1.000** against its real 64M ceiling, where its
actual working set is 6.4 MiB. A fixture whose every row sits at its limit cannot exercise a rule
about limits. Both tables are the host's measured values now, and the rack carries three rows it
never had: one genuinely starved, one under pressure with a refault rate of **exactly zero** - the
combination the old rule was structurally incapable of drawing - and one too young to have a rate.

**Eighteen assertions fail when the original rule is pasted back**, which is the step that earns
them, and the services block is 81 assertions rather than 53.

## The Network page, and the three things it drew from git alone, 2026-09-08

The last page to get the treatment the other six have had, and - as with Services the day before -
the layout turned out to be the smaller half. Five defects came out of reading it against the
running host, and **not one of them was visible at any viewport**.

### The animation had never run

`NetworkGraph.vue` set `animationDuration` inline on every spoke and `tokens.css` defined
`@keyframes flow`. **Nothing anywhere set `animation-name`.** The only `.flow` selector in the whole
application was the one inside `@media (prefers-reduced-motion: reduce)`, which sets
`animation: none !important` - so the sole rule naming the class was the one turning it off.

Everything built on top of it was correct and inert: the `flowing` gate with its three-poll slack,
`flowDuration()` mapping intensity to a 6s-1s dash period, and three paragraphs in this file arguing
that motion must stop when the reading goes stale because *"the eye reads movement long before it
reads opacity"*. **The only thing that ever moved on that page was nothing.**

It could not be caught by the one visual check this repository has, and for a stated reason: the
magnitude tick is drawn in both motion modes precisely *because* `fixtures/shoot.mjs` takes stills,
so a still of a working drawing and a still of a dead one are identical by design. The rule lives in
the component now, beside the class it applies to; the keyframe stays in `tokens.css`, beside the
argument for animating by the dash period rather than the path length.

### A stopped container drew grey, one page after the same fix

`home_server_container_running` is **absent** rather than 0 for a container that is not running,
because `podman ps` lists running containers. So a stopped service never entered the tone map, `tone()`
fell back to `off`, and `containerTone`'s `!running` branch was unreachable from this page entirely.

**This is the `/services` defect of 2026-09-08, on `/network`, found the next day.** It is the third
instance of the rule this file already states twice - *fixing one call-site instance is not evidence
about the others* - and the second time the answer was "ask `home_server_unit_state`, not `podman
ps`". `src/network.ts` calls `services.ts`'s own `liveness()` rather than restating it, so there is
one liveness verdict in the application and two pages read it.

### The `torrent` box was dead on the host and perfect in dev

`topology.ts` names the node `torrent`; podman names the container `torrent-infra` and the metric
carries podman's name. The graph joined on the node name, so on the live host that box read "not
measured" on every rail. **The fixture built its pairs from the node name too**, so dev drew it
healthy - a fixture derived from its consumer, for the third time in this file.

`metricNameFor()` is the one copy of the bridge, and it is **derived rather than listed**: a node is
a pod if anything declares it as its pod, which is what `podMembers()` answers - dead code until this
change. A hardcoded `torrent -> torrent-infra` would work today and break silently on the second pod.
The fixture now writes `torrent-infra` as a literal, checked against `podman ps`, with a comment
saying why it must not call `metricNameFor()` to get there.

### Three things the collector already had in hand and threw away

`bin/collect-metrics.py` calls `podman ps --format json` twice and `podman network ls --format json`
once, and discarded `c["Ports"]`, `c["Networks"]` and every network field but `subnets`. Three new
families, **zero new subprocesses**, **55 series** against 181 of headroom - 14 networks, 37
attachments, 4 ports, measured on the host rather than counted off a design.

**Not 38 attachments, which is what `home_server_container_network_pairs` reads.** That gauge counts
(container, segment) TRAFFIC pairs and the tunnel is one of them - it is a byte counter with no
podman network behind it, so it is a pair and not an attachment. 37 is what `stacks/` declares in
`Network=` lines and what `podman ps` reports, and the two agreeing is the check this page now draws.

- `home_server_network_info{network,driver,subnet,isolate}` - `isolate` is a **label on an info
  series**, the way `container_info` carries `pod`/`unit`/`image`, because
  `{isolate!="true"}` is a perfectly good alert expression and a second gauge would cost fourteen
  series for no new answer. It reads **empty, never "false"**, when the option is absent.
- `home_server_container_attached{container,network}` - emitted **before** the collector's PID and
  pod-member skips, so membership is strictly more available than the byte counters.
- `home_server_container_published_port{container,host_ip,host_port,protocol}` - **the container
  port is the value**, per CLAUDE.md's rule from `home_server_torrent_listen_port`. A publish is
  identified by where it is bound; the value says where it lands.

**"All isolate=true" was a sentence, not a reading.** The page printed `10 bridges, all
isolate=true` as static text compiled into the bundle, while nothing on this host checked `isolate`
on a stack segment at all - `agents.runner_isolation` and `ci.runner_isolation` both read the option,
and both only on the ephemeral `net-conduct-*` and `net-ci-*` networks. A hand-edited stack network
with isolation removed passed every check in this repository, underneath a page asserting in words
that it could not happen.

**An undeclared network is drawn and never graded.** `net-ci-*` and `net-conduct-*` belong to the
drivers by design, and podman's own default bridge genuinely carries no `isolate` option - so a rule
that only asked "is isolate true" would report a permanent fault on every host, every hour. Only a
segment `topology.ts` declares is judged on it.

**Membership was inferred from traffic, which fails in the case that matters.** The page derived who
was on a segment from whichever `rate(...[5m])` pairs came back, and a rate needs two samples - so a
container restarted inside the window returned no series and dropped silently out of its own
segment. A failed subnet join looked identical to a real detachment, too;
`unmapped_interfaces` counts those globally and names nobody.

### The drawing groups by network, and the multi-homed go on a spine

Ten horizontal rails with boxes packed along each answered "which rail is this on" and answered
"what is on `net-solver`" only by tracing a line - across a 1498x856 canvas with six of sixty grid
cells occupied, nine of ten rails holding five boxes or fewer and five holding exactly one.

A group is a box now and its single-homed members are inside it. **The five that are on more than
one segment are not inside anything**, because straddling a trust boundary is the security-relevant
fact about them and it has to be a line rather than an entry in a list. Drawing a copy of caddy
inside all eight of its groups says the opposite of what is true; giving it a "primary" group makes
its home an artefact of which `Network=` line comes first in its quadlet.

**Multi-homed is the union of declared and live, and computing it from git alone was wrong in the one
case the spine exists for.** A container that has drifted onto a second segment IS multi-homed - it
holds an address on two bridges - and reading only `topology.ts` drew it inside two group boxes, which
says "these are two different things" about one container.

**Elbows route in reserved bands, which is not decoration.** caddy alone needs eight lines reaching
most of the canvas, so anything aimed straight at its target draws through the boxes it passes. Each
grid row has a clear band above it, each spine node owns one lane in every band it uses and one
vertical lane in the left margin, and a line is margin -> band -> down into the group's top edge. No
elbow crosses a group and no two share a lane; `smoke.mjs` asserts both, at all three column counts.

**The radius is clamped to half the shorter adjacent leg**, which is the whole correctness of
`roundedPath()`. A fixed radius on a leg shorter than 2r pulls the curve's start point past the
previous corner and the line hooks back on itself - at whichever corner happens to be tight, and
therefore at one viewport only, because leg lengths move with the column count.

### Four more, from looking at the result

- **The headline counted five and the table listed seven.** `networkLead` counted segment and port
  rows while `attentionRows` also emits the member that drifted. Two derivations of one question,
  which is the defect this application records about the System page's findings strip - and which
  `attentionRows`' own docblock refuses in the sentence above the bug. The headline counts the list
  under it now.
- **One finding printed twice**, a line apart: `net-egress` drew *"membership drift - not running, so
  it holds no address"* directly above `duckdns` drawing the identical sentence. A segment inherits
  its members' trouble for the rail and must summarise rather than copy; only a segment-LEVEL fault
  gets a row of its own.
- **The state column named the wrong thing.** `bazarr` on a segment nobody declared it on read
  `unhealthy`, which is true about bazarr and says nothing about the row - the row is reporting an
  undeclared attachment. A drift row names the drift.
- **The group badge counted the boxes inside it**, so `net-arr` read "2" beside a table row reading
  seven members. It reads the segment's own membership now.

### Two things kept, and one limit stated

The **`WindowPicker` still does not appear**: every number here is an instant query over a 5m rate,
and *"a control that does nothing is a lie about a control"*. It comes back the day this page grows a
traffic-over-time lane.

**There is still no flow matrix and there cannot be one.** `nsenter -n` is `EPERM` as `core` and
`/proc/net/nf_conntrack` is root-only, so a line carries a container's total on a segment and never
traffic to a peer. The regrouping does not change that and the tooltips still say so.

**The straight-line route layer is gone rather than ported.** It drew 48 declared edges centre to
centre between boxes, which across a grouped layout is a thicket, and it silently dropped every edge
touching a terminal - so `wan -> caddy`, the most important edge on the page, could never be drawn.
`wan` and `internet` are boxes on the spine now, and `paths.ts`'s `why` - forty-eight hand-written
one-line explanations, rendered nowhere in this application until today - is in the node tooltip.

## Network and Services became five views, and the drawing became a control, 2026-09-08

**Two pages were left flat, and both had the same shape: one band that was the page.** `NetworkPage`
was 803 lines and `NetworkGraph` - ten segment boxes, a spine of the five multi-homed containers and
an elbow per attachment - was taller than the other four bands together, so a page whose first
question is *"is the segmentation intact"* put its two tables of readings below the fold at every
width. `ServicesPage` was 957 lines with the rack in the middle of it: nineteen units by eight
columns, each row carrying a 24-bar CPU strip, a three-line memory cell and a restart caption, sat
between the sentence that says what to type and the panel that says what the battery found.

Neither was near the 1,476-1,553 lines that forced the two earlier splits. **Height is the measure
here, not lines** - the same complaint the Agents and System splits were about, arriving from a
single band rather than from seven.

| Route | Answers |
|---|---|
| `/network/overview` | is the segmentation intact, and what is open to the host? |
| `/network/map` | how is it wired? |
| `/services/health` | is anything wrong with the stack, and what do I type? |
| `/services/list` | what is each service doing? |
| `/services/apps` | what do the applications report about themselves? |

Four of the seven tabs are sections now, so a flat page is the exception. `router.ts`'s opening
sentence and the Agents comment saying System was the only one to follow it were both rewritten
rather than left to rot, which is what the System split did to the Agents comment one day earlier.

**`/network` and `/services` are redirects rather than destinations, and `SubNav` is why.** It
matches on `router-link-active` and not the exact class, deliberately, so that
`/agents/rounds/<key>` keeps the Rounds segment lit - which means a segment pointing at `/network`
would also stay lit on `/network/map`, because one path is a prefix of the other. The name stays on
the default child for the reason already recorded: a record that only redirects is not a
destination.

### The drawing lost the tables it filtered, so a click had to mean something else

Clicking a segment or a service used to filter the two tables under it. Those are one view over now,
so a click **navigates**: `/network/overview` with `?focus=` set and `#segments` on the hash. The
selection was already in the URL - it was put there so a filtered view is a thing somebody can send
to somebody else - and that is what made this a two-line change rather than a new mechanism.

**The map holds no focus of its own**, and passes `:focus="null"`. Lighting one box on a drawing
where the filter has no visible effect is a control that does nothing, which is the rule the
`WindowPicker`'s absence from this section has always been about. `NetworkGraph` still emits `null`
for its two clear paths - clicking the lit node, and Escape - and both are ignored here.

**The hash needed `scrollBehavior`, which this router had never had.** vue-router does nothing with
a hash unless asked, so the handoff would have landed the reader at the top of a page whose filtered
table is two bands down, silently and at every width. It returns `undefined` for a hash-less
navigation, which is the default behaviour the other six pages already had, so nothing else moved.

The focus chip moved with the filter. *"showing X / clear"* used to sit on the drawing's band; it is
on the Segments band now, beside the first table it filters, and Published ports says *"filtered to
X"* rather than silently shortening.

### One derivation, two views, and now two pages

`ServicesPage`'s own docblock carried the argument before there was anywhere else to put it:
*"'Needs attention' is a FILTER over the same array the rack draws - never a second reading of the
same series, which is how the System page came to draw one finding two ways and disagree with itself
about what `note` meant."* Putting the filter on `/services/health` and the rack on `/services/list`
is exactly the pressure that produces that second reading, so the poll and its shaping became
`composables/useServiceRack.ts` - one function, two callers - rather than ninety lines copied.

**`activity` is the one thing the two do not share.** The 24-bar CPU strip is the only range query
on the section and only the rack draws it, so health passes `activity: false`, fires sixteen
instants and no range, and does not depend on the time window at all. That is what lets the
`WindowPicker` teleport from `/services/list` alone - verified in a browser, both directions.

`/network` went the other way and both views share `useNetworkReadings.ts` whole. The drawing is
`graphModel(segmentRows(...))` and the Segments table is `segmentRows(...)`: the same array drawn
two ways, so nine of the eleven queries are wanted by both, and trimming `ports` and `unmapped` off
the map would buy two instant queries at the price of a second return shape. Only one child is
mounted at a time, so nothing is fetched twice.

### Three views cannot open on the same word, and neither can a band and its own tab

The five opening bands are `Right now` and `The segmentation` for network, and `Right now`, `Every
service` and `What they report` for services. **Two of those are renames the split forced**: the
rack's band was `Services` under a segment now called Services, and the applications band was
`Applications` under a segment called Applications - the correction this document already records
for the Fleet band, twice more.

### Three views without a lead, deliberately

`networkLead` stays on `/network/overview` and `servicesLead` on `/services/health`, and no new lead
function was written - `src/network.ts` and `src/services.ts` did not change at all, which is why
`fixtures/smoke.mjs` needed no new assertion and every existing one is the regression test for the
move. The three views without a headline each **are** the reading: the graph's box colour is the
measured liveness verdict, its group edge is whether the segmentation holds and its elbows are
measured bytes; the rack is sorted worst-first with a tone per row; every applications row carries
its own tone and its own sentence. A headline over any of them would be a second reading of the same
array. `/agents/rounds/:key` had already established that a sibling view may have no lead.

### What proved it

`fixtures/shoot.mjs`'s `routes` array is the only thing in this repository that enumerates them, and
its comment spoke only of `/system`; it lists every view of every section now, which is sixteen
entries against a nav of seven. Baseline before the split was **43 problems, all of them the one
expected missing-poster 404**; after it, **52 - exactly three new routes times three viewports of
the same 404**, with no console error, no page error and no horizontal overflow at 1360, 834 or 390.
The handoff itself was checked in a browser rather than reasoned about: both redirects, the click
landing on `/network/overview?focus=net-solver#segments` with the table filtered to one row and the
page scrolled 313px to it, `clear` restoring all fifteen, a hand-typed `?focus=nonsense` still
self-clearing, and the range query fired by the rack view and by no other.

## Home and Library got the pass the other five had, 2026-09-09

`/home` and `/library` were the last two content pages with none of it. Measured before the change:
every other content page carried between one and four `Band`s and most carried the headline reading;
`HomePage.vue` had **no `Band`, no `.tbl` and no `--t-mono-xl`** in 361 lines, and `LibraryPage.vue`
had **none of the four primitives at all** - no `Band`, no `PanelBox`, no `.tbl`, no headline - and
not one media query in 285 lines of scoped CSS.

**Neither page is a split, and that is the decision rather than the omission.** The splits were
forced by height: Agents at 1,476 lines, System at 1,553, and Network and Services at 803 and 957
where one band *was* the page. 361 and 576 are nowhere near it, and a sub-nav over two bands would
be symmetry bought with the one thing the ladder is short of. Four of seven tabs are sections; these
two stay flat, as `/ci` does.

### Library was the last hand-rolled rack, and `base.css` had said so all along

The rebuild onto `.tbl` is a follow-up this document already carried. Seven columns on the
`.p4`/`.p3`/`.p2` ladder: `detail` goes at 1180, `progress` and `size` at 900, `state` and `rate` at
640, where the state pill folds into the title cell keeping its left edge and its tone - the round
board's answer, for the round board's reason. The `--rail` is set on the **row** so whichever cell is
first draws it. The 520px inner scroller is gone: a list that is the reason the view exists must not
hide its tail behind an inner scrollbar, which is the argument Alerts settled when it became band
two on `/system/health`.

**`c-state` is 128px and was measured, and 118 was wrong by one pixel.** With the column widened out
of the way the nine pills measure 46 to 102px - `no subtitles` is the widest - and the cell carries
24px of padding. At 118 the cell offered 94 and `downloading` wanted 95, so it ellipsed to
`downloadi...` at every width above the rung that drops the column. That is the trap the round
board's state column already paid for, in the same words: a pill is a flex item with the default
flex-shrink, and the ellipsis fires on the fraction two integer readings have already rounded away.

**`no_subtitles` had no fixture row and is the state that decides that width.** It has been in
`FileState`, `STATE_TONE` and `STATE_LABEL` since they existed and had never been rendered, so
nothing could see that its label is the longest of the nine. It is also the state this host has most
of: 543 episodes in the fixture, 1,109 live.

### The two headlines, and the arithmetic one of them has to show

`/home` leads with **"5 things happening"** over `2 watching, 3 in flight`, and `/library` with
**"3 in flight"** over `1 downloading, 1 transcoding, 1 queued`.

**Home's headline sums two of its three conditions, and the sub-line exists to say which.** A
pending request is somebody waiting on a person in another application - it is not a thing
happening, so `REQUESTS` is a condition and not an addend. It is also **never amber**: toning it
would put the front page in warning for as long as anybody had asked for anything, which is the rule
that cried wolf with a different subject.

**"In flight" is work the pipeline still owes: the three live states plus `queued`.** `queued` is
`steady` to `stateClass` because nothing about it animates, but it has not landed either, and a
headline counting only what moves would read `nothing in flight` over a table with a hundred queued
rows in it. `seeding` and `done` are excluded because both *have* landed - and with eight permanent
seeds on the live host, including seeding would make the number a constant.

**One filter answers three readings.** `inFlightRows` is what Home's condition counts, what
Library's headline counts and what Library's `in flight` chip both counts and filters on. The page
previously carried a hand-written `ACTIVE_STATES` beside a `stateClass` that already answered the
question - two groupings of one question, which is the drift `roundOutcome` was written to close and
which `networkLead` demonstrated by counting five while `attentionRows` listed seven.

**Three states before the number, and the last two are why these are functions.** Both halves of
Home's total come from `activity.json`, so with no document there is no total and `${NaN} things
happening` would be a headline claiming a dash was measured. A document that answered and then aged
is a different fact: the number stands and goes grey, because it was true then. `hostLead` makes the
same split for the same reason.

### Grey meant measured-and-zero, which is the recorded defect facing the other way

The first draft of both condition sets answered `off` for a zero, so a host with nobody watching and
nothing in flight - **its ordinary state**, the one `HS_FIX_EMPTY` exists to render - drew a grey
headline reading "nothing happening", in the encoding this application reserves for "nobody asked".
`fsTone` and `smartLine` were rewritten because absence read as health; this was health reading as
absence. `ok` is the ordinary body colour rather than green, which is exactly what a fact that was
measured and is fine should render as. Caught by an assertion, not by a screenshot: it renders
perfectly either way.

### Two defects a fixture could not have shown, and one only the rendered text did

**The media disk had no tone at all.** Library computed `{ mount, total, used: total - free }`
itself, with no ratio, so a media disk at 95 percent rendered exactly like one at 20 - on a mount
`/system/storage` grades correctly two pages away. It goes through `mountReading` and `fsTone` now,
and `system/HealthPage.vue`'s docblock had already stated the rule it broke: *"a second copy of that
arithmetic is how the two would start disagreeing about which mount is full."*

**A stalled row drew a bare `ProgressBar` track**, which this store reserves for "in progress, ratio
unknown" - so the one encoding meaning *it is moving* was drawn on rows that had stopped. The bar is
omitted where `progress` is null and the dash stands alone. Fourth call site to make this mistake;
the contract has been right every time.

**Home's in-flight sub-line read `2 errors, 2 stalled` under a value of `3 files`**, which invites an
arithmetic that is wrong - the stuck rows are a different set and none of the four was among the
three. It is a count now, `4 need attention`, and the split belongs to `/library`'s own attention
condition where the value it qualifies is the one it is about. **Found by reading the text
`shoot.mjs` dumps**, not by any assertion, and it is the clearest case yet for that dump existing.

### Seven metric families nobody had ever asked for

`home_server_library_*`, `requests`, `subtitles_*`, `subtitle_provider_*`, `pipeline_*`, `search_*`
and `seeding_*` are published on every collector run and Prometheus has kept four hundred days of
them. **None of them was named in `src/queries.ts` and none was read anywhere in the bundle.** This
is not the "fetched and drawn nowhere" defect the other passes found - these were never asked for at
all, so both media pages were built entirely from two documents that carry the working set and no
history whatever. "Is the subtitle backlog going up or down" was a question this application could
not answer about a number it printed.

`MEDIA` is in `queries.ts` and in `ALL_QUERIES`, so `uncovered()` covers it. `/library` draws four
lanes on one window and one cursor. Nothing from the applications themselves: the *arr queues, the
indexers, the Tdarr queue and the torrent rate are `/services/apps`' already, and drawing them again
would be one measurement on two surfaces.

**`libraryBytes` is `stage="transcoded"` only.** `queued/` is a staging area that drains to zero by
design, so stacking it would draw the pipeline working as if the library had grown. The live host
also has a `documentaries` series in `library_records` and in neither `library_bytes` nor
`library_files`, so a stacked chart legitimately gets a series present in one query and absent from
its neighbour - the fixture carries that asymmetry rather than tidying it away.

### Two numbers for one word, and only the live host could show it

**`home_server_subtitles_missing` and `home_server_subtitles_wanted_items` are not the same
quantity**, and the first draft of this page drew one in a panel directly under a condition printing
the other. `_missing` counts missing subtitle FILES across every configured language and reads
**1,109** on the live host; `_wanted_items` counts ITEMS wanting at least one and reads **626** -
and 626 is what `library.json`'s `no_subtitle_episodes` carries, which is what the condition prints.
Two numbers labelled "subtitles" on one page, disagreeing by 483, with nothing on screen to say they
measure different things.

**The fixture could not have shown it**, because a fixture has one number per series and cannot
contradict itself; catching it needed reading the live documents beside the live exposition file.
That is the rule about a fixture derived from its consumer arriving from a third direction - not
"the fixture agrees with the page", but "the fixture cannot disagree with itself". The chart draws
`_wanted_items` now and `_missing` is not catalogued, with the reason recorded at the query.

The same class, checked and cleared one panel over: `Library on disk` totals 777 GB of transcoded
library where the media disk reads 991 GB used of 8.0 TB. Those differ correctly - the disk also
holds what is downloading and what is still seeding - and the panel note now says so, because two
byte readings on one page that do not add up is a question a reader should not have to answer
themselves.

### Three ways the history band was drawn wrong, and MetricChart had said so

**The library chart was `stacked` with no `yMax`, which the component's own docblock forbids** in
those words: a stack is *"only honest with a `yMax` naming the total the bands add up to"*. Two
libraries sharing a disk is an accumulation, not a partition of a known whole, so there is no such
total - and drawn stacked and unpinned it filled the frame to an unlabelled top edge at 778 GB with
the highest tick reading 512 GB. That is the welded ceiling this document already records for the
memory chart, reached from the other direction: not a fixed ceiling no tick lands on, but no ceiling
at all. Two lines lose nothing here, because each library's own growth is the reading.

**Only one of the four charts carried `x-axis`**, so three of them had no time reference and the
fourth was taller than its neighbours - which `Band.stretch` then absorbed, hiding the mismatch it
exists to absorb only a few tens of pixels of. Every chart in the 2x2 band on `/system/load` and on
`/ci` carries its own axis; this one now does too, and all four print the same five instants. That
is the rule this document states as *"a time under one chart was above nothing on the one beside
it"*. Measured after: an 18px spread across the four, which is what `stretch` is for.

**The subtitle series was a pure ramp and drew a dead-flat line.** At 34 a week it moves 1.2 units
across a six-hour window on a 0-700 axis, so the panel whose whole point is the slope drew none at
the default window. A backlog does wobble - episodes arrive and get subtitled all day - so the
fixture wobbles and drifts, and the slope is visible without being invented.

### The evidence band, and the fixture that could not exercise it

`/library` ends with `FindingsPanel` over `['search', 'seeding', 'torrent']`, which is six checks and
the only page that asks for any of them. **No fixture had ever carried a check from any of the three
sections**, so the panel rendered "absent from the battery's last run" - the panel being honest about
a fixture that could not exercise it. The six are in `fixtures/model.ts` now with the live battery's
own ids and wording, and `search.stalled_queue` is a **warn** deliberately: a stalled download is
silent, blocks every alternative release with `already meets cutoff`, and ten episodes sat at "no
connections" for 225-243 hours before `bin/clear-stalled.py` existed. A fixture where the one finding
this band exists to surface always passes is an empty panel nobody would notice had stopped working.

It is on `/library` and not on `/home` for the reason the fleet page's containment table was deleted:
the same findings drawn on two surfaces is a pair that can disagree.

### `src/media.ts` is the sixth of these extractions

It was 190 lines of presentation vocabulary and is the section's source module now, the way
`machine.ts`, `lanes.ts`, `system.ts`, `services.ts` and `network.ts` each became one. Ten computeds
moved out of the two `.vue` files. **One module for two pages, deliberately** - Home's condition,
Library's headline and Library's chip are three readings of one array, and a module boundary is what
stops them becoming three derivations.

Thirteen new assertions, and **every one was proved to fail before it was trusted** by planting the
original defect back: the queued clause dropped from `inFlightRows`, seeding counted, requests added
to the total, the absence branch deleted, a stale document still claiming it is now, requests toned
amber, the subtitle backlog graded, a missing subtitle treated as a fault, a measured zero read as
unmeasured, an unreadable mount drawn as an empty one, `stale` collapsed into `fresh`, the chip
filtering on a different list from the one it counts, and the request age spelled with false
precision. Each was caught by the assertion written for it and by no other.

### What proved it

`npm run build`, `node fixtures/smoke.mjs`, `bin/lint-repo.sh` and `node fixtures/shoot.mjs` at 1360,
834 and 390. **The first shoot found a real defect the assertions could not**: `/library` reported
**91px of horizontal overflow at 390**, which is five filter chips in a non-wrapping `inline-flex` -
450px of segmented control in a 328px panel. `.hscroll` would have been the wrong answer, because
`base.css` reserves panning for a grid that genuinely cannot shed a column and a filter nobody can
see is a filter that lies; the row wraps instead. Silent on touch until something looked, which is
the whole argument for that assertion.

Column widths were then measured at all three rungs rather than reasoned about: the title cell gets
357px at 1360, 408 at 834 with `progress`, `detail` and `size` gone, and 189 at 390 - up from 169,
because `c-act` narrows to 84px there and the title takes a two-line clamp, the round board's answer
again. Final count **52 problems, matching the recorded baseline exactly**, all of them the one
expected missing-poster 404, with no console error, no page error and no overflow at any viewport.

## The header was a function of its pages, 2026-09-09

The report was that navigating moved the layout a few pixels.

**IT DID, AND THE HEADER HAD NO HEIGHT OF ITS OWN, WHICH MADE IT A FUNCTION OF ITS PAGES.** `.bar`
was 28px of padding plus whatever its tallest child happened to be, and the tallest child is
sometimes the toolbar: `WindowPicker` is 34.19px against an inactive tab's 32.14px, so `/library`,
`/ci`, `/system/load`, `/services/list` and `/agents/fleet` rendered a **63.19px** header and the
other eight a **61.14px** one. The header is not sticky above 900, so those two pixels moved the
whole page body every time somebody navigated. It is the defect that was reported.

**And two places said the header wraps and sticks at 640**, which has been the 900 rung since the
drawer moved. `base.css`'s ladder and the paragraph above both said it; `NavBar.vue` was the only
file that was right.

**The band nobody had sampled was twenty times worse.** `.toolbar` is the only child that can give
way - `.left` and `.verdict` are both `flex: none` - and between the 900 rung and about 1180 it is
crushed to 32-231px, at which point the teleported *text wraps inside it*. `overflow: hidden` does
not prevent that: it clips horizontally and grows vertically, which is the one direction that moves
the page. Measured at 901: `/home` **90.56px**, the three Agents routes **83.00px**, the note routes
65.00 and `/library` 63.19 - a **27px** spread.

**And the toolbar is 0px wide there**, which is what made it invisible as well as unmeasured. The
payload is clipped to nothing and its wrapped lines still push the height: `read only` two lines,
`asks the fleet` three, `/home`'s two freshness readings four. So `/home` was 29px taller than it
needed to be **for content that was not on screen at all** - a header growing for something nobody
could see, on a page whose own body then started 29px lower. Three rungs make four *bands* and the
walk sampled three of them; this was the fourth.

**So the row is declared: `--bar-row: 35px`, a floor on `.left` and on `.toolbar`, and
`white-space: nowrap` on the toolbar.** 35 is `ceil(34.19)`, the picker measured, and it clears the
34px `.menu` button and the 34px a `ChipLink` becomes under `(pointer: coarse)`. Every route now
reports exactly **64px** at 1360, 1180, 1024 and 901, and exactly **109px** at 900, 834, 640 and
390. `--bar-row` rather than `--row`, which `tokens.css` already spends on a gradient - it has no
consumer, but page content is teleported *into* this subtree and would have been handed `35px` for a
background.

**It is a floor in the CSS and a ceiling in the harness, and that division is the point.** A
`height` would slice an over-tall payload in silence, since the toolbar clips both ways; a floor
lets one grow the header where `fixtures/shoot.mjs` can name the route. The check carries **no
number** - it asserts only that every route agrees at a given viewport - so moving the row
deliberately is one edit that the check follows rather than fights.

**The cost is named rather than implied.** Below 900 the header is a constant 109px against
88.4-107.2 before, so nine of the fourteen routes pay 18px of sticky header on a phone. 35 is
already the smallest constant available. The lever, if it is ever too much, is the bar's own 14px
padding below 900 - never the row, which is what a control needs to be.

**`WindowPicker` never wrapped, and its comment said it did.** It carried `flex-wrap: wrap` under a
comment claiming it wrapped *"rather than losing 7d off the end"*, with `flex: none` on the next
line setting `flex-shrink` to 0 - so the box is its max-content width at every width and the wrap
could not fire. Measured on `/system/load`: 165x34.19 at 1360, 1180, 1150, 1100, 1000, 950 and 901
alike. **What actually happens is the thing the comment said it avoided**: `7d` is off the clipped
edge from about 1130 down, and at 901 the toolbar is 0px wide. The dead declaration is gone; the
clipping is a separate open question about what that band should *do*, and a scroller there is ruled
out because `base.css` gives one a 9px bar - which would put the header's height back under the
control of what a page teleported.

### The page that never got the recipe, and the property nothing defines

`network/OverviewPage.vue` was the eighth lead panel and the one that never got the shared recipe.
Seven were byte-identical on five values and it differed on all five - a 5px `lead-sub` rather than
7, a flat 10px `conds` gap rather than `--gap`/`--gap-lg`, 14/12 rather than 15/14, a 3px `cond` gap
rather than 5 - and its two rungs were different too: it folded three columns to two at 900 and to
one at 640 where the others go `flex-wrap: wrap` and then to the label-left subgrid. So its panel
was about 5px shorter than the same panel everywhere else, and nobody could see it, because the
comparison is never on screen.

**And its headline read `var(--fg-1)`, which is defined in no stylesheet.** `tokens.css` has `--fg`
and `--fg-2`..`--fg-5` and `--fg-dim`; that was the name's only appearance in the app. It is invalid
at computed-value time, so `color` fell back to `inherit` and landed on `--fg` from `body` - the
right colour, by accident, and a declaration that would have become the wrong one the moment any
ancestor set a colour. **Third of a family**: `--ink*` and `--t-micro` were the first two, and this
document and `docs/known-state.md` both record them as declarations that did nothing.

**So `bin/lint-repo.sh` grew a twelfth leg.** It collects every `--x` *declared* anywhere under
`apps/dashboard/src` - CSS declarations and the ones handed through `:style`, because `Band` passes
`--cols` and the tables pass `--rail` - and every `--x` *read* through `var()`, and fails on a read
nothing declares. It was proved to fail on `--fg-1` planted back.

**Its first finding was a false one, and that is the reason it strips comments.** `--cards` in a
`HomePage` docblock explaining the bento grid that was *deleted* - a sentence describing what the
file used to do, reported as a live defect. Block and template comments now come out of both sides
before either is collected: a property named only in a comment neither declares nor reads anything.

### The counted sentence had already moved, in two directions

`HomePage.vue` said the `conds` recipe was "unchanged through five pages" and
`system/HealthPage.vue` said four, on the same day, about the same recipe. Neither was right: eight
pages carry it now. The number is gone from all three copies rather than corrected for the third
time - the sentence names the set instead of counting it.

### What proved it

`npm run build`, `bin/lint-repo.sh` and `node fixtures/shoot.mjs` at 1360, **901**, 834 and 390.

**Every assertion was made to fail before it was trusted.** The baseline walk, with the check in
place and no CSS changed, printed all four `header @` lines and named the routes; each of the three
declarations was then removed on its own to show which band it holds - `white-space: nowrap` brings
back 901 and nothing else, the `.toolbar` floor brings back 834 and 390 and nothing else. The
`.left` floor holds a state no route has, so it was measured directly instead: with `#toolbar`
emptied the header is 64px with it and 61.14 without, at 1360 and 901 alike.

Final count **69 problems against a baseline of 73** - four fewer, and the four are the header
lines. Everything remaining is the one expected missing-poster 404. The new viewport reported no
horizontal overflow on any route, which is the first time anything has looked at that band.

