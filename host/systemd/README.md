# Host systemd user units

Plain `systemd --user` units, as opposed to the quadlets in `stacks/`. Anything here runs **on the
host** rather than in a container, which is the point: `podman exec` reaches into any container
whatever the network topology says, so a host-side unit can talk to services that are deliberately
unable to talk to each other.

`~/.config/systemd/user/` is a **second symlink root**, alongside the
`~/.config/containers/systemd/{common,torrent,media,infra}` ones that point at `stacks/`. It does not
exist on a fresh host, so it needs creating once:

```bash
mkdir -p ~/.config/systemd/user
for u in /var/home-server/host/systemd/*.service /var/home-server/host/systemd/*.timer \
         /var/home-server/host/systemd/*.slice; do
  ln -sf "$u" ~/.config/systemd/user/
done
for d in /var/home-server/host/systemd/*.service.d /var/home-server/host/systemd/*.timer.d; do
  ln -sfn "$d" ~/.config/systemd/user/
done
systemctl --user daemon-reload
systemctl --user enable --now home-server-promote.timer home-server-verify.timer \
                              home-server-caddy-build.timer home-server-backup.timer \
                              home-server-reboot.timer home-server-boot-reclaim.timer \
                              home-server-metrics.timer \
                              home-server-dashboard-build.timer home-server-seeding.timer \
                              home-server-search.timer home-server-conduct-runner-build.timer \
                              home-server-agents-update.timer home-server-mirror-update.timer \
                              home-server-github-runner-build.timer \
                              home-server-ci-artifacts-sweep.timer \
                              home-server-storage-census.timer \
                              home-server-verify-restore.timer \
                              home-server-verify-restore-offsite.timer \
                              home-server-credential-probe.timer \
                              home-server-verify-media.timer \
                              home-server-verify-segmentation.timer

# TWO UNITS HERE ARE SERVICES RATHER THAN TIMERS, so they are enabled on their
# own line. conduct is long-running - it polls - rather than something a clock
# starts, and its [Install] is WantedBy=default.target. It needs the checkout
# below to exist first; without it the unit starts, fails, and retries every 30
# seconds for ever.
#
# The secret sync is a oneshot ordered Before= conduct. It is NOT what makes the
# podman secret persist - secrets already survive a reboot - it is what makes a
# fresh host and a rotated .env self-healing within one boot, and what stops "the
# secret exists" being a fact recorded only in somebody's shell history. It
# refuses on an empty value rather than creating an empty secret, because a
# container started with one authenticates as nobody and that reads as a model
# outage twenty minutes later rather than as a configuration error now.
systemctl --user enable --now home-server-conduct-secret.service
systemctl --user enable --now home-server-conduct.service

# ONE-TIME, and only for this one. Enabling a Persistent= timer writes its stamp
# file straight away, so there is no missed elapse to catch up and it does not
# fire - measured. Every other built image here is pulled into the dependency
# graph by a .container that names it; nothing references conduct-runner, so
# without this line the phase runner does not exist until the first Saturday.
systemctl --user start home-server-conduct-runner-build.service

# THE SAME ONE-TIME START, FOR THE SAME REASON, and with a worse consequence if
# it is skipped. No .container references the CI runner image either, so on a
# fresh host it does not exist - and a lane's preflight then exits 4 on every
# attempt until the first Saturday, which the start limit turns into a unit
# sitting in `failed`. It takes longer than the phase runner's: a Fedora base,
# a dnf transaction including a browser dependency set, and a smoke test that pulls
# three service images through the NESTED engine on a cold store.
systemctl --user start home-server-github-runner-build.service

# THE CI LANES ARE INSTANCES OF A TEMPLATE, so they are enabled by name rather
# than by the glob above - the glob links the template file, which cannot be
# started on its own. Three lanes, because host/systemd/app-ci.slice owns CPUs
# 4-9 and each lane takes a pair; bin/github-runner.sh refuses a fourth rather
# than silently sharing one. ADDING A LANE IS TWO EDITS AND THIS IS THE SECOND:
# widening the slice's cpuset hands the cores over, and this line is what makes
# anything take them. A lane enabled here without the cpuset gets systemd's
# refusal; a cpuset widened without this line gets silence.
#
# THEY WILL NOT START UNTIL GITHUB_RUNNER_PAT AND GITHUB_RUNNER_GROUP_ID ARE SET
# and that is deliberate - a lane exits 3 naming the variable rather than
# registering into the organisation's Default group, which every public
# repository can see. See .env.sample and docs/ci.md.
systemctl --user enable --now home-server-github-runner@1.service \
                              home-server-github-runner@2.service \
                              home-server-github-runner@3.service

# AND THE SWEEP, WHICH IS THE THIRD UNIT HERE TO NEED A ONE-TIME START AND THE
# MILDEST OF THE THREE. `enable --now` writes the stamp file immediately, so a
# Persistent=true timer has no missed elapse to catch up on and does not fire
# until its next real calendar match. For the two build units above that means an
# image that does not exist; here it means the shared artifact store grows for a
# day, which nothing notices. It is started anyway so the pattern is uniform -
# the reason this trap has been hit three times is that it is invisible in every
# individual case.
systemctl --user start home-server-ci-artifacts-sweep.service

# AND THE STORAGE CENSUS, WHICH IS THE SIXTH TIME THIS TRAP HAS BEEN PAID FOR.
# Its consequence is the mildest yet and the most misleading: until it runs, the
# marker is absent, so capacity.census reports "has never recorded a walk" and
# capacity.var_breakdown and capacity.var_commitment both read "not measured" -
# three checks saying nothing, on a host where the thing they measure is the
# reason they were written. The alternative was to let them read zero, which is
# absence-read-as-health and worse.
systemctl --user start home-server-storage-census.service

# AND THE THREE ADDED ON 2026-09-09, WHICH IS THE SEVENTH, EIGHTH AND NINTH TIME
# THIS TRAP HAS BEEN PAID FOR. Same mechanism every time - `enable --now` writes
# the stamp immediately, so a Persistent=true timer has no missed elapse and
# does not fire until its next real calendar match - and three different
# consequences, none of which looks like a fault:
#
#   credential-probe   waits until 02:40 tomorrow. ingress.dns_credential,
#                      agents.model_credential_valid and
#                      agents.publish_credential_valid all report "has NEVER
#                      been probed" for a day, which is correct and reads like
#                      a finding.
#   verify-media       waits a WEEK, and media.keyframe_drift says so.
#   verify-segmentation  waits a week too, and net.containment says so - so the
#                      segmentation stays an assertion about unit files for
#                      seven more days than it needs to.
#
# The middle one is why these are started rather than left: a library sweep that
# has not run is the same reading as a library sweep that found nothing wrong,
# and the whole point of the check is that those are different sentences.
systemctl --user start home-server-credential-probe.service
systemctl --user start home-server-verify-media.service
systemctl --user start home-server-verify-segmentation.service

# AND THE TWO RESTORE VERIFICATIONS, WHICH ARE THE FOURTH AND FIFTH. Same trap,
# and the consequence sits between the two above: nothing is broken and nothing
# grows, but the first proof that the backups actually restore waits a week for
# one of them and a MONTH for the other. bin/verify-host.sh reports that
# correctly in the meantime - `no server restore verification has EVER been
# recorded` - so the skip is visible rather than silent, which is more than the
# first three traps managed.
#
# THE OFF-SITE ONE PULLS THE WHOLE 4.6 GB REPOSITORY BACK FROM SCALEWAY (2m45s
# measured), so run it when that is
# convenient rather than reflexively; the weekly one reads a local repository and
# costs nothing but disk I/O. Both refuse cleanly if .env has not been rendered.
systemctl --user start home-server-verify-restore.service
systemctl --user start home-server-verify-restore-offsite.service
```

**`/var/agents` IS A SECOND CHECKOUT AND IT IS NOT MADE BY ANY OF THIS.** conduct's
own code lives in `brinkflew/agents`, which is private, and the server has no GitHub
credential except a read-only deploy key made once by hand. On a fresh host:

```bash
ssh-keygen -t ed25519 -N '' -C conduct@home-server -f ~/.ssh/agents_deploy
# add ~/.ssh/agents_deploy.pub to the repo's deploy keys, READ-ONLY, then:
cat >> ~/.ssh/config <<'EOF'
Host github.com
    User git
    IdentityFile ~/.ssh/agents_deploy
    IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
