# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted server stack, currently media-focused, defined as rootless Podman quadlets.
The scope is deliberately widening beyond media - prefer changes that generalise over ones that
assume the stack is only Sonarr/Radarr/Jellyfin.

| Path | What it is |
|---|---|
| `stacks/` | **what is actually running.** Rootless Podman quadlets. Change these to change the server. |
| `apps/` | **what those units deploy into containers.** One directory per service. |
| `host/butane/` | the Ignition config that defines the host itself - applied |
| `host/systemd/` | plain systemd units that run on the host rather than in a container |
| `secrets/` | every credential, sops+age encrypted; `.env` is rendered from it |
| `docs/` | what was learned the hard way, and most of what this file used to carry. See the index below. |

**One rule holds those two apart: unit definitions in `stacks/`, the files they deploy in `apps/`.**
A payload gets into its container by an `ExecStartPre=` copy on that service's quadlet, so git stays
authoritative and nothing has to be tracked inside the gitignored `config/` tree. Four services use
it today: `apps/caddy/` (the Caddyfile, bind-mounted rather than copied), `apps/tdarr/plugins/`,
`apps/sonarr/scripts/` and `apps/jellyfin/custom.css`.

**The migration happened on 2026-08-12.** The server runs uCore with rootless Podman quadlets.
`docker-compose.yaml` was kept for reference until 2026-08-14 and is now deleted: the two runtimes
had diverged (Compose still defined a `tdarr-node-02` that has no quadlet, and had no `bazarr`,
which does), so "it documents a configuration that demonstrably worked" had stopped being true.
`git log` has it if it is ever wanted.

**The service user is `core`, uid 1000** - not `avanserv`, which no longer exists. Fedora CoreOS
ships `core` at uid 1000 and Ignition cannot create a second user there, so the account that already
held the uid was adopted. The filesystem stores uids, so `/mnt/media` and `config/` needed no chown.

There is no application code here: no build, no lint, no test suite. The unit of work is a
service definition, and the verification loop is "does the container come up and stay healthy".

## Where the rest of this lives

**This file used to carry all of it, and stopped being loadable.** It reached 133 KB - about 33,000
tokens read in full before any work begins, whether the session is about a Caddy route or the
transcode policy. The known-state section was lifted out on 2026-08-19 for that reason and the rest
followed the same day, by the same rule: **lifted whole, never rewritten.** The arguments in them
are load-bearing and several were paid for in outages.

| File | What it carries |
|---|---|
| `docs/networking.md` | one network per trust boundary, `isolate=true`, the torrent pod, the media mount, ingress and passkey sign-on |
| `docs/media-pipeline.md` | `queued/` -> `transcoded/`, Tdarr's libraries and flow traps, the transcode policy, the Radarr `[VO]` profile, hardlinks, the seeding policy |
| `docs/observability.md` | `status.json` and its stable check ids, Prometheus and the collector, the alert chain to the phone |
| `docs/backups.md` | the three copies, the append-only off-site key, and why a backup is not proven until restored |
| `docs/dashboard.md` | the Vue application, its five sources, and what it may and may not assert |
| `docs/repo-conventions.md` | `config/` vs `apps/`, how a file reaches a container, ASCII, `bin/lint-repo.sh` |
| `docs/agents.md` | the three tiers, the marker contract, the phase invocation, and what must never travel to ntfy |
| `docs/ci.md` | the three CI lanes, the nested container engine, the credential that never enters a container, and what a lane may reach |
| `docs/known-state.md` | the seventy-four conclusions from auditing the running host |

**What stays here is what has to be known BEFORE touching anything**: what this is, how a change
reaches the server, secrets, the commands, and the known-state index below. Everything else is one
`Read` away, and the index is what tells you to go and read it.

**A new section belongs in one of those files, not here.** Adding it here is how this file grew back
past the point that forced the split.

## Deployment model

