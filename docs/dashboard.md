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

**It is READ-ONLY, and that is structural rather than a v1 shortcut.** The design has restart, pull,
approve and terminate buttons, and no container here can have them: `container_t -> unconfined_t :
unix_stream_socket connectto` is DENY and is not fixable by relabelling. Actions need a privileged
host-side surface reachable from a browser, which is a decision to take on its own merits. **Every
one of those chips is a deep link into the owning application instead**, which keeps the design's
layout slot and is what its own fallback chip already did - `src/links.ts` holds the mapping, derived
from `window.location.hostname` so no build-time variable is involved.

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
been one.**

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

**Fonts are vendored, not fetched.** `@fontsource/*` self-hosts Geist and Azeret Mono in the bundle,
for the reason `apps/jellyfin/custom.css` records at length about the sixteen `@import` URLs it used
to carry.