sudo install -d -o core -g core -m 755 /var/agents
git clone git@github.com:brinkflew/agents.git /var/agents
```

**A SECOND read-only deploy key, for the project mirrors, and it must NOT go in that
`Host github.com` block.** `IdentitiesOnly yes` pins one identity there, and a second
`IdentityFile` line either loses to it or races it - so `conduct mirror` passes
`-F /dev/null -i <key> -o IdentitiesOnly=yes` and ignores this file entirely.
**GitHub answers a valid key for the wrong repository with `repository not found`**,
which reads as a typo in the remote URL rather than as the wrong identity, and that is
the failure this arrangement exists to make impossible:

```bash
ssh-keygen -t ed25519 -N '' -C conduct-mirror@home-server -f ~/.ssh/upskald_deploy
# add ~/.ssh/upskald_deploy.pub to avanserv/upskald's deploy keys, READ-ONLY, then
# prove it BOTH ways - each key must reach its own repository and neither the other:
for k in upskald_deploy agents_deploy; do for r in avanserv/upskald brinkflew/agents; do
  GIT_SSH_COMMAND="ssh -F /dev/null -i ~/.ssh/$k -o IdentitiesOnly=yes" \
    git ls-remote "git@github.com:$r.git" refs/heads/main >/dev/null 2>&1 &&
    echo "$k CAN read $r" || echo "$k cannot read $r"