This repo is the source of truth. The server runs a **git checkout of it** at `/var/home-server`,
reachable over passwordless SSH as `home` (WAN, via the router's `9122 -> 22` forward) or
`home.local` (direct, `192.168.0.100`). **Prefer `home.local`** - the WAN route depends on NAT
hairpinning and on the forward still pointing at the right address.

**The same applies in the BROWSER, and it costs more than it does over SSH.** Every public hostname
here is a CNAME to `avanserv.duckdns.org`, which resolves to the server's own WAN address
(`91.86.121.124`), so a LAN machine loading `watch.avanserv.com` sends every request out through the
router and back in through NAT loopback. Measured against `/web/index.html`: **12-16 ms direct
against 74-79 ms proxied, about 5x per request** - and a Jellyfin page is ~29 JS bundles plus 30-60
images, so a full load went 283-684 ms direct against 898-1612 ms proxied. Nothing is misconfigured;
the packets are simply taking a long way round.

**Split-horizon DNS would fix it, and was CONSIDERED AND DECLINED on 2026-08-15.** Recorded here
because the measurement above reads like a pending action item and will otherwise be re-proposed
every time someone rediscovers it. Three things settled it:

- **It is not perceptible.** 5x on a number that starts at 12 ms is still under a tenth of a second,
  and nobody browsing has ever noticed. The measurement is real; the complaint was theoretical.
- **A blanket override is unavailable.** `*.avanserv.com` serves a DIFFERENT machine, so the
  override cannot be `avanserv.com` -> `192.168.0.100`; it has to enumerate the fifteen hostnames
  Caddy answers for. That is a second list of the Caddyfile's site blocks, maintained by hand, in a
  place nothing validates - the most driftable shape this repository has a name for.
- **Both places to put it are worse than the problem.** On the router it is unversioned state this
  repo cannot see, verify or restore, which is the whole reason `host/butane/ucore.bu` exists. On
  the server it is a resolver container the whole house then depends on for DNS, so the machine
  going down stops being "the media stack is offline" and starts being "the internet is broken".

It would also silently change what `bin/verify-host.sh --routes` measures, since that battery
resolves the same public names from the server itself - it would stop proving the WAN path and
nothing would say so.

`~/.config/containers/systemd/{common,torrent,media,infra}` are symlinks into `stacks/`, so
`git pull && systemctl --user daemon-reload` is the entire deploy - there is no copy step.

**`~/.config/systemd/user/` is a second symlink root**, pointing at `host/systemd/`. It holds plain
systemd units rather than quadlets - things that run *on the host* rather than in a container, which
is how they reach services that are deliberately unable to reach each other. It does not exist on a
fresh host and is not created by Ignition; see `host/systemd/README.md` for the one-time setup.

**Containers run `PUID=0`/`PGID=0`, which is not a privilege escalation.** Rootless Podman maps
container UID 0 to the invoking user, `core` (uid 1000), which is what owns `/mnt/media` and
`config/`. A container "running as root" is uid 1000 on the host. Anything *other* than 0 maps into
the subuid range (`core:100000:65536`) and cannot read the data.

```bash
ssh home.local 'cd /var/home-server && git status --short'   # ALWAYS do this before editing
```

**The remote has drifted from git before**, and it is easy to cause. Reconcile any drift into git
*before* making changes, or your edits will be silently clobbered or will clobber someone else's.

**Change files here, commit, then `git pull` on the server - never edit them over SSH.** Editing
the checkout directly recreates the drift, and the next `git pull` refuses to apply with "local
changes would be overwritten". The only thing that legitimately differs on the server is the
runtime state under `config/`.

## Secrets

**`.env` is generated, not edited.** It is rendered from `secrets/env.sops.env` - every value
encrypted with sops+age, committed to this public repo, which is what finally puts the credentials
under version control and into a backup. Editing `.env` in place works right up until the next
render silently discards it.

```bash
sops secrets/env.sops.env      # decrypts into $EDITOR, re-encrypts on save
git commit && git push          # then on the server:
ssh home.local 'cd /var/home-server && git pull && ./bin/render-env.sh &&
                systemctl --user daemon-reload && systemctl --user restart <affected units>'
```

- **Two age recipients**, workstation and server, so losing either machine does not lock you out.
  Their private keys are at `~/.config/sops/age/keys.txt` and belong in a password manager - they
  are the one thing here that cannot be regenerated. Adding a third recipient means editing
  `.sops.yaml` *and* running `sops updatekeys secrets/env.sops.env`; existing files are not
  re-encrypted for you.
- **The creation rule is matched against the file sops reads, not the one it writes.** Seeding
  `secrets/env.sops.env` from `.env` therefore matches as `.env`, which is why `.sops.yaml` covers
  both names. Without that it fails with an unhelpful "no matching creation rules found".
- **Variable names stay legible and empty values stay unencrypted.** That is deliberate: a diff
  should still show which credential changed. It does mean the file publishes the shape of the
  stack, which `stacks/` and `.env.sample` already do in full.
- **sops' dotenv format does not preserve every comment**, so a rendered `.env` is barer than a
  hand-written one. `.env.sample` is the documentation; **update it whenever you add a variable**,
  or the next person gets `variable is not set` from `${VAR:?err}`.
- `sops` and `age` are static binaries in `~/.local/bin` on both machines, not system packages -
  `/usr/local` needs a sudo password on the server and this does not. That directory is absent from
  a non-interactive ssh `PATH`, which is why `render-env.sh` sets it itself.

## Commands

All of these run on the server as `core`, from `/var/home-server`. **No `sudo`** - the stack is
rootless, and `systemctl --user` is a different unit space from `systemctl`.

```bash
git pull && systemctl --user daemon-reload    # the whole deploy; quadlets are symlinked in
./bin/render-env.sh                           # regenerate .env after a secrets change
systemctl --user restart <service>
systemctl --user status <service>
journalctl --user -u <service> -f
podman ps                                     # STATUS shows healthy/unhealthy
systemctl --user list-units --failed          # the fastest health check
podman ps --filter health=unhealthy           # the one that catches a live-but-broken service

systemctl --user start caddy-build            # after editing apps/caddy/Dockerfile (~75s)
systemctl --user start home-server-dashboard-build.service   # THE DEPLOY for apps/dashboard/
systemctl --user start home-server-conduct-runner-build.service  # build, smoke, promote :latest
systemctl --user restart dashboard            # then swap onto the new bundle
podman exec caddy caddy reload --config /etc/caddy/Caddyfile   # routing change, no downtime

./bin/verify-host.sh                          # the whole battery; also writes the MOTD
./bin/verify-host.sh --routes                 # plus the public routes (slow)
./bin/verify-host.sh --json | jq .summary     # the same findings, machine-readable
jq -r '.checks[]|select(.status!="pass")|"\(.status)  \(.id)  \(.message)"' \
  /var/lib/home-server/status.json            # what the hourly run last found
bin/collect-metrics.py --print | grep container_network   # the per-segment counters
./bin/verify-media.sh "/mnt/media/library/transcoded/movies/<film>/<film>.mkv"
./bin/verify-media.sh --library movies        # will these drift in a browser?
podman auto-update --dry-run                  # 17 rows with a policy, not an empty table
systemctl --user list-timers                  # verify hourly, backup + auto-update + search nightly

systemctl --user start home-server-backup     # back up now rather than waiting for 03:00
journalctl --user -u home-server-backup -n 50

./bin/search-missing.py --dry-run --verbose   # what is missing, and what is merely unreleased
systemctl --user start home-server-search.service   # sweep now rather than waiting for 04:30
```

**From the workstation**, because they either need credentials the server does not have or have to
outlive the machine they are talking about:

```bash
./bin/verify-restore.sh                       # does the latest snapshot actually restore?
./bin/verify-restore.sh --repo offsite --deep # the copy that survives the disk, data re-read
./bin/backup-config.sh && ./bin/backup-offsite.sh   # the third copy, and the off-site prune
./bin/reboot-host.sh --dry-run                # pre-flight for the one dangerous operation
./bin/lint-repo.sh                            # ASCII, exec bits, shellcheck, quadlet dry-run
```

**Updates are automatic, in two independent tracks.** Containers: `podman-auto-update.timer`
nightly, following tags, rolling back on a failed start. Host: `rpm-ostreed-automatic.timer`
nightly, which **stages and never reboots**. Applying it is either a deliberate human act via
`bin/reboot-host.sh`, or `home-server-reboot.timer` hourly from 05:00 to 09:00 on Sundays - which
applies a staged deployment only when greenboot is armed to undo it and refuses on anything else.
**Five attempts rather than one, because the refusal that actually fires is transient**: the
encoder gate means a Tdarr job running at 05:08 used to cost the deployment a whole week. A
deployment that
boots but breaks sshd now rolls itself back rather than being a car journey; `bin/verify-host.sh`
still tells you one is waiting, via `/run/motd.d/`.

**The reboot procedure, which is the only genuinely dangerous step, is now a script.** Run it from
the **workstation**, because the waiting cannot happen on the machine that is rebooting:

```bash
./bin/reboot-host.sh --dry-run    # pre-flight only: health, /boot, encoder idle, what is staged
./bin/reboot-host.sh              # the whole sequence, with a typed confirmation
```

It does what the hand procedure did, with the two mistakes that have actually been made built in as
code rather than as warnings to remember: it derives the **booted** deployment index rather than
assuming 0, and it unpins and runs `rpm-ostree cleanup -r` afterwards. **On a failed verification it
stops with the pin still in place**, because that pin is the rollback.

```bash
# what it does, if you would rather type it
rpm-ostree status && df -h /boot              # what is staged, and room to apply it
systemctl --user list-units --failed; podman ps --filter health=unhealthy
nvidia-smi --query-gpu=utilization.encoder --format=csv   # 0,0 - nothing mid-encode
# pin the BOOTED deployment - NOT index 0, which is the staged one when one exists
idx=$(rpm-ostree status --json | jq '[.deployments[]] | map(.booted) | index(true)')
sudo ostree admin pin "$idx"
sudo systemctl reboot                         # on a day you could reach the machine
./bin/verify-host.sh                          # then UNPIN - a pin can cost a whole /boot slot
idx=$(rpm-ostree status --json | jq '[.deployments[]] | map(.pinned) | index(true)')
sudo ostree admin pin "$idx" --unpin && sudo rpm-ostree cleanup -r
```

**A unit stuck in `activating` is usually a `Restart=always` loop, not slow progress.** Read the
journal rather than waiting - the real error scrolls past between restarts, and the restart counter
tells you how long it has been failing.

There is no `docker compose config` equivalent. The nearest linter is generating the units without
starting anything, which catches syntax errors but **not** unset variables:

```bash
/usr/libexec/podman/quadlet -dryrun -user
```

**That path, not `/usr/lib/systemd/user-generators/podman-system-generator`** - this podman ships
the generator as `podman-user-generator` and the standalone binary is the one above. The wrong path
fails with `No such file or directory`, which reads like the check is unavailable rather than
misspelled.

Changing a network's subnet or options is not a live edit: a network cannot be modified in place or
removed while containers are attached, so it takes stopping the stack, `podman network rm`, and
starting again.

The Caddyfile can be checked without deploying it, which is worth doing since a bad one takes the
whole ingress down. `acme_dns gandi` does not exist in the stock image, so validation needs the
custom build:

```bash
podman run --rm -v "$PWD/apps/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -e DOMAIN=example.com -e PORT_TDARR_WEB=8265 \
  -e PORT_QBITTORRENT_WEB=8200 -e PORT_JOAL_WEB=8221 -e GANDI_BEARER_TOKEN=dummy \
  home-server/caddy:latest caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

## Known state

**The seventy-four conclusions from auditing the running host live in `docs/known-state.md`.** They
moved out of this file on 2026-08-19, when it passed the character budget that decides what is
loaded into context at all - so the choice was not which paragraphs to keep, it was whether the file
carrying them stayed loadable. Nothing was rewritten or dropped; the section was lifted whole.

**The index below is the half that has to stay here**, because knowing a landmine exists is what
sends you to read it, and an entry nobody knows about is one nobody reads. **Read the full entry
before changing anything in the area it names** - most of them record a failure where every visible
signal read green.

**Append to `docs/known-state.md` AND add the matching line here. Both halves or neither.**

### The rename, and the three things that did not follow
- Moving the checkout dangles the `greenboot/required.d` symlink, which is a red boot, and leaves
  renamed units in runtime state as `failed` phantoms only `reset-failed` clears.
- The project was `media-stack` until 2026-08-15. Three `git grep` hits are deliberate, and the
  restic identity was rewritten in place rather than edited.

### Podman is not Docker
- `firewalld` now governs published ports - closed by default, symptom `No route to host` against a
  container that looks perfectly healthy.
- SELinux blocks `/dev/net/tun` until `container_use_devices` is on, with **no AVC logged**.
- Podman does not create missing bind-mount source directories, and `Restart=always` makes that a
  silent 5-second retry loop rather than a failure.
- Podman will not guess a registry: every image reference must be fully qualified.
- Every quadlet interpolating a variable needs its own `EnvironmentFile=`, `.network` units included.
- `/mnt` is a symlink to `/var/mnt`, so the unit is `var-mnt-media.mount` with `Where=/var/mnt/media`.
- Quadlet's `Environment=` splits on whitespace and truncates silently. Quote any value with a space.

### Reaching a service, and restoring one
- A 302 from an admin route proves the proxy and sign-on, not the backend.
- A config restored from a running stack can carry live lock files; qBittorrent then exits one
  second after starting, logging only `termination initiated`.
- `WebUI\LocalHostAuth` must be `false`, or gluetun's port-forward push gets a 403 for ever - and
  **JOAL shares that namespace**, so it reaches qBittorrent's WebUI unauthenticated. Not cheaply
  fixable; what would close it is dropping JOAL.
- **The daily passkey prompt was Tinyauth's stock `sessionExpiry`, absolute rather than idle-based**
  - stamped at login, never refreshed, so constant use did not extend it. Not the nightly
  auto-update: `NRestarts=0` across a 24h-apart pair of sign-ins. Now thirty days. Pocket ID's
  60-minute `SESSION_DURATION` is left alone deliberately - it is what keeps the rollover a real
  passkey ceremony rather than a silent redirect.

### The host: image, driver, and which updater is armed
- uCore `stable-nvidia-lts`, immutable: host tools go in `~/.local/bin`, host config in
  `host/butane/ucore.bu`, and Ignition runs once so editing it changes nothing running.
- `-lts` is the NVIDIA **driver** branch, not an LTS kernel. Reverting the tag reinstalls 610.
- Zincati and `bootc-fetch-apply-updates.timer` are **masked**, not disabled - exactly one updater
  may be armed, and `disable` is silently undone by a `Wants=` elsewhere.
- `AutomaticUpdatePolicy=stage` is uCore's own default, restated in `ucore.bu` deliberately.
- The image ref is `ostree-image-signed:docker://`. Do not ship your own policy or key through
  Ignition - it becomes a permanent `/etc` override that survives a key rotation.

### Container auto-update, and the rollback it rests on
- Images follow tags, nightly. `Notify=healthy` is what makes the rollback fire, and a `.build` unit
  needs its own timer because auto-update does not trigger one.
- **A rollback restores the image and cannot un-migrate a database.** The 9.5-hour Pocket ID outage,
  and why a health probe shelling out to `curl` is an undeclared dependency on a binary the image
  merely happens to ship. **Eighteen of the twenty-seven quadlets still probe that way, and NONE of
  those eighteen images declares a healthcheck of its own** - so Pocket ID's fix cannot be copied
  across, and `containers.probe_binaries` watches the dependency instead. This line said "ten" until
  2026-08-19, when it was counted.
- **The rollback now has a restore point in front of it.** `bin/pre-update-snapshot.sh` runs as
  `ExecStartPre=` on `podman-auto-update.service`, because the updater fires at ~00:00 and the
  backup at 03:00 - so the newest snapshot was 21 hours old at exactly the moment one was needed.
- The nightly prune does not eat the rollback - but **never run `prune -a`**.
- That same prune fails the unit over a leftover buildah working container, and the failure names the
  one component that was working.
- uCore ships its own `nvidia-cdi-refresh`; a second CDI spec is rejected rather than merged.

### `/boot` holds two slots and cannot be grown
- One slot per distinct kernel+initramfs, 303 MB of 350 used, and XFS cannot be shrunk. Five
  corrections learned by doing it wrong: pinning the booted index rather than 0, unpinning after
  verifying, WARN vs FAIL under `--greenboot`, `cleanup -r` taking two deployments, and the pending
  deployment it cannot reclaim at all.
- **A clean `rpm-ostree db diff` does not mean a slot is free to skip.** uCore rebuilds the
  initramfs every image build, so a perl-only diff with an identical kernel still writes 146 MB.
  Compare the initramfs objects; the loader entry does not exist until finalization.

### The nightly OS updater can silently skip a real update
- `rpm-ostree upgrade --check` can be wrong and `rpm-ostreed-automatic` believes it, so the host
  stops taking OS security updates indefinitely while every signal reads green.

### Checks that could not see the thing they measured
- **`conduct verify` cannot tell a change that broke the gate from a gate that was already broken**,
  and blames the phase for both. Proved by a refusal on a test GitHub Actions calls green on the
  identical base. The pinned base and the artifact rescue both earned themselves in the same run.
  **Closed 2026-08-24**, and the reason it looked expensive was wrong: the base is measured only
  after the head gate has already failed, in the same rebuilt worktree. The base commit turned out
  to be the one that added the failing test. The comparison is the failing `make` target, `None` is
  not a target and must not match another `None`, the rebuild destroys the head tree so everything
  is read out of it first, the cache is keyed on the runner image as well as the base - and none of
  it distinguishes a flaky test from either cause.
- A check that counts the unit executing it blocks the remedy for its own condition.
- `update.policy_count` spent three minutes a run asking every registry a local question - and read
  `$repo` several hundred lines before it was assigned, reporting "not measured".
- **Caddy was down for 35 minutes and three checks looked straight at it**: a dependency failure is
  `inactive`, not `failed`, and a container that never started is absent rather than unhealthy.
- `routes.ntfy` asked for `/`, ntfy's public web UI, so it was wrong in both directions at once.
- **`ContainerRestartLoop` read a counter that resets on every restart**, so it could never fire -
  0 through all 6,224 of Pocket ID's restarts. Systemd's `NRestarts` is the one that survives.
- **`Restart=always` at `RestartSec=5` cannot reach systemd's 5-in-10s limit**, so no unit here ever
  gave up. Detection was never the problem; an end state was.
- **Alertmanager was a destination and never a scrape target**, so three of the four hops to the
  phone were unmeasured - including the 401 its own config file warns about.
- **The one job that proves the backups restore was the one job with no record**, and running it
  found the workstation's third copy four days stale.
- **A Postgres dump outlives its own accuracy**, because the shadow tree is never deleted and the
  `protect` filter keeps last night's copy - so existence and freshness are asserted by different
  scripts on different machines.
- **`systemctl show` reports a unit that does not exist as `inactive`, exit 0**, so any
  hand-maintained watchlist is a check that stops firing the moment a name drifts. `LoadState` is
  the only discriminator - and for a *slice* even that reads `loaded`, because systemd synthesises
  slices; `FragmentPath` is what tells a real unit file from a default.
- **Asking `rpm-ostree` a question starts the daemon you were asking about**, so polling
  `rpm-ostreed.service` to detect an OS update makes it busy. Read the `transaction` field instead.
- **A `Slice=` naming a slice with no unit file silently gets systemd's defaults**, so the fleet's
  one aggregate ceiling can be absent while every member is healthy and fully observed. The
  `host/systemd/` symlink loop globs by EXTENSION, which is where that comes from.
- **The collector's cgroup join was flat**, so the first unit ever placed in a slice would have lost
  32 of its 43 series with nothing but a counter to say so. Not `/proc/<pid>/cgroup` - the pod
  members resolve somewhere else entirely.
- **"A container" meant "a quadlet" in six readers at once.** One throwaway `podman run --rm` made
  `identity_unresolved` read 1, inflated two counts, and minted network series under an unbounded
  label. The skips key on the PRESENCE of `io.home-server.ephemeral`, and `grep -vxF ""` matches
  every line, so the empty case has to short-circuit or it PASSes at zero.
- **Do not give a phase runner a unit label to "fix" the skip** - the dashboard's worst-five
  availability strip would then carry dead runners for thirty days each.
- **A Windmill worker's tags hot-reload from a row in Postgres**, so `WORKER_TAGS=` in the quadlet is
  a bootstrap the UI overrides at run time with nothing in `git diff`. `agents.worker_lanes` reads
  them back out of the database.
- **A Windmill worker serves no HTTP**, so its probe is a `psql` query - the only one here that asks
  a second container whether the first is doing its job. A worker that registers nothing leaves no
  unit failed and no container unhealthy; work just queues.
- **`worker_ping` keeps a row per worker name and the name changes on every start**, so row counts -
  including `workers_alive` in Windmill's own health endpoint - over-count after a restart.
- **A `chcon` is what lets a phase read its own worktree**, it is undone silently by any
  `restorecon`, and type inheritance is what carries it to every file created afterwards.
- **`--security-opt label=level:s0` fixes a trap this design does not have.** The MCS categories
  come from `:Z`, not from bind mounts; four runs proved every file lands at `s0`. Shipping it would
  have removed per-container separation for nothing.
- **`isolate=true` blocks more than other bridges**: a published port reached at the host's LAN
  address DNATs into the owning container's bridge, so Caddy and Jellyfin are unreachable from a
  fleet network. The host itself and the internet are not.
- **`Nice=` cannot be set on a transient scope**, and a read-only rootfs turns every cache
  environment variable into a required mount.
- **`Persistent=true` does not fire on first enable** - the stamp file is written straight away - so
  the one image nothing else builds needs a one-time start in `host/systemd/README.md`.
- **`node:24-trixie-slim` ships no `python3`, `git` or `make`**, and trixie renamed `libmagic1` to
  `libmagic1t64`.
- **A fact key and a collector metric name landing on one exposition file rejects the WHOLE
  scrape**, because the battery is hourly and the collector runs every 30s, so the two disagree by
  construction. `bin/lint-repo.sh` leg 9 makes it a build failure. The agent families are one letter
  apart: `agents_*` facts against `home_server_agent_*` metrics.
- **A lint leg that greps for a literal metric name cannot see one built by concatenation**, which
  the first version of leg 9 proved by passing with a planted collision. Prefixes are the fix, and
  the bare `home_server_` bridge must be excluded or it fails on all ninety.
- **`ActiveState` is `active` for a long-running unit whether busy or idle** - the mirror of the
  oneshot trap one gate over. The phase refusal reads a marker, and believes it only while the
  heartbeat is fresh.

### The orchestrator, and four assumptions its first live run contradicted
- **`Environment=` does not expand `${VAR}` from `EnvironmentFile=`**, and `os.makedirs` on the
  resulting literal path succeeds rather than raising - so the state database lands outside the tree
  the backup walks and nothing says so.
- A detached `podman run` lands **outside** `app-agents.slice`; only the scope-wrapped runner is in
  it. `--cgroup-parent` is the fix and its own failure is a limitless transient slice, silently.
- **`--name` is not a DNS alias**, so a container named `<id>-db` cannot answer to `db`.
- An environment variable a config uses **verbatim** is a different hazard from one it derives:
  `REDIS_URL` must name logical database 1, or e2e isolation collapses with every test still passing.
- A guard keying on "is the database on loopback" refuses inside a namespace, where the address is a
  service name. Its own comment names the premise a phase runner breaks.
- **The reconciler reaped a live verification 27 seconds before it finished**, because the lease's
  pid had been overwritten with the container's - covering the setup window and never the teardown
  one, on the branch that has no grace period. A hand run beside `serve` is the only way to see it.
- **A person can answer a step that belongs to conduct and nothing on the server can stop them.**
  Every suspend is an approval form; `user_groups_required` and `self_approval_disabled` were both
  measured and neither binds an admin, which this one-seat workspace's only human is. The boundary
  is one-directional by measurement, not by oversight.
- **One dead flow job stopped the whole fleet for two hours**, because the undelivered-answer retry
  runs unguarded at the top of the cycle, ahead of the notifications and the dispatch pass.
- **Granting `Bash` without `BashOutput` is a grant that fails silently**: a phase backgrounded its
  own type-check, could not read it, committed three type errors and answered `done` with no
  concerns. The same task on an earlier run reported the exact issue as a concern.


### The gate the fleet was going to trust, and six ways it was not a gate
- **Running git in a directory is running its owner's code.** `core.fsmonitor`, `core.hooksPath`,
  `textconv` and `remote.url = ext::sh -c` all exec from a repo's own config, only three git options
  are protected-config-only, and two of the trigger calls shipped before any model phase existed.
- **A diff is only as trustworthy as the ref it is measured against.** `origin/main` lives in the
  worktree, so `git update-ref` empties the diff while the tree stays clean and every path check
  passes.
- **`git clone --local` hardlinks the object store**, so a writable `.git` in a container is write
  access to the mirror every other clone is made from - and it surfaces later as a git bug.
- **A receipt its own subject can mint is not evidence**, and a hook whose command cannot be found
  **fails open**. A `PreToolUse` hook must never answer `allow`: that bypasses the permission system.
- **`git reset --hard` does not make a tree pristine**, and a phase that committed nothing passes
  every other check.
- **The file that decides what a check means is usually not the file a short list names**, which is
  why the protected paths are two tiers - and why a deleted test escapes both.

### The mirror is not a cache, and the second key cannot go where the first one is
- A phase container cannot just clone the branch: the repo is private and the runner may hold no
  GitHub credential at all, the diff's base must come from a repository the phase cannot write, and
  one host-side copy is what pins base and worktree to the same moment.
- **A second deploy key added to the existing `Host github.com` block loses to `IdentitiesOnly`**,
  and GitHub answers a valid key for the wrong repository with `repository not found` - which reads
  as a bad URL. `-F /dev/null` is the fix.
- **Refreshing the base at verification time breaks `merge-base --is-ancestor`**, so a good run is
  refused for something the refresh did. Fetch at dispatch, and **pin the base on the run row** -
  verify runs later, and reading it live lets the nightly timer move it under a finished run.
- **`CREATE TABLE IF NOT EXISTS` does not add a column to an existing table**, and the first UPDATE
  naming it raises inside a phase that already ran. Migrate on `pragma_table_info`, not on the
  exception.
- A mirror that stopped fetching looks exactly like one nobody pushed to. `FETCH_HEAD`'s mtime dates
  the attempt, not the change.

### The control plane's arrow, and three states that look alike in the journal
- conduct polls Windmill and Windmill cannot reach conduct: a listener needs the podman-socket
  SELinux denial or a firewalld hole. In `paths.ts` that is `conduct` never appearing as a `to`.
- **Work is a suspended flow step, addressed by MODULE ID from git** - not by a payload. conduct
  answering an approval step would be conduct approving its own gate.
- **`jobs/queue/list` declares `args` and `flow_status` and returns both null** - the schema
  describes the type, not what the endpoint fills. Reading the schema is not measuring the endpoint.
- **A `suspend` belongs to the module it PRECEDES**, so the module reading `WaitingForEvents` is the
  next one. Naming the wrong one made conduct skip its own work with no error anywhere.
- A flow drift check must strip Windmill's generated `lock` by name, or it fires on every flow.
- `agents.approvals_pending` counts conduct's suspended steps too and cannot separate them in SQL.
- **The answer is stored before it is delivered**, so an undeliverable one retries the resume and
  never the twenty-minute phase.
- **An unset token HOLDS and a 401 FAILS the cycle.** A rollout must not look like a fault; a
  revoked token must not look like health.
- A flow is a Postgres row the UI can edit, so `serve` rewrites it from git at every start.
- The verify lane stopped being the semaphore when the arrow inverted; conduct's lease is.

### The loop closed, and the two wasted runs on the way there
- `avanserv/upskald#249` is a draft PR the fleet opened on 2026-08-24: task in, model phase, gate on
  a tree it could not write, a person on a phone, PR out. The base-gate cache made the verification
  15 minutes rather than 30, and a red gate published because the base was red on the same target.
- Three ship runs for one PR. Neither waste was the fleet working badly: one click on conduct's own
  suspended step, and one tool granted without the tool that reads its result.

### What a phase is given, and the flags that decide it
- **`--setting-sources` has three values and does three different things**: `''` loads no skills and
  no `CLAUDE.md`, `user` loads the container's own ephemeral HOME, `project` loads the branch's - and
  its hooks. Only one of the three is safe here, and it is not the one that was set.
- **`--model` unset meant Sonnet** while every workstation session was on Opus, and nothing said so.
- A mount is not access: `Read` and `Glob` are confined to the working directory, so a declared
  `--add-dir` is what makes a read-only mount openable. The first live run answered correctly anyway,
  by finding a way round.
- rtk's hook answers `updatedInput` and never a permission decision - but `Bash(rtk:*)` is `Bash(*)`,
  so `permission_denials` is empty from now on and that silence is not evidence.
- A cold knowledge-graph build is 12s and 38 MB - but **the graph stores absolute paths**, so it is
  per WORKTREE and not per project; sharing it is refused, loudly, naming the other tree's files.
- **A phase that hit `--max-budget-usd` exits non-zero exactly like a broken `make install`.** Only
  the result event's subtype tells them apart, and nothing read it.

### Windmill will not make a suspend conditional the obvious way
- **`skip_if` disables that module's suspend whatever the predicate evaluates to** - proved with a
  literal `false` - so a gate built with it can only publish, never ask. On the waiting module it
  does not prevent the wait. A `branchone` hides the suspend in a sub-job where `current_module()`
  reads `None`. `stop_after_if` is what works, and needs no change to conduct at all.
- **`user_auth_required: true` makes the owner resume endpoint fail as enterprise-only**, so conduct
  was already unable to answer the human gate by a mechanism nobody had found. **Removed
  deliberately 2026-08-29** so the dashboard could answer the card it now shows.

### The publish path, and two ways a killed phase never came back
- **A report is a value, not a status**: a flow module returning `{"ok": false}` succeeds, so a
  failed gate was recorded as a green flow from the moment the transport landed.
- **A phase killed mid-run wedged its own step for ever** - `poll` opens the dispatch row before it
  dispatches - and `state.py`'s comment said the opposite. The retry loop also had no prefix guard,
  so one plausible way to record a notification would have let conduct approve its own gate.
- **`main` is not branch protected**, so one name check is the whole boundary; and a branch named
  for a reused worktree lets a pull request change under an approval.
- A deploy key has no REST surface; a `pull_requests:write` PAT has labels and reviews, and is not a
  Bot. ntfy would have delivered nothing four different ways, all exiting 0.
- A planted commit cannot prove the chain, because `prepare_worktree` resets the tree.
- **The base pin read the wrong repository**, so a phase was blamed for commits other people pushed
  between the mirror refreshing and staging catching up. An empty commit was refused for touching
  `Makefile`.
- **The encoder gate refused on a device the fleet cannot address** - a runner gets no GPU at all -
  and, dispatch being continuous, any transcode queue stopped the fleet outright.
- **A drift check can fire on a key the server refuses to keep** - Windmill drops a default, so git
  held a key the deployed flow never had. The mirror image of the `lock` trap.

### The round, and four ways a phase reads a tree that is not the one it was sent to
- `prepare_worktree` is destructive, so every phase after the first one continues someone's work -
  and resetting deletes the commits under review, silently. `continues` and `needs_commits` are two
  tuples because they answer different questions, and the planning phase is in neither.
- A continuing phase must INHERIT the base pin, not take one. Keying the graph build on `needs_task`
  made the squash phase rebuild 38 MB it never opened.

### A stable branch name, and the guarantee the head sha was quietly providing
- `stop_after_if` fires correctly after a resumed suspend, measured both directions. A task-shaped
  branch is mutable, which gives back the run-N/run-N+1 hazard - closed by a publication refusal at
  the planning step and by `--force-with-lease` on the sha conduct itself pushed.
- A squash rewrites history and the TREE is what carries the gate across it. The round counter must
  never be a flow argument, the continuation marker is cleared before the start, and the publication
  pass must run before the continuation pass.

### Three ways a new phase reads something that is not there
- `ALLOW_BASH_READONLY` had no git, and the reviewing phase's first instruction is `git diff`. rtk
  rewrites `git diff` into a summary, so a review would report findings about code it never saw. A
  bare `git commit` opens an editor a container does not have.
- All three answer confidently from less information than they were given, and none of them fails.

### One artefact for two readers, and the flag that unmade a pull request
- `+` is a successful FORCED push and `_FLAGS` listed three of git's six, so a squash that worked
  was read as a refusal and the PR opened describing a commit its branch no longer held. Every
  check green, because the tree was right the whole time.
- The approval card is not a PR description; withholding the `pr` skill did not stop the fleet
  writing a body, only the right one; and two phases naming one finding differ by a word, which a
  case-folded title comparison cannot see.

### A binary that answers is not a binary that works
- `node` is assumed by every JS action and declared by none, so ENOENT names the prek HOOK rather
  than the interpreter; `nodejs24` ships `node` alone, without `npm`/`npx`.
- **Fedora builds node `small-icu`**, so `Intl.DisplayNames` answers `NL` for `NL` - one test of
  4,460, no throw and no warning. The gate asserts the display NAME, never `icu_small`.
- A binary list is only as good as its enumeration: 26 asserted, and a lane shipped that could not
  lint.

### Turning a feature off costs nothing when it bills per person
- GHAS bills per ACTIVE COMMITTER, so disabling it on 17 of 19 repos saved $0; and a minimal
  configuration silently defaults every setting it does not name to `disabled`.
- `advanced_security` reports **absent**, not `disabled`, on a repo that is actively billing - the
  `code-scanning/default-setup` **403 is the only reliable negative** - and a PATCH naming it is
  rejected ATOMICALLY, so `secret_scanning` stayed on while the call looked sent.
- **`gh api --jq` prints error bodies to STDOUT**, so "did it return anything" reads a refusal as an
  answer; and `visibility` comes back lowercase, which made a billable count read 0 at $47/month.

### The engine kept its state where the job could reach it, and the ninth reproduction still did not fire
- `XDG_RUNTIME_DIR` was on the 1777, 512 MB `/tmp` a job's own steps write to - locks, exit files,
  and the pause pid file that owns the namespace every nested layer is mounted into.
- **`runroot` loses to `XDG_RUNTIME_DIR` silently**, exactly as `graphroot` loses to
  `rootless_storage_path`; the gate must ask the ENGINE, not read the file back.
- **`/run` was uncapped at 7.8G inside a 3,584M `MemoryMax`**, and an explicit `--tmpfs` REPLACES the
  read-only-tmpfs mount, so `tmpcopyup` is required. uid 1000 cannot `mkdir` in `/run`.
- **Nine reproductions of upskald's `api-checks` failure, none of which fired** - the last taking the
  namespace hypothesis apart three ways in one run. The move is a correctness fix, NOT the cure.
- **So the shim stopped being only a witness**, and that reversal is stated. A failing `podman
  start` writes zero bytes to stdout, which is the only reason a retry is safe; `docker start -a`
  returns the CONTAINER's exit code, so it must never be retried.

### The store remembered the old runroot, and podman believed it over everything
- **libpod records its runroot in `db.sql` at the root of the GRAPH ROOT**, a lane bind mount
  that outlives every image upgrade - and podman uses the recorded value over the environment
  AND `storage.conf`, silently. Third of a family, after `graphroot` and `runroot`.
- The result is **two engines over one store**: `pause.pid` under one runtime dir, `alive` and
  `exits` under another, with mount refcounts split between them.
- **Reproduced on demand after ten reproductions that fired at nothing** - and the repair is
  deleting `db.sql` alone, never the store. **A split is NOT sufficient to break
  `docker start`**, so it is not the `api-checks` fix.
- **The smoke test already had the assertion and reported `ok`**, because `runner()` builds a
  FRESH lane and a fresh lane has no stale `db.sql`. The gate is `ci.runtime_dir` in
  `verify-host.sh`, which reads a RUNNING lane - **proved to FAIL before it was trusted**.
- **`podman exec` without `--user` is container root and reports `rootless: false`**, a
  different code path; it answered `/tmp` for a lane whose jobs used `/run`.
- A smoke leg ran `docker info` and claimed to prove `DOCKER_HOST` - but the shim execs LOCAL
  podman, which honours `CONTAINER_HOST`. `.env`/`.path` in the never-cleaned runner tree
  rewrite every job step's environment.

### The post-mortem measured the wrong mount namespace, and reported it as a finding
- **Rootless podman mounts inside the PAUSE PROCESS's namespace**, so `/proc/self/mountinfo` and
  `ls -A <layer>/merged` from a shell see nothing the nested engine mounted, however healthy.
- Measured on a **running** postgres: `overlay mounts shim-ns=1 pause-ns=2`, `merged entries
  shim-ns=0 pause-ns=18`. The failing job reported exactly what a WORKING container gives, so
  "the nested podman mounted nothing" was never measured. Retracted from three files.
- `/proc/<pid>/root` resolves paths in that namespace and needs only the same uid. **Print both
  numbers labelled**, so the old reading can still be recognised.
- **libpod unmounts on a failed start**, so the post-mortem runs AFTER cleanup - an empty
  `merged/` cannot separate "never mounted" from "mounted then torn down". Read `State.Status`.
- **The instrument had no control**: that block had never been printed on a SUCCEEDING start.

### A backlog is a corpus, and the parent task is in it
- Nothing ever asked the tracker whether a follow-up already existed, so a re-run re-filed its own
  follow-ups and a duplicate of a task a PERSON wrote was never checked at all.
- The subset rule survives a wider corpus; the length at which it is trusted does not. Measured over
  905 open tasks: 9 collisions bare, 3 at a four-word floor on BOTH sides, and all three real.
  Epics are dropped, and a follow-up's own parent task is a false positive only a live run showed.
- A tracker search that fails must file anyway and say so, and the cap applies to what survives.

### A failed flow is unrecoverable and almost nothing in it is
- A Windmill `CompletedJob` is terminal, but the plan, the commits, the report and the review all
  survive - so a resume is a NEW flow run that skips the three model phases conduct recorded as
  done. The gate is never skipped: it costs no credits and the push lives inside it.
- `run.result = 'ok'` is not "the step succeeded", a skip that trusts a flag alone publishes
  whatever is in the tree now, and `not payload.get("exit_code")` also matches a phase that exited 0.

### The last step of the pipeline is the first one that leaves the host
- A transient `exit 128` on the push threw away a run that had already planned, changed and gated.
  Retried three times, and "worth retrying" keys on the absence of a per-ref line - a rejection
  always prints one, a transport failure never does.
- ssh's trailer is identical for four different causes, so keeping git's LAST line kept the useless
  one. A handler that raised was answered and never echoed, so the journal said only "failed".

### The worktree is reused between changes, and so is everything keyed on it
- "The most recent X on this worktree" is the previous TASK's X until this one overwrites it. The
  planning phase would have triaged a stale review; the push would have leased against a branch
  belonging to another task, which git refuses outright.

### A filesystem that counts against the memory ceiling, and a browser that fills it
- **A tmpfs inside a container is part of its MEMORY budget**, unreclaimable without swap, so a full
  one pins the cgroup at `MemoryHigh` for ever. `/tmp` 2g plus `/dev/shm` 1g inside a 3G `MemoryMax`
  could reach the hard limit with every process behaving.
- **`--shm-size` was inert** because podman mounts `/dev/shm` `noexec` and Chromium falls back to
  `$TMPDIR` - the `exec` flag that makes `/tmp` usable is what made Chromium prefer it. 1,925 MB in
  969 unlinked fds.
- **`MemoryHigh` throttles and does not kill**, so `oom_kill` stayed 0, nothing failed, nothing
  paged, and `cpu.stat` proved CPU innocent. The browser said `ERR_INSUFFICIENT_RESOURCES` and
  Playwright said `element(s) not found` - which is a different sentence from "not visible".
- **`du` cannot see an unlinked file**: 49 MB against `df`'s 2,047 MB. Only `df` and `/proc/*/fd`.
- **A container is not memory- or CPU-namespaced**, so Chromium sizes pools from the host's 15.8 GB
  and node from `nproc` 12, inside a 3 GB, 4-core cgroup. The hosting side has to leave room.

### Two defects in one uCore image
- `policy.json` shipped truncated with NUL padding: nothing could be pulled or built, 22 running
  containers stayed healthy throughout, and **`jq` accepts the broken file**. The repair is a local
  `/etc` override that `deploy.image_policy` carries the removal trigger for.
- Performance Co-Pilot shipped unlabelled binaries and blocked an OS update. Its timers report
  `disabled` from `list-unit-files` and were active - check `list-timers`.

### greenboot, GRUB, and the red boot that arms the fallback
- **A red boot arms GRUB itself and stays armed until a green boot**, silently turning the next
  deliberate reboot into a rollback while every signal reads correct. Four things went wrong at once,
  including six sites selecting on `.staged` when `pending` is the state that boots next.
- `greenboot.verdict` FAILed for ever over an event nobody could act on. The `red.d` hook assertion
  is what makes the downgrade to WARN sound rather than a silencer.

### A digest that is not comparable, and a marker a reboot wipes
- Two kinds of sha256 name the same image, so the obvious digest check fires on every host, on every
  run, on a perfectly current machine. Resolve the index to this host's architecture first.
- `ExecMainExitTimestamp` is runtime state a reboot wipes, so "has never run" and "has not run since
  boot" look identical.

### Disks, and where things must not be put
- `/mnt/media` has no redundancy, holds only re-downloadable media, and is deliberately not backed up.
- Transcode scratch stays off the media disk - do not "simplify" it back under the media volume.
- `nv-patch.sh` is deleted and should not come back.
- `config/` is on `nvme0n1p4`, not `p3`. `p3` is the 350 MB `/boot`.

### The segmentation, and what it buys
- The forbidden edges are verified **by IP from a throwaway container**, never by name resolution.
- Prowlarr is the single hop out of `net-solver`, so its own login matters more than the others'.
- SMT is on deliberately, which removes FCOS's `nosmt`; `net-solver` isolation is the barrier that
  is trusted instead, and the `kernel_arguments` block is what to revert if that stops looking right.
- Gluetun's HTTP and Shadowsocks proxies are off - unauthenticated, they were an open proxy into
  the VPN for any LAN device.
- Services address each other over their shared network, never a public hostname.
- Tinyauth's token and userinfo URLs are internal; only the two the browser follows stay public.

### Logs, and why priority is not a signal
- A container's stdout is journal priority 6 and its stderr is priority 3, so an application logging
  to stderr records every cheerful 200 as a journal **error**.
- `journalctl -p err` is still not usable: Jellyfin alone emits 2,644 priority-3 lines a day of
  ffmpeg chatter and cannot be told otherwise. Alerting keys on unit state and container health.
- podman's `health_status` events were 47.3% of all journal bytes and are now off entirely.

### The media spindle, measured
- It gets **slower** with concurrency - two readers cost 45% of total throughput and the penalty is
  head travel, not layout. The answer to "it's slow" is fewer jobs, never more bandwidth.
- Tdarr's spindle reads are a burst at job ingest; it then works entirely from the NVMe cache.

### Jellyfin and the transcode pipeline
- Jellyfin is the largest CPU consumer and is not serving anybody: **trickplay has its own hardware
  switches**, independent of playback's, and all three shipped off.
- Playback hardware decoding was **never** off - a line-matching grep cannot show an XML element's
  contents, which is how that was misdiagnosed.
- An irregular keyframe interval breaks browser playback, and the symptom names neither cause.
  Throttling is innocent, and `bin/verify-media.sh` is the check.
- Jellyfin sitting **at** its `MemoryHigh` with a climbing throttle counter is fine. Read `anon` vs
  `inactive_file` and `memory.pressure`, not `memory.events high`.
- Jellyfin 10.11's own queries are slow; inherent to the EF Core rewrite, not a configuration problem.
- Two NVENC sessions already pin the encoder block at 100%, which is why the worker limits are
  `transcodegpu:2, transcodecpu:0`.
- `queueSortType: sortPathAZ` is how episodes come out in order.
- The community "5 steps" flow was actively destructive and is retained only as a rollback.
- A Tdarr health check is a full-file decode; queueing 470 wedged the whole host while it still
  answered ICMP and completed TCP handshakes.

### cgroup limits, and the controller that was not delegated
- **`CPUQuota` protects the host and tells the guest nothing.** `nproc` reads 12 inside a cgroup that
  delivers 4, so every worker pool oversubscribes 3x - measured at 5x slower and a reproducibly
  refused good change. `AllowedCPUs` is the half that was missing, and `--cpus` does not fix `nproc`.
- `io` is **not** delegated to the user manager by default, so every `IOWeight=` in `stacks/` was
  inert - the control aimed at the cause above was the one not working. Verify; the failure is silence.
- Every service quadlet carries `MemoryHigh`/`MemoryMax`; the Tdarr units add CPU and IO weights.
  These are systemd cgroup directives, not podman flags.
- Tdarr runs again, both units. **A `Wants=` on a disabled unit silently re-enables it** - use
  `After=` for ordering, never `Wants=`.

### Indexers, and three ways to find nothing while everything is green
- **Adding indexers was the wrong answer and was measured rather than argued.** Most of what is
  "missing" is not released yet, and `isAvailable` reads true for a 2027 film - it means "may Radarr
  grab this", not "does this exist".
- **The `[VO]` floor was unreachable and this file asserted the opposite.** 124 releases, 0 approved,
  and the "scores ~50" claim above was wrong for as long as the profile existed.
- **A back-catalogue title is searched once, at add time, and never again.** RSS only carries new
  uploads, so 94 episodes stayed missing while three approved releases sat on a configured indexer.
  `bin/search-missing.py` is the fix.
- **Searching by season was the obvious economy and returned nothing**, because a season query asks
  for a season PACK. Disproved by the first live run; the cap is counted in episodes now.
- **A stalled download blocks every alternative release and reports itself as `downloading`.** One
  refused all 49 candidates for a film with `already meets cutoff`, six of them at score 870.
- The ISP resolver returns a blocking page for several indexer domains, which is why prowlarr and
  flaresolverr carry their own `DNS=`.
- **That override works and is no longer the explanation for a down indexer.** Six zeros were five
  unrelated causes, none of them DNS.
- Prowlarr pushes every indexer to every application and retries the refused ones for ever. Some gap
  between the three counts is correct, so read them - do not alert on equality.

### A restart that cut a stream, and the gate that was looking at the wrong device
- **The nightly update interrupted a live session on 2026-08-19**, at one-minute resolution in the
  series: two of three connected clients never came back. `podman auto-update` takes no
  per-container filter, so the whole run is gated instead.
- **`ExecCondition=` skips a unit without failing it** where `ExecStartPre=` fails it, which is why
  the update gate exits 1 to refuse and `reboot-when-staged.sh` exits 0.
- **A DirectPlay session opens no encode session**, so the reboot window's `nvidia-smi` gate read 0%
  while a film played. The same measurement is priced two ways on purpose: unknown refuses before a
  reboot and proceeds before an update, and `update.playback_probe` keeps the open direction from
  being a blind spot.
- **A staleness filter drops ghosts; only the ceiling drops a tab left open all night** - one
  measured run of 18.4 hours. Three days, not the encoder's fourteen, because the interruption is
  cheap.
- **The host is on UTC and the household is not**, so "move it to 5am" would have landed the update
  on top of the 03:00 backup.
- **The `host/systemd/` symlink loop globs by EXTENSION** and knew only `*.service.d`, so the first
  `*.timer.d` was invisible with `daemon-reload` reporting success. Third time.
- **Widening a `Persistent=true` timer's calendar fires it immediately on the next
  `daemon-reload`** - the new schedule creates missed elapses in the past. The mirror of the
  first-enable trap. A skipped unit also reports `Result=exec-condition`, which is not a failure.
- **A skipped run CLEARS `ExecMainExitTimestamp` rather than leaving it stale**, so `check_timer_run`
  says "has never run" and FAILs from the FIRST deferral. Got wrong twice before it was measured;
  the check grades on the deferral age and reads none of the unit's own timestamps.

### The dashboard measured one thing twice, and drew another thing two ways
- **`sum(rate(node_disk_*))` counted the media spindle twice**: diskstats drops partitions and not
  device-mapper, so dm-0 was added to the sda it sits on. Measured, 0.0003% apart.
- A byte axis stepped in base ten is round before the unit conversion and ragged after it - a
  16 GiB frame labelled "0 B / 5 GB / 9 GB / 14 GB". Byte and rate axes step on powers of two.
- **The same findings were drawn twice and disagreed about `note`** - amber in the strip, grey in
  the list - and no fixture had one, so nothing could see it. `checkTone()` is the one mapping.
- **The dead man's switch was rendered as a warning.** Filtered out now; and because hiding it must
  not hide its absence, a response without it raises a `fail` line in its place.

### The credential that could not read the number, and four defects on the path to it
- A `claude setup-token` gets **403 `user:profile`** from `GET /api/oauth/usage`, which a signed-in
  workstation reads fine - so the account-wide percentages three consumers promised are unreachable
  from a headless host. The status on the phase's own model call is what replaced them, and
  **absence must PROCEED rather than refuse**, the inverse of the rule the endpoint design had.
- **`shutil.rmtree` on a symlinked directory deletes nothing and raises inside `ignore_errors`**,
  while `isdir` follows the link and says yes - a planted `.git/hooks` survived and `post-checkout`
  ran as `core` outside every boundary. The report was built from `listdir` before the removal, so
  it claimed a deletion that never happened.
- **`core.quotePath` C-quotes any non-ASCII path**, so a refused path escaped classification by
  being spelled with an accent. A drift check compared a flow's `value` and never its `schema`. A
  `# noqa` on one imported name does not cover the import, and `ruff --fix` would have deleted a
  live attribute.
- **`git reset --hard` leaves untracked files** and `prepare_worktree` never cleaned - the lesson
  was applied to the verification tree only, and worktrees are reused.
- **Starting an MCP server is a process spawn, not a tool call**, so no hook sees it. `--bare` skips
  hooks; `--permission-mode bypassPermissions` is the supported spelling of the bypass.
  `--setting-sources ''` loads nothing while `--settings` still installs the hook, and a hook
  outranks `--allowed-tools`. `-p` silently ignores a settings file that fails validation.

### A runner that cannot be contained the way a phase runner is, and a health status nobody sets
- **Podman drives healthchecks with transient systemd timers, and a container has no systemd**, so
  `--health-cmd` only warns and the status stays `starting` for ever - while GitHub's runner waits
  on it with NO RETRY CAP and upskald sets `timeout-minutes:` on zero jobs. A six-hour hang with the
  container running, the service serving and nothing on this host reporting anything wrong. The fix
  is a poll loop; polling FASTER than the declared interval fails a healthy postgres instead.
- **An engine old enough to ship in an LTS cannot run a container here; a newer one can with almost
  nothing.** Ubuntu 24.04's podman 4.9.3 refuses with `newuidmap: write to uid_map failed` - every
  range in the map, `CAP_SETUID` present, and NO AVC even with `semodule -DB`. podman 5.8.4 does it
  with DEFAULT capabilities and SELinux enforcing, so the base is `quay.io/podman/stable`, whose
  own user already has subuid ranges that fit a rootless outer container. `setup-python`'s
  Ubuntu-only assets are closed by baking Python into `RUNNER_TOOL_CACHE`.
- **Four flags, bisected, and none of the refusals names the one that fixes it**:
  `container_engine_t` (not `label=disable`, which runs as `unconfined_t` and removes SELinux
  entirely), `unmask=ALL` (locked mounts, not masking), `--cap-add=SYS_ADMIN` (a detached container
  sets its own hostname; this makes `--read-only` hygiene rather than a boundary), `/dev/net/tun`.
- **A one-command probe and the real workload took different code paths** - an interactive
  `podman run alpine echo ok` needs no tap device and a DETACHED one does, which is every
  `services:` block. **`/dev/net/tun` is group-0 and the NESTED namespace loses that**, so the
  runner's PRIMARY gid must be 0; the chmod that looks like the fix returns EPERM and, written
  `|| true`, fails invisibly.
- **`--read-only` breaks the runner before podman is involved** - `--jitconfig` is written to disk as
  `.runner`/`.credentials` and read back for a label. The writable tree is also what stops a mint
  storm, because a JIT config carries no `disableUpdate`.
- **A lane's bind mounts mask what the image put under them** ($HOME hid the engine's own config,
  the tool-cache mount hid the baked Python), **`cp -a` carries the MCS categories** so the next
  container cannot read what it was given, **`core` cannot `rm` a lane** without `podman unshare`,
  and **`rootless_storage_path` under `[storage]`** is the key that is read - `graphroot` is not.
