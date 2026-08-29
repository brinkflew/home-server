# Repository conventions

Lifted whole from `CLAUDE.md` on 2026-08-19. Nothing here was rewritten.

## `config/` is ignored wholesale, and `apps/` is why it can be

Everything under `config/` is **runtime state on the server** - application databases, Jellyfin
metadata, Caddy's certificates and ACME account, Pocket ID's passkey records. It is not in git.
Treat it as precious: it is the one thing here that cannot be rebuilt from this repository, which
is what `docs/backups.md` exists for.

**`.gitignore` is a single `config/` rule, and adding an exception to it is the wrong move.** It
used to carry a four-rule un-ignore chain (`config/*`, `!config/sonarr/`, `config/sonarr/*`,
`!config/sonarr/scripts/`) because git will not descend into an ignored directory to find an
exception inside it. All of that plumbing existed to track one 9-line script.

**A file that has to reach a container's config tree goes in `apps/<service>/` and is copied in by
an `ExecStartPre=` on that service's quadlet.** That is the same contract Tdarr's plugin always
had, now used for all of them:

| Tracked at | Lands at | How |
|---|---|---|
| `apps/caddy/` | `/etc/caddy` | bind-mounted read-only, as a directory |
| `apps/tdarr/plugins/` | `config/tdarr/server/Tdarr/Plugins/Local/` | `cp -a` |
| `apps/sonarr/scripts/` | `config/sonarr/scripts/` | `cp -a` |
| `apps/jellyfin/custom.css` | `config/jellyfin/branding.xml` | `bin/render-jellyfin-branding.py` |
| `apps/jellyfin/encoding.conf` | `config/jellyfin/encoding.xml` | `bin/render-jellyfin-encoding.py` |
| `apps/tdarr/flows/` | nowhere - **a record, not a deployment** | by hand; see that directory's README |

**Two things are tracked that nothing deploys, and the distinction matters.** `apps/tdarr/flows/`
holds an export of `avsOnePass1`; Tdarr has no import-from-disk mechanism, so the flow that actually
runs lives in its SQLite database and is edited in Tdarr's own flow editor. It is tracked so a flow
is reviewable and diffable at all - it decides what happens to every file in the library and was
previously recoverable from nothing but a backup of gitignored state. **Re-export it after any
edit**, or the copy in git silently becomes fiction.

**Jellyfin's `encoding.xml` came under the contract on 2026-08-15, and only in part.**
`apps/jellyfin/encoding.conf` names the elements that are decisions rather than defaults - the
keyframe-extraction extension list, throttling, the hardware-decode codec list - and
`bin/render-jellyfin-encoding.py` writes **only those**, never creating the document. That
restriction is the design, not laziness: `encoding.xml` has ~50 elements (tonemapping, VAAPI
device, CRF targets, deinterlacing) that are genuinely Jellyfin's to own, and authoring it from a
handful of tracked keys would reset every one of them by omission. **A list element must be declared
`Element[] = a,b,c`**, because an emptied list is written `<Foo />` and cannot be told from a scalar
by inspection - which is precisely the state the renderer exists to repair.

**`system.xml` and `network.xml` are still outside it**, and they hold real decisions - whether
trickplay uses the GPU, which proxies are trusted - so a `git grep` does not find them and a restore
brings back whatever was there. Treat them the way the Sonarr download-client settings are treated:
check them through the API rather than assuming.

**Git is authoritative, so editing the copy on the server is pointless** - it is overwritten on the
next start. Two consequences that are easy to be surprised by:

- **A Custom CSS edit made in Jellyfin's own UI reverts.** It survives until the next restart, and
  `podman-auto-update` restarts Jellyfin nightly, so it will look like it worked and quietly undo
  itself overnight. Edit `apps/jellyfin/custom.css`.