done; done

# ONE-TIME, for the same Persistent= reason as conduct-runner-build above: enabling
# the timer writes its stamp and does not fire, so the first fetch is by hand.
systemctl --user start home-server-mirror-update.service
```

**The third key is the only one that can write, and one guard is all that keeps it
off `main`.** Measured on 2026-08-22: `main` is **not** branch protected on
`avanserv/upskald` - `GET .../branches/main/protection` answers 404 - and GitHub
has no ref-scoped deploy key, so nothing on the far side refuses a push to the
default branch. What refuses it is `conduct/publish.py`, which computes
`agents/<worktree>-<head12>` and will not push anywhere else.

```bash
ssh-keygen -t ed25519 -N '' -C conduct-push@home-server -f ~/.ssh/upskald_push
# add ~/.ssh/upskald_push.pub to avanserv/upskald's deploy keys WITH WRITE ACCESS.

# THE PROOF LOOP NOW HAS TWO AXES, and the one that matters is the second.
# Reading proves nothing new - the fetch key already reads that repository - so
# what has to be shown is that the FETCH key cannot write. A --dry-run push
# negotiates with the server and updates nothing, so the whole grid is provable
# without touching a ref.
sha=$(git -C /var/home-server/cache/conduct/mirrors/upskald.git rev-parse refs/heads/main)
for k in upskald_push upskald_deploy; do
  GIT_SSH_COMMAND="ssh -F /dev/null -i ~/.ssh/$k -o IdentitiesOnly=yes" \
    git -C /var/home-server/cache/conduct/mirrors/upskald.git \
    push --dry-run git@github.com:avanserv/upskald.git \
    "$sha:refs/heads/agents/proof" >/dev/null 2>&1 &&
    echo "$k CAN write" || echo "$k cannot write"