- **`timeout` as pid 1 returns 125 with nothing on stderr**, so four by-IP containment probes
  reported they had proved nothing and the cause was inside the probe. **A shell wrapper does not
  fix it**: `sh -c 'timeout ...'` with a single command EXECS it. `--foreground` is what works, and
  a first measurement pointed the other way only because it happened to have a second command
  after the `;`.
- **A ceiling is not usage, and reading it as one nearly cost a second slice.** app-agents reserves
  4,608M and its 30-day median is **957 MB**, p90 1,455 MB, with a phase in flight 6.9% of the time.
  `-p AllowedCPUs=` works on a transient SCOPE as well as a slice - measured, `nproc` reads 2.
- **`agents.runners_leaked` filters on the ephemeral label alone, so it now watches two fleets.**
  The number stayed at 7200 and the message widened; raising it for CI would have blinded it for the
  agent fleet on a threshold neither owns. Creating a lane's network from the driver keeps `net-ci-*`
  out of `agents.runner_isolation`'s stack list, and the whole change out of `topology.ts`.
- **`bin/reboot-host.sh` said nothing about work in flight at all**, so adding only the CI half would
  have read as "nothing else is running". A killed CI job is NOT re-queued by GitHub, unlike a phase.
- **Noble already has a uid-1000 user, and three package names differ**: `liblttng-ust1t64`,
  `libmagic1t64`, and `containers-common` is `golang-github-containers-common`. A workflow's
  `image: postgres:16-alpine` is an unqualified short name podman refuses without a search list.