- **That CSS is VENDORED, and two of its stylesheets were deleted on purpose.** It used to be 16
  `@import` URLs into `CTalvio/Ultrachromic` at HEAD - an unpinned dependency on someone else's
  repository, on a page behind sign-on, plus 16 render-blocking fetches before first paint. It is
  inlined now (37 KB, ASCII, one remaining `@import` for a Google Font, which **must stay on the
  first line** - CSS ignores an `@import` that follows any rule, so moving it silently drops the
  font). `effects/glassy.css` and `effects/pan-animation.css` were **not** inlined: the first put
  `will-change: backdrop-filter` on 11 selectors including `.indicator` and `.cardOverlayButtonIcon`,
  which are on *every card*, so a 100-card page became 100+ composited layers each re-sampling what
  was behind it; the second ran an infinite `backgroundScroll` animation on the full-viewport
  backdrop, so it was never static. Together they re-blurred a moving full-screen image every frame
  and re-sampled it through a hundred layers, which is what made the UI "barely usable" while every
  other app was fine. **Do not add them back.** One narrow `backdrop-filter` survives on the three
  `.itemProgressBar` selectors; it is the next thing to remove if scrolling still stutters.
- **Sonarr's script path is recorded in `sonarr.db`, not here.** The "Clean Anime Extra Files"
  Custom Script connection stores `/config/scripts/anime-extra-files.sh`. Where the file lives in
  git is free; where it lands in the container is not, and a mismatch fails silently because that
  connection only fires on import.

## Editing this repository

There is still no build, no lint in the compiler sense and no test suite. What exists is
`bin/lint-repo.sh`, which asserts the four conventions nothing else enforces: every tracked text
file is ASCII, every script in `bin/` is executable, the shell passes shellcheck, and the quadlets
generate.

**The shellcheck leg SKIPS rather than FAILS when shellcheck is absent, and it had therefore never
run.** It was installed on neither machine until 2026-08-14, so the linter reported `all checks
passed` across 2,224 lines of shell it had not looked at - the exact shape of the problem this
repository keeps rediscovering, where a check that does nothing is indistinguishable from one that
works. The skip is still correct, because `/usr` is read-only on the server and the script has to
stay runnable there; the fix is that `bin/README.md` now names shellcheck as a workstation
prerequisite and says how to install it. The first real run found 18 issues, all of them minor.

**Prose and output here are ASCII, and that is checked rather than hoped for.** 402 non-ASCII
characters had accumulated by 2026-08-14 - em dashes, box drawing, arrows, a vulgar fraction. They
arrive by copy-paste, they are invisible in review, and in the shell scripts they end up inside
`printf` format strings that a terminal may not render. Use `-` for a dash, `->` for an arrow,
`>=` for a comparison, `x` for a multiplication sign.

**`.vscode/` is tracked**, and it exists because all 26 quadlets and 6 plain units otherwise open as
unhighlighted text. `hangxingliu.vscode-systemd-support` is the one that matters - its `systemd-conf`
language claims `.container`, `.volume`, `.pod`, `.build`, `.network`, `.service` and `.timer`, which
is every unit type here. Butane and Ignition have no extension in Open VSX at all, so `*.bu` is
associated with YAML and `*.ign` with JSON instead.

**No SOPS extension, deliberately.** The transparent-decrypt ones add a path by which a plaintext
secret can be written to disk in a public repository. `sops secrets/env.sops.env` opens it in
`$EDITOR` and re-encrypts on save without plaintext ever touching the disk.

## The dashboard's three global conventions

`apps/dashboard/` scopes almost everything to a component. Three things cannot be scoped, and they
are worth knowing before writing a panel.

**A LIST OF RECORDS IS A TABLE, NEVER A GRID OF CARDS**, and there is exactly one recipe for it:
`.tbl` in `src/styles/base.css`. One horizontal rule per row and nothing else - no vertical rules,
no zebra, no outer border, because the panel's surface step already bounds it and a ruled grid on a
near-black ground reads as a spreadsheet. Severity is `td.rail` with a `--rail` custom property: a
2px inside edge on the first cell, so the colour reads down the left without a coloured wash on
every row. A card grid makes the reader re-find every field in every tile, in a different place each
time because the values are different lengths; a column lets them scan one field down all of them.

**`table-layout: fixed` is part of that recipe and is not cosmetic.** With auto layout `width: 100%`
is a FLOOR: the table grows past its container whenever a column's min-content width exceeds its
share, and one nowrap element in a cell is enough to do it. A chip is exactly that, which is why
`ChipLink` wraps its label in a shrinkable span - without it a long branch name widened the round
board and gave the whole page a horizontal scrollbar.