done
# upskald_push CAN write / upskald_deploy cannot write. ANY OTHER RESULT IS THE
# FINDING - a read-only key that can push means the wrong key was uploaded, and a
# push key that cannot means the deploy key was added without write access, which
# GitHub reports as a message about keys rather than about permissions. That is
# the third instance here of the same misleading GitHub error the `-F /dev/null`
# argument above exists for.
```

**And two things in Windmill, by hand, in this order.** The variable is the
fleet's ability to open a pull request and deleting it in a browser is the kill
switch; the folder has to exist first because **a folder path in Windmill is a
string rather than a reference** - `f/agents/phase` deployed happily into a folder
that was not there, so a secret placed under the same path would carry no folder
ACL behind it.

1. Settings -> Folders -> new folder `agents`.
2. Variables -> new variable, path `f/agents/github_pr_token`, **secret**, holding
   a GitHub fine-grained PAT scoped to `avanserv/upskald` alone with
   **Pull requests: write** and **no `workflow` scope**. Add `Contents: read` if
   the create call answers 404 - a fine-grained token needs to see the head branch
   on a private repository, and that failure reads like a wrong slug.

`bin/verify-host.sh` reports both halves as `agents.publish_configured`, and is
honest about what it cannot prove: that either credential still authenticates.

**The mirror it fills is not a cache and deleting it does not simplify anything.**
`avanserv/upskald` is private and the phase runner may hold no GitHub credential in
any form, so a container cannot clone it; the base every diff is measured against has
to come from a repository the phase cannot write; and one host-side copy is what pins
base and worktree to the same moment rather than to two clones either side of a push.
`conduct/mirror.py` carries the argument in full.

`IdentitiesOnly yes` is not decoration: without it ssh offers every key it can find
and GitHub rejects the connection on the first wrong one, which reads as a
permissions problem rather than as an ordering one. There is no build step and no
virtualenv - conduct is stdlib-only, so the deploy really is `git pull` and nothing
else, which is what `home-server-agents-update.timer` does nightly.

**The mirror lives under the fleet root because of SELinux**, at
`cache/conduct/mirrors/`, so it inherits `container_file_t`; anywhere else under `/var`
is `var_t` and every phase fails with a permission error naming SELinux nowhere. It was
seeded from a workstation until 2026-08-22, when it got the deploy key above and
`home-server-mirror-update.timer` instead.

**The loop is a glob rather than a list on purpose.** It used to name the four files it knew about,
and `home-server-caddy-build` was added later and never appended - so it was enabled on the server
and absent from the documented setup, which means a rebuild from this file would have produced a
host where Caddy silently never updated. A glob cannot drift; the `enable` line still can, so it
names every timer explicitly.

**It globs by EXTENSION, though, and that is its blind spot - `*.slice` was added on 2026-08-19.**
A glob cannot drift within the extensions it names and is completely blind outside them, so this
loop was `*.service *.timer` only and `app-agents.slice` would have been invisible to it. That
failure is worse than the Caddy one it was written for: a `Slice=` naming a slice with no unit file
does not fail, so systemd instantiates it with defaults and every member starts, stays healthy,
stays fully observed and is contained by nothing. `agents.slice_limits` is what catches it, by
reading the limits back out of the cgroup rather than out of the unit file.

**A slice is NOT enabled and must not join the `enable` line.** It carries no `[Install]` section;
systemd pulls it in because a unit's `Slice=` names it.

**Adding a unit here means adding it to that loop.** Individual files are symlinked, not the
directory - unlike `~/.config/containers/systemd/{common,torrent,media,infra}`, which point at
whole directories in `stacks/` and so pick up new files for free. A unit added here and not
symlinked is invisible, and nothing complains.

**A `*.service.d/` or `*.timer.d/` directory is the one exception, and it is symlinked WHOLE**,
which is why there is a second loop. These are drop-ins over units this repository does not own -
podman's own `podman-auto-update.service` and `podman-auto-update.timer` today - so there is no
file of ours to symlink beside them, and systemd resolves a symlinked drop-in directory happily.
Linking the directory rather than each `.conf` inside it means a second drop-in is picked up for
free, the way `stacks/` already works. Note `ln -sfn`: without `-n`, a re-run follows the existing
symlink and nests the target inside itself.

**That loop globs by EXTENSION, which is the third time that has cost something.** It read
`*.service.d` only until 2026-08-22, so the first `*.timer.d` directory added to this repository was
invisible: `daemon-reload` reported success, `systemctl cat` showed podman's stock timer, and the
retry window simply did not exist. Same shape as the `Slice=` entry in `docs/known-state.md`, where
a slice with no unit file silently got systemd's defaults. **A new drop-in EXTENSION means editing
the glob**, and an existing host needs the one-time link by hand:

```bash
ln -sfn /var/home-server/host/systemd/podman-auto-update.timer.d ~/.config/systemd/user/
systemctl --user daemon-reload
```

**Drop-ins over a USER unit may be symlinks into the checkout; over a SYSTEM unit they may not.**
`systemd --user` for uid 1000 runs as `unconfined_t` and reads `var_t` fine, which is why every
quadlet here is already a symlink. PID 1 cannot, so `host/journald/` and greenboot's ordering
drop-in are duplicated into `host/butane/ucore.bu` instead - and the failure there is silent, with
`systemctl cat` printing a file that does not apply and no AVC logged. See
`host/greenboot/README.md`.

**Assert a drop-in by its effect, never by its presence**, for that same reason:

```bash
systemctl --user show podman-auto-update.service -p ExecStartPost
```

After that a `git pull` deploys changes to these units the same way it does for quadlets - they are
symlinks, so there is no copy step. Only `daemon-reload` is needed.

| Unit | What it does |
|---|---|
| `home-server-promote` | Moves media that Tdarr has both transcoded **and** health-checked from `library/queued/<type>` into `library/transcoded/<type>`, which is the only place Jellyfin reads. It calls Radarr's and Sonarr's editor endpoints with `moveFiles=false` plus a rescan, so the applications are told where the file went and never lose track of it. See `bin/promote-transcoded.py`. |
| `home-server-verify` | Runs the host health battery hourly and writes **two** files: `/run/motd.d/40-home-server.motd`, so a staged OS update, a failed unit, a stale CDI spec or a backup that has stopped running is the first thing an ssh session shows; and `/var/lib/home-server/status.json`, the same findings keyed by a stable id for a dashboard to read. The MOTD is on tmpfs and dies with the boot - the JSON does not, which is what finally gives this unit a durable record of its own last success. See `bin/verify-host.sh` and `docs/observability.md`. |
| `home-server-caddy-build` | Rebuilds the Caddy image weekly. Caddy is one of two images built here rather than pulled, and `AutoUpdate=local` notices a new image without producing one - so without this it would never update. See `apps/caddy/Dockerfile`. |
| `home-server-dashboard-build` | Rebuilds the dashboard image nightly, and **this one is also the deploy path**. Its content comes from the checkout rather than from an upstream release, and `dist/` is not committed - so a `git pull` that changes `apps/dashboard/src/` deploys nothing at all until this runs, silently, while every other kind of change in the same commit takes effect on `daemon-reload`. Nightly rather than weekly for that reason. Run it by hand to see a change now. See `apps/dashboard/README.md`. |
| `home-server-conduct-runner-build` | Rebuilds the coding-agent phase runner weekly and **verifies it before the fleet can use it**. Three sequential `ExecStart=` lines - build, `bin/conduct-runner-smoke.sh`, then `podman tag :next :latest` - so a build that succeeds and produces a broken image leaves `conduct` on the last image that worked. Unlike the two above it, **nothing else ever builds this image**: no `.container` references it, so a fresh host has it only because `Persistent=true` fires the timer on first boot. See `apps/conduct-runner/Dockerfile`. |
| `home-server-reboot` | Applies a staged OS deployment on **two windows** - hourly 05:00-09:00 on Sundays for anything staged, and 06:00-09:00 on any other morning for a staged **critical** advisory only, since `deploy.image_age` gives one a three-day deadline a weekly window cannot meet. **06 rather than 05 because `verify-segmentation` (Tue 05:20), `verify-restore` (Wed 05:30), `verify-restore-offsite` (Mon 05:30) and `verify-media` (Thu 05:40) were all placed to sit outside this window** while it was Sunday-only. Either way, only if greenboot is armed to undo it, no deployment has been rejected and left unexplained, no backup is running, the host is healthy now and nothing is mid-transcode. Every check is a refusal and doing nothing is the default; the one exception is the encoder, which stops being a veto past 14 days staged or 30 days of uptime. Five attempts rather than one because that refusal is transient. See `bin/reboot-when-staged.sh`. |
| `home-server-boot-reclaim` | **The step the unattended reboot structurally cannot take.** `/boot` is 350 MB usable, a deployment slot is 145.3 MiB, and an update needs a third slot transiently - `ostree-finalize-staged` writes the new kernel before the old one is dropped, asking for 152.3 MB in the journal. Two fit and three do not, and the partition cannot be grown: zero free sectors on the disk and `p4` is XFS. `bin/reboot-host.sh` has always kept the invariant by hand, ending in `rpm-ostree cleanup -r` after the reboot it performed; `bin/reboot-when-staged.sh` reboots and the process that would clean up dies with the machine. So every unattended reboot left two slots spent, the next image staged into a partition with no room to finalize it, and the Sunday window refused - correctly - every week until somebody ran two commands by hand. Five minutes after a boot then every thirty, doing nothing at all while `/boot` has room. It drops the rollback only on a green verdict **from this boot**, and pins the outgoing commit with an ostree ref first, so what is given up is the second `/boot` entry rather than the deployment. See `bin/reclaim-boot-slot.sh`. |
| `home-server-metrics` | Collects, every 30 seconds, the numbers no container can honestly measure here: host filesystems (node-exporter's collector reads `/proc/1/mountinfo`, which no rootless container may), host network (`/proc/net` resolves in the reader's namespace), and the cgroup memory detail that separates a container holding cold page cache from one that is actually starved. It writes Prometheus exposition format into node-exporter's textfile directory rather than pushing, because Prometheus pulls - which also buys `node_textfile_mtime_seconds`, dating the file from outside the collector. See `bin/collect-metrics.py`. |
| `home-server-backup` | Backs up `config/` nightly at 03:00, to `/var/backups/home-server` and then off-site by `restic copy`. This is the backup that actually happens; the workstation's `bin/backup-config.sh` is a third copy taken when someone is home. See `bin/backup-server.sh`. |
| `home-server-verify-restore` / `home-server-verify-restore-offsite` | **Prove the backups restore, rather than that they exist.** `restic check` says a repository is internally consistent; neither it nor any staleness marker says that what comes out is a config tree the stack can start from. There are three repositories and until 2026-09-09 the one written nightly by automation - `/var/backups/home-server`, the copy an ordinary restore would use - was the only one nothing verified, because `--repo local` names the WORKSTATION's third copy at `~/backups` and reads like it means this machine. Every other job here has a timer and a durable marker; these had the marker and no timer, so the remedy was a person remembering. Weekly on a Wednesday for the server's own repository, monthly on the first Monday for the off-site copy - both at 05:30, the first quiet minute after the 00:00-04:50 night of jobs, and neither on a Sunday, because 05:00-09:00 there is the reboot window and a restore in progress would be killed by the machine going down. **They do not replace the workstation drill and their markers are separate so that they cannot**: `bin/verify-restore.sh --repo offsite`, run by hand, is the only thing that proves the surviving copy is reachable WITHOUT this machine, and one shared key would have held its marker green for ever. Four kinds, four markers, four ceilings. See `bin/verify-restore.sh` and `docs/backups.md`. |
| `home-server-seeding` | Enforces the one part of the seeding policy qBittorrent cannot express: a **72-hour floor** before any torrent may be stopped. Every share limit qBittorrent has is a maximum that triggers an action, so a minimum can only be enforced by withholding those limits - which is all this does. Past 72h a torrent gets ratio 1.5 and a seven-day seeding limit and qBittorrent stops it on whichever lands first; Radarr and Sonarr then delete it and its files, as they already did. It deletes nothing itself, and a stopped timer means nothing is ever reaped rather than things being reaped early. See `bin/apply-seeding-policy.py`. |
| `home-server-search` | Sweeps for monitored media that is missing and has actually been released, and asks Radarr and Sonarr to search for it. It exists because a back-catalogue title is searched once, at add time, and never again - RSS only carries new uploads, so 94 episodes stayed missing while approved releases sat on a configured indexer. Counted in episodes rather than seasons, because a season query asks for a season PACK and returned nothing. **This row was missing from this table until 2026-08-19**, which is the drift the glob above was written to prevent, arriving in the half of the setup that is still a hand-maintained list. See `bin/search-missing.py`. |
| `app-agents.slice` | **Not a unit that runs anything - a cgroup ceiling.** Every Windmill container, `conduct` and every phase-runner scope joins it, so the fleet is bounded in aggregate rather than by a sum of per-unit limits it could never have: its runners are `podman run --rm`, so their count is a variable. The `app-` prefix is load-bearing - systemd derives the hierarchy from the dashes, so this nests under `app.slice` where every quadlet already lives, which is the path `bin/collect-metrics.py` resolves against. It has no `[Install]` and is never enabled; a unit's `Slice=` pulls it in. Assert it by its effect - `agents.slice_limits` reads the limits back out of the cgroup, because a `Slice=` naming a slice with no unit file silently gets systemd's defaults. See `host/systemd/app-agents.slice`. |
| `home-server-conduct` | **The orchestrator.** A plain user unit rather than a quadlet because no container here may reach the podman socket - `container_t -> unconfined_t : unix_stream_socket connectto` is DENY under enforcing SELinux - and forking podman is the whole of its job. It runs each phase one tier down, inside `conduct-runner`, under a transient scope in `app-agents.slice` with `--cap-drop=ALL`, `--read-only` and a network of its own. It polls Windmill rather than being called by it, so the control plane has no route to the host at all. `RestartSec=30` rather than the usual 5, because a crash loop here can respawn `claude -p` on the way past and what that burns is the quota shared with your own sessions. See `/var/agents` and `docs/agents.md`. |
| `home-server-agents-update` | Pulls `/var/agents` nightly at 04:50 and restarts conduct only if it was already running. `--ff-only`, so a checkout that has diverged is refused rather than merged - and `agents.checkout_drift` reports it within the hour. Nothing is built: conduct is stdlib-only, so there is no venv to rebuild and no lockfile to drift. |
| `home-server-conduct-secret` | Copies the runner's model credential out of the rendered `.env` into podman's secret store, over **stdin** - the only route that puts it in neither argv nor a second file on disk. `Environment=` on a quadlet is printed in full by `systemctl --user show -p Environment`, and `--secret` from a file needs the plaintext at a second path. Measured afterwards: the value reaches the container and `podman inspect` shows neither it, nor the target variable's name, nor anything in `.Config.Secrets`. Inside the container it is still in `/proc/1/environ`, which is why the runner's token is a **different** token from the one conduct reads the quota with. `agents.model_credential` warns when the secret is OLDER than the `.env` it came from - the state nothing else here can see, because the phases keep working and authenticate as the wrong credential. |
| `home-server-mirror-update` | Fetches each project's mirror from GitHub nightly at 04:40, ten minutes ahead of the checkout pull so a refresh runs on code that was already deployed. **The mirror is not a cache**: `avanserv/upskald` is private and the phase runner may hold no GitHub credential in any form, so a container cannot clone it; the base every diff is measured against has to come from a repository the phase cannot write; and one host-side copy is what pins base and worktree to the same moment. It runs over a **second** read-only deploy key and passes `-F /dev/null`, because the `Host github.com` block above pins `IdentitiesOnly` to the other one - and GitHub answers a valid key for the wrong repository with `repository not found`. `agents.mirror_fresh` reads `FETCH_HEAD`'s mtime, since a mirror that quietly stopped moving is indistinguishable from one nothing has pushed to until verify refuses three days later. See `conduct/mirror.py`. |
| `home-server-storage-census` | **Answers "what is filling /var", which nothing on this host could.** `node_filesystem_avail_bytes` had /var going from 47.4 GiB used to 146.4 GiB in 25 days and cannot say why; finding out took an ssh session and six `du`s. This walks four roots hourly and leaves a marker that `bin/verify-host.sh` and `bin/collect-metrics.py` both read - one measurement, three readers, no quantity measured twice. **Hourly and not a collector source**: the walk is 7-9s and `home-server-metrics.service` is budgeted at `TimeoutStartSec=25s` against a 30-second tick, so a third of that spent on a number moving ~170 MB an hour is the wrong trade. **Not part of the battery either**, though that is also hourly: `bin/verify-host.sh` is what `--greenboot` runs and its exit code decides whether the OS rolls back, so four traversals of 150 GB do not belong on that path. **No `Slice=`**, deliberately - it walks the lanes, the fleet, `config/`, the backups and the graph root, so charging it to any one slice would make that slice's own headroom reading include work that is not its. See `bin/storage-census.sh` and `docs/observability.md`. |
| `home-server-ci-artifacts-sweep` | **Sweeps half of the CI lanes' shared artifact store and must never touch the other half.** upskald's jobs hand work to each other through a directory mounted into every lane as `$CI_ARTIFACT_STORE`, which has two subtrees wanting opposite treatment: `runs/` is per-run scratch swept on **two windows**, and `state/` is the coverage ratchet's memory - a few hundred bytes recording the percentage each surface may not regress below - which is swept by nothing and staged into the nightly backup by `bin/backup-server.sh`. **Thirty days for a whole run, three for `*-nyc`, and the split is what finally fitted**: measured 2026-09-11 over 106 run-attempts, nyc was 53,638 MB of 53,659 - **99.96%** - so a single window could never have held this store, and 30 for everything else costs about 1 GB. The whole-run floor is seven and is hard, because one consumer runs at merge and reads a pull request's LAST CI run, which may be weeks old if the branch sat; the nyc floor is two, because its only reader is the **same run's** fan-in, minutes after the write. Taking the split needed the question the sweep had been refusing to guess at - what reads raw nyc - answered by reading upskald's workflows: exactly one job, in the producing run, and the merge-time consumer that justified the seven turned out to read GitHub artifacts rather than this store at all. **It is a timer rather than part of `gc_lane` because the store is shared**: every other reclaim in `bin/github-runner.sh` operates on a `$LANE_ROOT` exactly one process owns, and two drivers sweeping one tree have no lock between them. See `bin/ci-artifacts-sweep.sh` and `docs/ci.md`. |
| `home-server-github-runner-build` | Rebuilds the GitHub Actions CI runner image weekly and **verifies it before a job can be stranded on it**. Same three-step shape as the phase runner's - build, `bin/github-runner-smoke.sh`, then `podman tag :next :latest` - and the same property that nothing else builds this image, so a fresh host needs the one-time start above. What its smoke test does that the phase runner's does not is prove the image can run CONTAINERS: a nested rootless pull, a published port answering on `localhost`, and a service container reaching `healthy`. That last one is not fussiness. Podman drives healthchecks with transient systemd timers, there is no systemd inside a container, and GitHub's runner waits on health status in a loop with **no retry cap** - so without `apps/github-runner/scripts/podman-healthcheck-loop.sh` a `services:` job holds a lane for the default 360 minutes with the container running, the service serving, and nothing on this host reporting anything wrong. See `apps/github-runner/Dockerfile`. |
| `home-server-credential-probe` | **The three credentials nothing else here proves still work.** `agents.model_credential` and `agents.publish_configured` both ended their own PASS message with "neither of which proves the token still authenticates", deliberately - a read of the filesystem establishes presence and freshness and nothing else - and every certificate on this host was its FIRST issuance, so `GANDI_BEARER_TOKEN` had never once been exercised by the DNS-01 write that renews all fifteen of them. Daily, and the cadence is the whole argument: `bin/verify-host.sh` rejected a live publish probe outright on the grounds of "~8,760 GitHub auths a year for a credential that almost never changes", which is an objection to hourly and a correct one. 365 is a different number. The Gandi leg WRITES and removes a TXT record, because a PAT that can list the zone and not change it authenticates perfectly and renews nothing; the model leg treats only 401 as a rejection, because a scoped OAuth token answering 403 to an endpoint it is not entitled to is a token that works. See `bin/probe-credentials.sh`. |
| `home-server-verify-media` | **The one check for a failure that has actually happened, which ran by hand only.** `bin/verify-media.sh` existed for weeks and no unit referenced it. A file whose keyframes fall closer together than Jellyfin's 6s HLS segment makes ffmpeg merge GOPs, so segment N carries different media than playlist entry N and the error ACCUMULATES - +22.397s after twenty-five segments, measured - which looks like the picture jumping and subtitles drifting and names neither the cause nor the file. Weekly, sampled at three 120s demux windows a file across 725 of them, `Nice`/`IOWeight` throttled because `/mnt/media` is one spindle whose throughput FALLS with concurrency. `ExecCondition=` defers while somebody is watching, which is why `media.keyframe_drift` grades the MARKER and not the unit: a skipped run clears `ExecMainExitTimestamp` rather than leaving it stale, so `check_timer_run` would report "has never run" and FAIL from the first deferral. |
| `home-server-verify-segmentation` | **Sends a packet at every edge that is meant to be closed.** The split into ten networks is the security model, and until 2026-09-09 the only evidence any forbidden edge was still forbidden was somebody running a throwaway container by hand - `net.segment_isolation` reads the `isolate=` option hourly, and this is the half that is evidence rather than configuration. BY IP, never by name: a container has one address per network it joins. **The exit code is the finding, not merely its sign** - `timeout` returns 124 for a dropped packet, and a refusal returns fast because the packet ARRIVED and only the port was shut, which is not a blocked edge. It carries a POSITIVE CONTROL and discards the whole run when that fails, because a missing image or a podman that will not start a container makes every forbidden edge read "dropped", which is the answer it hopes for. Every probe carries `io.home-server.ephemeral`. See `bin/verify-segmentation.sh`. |
| `home-server-github-runner@` | **A template, one instance per CI lane**, enabled by name because the glob above links the template rather than an instance. Each lane mints a single-use just-in-time runner identity on the `avanserv` organisation, runs exactly one job in a `podman run --rm` container under a transient scope in `app-ci.slice`, and repeats. The organisation PAT never enters the container - it reaches `curl` on stdin, so it is not in argv either - and `bin/github-runner-smoke.sh` asserts its absence from `/proc/1/environ` rather than assuming it. **The loop is in the script, not in `Restart=`**: a finished job is a process exit, so letting systemd cycle it would make a completed job and a crash indistinguishable and put a busy lane into `failed` for having done its work. A non-zero exit therefore always means something a restart cannot fix, and the exit code says which - 3 configuration, 4 missing image, 5 credential rejected, 6 bad runner group. See `bin/github-runner.sh` and `docs/ci.md`. |
| `app-ci.slice` | **The second cgroup ceiling, and not a unit that runs anything.** All three CI lanes, their drivers and the image build join it. Sized against a measurement rather than against the other slice's ceiling, which is what makes two slices fit on a 15.8 GB host: `app-agents.slice` reserves 4,608M but its 30-day median use is **957 MB**, its p90 1,455 MB, and a phase is in flight **6.9%** of the time. `AllowedCPUs=4-9` here is only half the answer - the slice value alone would give *all three* lanes `nproc=6` and put eighteen workers on six cores, so `bin/github-runner.sh` pins each lane scope to one pair of it and a job sees 2. The lanes were **not** widened when the third was added on 2026-08-27: upskald's two long jobs are single-threaded, so a wider pair could not have touched either, and a lane's own two cores measured 45% busy while a job ran. Assert it by its effect: `ci.slice_limits` reads all six controls back out of the cgroup, because a `Slice=` naming a slice with no unit file silently gets systemd's defaults. See `host/systemd/app-ci.slice`. |
| `podman-auto-update.service.d` | **Not a unit of ours - a drop-in over podman's**, and now three files. `10-` makes the `ExecStartPost=` image prune non-fatal, so a disk reclaim that could be skipped for a night cannot mark the unit that updates eighteen containers as failed. It could and did: on 2026-08-17 and 2026-08-18 `podman auto-update` exited 0, every container updated, and the unit reported failure because the prune hit a leftover build container and exited 125. The condition itself is now measured by `containers.storage_orphans`, which is what makes this a correction and not a silencer. `20-` runs `bin/pre-update-snapshot.sh` as `ExecStartPre=` with **no** `-` prefix, so a failed database snapshot aborts the update rather than leaving the rollback with nothing to restore. `30-` runs `bin/update-when-idle.sh` as `ExecCondition=`, which skips the run - without failing the unit - while somebody is watching Jellyfin. |
| `podman-auto-update.timer.d` | **Also a drop-in over podman's**, and the reason the symlink loop above had to learn `*.timer.d`. Podman ships `OnCalendar=daily`, one attempt at ~00:00-00:15 and no second chance for a day. That is fine for an unconditional update and wrong for a gated one, so this replaces it with three attempts at 00:00, 01:00 and 02:00 UTC - 02:00 to 04:00 local, the quietest band there is. The `OnCalendar=` empty assignment is load-bearing for the same reason `10-`'s is: systemd appends to a list directive unless it is cleared first. |

```bash
systemctl --user list-timers home-server-promote.timer home-server-verify.timer
journalctl --user -u home-server-promote -n 50
/var/home-server/bin/promote-transcoded.py --dry-run     # safe, changes nothing
/var/home-server/bin/apply-seeding-policy.py --dry-run --verbose   # ditto
/var/home-server/bin/verify-host.sh                      # read-only apart from the MOTD
/var/home-server/bin/verify-host.sh --routes             # also walks the public routes
```