- **Cache keys are shared between hosted and self-hosted runners** (`runner.os` is `Linux` on both),
  so a self-hosted run can break the next HOSTED one. Labelling a lane `ubuntu-latest` is a trap:
  the fallback keys on whether a runner is CONNECTED, so a workflow silently alternates environments.

### A thing that shipped, a thing that could not arrive, and no way to tell them apart
- **`gh` was never in the lane image and the cost is the CONSUMER, not the package.** It fails
  green twice: an AI review silently goes full rather than incremental because `_run` catches
  `OSError`, and the coverage gate warned-and-passed having enforced no threshold at all. Fedora 44
  ships it; the two assertions worth making are that it can write `~/.config/gh` on a read-only
  rootfs and that it resolves `GH_TOKEN` with no login.
- **The tool-cache seed guard keyed on EXISTENCE, which is not a version**, so a lane was seeded
  once ever - and the `ensurepip` work shipped in the image and reached neither deployed lane with
  every signal green. The stamp is derived from the tree, the cache is cleared rather than copied
  over, and `ci.toolcache_seed` grades it because the smoke test builds a fresh lane and passes by
  construction.
- **The smoke test chowned `1000:1000` where the driver chowns `1000:0`** under a comment claiming
  they matched - and gid is the only asymmetry the `docker start` 125 has ever shown, so no
  gid-based hypothesis was testable through it.