**TWO NUMERIC VOICES, AND THE SPLIT IS BY KIND RATHER THAN BY "IS IT A NUMBER".** `.mono` is for
anything you would copy, grep or type, and for any value carrying a unit: an id, a path, a unit
name, an image tag, a timestamp, `4.1 MB/s`, `41.2%`. `.count` is for a bare count: `12 units`,
`6 restarts`, `2 of 8`. The old rule - every number in the mono face, no exceptions - put `12 units`
and `/var/mnt/media` in the same voice, which made a page of counts read like a config file. Both
set `tabular-nums`, so neither reflows its column as it ticks.

**A BAND IS EITHER FULL WIDTH OR N EQUAL COLUMNS**, and `Band.vue` is the component that makes it
structural. A band that needs a grid AND a full-width panel under it is two bands, not a special
case. Two rhythms carry it: `--gap` between panels inside a band, `--gap-lg` between bands, which is
what makes a page read as bands rather than as one long stack. It governs panels *within* a band -
one full-width panel is free to have hierarchy inside it, which is what the Agents board's header
is.

**THREE BREAKPOINT RUNGS, AND THEY ARE LITERALS BECAUSE A MEDIA QUERY CANNOT READ A CUSTOM
PROPERTY.** There is no `--bp-*` token and there cannot be one, so the numbers are repeated in
scoped blocks across the app and the ladder is written down here instead. Add to it rather than
inventing a fourth.

| Rung | | What changes |
|---|---|---|
| **1180** | the fold | `Band` goes to one column. `Band.vue` states it and names the 1360x860 reference viewport. `.tbl` drops its `.p4` columns. |
| **900** | tablet | N-up tile grids fold; the four hand-rolled racks and the network drawing gain a scroller; `.tbl` drops its `.p3` columns; the nav becomes a drawer. |
| **640** | phone | The header sticks and `--pad-page` tightens to 14px; `.tbl` drops its `.p2` columns. |

`1100`, `1280` and `1400` also exist, on three pages, each doing a real job at a real width. They
are left alone deliberately: normalising them onto the ladder would be a desktop behaviour change
made for tidiness.

**The 900 rung is where the nav goes because it was measured.** Seven tabs are about 452px, the
lockup 113px, the verdict pill up to 229px and the gutters 66px - the header needs 776px before a
page teleports anything into it. Written at 640 first, and the tablet viewport reported 44px of
overflow on all nine routes.

**NOTHING SHRINKS TO FIT.** The type floor is 11px at every width; a phone is read closer than a
wall panel, not further away, so a narrow screen gets fewer columns and never smaller type. The two
exceptions are chrome insets, not type: `--pad-chip` and `--pad-control` GROW under
`@media (pointer: coarse)`. The tokens move rather than the call sites, which is one edit instead
of forty.

**Column priority is how a table survives a narrow window, and it is one tier per rung.** `.p4`
drops at 1180, `.p3` at 900 and `.p2` at 640; `.fold4` / `.fold3` / `.fold2` are lines inside the
surviving cell that appear only once their own column has gone, so a fact relocates rather than
disappearing. Put a fold OUTSIDE any clamped element - `FindingsPanel`'s `.msg` is a two-line
clamp, and an id nested inside it spent one of the message's two lines.

**`.p4` is not a phone tier and that is the point.** The round board is the only six-column table
here and carries 814px of FIXED width, which is more than the 1180 rung leaves the one flexible
column it has: at a 1000px window the task title had **104px**, about thirteen characters, on an
ordinary laptop. Nothing else needed it - the round page's five-column table still gives its
flexible column 384px at 920 - so it is a tier on an existing rung rather than a re-rung of `.p3`.

**A FOLD MUST BE A WRAPPER ELEMENT AND AN EMPTY WRAPPER MUST COST NOTHING.** A fold class put on a
COMPONENT lands on that component's root, where its own scoped rule (`ChipLink`'s
`.chip { display: inline-flex }`) is one class more specific than a bare `.fold4` - so the fold
never hides. Wrap it; then give the wrapper `display: contents` inside the rung, or an empty one is
still a flex item opening a gap between two visible things.

**And `overflow-x: hidden` on `body` is refused.** It conceals the class of defect the ladder
exists to remove, and conceals it worst on touch, where the scrollbar is an overlay and a page
running off the right edge is already silent. `apps/dashboard/fixtures/shoot.mjs` asserts
`scrollWidth` against `clientWidth` at three viewports on nine routes instead. Absence is the
finding.
