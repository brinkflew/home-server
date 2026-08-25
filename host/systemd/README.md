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
                              home-server-reboot.timer home-server-metrics.timer \
                              home-server-dashboard-build.timer home-server-seeding.timer \
                              home-server-search.timer home-server-conduct-runner-build.timer \
                              home-server-agents-update.timer home-server-mirror-update.timer \
                              home-server-github-runner-build.timer

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
# started on its own. Two lanes, because host/systemd/app-ci.slice owns CPUs 4-7
# and each lane takes half; bin/github-runner.sh refuses a third rather than
# silently sharing a pair.
#
# THEY WILL NOT START UNTIL GITHUB_RUNNER_PAT AND GITHUB_RUNNER_GROUP_ID ARE SET
# and that is deliberate - a lane exits 3 naming the variable rather than
# registering into the organisation's Default group, which every public
# repository can see. See .env.sample and docs/ci.md.
systemctl --user enable --now home-server-github-runner@1.service \
                              home-server-github-runner@2.service
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
| `home-server-reboot` | Applies a staged OS deployment, hourly 05:00-09:00 on Sundays - but only if greenboot is armed to undo it, no deployment has been rejected and left unexplained, no backup is running, the host is healthy now and nothing is mid-transcode. Every check is a refusal and doing nothing is the default; the one exception is the encoder, which stops being a veto past 14 days staged or 30 days of uptime. Five attempts rather than one because that refusal is transient. See `bin/reboot-when-staged.sh`. |
| `home-server-metrics` | Collects, every 30 seconds, the numbers no container can honestly measure here: host filesystems (node-exporter's collector reads `/proc/1/mountinfo`, which no rootless container may), host network (`/proc/net` resolves in the reader's namespace), and the cgroup memory detail that separates a container holding cold page cache from one that is actually starved. It writes Prometheus exposition format into node-exporter's textfile directory rather than pushing, because Prometheus pulls - which also buys `node_textfile_mtime_seconds`, dating the file from outside the collector. See `bin/collect-metrics.py`. |
| `home-server-backup` | Backs up `config/` nightly at 03:00, to `/var/backups/home-server` and then off-site by `restic copy`. This is the backup that actually happens; the workstation's `bin/backup-config.sh` is a third copy taken when someone is home. See `bin/backup-server.sh`. |
| `home-server-seeding` | Enforces the one part of the seeding policy qBittorrent cannot express: a **72-hour floor** before any torrent may be stopped. Every share limit qBittorrent has is a maximum that triggers an action, so a minimum can only be enforced by withholding those limits - which is all this does. Past 72h a torrent gets ratio 1.5 and a seven-day seeding limit and qBittorrent stops it on whichever lands first; Radarr and Sonarr then delete it and its files, as they already did. It deletes nothing itself, and a stopped timer means nothing is ever reaped rather than things being reaped early. See `bin/apply-seeding-policy.py`. |
| `home-server-search` | Sweeps for monitored media that is missing and has actually been released, and asks Radarr and Sonarr to search for it. It exists because a back-catalogue title is searched once, at add time, and never again - RSS only carries new uploads, so 94 episodes stayed missing while approved releases sat on a configured indexer. Counted in episodes rather than seasons, because a season query asks for a season PACK and returned nothing. **This row was missing from this table until 2026-08-19**, which is the drift the glob above was written to prevent, arriving in the half of the setup that is still a hand-maintained list. See `bin/search-missing.py`. |
| `app-agents.slice` | **Not a unit that runs anything - a cgroup ceiling.** Every Windmill container, `conduct` and every phase-runner scope joins it, so the fleet is bounded in aggregate rather than by a sum of per-unit limits it could never have: its runners are `podman run --rm`, so their count is a variable. The `app-` prefix is load-bearing - systemd derives the hierarchy from the dashes, so this nests under `app.slice` where every quadlet already lives, which is the path `bin/collect-metrics.py` resolves against. It has no `[Install]` and is never enabled; a unit's `Slice=` pulls it in. Assert it by its effect - `agents.slice_limits` reads the limits back out of the cgroup, because a `Slice=` naming a slice with no unit file silently gets systemd's defaults. See `host/systemd/app-agents.slice`. |
| `home-server-conduct` | **The orchestrator.** A plain user unit rather than a quadlet because no container here may reach the podman socket - `container_t -> unconfined_t : unix_stream_socket connectto` is DENY under enforcing SELinux - and forking podman is the whole of its job. It runs each phase one tier down, inside `conduct-runner`, under a transient scope in `app-agents.slice` with `--cap-drop=ALL`, `--read-only` and a network of its own. It polls Windmill rather than being called by it, so the control plane has no route to the host at all. `RestartSec=30` rather than the usual 5, because a crash loop here can respawn `claude -p` on the way past and what that burns is the quota shared with your own sessions. See `/var/agents` and `docs/agents.md`. |
| `home-server-agents-update` | Pulls `/var/agents` nightly at 04:50 and restarts conduct only if it was already running. `--ff-only`, so a checkout that has diverged is refused rather than merged - and `agents.checkout_drift` reports it within the hour. Nothing is built: conduct is stdlib-only, so there is no venv to rebuild and no lockfile to drift. |
| `home-server-conduct-secret` | Copies the runner's model credential out of the rendered `.env` into podman's secret store, over **stdin** - the only route that puts it in neither argv nor a second file on disk. `Environment=` on a quadlet is printed in full by `systemctl --user show -p Environment`, and `--secret` from a file needs the plaintext at a second path. Measured afterwards: the value reaches the container and `podman inspect` shows neither it, nor the target variable's name, nor anything in `.Config.Secrets`. Inside the container it is still in `/proc/1/environ`, which is why the runner's token is a **different** token from the one conduct reads the quota with. `agents.model_credential` warns when the secret is OLDER than the `.env` it came from - the state nothing else here can see, because the phases keep working and authenticate as the wrong credential. |
| `home-server-mirror-update` | Fetches each project's mirror from GitHub nightly at 04:40, ten minutes ahead of the checkout pull so a refresh runs on code that was already deployed. **The mirror is not a cache**: `avanserv/upskald` is private and the phase runner may hold no GitHub credential in any form, so a container cannot clone it; the base every diff is measured against has to come from a repository the phase cannot write; and one host-side copy is what pins base and worktree to the same moment. It runs over a **second** read-only deploy key and passes `-F /dev/null`, because the `Host github.com` block above pins `IdentitiesOnly` to the other one - and GitHub answers a valid key for the wrong repository with `repository not found`. `agents.mirror_fresh` reads `FETCH_HEAD`'s mtime, since a mirror that quietly stopped moving is indistinguishable from one nothing has pushed to until verify refuses three days later. See `conduct/mirror.py`. |
| `home-server-github-runner-build` | Rebuilds the GitHub Actions CI runner image weekly and **verifies it before a job can be stranded on it**. Same three-step shape as the phase runner's - build, `bin/github-runner-smoke.sh`, then `podman tag :next :latest` - and the same property that nothing else builds this image, so a fresh host needs the one-time start above. What its smoke test does that the phase runner's does not is prove the image can run CONTAINERS: a nested rootless pull, a published port answering on `localhost`, and a service container reaching `healthy`. That last one is not fussiness. Podman drives healthchecks with transient systemd timers, there is no systemd inside a container, and GitHub's runner waits on health status in a loop with **no retry cap** - so without `apps/github-runner/scripts/podman-healthcheck-loop.sh` a `services:` job holds a lane for the default 360 minutes with the container running, the service serving, and nothing on this host reporting anything wrong. See `apps/github-runner/Dockerfile`. |
| `home-server-github-runner@` | **A template, one instance per CI lane**, enabled by name because the glob above links the template rather than an instance. Each lane mints a single-use just-in-time runner identity on the `avanserv` organisation, runs exactly one job in a `podman run --rm` container under a transient scope in `app-ci.slice`, and repeats. The organisation PAT never enters the container - it reaches `curl` on stdin, so it is not in argv either - and `bin/github-runner-smoke.sh` asserts its absence from `/proc/1/environ` rather than assuming it. **The loop is in the script, not in `Restart=`**: a finished job is a process exit, so letting systemd cycle it would make a completed job and a crash indistinguishable and put a busy lane into `failed` for having done its work. A non-zero exit therefore always means something a restart cannot fix, and the exit code says which - 3 configuration, 4 missing image, 5 credential rejected, 6 bad runner group. See `bin/github-runner.sh` and `docs/ci.md`. |
| `app-ci.slice` | **The second cgroup ceiling, and not a unit that runs anything.** Both CI lanes, their drivers and the image build join it. Sized against a measurement rather than against the other slice's ceiling, which is what makes two slices fit on a 15.8 GB host: `app-agents.slice` reserves 4,608M but its 30-day median use is **957 MB**, its p90 1,455 MB, and a phase is in flight **6.9%** of the time. `AllowedCPUs=4-7` here is only half the answer - the slice value alone would give *both* lanes `nproc=4` and put eight workers on four cores, so `bin/github-runner.sh` pins each lane scope to half of it and a job sees 2. Assert it by its effect: `ci.slice_limits` reads all six controls back out of the cgroup, because a `Slice=` naming a slice with no unit file silently gets systemd's defaults. See `host/systemd/app-ci.slice`. |
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