### Eighteen more reproductions that fired at nothing, and one hypothesis retired
- Instruments live, both lanes loaded past the band that reproduces, eighteen attempts - six cached
  and serial, twelve with a forced fresh pull on both lanes at once - and none fired. Every one ran
  inside a LONG-LIVED lane container, which the real workload does not.
- **The 31-32 second gap before three of the four heals is the failure's own duration**, not a
  precursor; successful cycles that evening are 32-33s apart too.
- **The load hypothesis is contradicted by the post-mortem's own numbers**: io and memory pressure
  0.00, memory 155 MB, 66 pids of 1024 at the instant of failure. The lane was idle.
- **A driver killed without its TERM handler could `rm -rf` a live store** - no lock anywhere, the
  job in a sibling scope, `job_in_flight` not restored. **Ruled out for 2026-08-26**: both driver
  pids held continuously across both evening failures and the day carries no non-clean exit. Guarded
  anyway, in one `podman ps`.

### One directory for every lane, and the half of it that must never be swept
- The coverage ratchet moved off GitHub onto this disk, and `absent` PASSES upskald's gate while
  `unavailable` fails it - so a lost baseline enforces nothing on every surface at once, silently.
  An empty capture of an existing store is therefore fatal to the backup run.
- **A sibling of `lanes/`, not a child**, or `lane_reset` would take it on the first self-heal; and
  deliberately not under `config/`, or the "no `config/` in a lane" assertion becomes "except this
  one". `state/` is staged into the backup the way the TSDB snapshot already is.
- **`CI_ARTIFACT_STORE` is in the image's `ENV`, never an `-e`** - the driver passes no environment
  into a lane, and the value is a container path. Always being set is the point.
- Thirty days on `runs/`, because a merge-time consumer reads a pull request's LAST run; a sweep on
  its own timer, because two drivers over one shared tree have no lock; and `podman unshare` or the
  copy reports success having copied nothing.
- **A live-but-unseeded store gives a pipeline exactly as green as a seeded one**, so `ci.artifact_store`
  grading `du -sb state/` could not tell: any stray file made the bytes non-zero while a consumer
  opening its own `baselines.json` got `absent` and PASSED. It counts baselines now, an unseeded
  store is a **warn** rather than a note, and it was made to fail before it was trusted.
- The migration was verified by re-fetching the source fresh - not the copy used to seed - and
  matching sha256 from inside both lanes, with no credential passed into a lane to do it.

### A tool that assumes a distribution, and does not check before it fails
- **`playwright install --with-deps` supports Debian and Ubuntu only and does not detect that it
  cannot work**: on Fedora it warns, uses the Ubuntu package list anyway and exits 127 on
  `apt-get`. Gated on `runner.environment` rather than deleted, because hosted is the escape hatch.
  The next missing library surfaces as Chromium failing to launch, naming neither the step nor
  Playwright.

### A fallback build makes another distribution's ABI your problem
- Playwright's `hostPlatform.ts` returns `ubuntu24.04-x64` for every distro it does not recognise,
  so a Fedora lane must satisfy **Ubuntu's** sonames. chromium is exempt - Google's build is
  distro-agnostic - which is why it worked here from the first run and the other two did not.
- **Five sonames have no Fedora package at any version**: WebKit hard-links ICU 74 and
  `libjpeg.so.8` against Fedora's 76/77 and `.so.62`, and dlopens `libx264.so`, which Fedora
  excludes entirely for patents. Vendored from pinned `.deb`s, and safe only because the linker
  matches EXACTLY - measured, `.so.77` still resolves to `/lib64`. `ld.so.conf.d`, never
  `LD_LIBRARY_PATH`, which outranks a binary's own `DT_RUNPATH`. `ldconfig` will not invent the
  unversioned `libx264.so`, and a package name in Playwright's table can be a heuristic for a
  soname rather than a fact about the package.
- **`ldd` clean is not Playwright-clean**: `validateDependenciesLinux` names dlopen dependencies no
  `ldd` can see, and **throws on launch**, not only on install. The mirror is firefox's
  `libavcodec60`, which is a dlopen and deliberately absent. A permanent warning box would hide the
  next real one, which is why the three dlopen packages are installed anyway.
- The bundle's OWN libraries read `not found` to a naive `ldd`; Playwright's table omits `graphene`
  and `vulkan-loader` and lists thirteen this base already had. The smoke test had **no browser
  assertion at all** until 2026-08-27, while two documents predicted the failure it would catch.

### Running a browser as container root is a different code path, again
- The image has no `USER` - `runner-init` re-execs through `setpriv`, so a probe passing
  `--entrypoint` is root and measures a container no job runs in. Chromium hung five minutes as
  root, and reported `Target crashed` at podman's default 64 MB `/dev/shm`. Third of the family.

### The fleet chooses its own work, and four things that look alike while it does
- **`_plan_step` never read `status: blocked`**, which has been in the schema and the prompt since
  the planning phase existed - so a blocked plan returned `ok: true` and the flow spent $15
  implementing a task the planner had just said could not be implemented. The task cannot be moved
  back and should not be: it parks in `Planning`, which the candidate pool already excludes.
- **Between `run_flow` and the flow's first suspend nothing says a task was taken**, so a second
  would be picked - and `chain_open` supersedes on a differing `odoo_task`, so that silently CLOSES
  the first one's round. Claim before the start, restore on failure. **Falling out of the dispatch
  loop is not `idle`** either: it `continue`s past the unprefixed human gate.
- **An intake that has stopped looks exactly like an empty backlog**, so `agents.intake` grades the
  LOOK and not the run. Holding is `ok` with the reason in the message; the two are told apart by
  the AGE, never by the string.
- **Turning that switch back off made the detector fire on the switch**: the `intake` row outlives
  the flag, so a paused fleet aged into a warn and paged every half hour for a state somebody asked
  for. The keys are dropped with the switch now - a docstring had promised that and never
  implemented it, because absence held by construction until the first pause.
- **The milestone ladder is ordered by the M-number in the name and by nothing else** - `deadline`
  and `is_reached` are unset on every rung, the id runs backwards, priority is not a milestone
  signal, and a string sort puts `M10` between `M1` and `M2`. A dependency is clear only when
  `is_closed` is true; absence from the pool is not evidence.
- **The select worktree is reused, so `last_answer` without `since` returns the PREVIOUS look's
  choice** - and a phase that exits 0 answering nothing is a real shape. The fleet would start a run
  nothing chose today, with every clause passing. Same family as the stale review one row up.
- **Nothing bounded the fleet as a whole** until `REVIEW_CAP`. What it prevents is not a crash - it
  is twelve conflicting draft PRs and a person who has stopped reading them.

### The lane healed itself, because the remedy had been a person
- **`api-checks` has passed since both lanes were emptied BY HAND**, which repaired nothing. A
  one-minute reproduction eliminated `ports:`, the runner's container-init path and the inherited
  environment, and produced the one positive result: wiped lanes pass, lanes with ~2.5 GB of state
  from twenty-odd jobs fail. **Not a threshold** - it failed at 2.4 GB after 21 jobs and passes at
  2.5 GB after 39.
- **So the state is BOUNDED rather than explained**, on three triggers, and the shim's channel out
  of an ephemeral lane is a file in `$HOME` because that is the only part of one that outlives it.
  The manual remedy destroyed the evidence twelve reproductions have failed to recreate, so a reset
  with a reason keeps the store's metadata first - and a routine window reset keeps nothing, or
  fifty of them would evict the two that matter.
- **Three defects in one reclaim, and the first hid the other two** - it had never once fired.
  `du` outside the user namespace read 1,383 MB against 2,500 MB actual; it cleared `home/work`,
  which has never existed, because the workspace is `runner/_work`; and it recreated `tmp/` and
  `storage/` without chowning them back. A check that under-reports hides everything gated behind
  it, and code that never runs stops being reviewed.
- **`bin/github-runner-smoke.sh` structurally cannot see either**, building a fresh lane every run,
  which is the same blind spot that let the `db.sql` split through with a green tick.

### A ceiling nothing measures is a ceiling nobody can tell is wrong
- **Three e2e shards all pinned to `MemoryHigh` EXACTLY, to within 2 MB, with `max` and `oom_kill`
  at 0** - the throttle working, not a ceiling under strain. Nothing was raised. `anon` alone is
  2,607 MB of the 2,816M, so the 768M to `MemoryMax` is the whole margin.
- **The scope is `--collect`**, so its peaks have to be sampled while the job runs; they are kernel
  high-water marks, so the rate does not decide the answer, but the last interval before exit is
  missed and that makes it a floor. `memory.events` is per-cgroup and the cgroup is new every job.
- **`ai-review` now runs on a lane**, which `docs/ci.md` used to forbid. What widens is what runs,
  not what is held: the credential is upskald's repo secret, not this host's.

### The failure came back on the machinery built for it, and one number differed
- **It recurred 40 minutes later and healed itself**: shim retried, post-mortemed, left the
  breadcrumb; driver captured and reset 21 seconds later; `ci.lane_store` reported it. Nobody had
  to notice a red job.
- **The driver's capture was nearly worthless and the reason was already on record** - it runs
  POST-CLEANUP, so a failing store is byte-for-byte the shape of a working one. The limitation
  written about the shim's block, rediscovered in the thing built to get round it.
- **The shim's block finally had a CONTROL**: failing start reads `merged`/`work` gid **65535**,
  pause-ns overlay mounts 1, merged 0 entries; a healthy start thirty seconds later reads gid 0,
  mounts 2, merged 18 - as do all eleven other layers. **Not the overflow gid**, which is 65534
  here; 65535 is inside the engine's mapped range and something chose it.

### Four heals in a day, and three instruments that were pointed at nothing
- **The post-mortem was reaching NOBODY**: `tee FILE 2>/dev/null >&2` applies left to right, so
  tee's stdout went to the /dev/null fd 2 had just been pointed at. Three groups in the forensic
  capture, ZERO in the job logs. The smoke test asserted the file and only the file.
- **`mountpoints.json` was never absent, it was the wrong path** - it lives in the RUNROOT, and the
  comment explaining the absence away made a bug look like a finding.
- **65535 was read against the LANE's gid map, not the nested engine's.** Off the pause process the
  nested map is `0 0 1`/`1 1 999`/`1000 1001 64535`, so lane 65535 is its CEILING and is what the
  nested overflowgid maps onto. Not "a gid something chose".
- **Three of the five rows compared a post-cleanup failure against a RUNNING control**, so they
  could only ever differ. The shim now SAMPLES the start; setup before the fork, and the subshell
  must clear the EXIT trap that deletes the samples.
- **The load it was blamed on was absent for two of the four**, `store_jobs` was 4/12/18 against a
  50-job window, and a mid-job reset is ruled out by the journal.
- **`chown 1000:1000` wrote a gid nothing else writes** (the runner's primary gid is 0), and
  preflight's `-R` ran over a populated store on every driver start. **Not ruled out for the
  evening pair**: both drivers restarted at 13:43:43, so it ran over both stores hours before they
  failed. The first version of that line said the opposite, off a window that started at 20:34.
- **Fedora ships no pip for a parallel `python3.13`** - no such package at all; `ensurepip
  --altinstall`, and `--altinstall` is what stops 3.14's `pip3` becoming 3.13's.

### A fleet that is invisible to every reader except its own marker
- Ephemeral-labelled, `--rm` and `--no-healthcheck` compose into a host where a wedged lane or a
  stuck phase leaves no failed unit, no unhealthy container and no other page anything to show. The
  marker is the only witness, so absence is the finding and grey is checked before green.
- A gauge that resets at UTC midnight must be bucketed on UTC; the availability strip's local days
  would take every bar's peak from the previous day. A NULL `run.result` is in flight, not failed.
  The oldest approval's age lives in a check's message and in no fact.

### The lane that held its work and stopped saying so
- **The hold loop napped without writing the marker**, so `ci.heartbeat` warned on two perfectly
  healthy held lanes - 710s and 258s stale, units active, registrations online. Same defect as the
  idle case forty lines below in the same file, where the fix and the reason were already written.
  Nothing acted on it: `reboot-host.sh` needs `job_in_flight=1` AND a fresh heartbeat, and a held
  lane has neither.
- **The hold's "costs almost nothing" rested on a 6.9% duty cycle measured at two lanes holding
  one**, and the third lane joined the held set by the predicate saying nothing. A 2026-08-28 spot
  reading put the held lanes near 36-38% of a busy morning - CI running at roughly one lane so that
  an overlap could not happen.
- **So the hold was removed outright the same day, and the loop that defect lived in is gone.** It
  was a SCHEDULING guarantee that the two slices could not peak together; the cgroup ceilings are
  now the only bound and they sum to **14,592M of a 15,828M host**. Survivable only because neither
  slice has ever neared its ceiling - three lanes plus a phase at observed peaks is ~9.9 GB, not
  14.6 - so "the peaks do not coincide" is now an observation relied upon, not a thing arranged.
  `app-ci.slice` names what would say otherwise; throttling at `MemoryHigh` is NOT it.

### A lane at 45% of its cores was not waiting on the network
- 45% mean, 71% p90, 76% max across a lane's two pinned cores with 0.8% iowait reads as "give it
  more cores", and does not mean that. **Both long jobs on upskald's critical path are
  single-threaded** - `pytest` with no `-n`, Playwright at `workers: 1` under CI - so no cpuset
  can shorten either. `app-ci.slice` widened `4-7` -> `4-9` for a third LANE, never wider lanes.
- Lifetime `nr_throttled` is 4 and lifetime memory PSI is 60s, so neither `CPUWeight` nor the
  ceilings were ever the constraint. And a cpuset is **not exclusive**, which is what `docs/ci.md`
  forgot one section after saying it: widening shares 8-9 rather than taking them from Jellyfin.

### Uploading from this host costs 20-40x what downloading does
- **`j178/prek-action@v2` caches on your behalf**, outside the `runner.environment` guard upskald
  put on its own cache step: 50 MB up at 0.4-0.5 MB/s, 1m53 per run, over a `~/.cache/prek` the
  lane already keeps. The same cache downloads at 5-19 MB/s. The tell is a `Post <step>` in minutes.
- **Queueing was never where the time went** - 171 seconds across eleven jobs against 29m24s of
  wall clock, 67% of which is test execution. The third lane is for e2e shard WIDTH, not a queue.


### A board that could not show an outcome, and an ETA that is usually a dash
- The round board read `closed_at IS NULL`, so `published` and `stopped` were states it could never
  draw. The outcome is the publication JOIN, never `closed_why`, which is prose - and a closed
  publication carrying no pull request is a THIRD outcome, not either neighbour.
- **conduct was throwing the pull request away**: a sentence in Odoo was the only record one had
  ever been opened. `publication` carries it now, optionally, and closes with COALESCE.
- Progress is `chain.done`, which is per ATTEMPT - so the row must keep printing "attempt N of 2".
- **A round waiting on a person gets no ETA.** The remaining phases are the machine's work; the real
  wait is a person, bounded by a seven-day timeout. The first render said "~1m" over an eleven-hour
  gate. Below five samples the estimate is withheld entirely rather than guessed.
- **Hiding a merged round needs positive evidence and the GitHub leg fails open** - `unknown` stays
  visible. It is the FIRST host-side network call the collector makes, on a third, read-only token,
  and `github` is the one source `sourceNotes` must not speak for.
- **`chain` IS NOT A LOG**: its worktree_id is a PRIMARY KEY on a REUSED worktree and `chain_open`
  does INSERT OR REPLACE, so it holds ONE row against eleven rounds in `run`. The board reads the run
  log and groups on `plan`; `chain` speaks only for the round in flight. The publication join is
  windowed in consequence, and `run.odoo_task` exists because a task id cannot be parsed out of the
  prompt in `run.task`.
- **The two halves deploy separately**: a SELECT naming `pr_url` before conduct migrates reads as an
  unreadable database and blanks the board. Guarded on `pragma_table_info`, caught against a copy of
  the LIVE database - every fixture already had the column. And a row written before those columns
  read "not published" permanently, so `unknown` outranks that claim.
- Two panels called "Runs" counted rounds and phase executions; `runs_today = 6` could be one round.

### The dashboard can act now, on the path work already takes
- A command is a SUSPENDED FLOW STEP, so nothing new reaches the host: the browser POSTs to Caddy,
  Caddy rewrites to one literal Windmill path with a server-side token, conduct polls and answers.
- `rewrite` beats an allowlist - the client's path is DISCARDED. Proved with requests; `caddy
  validate` passes a guard that protects nothing, and a bare `/api/control` does not match.
- `config.py` is read at import and a restart REAPS A LIVE PHASE, so the switch is a row read every
  cycle. Absent is not `off`, an unknown action is refused, and a hold dies at CONDUCT_TIMEOUT.
- A restart cancels BEFORE it starts, or it is two rounds on one worktree.
- `conduct` is never a `to` was prose and is now `NEVER_A_DESTINATION`, asserted and proved to fire.

### The gate rewrites the tree it is measuring, and the loop for that was unreachable
- `make check` runs `format` and `lint` BEFORE everything that reads, so the tested tree is the
  dirty one and committing it satisfies the assertion. A protected path and 2 MB are still refusals.
- **`_review_step`'s "the base passes it, so the change broke it" could never print**: judge_base
  refuses in exactly that case, so a red gate that was the change's fault never reached the review.
- A REPAIR keeps the plan and re-runs dev and the gate; it must count itself, because `chain_open`
  counts from inside the planning phase a repair skips. `MAX_ATTEMPTS` 2 -> 3.
- The branch is pushed at the end of dev, so a refused round now leaves one on GitHub for ever.
- `run.error` and `run.branch`: neither `report` nor `chain` is a log, both hold one row.

### Two dashboard regressions the fixtures could not see, and four properties that never existed
- `opened_at` was never emitted, so every row read "opened never"; `closed_why` was read only while
  the round was open, so it was null on every round that had stopped.
- `attempts !== null` does not catch `undefined`, and the collector and the bundle deploy
  separately. `--ink*`/`--t-micro` are in no stylesheet, so those declarations did nothing.

### One SIGTERM, three defects, and five rounds that produced nothing
- conduct's phase wait read no stop flag, so systemd's default 90s stop timeout expired while a
  phase ran and **core-dumped conduct mid-phase**. The fix is an interruptible wait, never a longer
  timeout - that would hang every deploy for up to ninety minutes.
- **A reaped worktree left its round claiming the work still existed**, and `_failed_flow`'s three
  guards never ask whether the tree exists - so a resume skipped the plan and failed in zero seconds
  twice. Closing the round is the fix, not clearing `done`; every outbound call the reconciler makes
  is wrapped on its own, or a Windmill outage abandons the rest of the sweep.
- **$15.00 was binding on the upper half of its own distribution** - four dev runs at $4.88, $10.93,
  $14.63 and $15.11. Running out is now repairable and breaking is not, keyed on the result event's
  SUBTYPE and never on the sentence; the log is parsed once for both answers.
- An `EmptyTree` cannot tell its two causes apart and must not assert either. A failed round parks
  its task where intake cannot reach it, by design, and only a person can move it back.


### The command arrived, and the receipt could not be read
- **Windmill's run endpoint answers `201 text/plain`**, 36 bytes of bare job id: `res.ok` is true for
  a 201 and the sign-in sniff knows only `text/html`, so it walked past both guards into
  `JSON.parse`. The comment naming the hazard was one line above the call that ignored it, and
  conduct had already hit and handled the same thing.
- **Proving a route with curl does not prove the client** - no fixture reached `src/api/`, so the
  browser's read of the response had never run. Every other layer said yes and the button said
  `failed`, which invites a second press of a command already carried out.
- A chip that never clears `asked` stops naming its own action once the label flips under it.


### The loop was inside a phase, and every signal said it was fine
- **conduct's poll loop is single-threaded**: `cycle` takes ONE snapshot of suspended jobs and then
  blocks in the dispatch, so a disarm posted eight minutes into a dev phase was not in the list at
  all and landed **33m 47s** later. Nothing escaped - conduct cannot take new work mid-phase - so it
  was latency, not loss.
- **`_await_phase` refreshes the heartbeat every 15s while the loop is fully blocked**, so
  `last_ok_at` read two seconds old after nineteen minutes of not polling. No check could fire.
  `agents.control_lag` is the one that can, and `v2_job.runnable_path` is what makes it possible -
  `approvals_pending`'s "the SQL cannot separate them" is false for the control flow.
- **60s is `POLL_SEC`, the sleep BETWEEN cycles, not the length of one** - six places said "within a
  minute". A control step was also answered INSIDE the dispatch loop, behind both of its early
  returns, so it could be starved on an ordering nothing sorted.
- **A remembered ask is cleared by derivation, never a timer**, and `control.json` is a cadence fix
  rather than a content one: the fast document is a PRECEDENCE over `fleet.json`, and only when its
  own source answered.

### The card was in the database all along, and the lock that had to go
- The board showed the PHONE copy cut to 240 characters; the card a person approves is 7,568 bytes
  and was already in `report.body` and `dispatch.payload`. Reading it needed no conduct change.
- `user_auth_required` was spent so the dashboard could answer, so the `conduct_` prefix is now the
  ONLY lock - proved to fail before being trusted. The approve flow carries its mirror, answering
  `publish_pr` and nothing else, or a browser could forge a verification result.

### A transcript that can be served, and the drop that makes the redaction affordable
- **Drop tool results first, redact second**: `DOCKER_VOLUME_CACHE` is 3,920 hits raw and 17 in what
  survives, so the strict pass costs nothing. No credential was in any of the 73 logs.
- An unreadable `.env` SKIPS the render: a redactor built from an empty environment looks exactly
  like one that found nothing to redact. `agents.round_detail` greps the output, names the variable
  and never the value, and was proved to fail on a planted token.
- **A log must not be claimed twice and the match needs a ceiling**, or a reader is shown somebody
  else's transcript. `run.log` is what makes the join possible; the filename fails three ways.
- The collector deletes for the first time, `--print` had to be taught to a source that writes, and
  `phaseClock` read the first running run in the document rather than the row's own.


## Target architecture

**Steps 1 and 2 are done.** The host is uCore `stable-nvidia-lts` and every service is a rootless
Podman quadlet: `network_mode: service:gluetun` became a Podman pod, `runtime: nvidia` became CDI
device refs, and every bind mount carries `:z`/`:Z` except `/mnt/media`, which is labelled once at
mount time by `context=` instead of relabelling 7.3 TB per container start.

Doing ingress, segmentation and secrets on the Compose stack first was the right call, but not for
the reason given at the time. The claim was that their configuration would "carry over unchanged".
**It did not** - segmentation had to be rebuilt with `isolate=true` because netavark does not
inherit Docker's inter-bridge isolation, and ingress needed firewalld rules that Docker made
unnecessary. What carried over was the *design*, and the fact that it had been proven to work: when
FlareSolverr could reach Sonarr on the new host, the question was "why is this different here",
not "was this ever right".

**Step 3 is done.** `bin/backup-offsite.sh` copies the repository to Scaleway Object Storage with
its own password, and both age keys and both restic passwords are in the password manager - which
was the actual gap, since the alternative was an off-site backup nobody could decrypt.

**Step 5 is done, and it replaced the pinning rather than building on it.** The old wording here
claimed digest pinning was auto-update's *prerequisite*; that was backwards. `AutoUpdate=registry`
resolves a tag, so a digest makes it a no-op - the two are alternatives, and the pinning was
abandoned because nothing maintained it. See `stacks/README.md`.

Remaining, in order:

1. **Monitoring**, so a failed unit surfaces without someone running `systemctl --user --failed`.
   `bin/verify-host.sh` and its MOTD cover the specific things automation puts at risk - a staged
   deployment nobody applies, an update run that silently stopped, a CDI spec that no longer matches
   the driver, a backup that has stopped running, a checkout that has drifted from git.

   **The data layer is done, 2026-08-15.** `/var/lib/home-server/status.json` carries every finding
   keyed by a stable id, plus a `facts` object of the numbers, rewritten hourly - see `docs/observability.md`. The journal is declared and bounded at 90 days, and 47% of its volume (podman's
   `health_status` events) is gone. **The durable-record gap named below is closed**: `status.json`
   carries `generated_at` and lives where a reboot does not reach, so this script finally has the
   marker every other job already had.

   **The time-series layer is done too, 2026-08-15** - Prometheus, node-exporter and
   `bin/collect-metrics.py`, at `metrics.avanserv.com`. See `docs/observability.md`. That closes the other half of
   what a dashboard needs: `status.json` says what is true now, and the store says when it stopped
   being true. **Everything that list named as "still to come" landed the same day**: GPU, sensors
   and SMART, the application sources over `podman exec`, all 92 checks as `home_server_check_status`
   series, and the TSDB snapshot in both backup scripts. **cAdvisor is the one item that was dropped
   rather than done** - the collector has to read the same cgroup files anyway for the four numbers
   cAdvisor does not export, so a second container would have been a second source for one truth.
   The steady-state cardinality was 2,896 series against the 4,000 the check budgeted for.
   **Both halves of that have moved**: the agent-fleet units took it to ~4,015, so the budget was
   re-derived to 4,500 on 2026-08-19. A container is 41-45 series, measured, which is what makes
   "one more service" a number rather than a shrug.

   **The notification path is done too, 2026-08-15**, which closes this item. Prometheus rules ->
   Alertmanager -> ntfy-alertmanager -> ntfy -> phone, 30 rules in six groups, at
   `ntfy.avanserv.com`. See `docs/observability.md`. Prometheus having alerting rules built in is part of why it
   was chosen over a store needing a second container for them, and that paid off exactly as
   expected.

   **The dashboard is done too, 2026-08-15, and this item is now closed.** A Vue 3 application at
   `home.avanserv.com`, in `apps/dashboard/`, built on the server from the checkout. It is what
   every keyed id and every series was for. See `docs/dashboard.md`.

   **All five pages are built as of 2026-08-18.** Network was the last, and it is the only one that
   needed a new measurement rather than a new arrangement of existing ones - see `docs/dashboard.md`.

   **All four pages were built as of 2026-08-17.** Home and Library needed Jellyfin sessions,
   Jellyseerr requests, poster images and the \*arr queues, none of which was collected - so they
   are a collector change first and two pages second. **It reads, and asks the fleet for three
   things**: no container can reach the podman socket, so restart and pull are still impossible and
   every media chip is still a deep link. The three that act - arm intake, hold a round, restart one
   - took the decision this line used to call "the next deliberate one" and took it the way the
   repository already trusts: the browser POSTs to Caddy, Caddy rewrites to one literal Windmill
   path with a server-side token, and conduct answers the suspended step on its next poll. No
   listener, no firewalld hole, `conduct` still never a `to`.

   **Do NOT build either on `journalctl -p err`.** Jellyfin alone emits 2,644 priority-3 lines a day
   of ffmpeg chatter and there is no lever to stop it - see Known state. Unit state and container
   health are the signal. Note also that `duckdns` and `unpackerr` never report health - neither
   serves HTTP - so a check assuming every container has a health status reports them broken for
   ever. `home_server_container_health` is **absent** for those two rather than zero, which is what
   lets the `ContainerUnhealthy` rule cover every container without naming any.

   **The generalisable lesson from the backup work: an automated job needs a durable record of its
   last success, not just a unit that exits 0.** `ExecMainExitTimestamp` is wiped by a reboot, and a
   pull-based job leaves no trace on the machine being watched at all. Anything added here should
   write its own timestamp somewhere `verify-host.sh` can read.
2. ~~greenboot, and only then an unattended reboot window.~~ **Done, 2026-08-14.** See
   `host/greenboot/README.md`. greenboot is layered - the one package on this host, and a
   deliberate exception to the rule below - and a rejected deployment rolls itself back. The
   reboot window is `home-server-reboot.timer`, hourly from 05:00 to 09:00 on Sundays, driven by
   `bin/reboot-when-staged.sh`, which is nothing but refusals - with one deliberate exception.

   **A gate that is correct every time can still be wrong in aggregate, and the encoder gate
   was.** It refuses while a transcode is running, which is right, but the window was a single
   instant and Tdarr jobs run for tens of minutes - so one busy minute cost the deployment a
   whole week, and a queue that stayed busy could do that indefinitely while every individual
   refusal remained defensible. Two changes, both needed: **five attempts across the morning**,
   so a transcode finishing at 05:30 does not cost seven days; and **an escalation** - past 14
   days staged or 30 days of uptime, the encoder stops being a veto and the transcode is killed.
   The trade is named rather than implied: a killed transcode is a *cost* of one hour of GPU
   time against a source that is hardlinked in `downloads/` and untouched, while another month
   on an unapplied image is a *risk*. Two clauses because they fail differently - the staged
   age resets whenever a new image supersedes the old one, so on a weekly release stream it
   could never reach 14, and only uptime cannot be starved.

   **The rollback is proven, not assumed**, by layering `tree` to make a second deployment and
   rejecting it: four red boots, then `Rollback successful`, then a clean boot on the deployment
   without `tree`, seven and a half minutes unattended. Three things that cost real time and
   would cost it again:

   - **GRUB boot counting does not work on FCOS out of the box, and its absence is silent.**
     greenboot ships its snippet to a bootupd *source* directory that layering never regenerates,
     so the counter is armed and never counted down: checks run, journal reads healthy, rollback
     cannot happen. `/boot/grub2/custom.cfg` is what closes it.
   - **greenboot reboots the machine itself on a red boot.** The unit files say otherwise - no
     `OnFailure=`, no `redboot.target` - and every one of those facts is true and leads to the
     wrong conclusion, because the behaviour is in the binary. Reasoning from unit files about
     what a program does is how a whole afternoon gets spent.
   - **A system unit, or a drop-in for one, cannot be a symlink into `/var/home-server`.**
     SELinux is Enforcing and the checkout is `var_t`, so PID 1 cannot read it - while
     `systemctl cat` prints the file happily and no AVC is logged. The check scripts *are*
     symlinks and correctly so: greenboot execs those itself. What systemd launches or parses
     must be labelled; what a running process then reaches is free.

**The applications keep their own logins.** Segmentation narrowed who can reach them; it did not
reduce `net-arr` to a single caller, so `AuthenticationMethod=External` would still trust five
containers rather than just Caddy. Revisit it only if those segments are split further, and note
that their *"Disabled for Local Addresses"* option is never the right tool here: Caddy and every
other container are RFC1918 addresses, so it disables authentication for precisely the attacker
path.

**Avoid host-level package dependencies.** `/usr` is read-only and every layered package makes the
next rebase slower and able to fail on dependency solving - which is why `nv-patch.sh` was deleted,
and the reason greenboot is a gate rather than a given.
