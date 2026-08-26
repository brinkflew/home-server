# Continuous integration on this host

`docs/agents.md`'s sibling. That file is the hosting for the coding-agent fleet; this is the
hosting for GitHub Actions. They share a host, a design language and most of their traps, and
where they differ it is written down here rather than left to be inferred.

Added 2026-08-24.

## What this is

Two **lanes**. Each is a `systemd --user` process that mints a single-use GitHub Actions runner
identity, starts one container, lets that container run exactly one job, tears the registration
down, and does it again. The lanes are `home-server-github-runner@1.service` and `@2`; the driver
is `bin/github-runner.sh`; the image is built here from `apps/github-runner/Dockerfile`.

```
tier 0  systemd --user, unconfined_t   home-server-github-runner@<n>   may fork podman
tier 1  container_t, uid0 -> core      github-runner (--rm)            the runner, one job
tier 2  inside tier 1's own userns     postgres / redis / mailpit      the job's services:
```

The middle row is where the difference from `docs/agents.md` lives. A phase runner executes
model-authored code and needs no container runtime; a CI lane executes whatever is in a pull
request and **must** have one, because `avanserv/upskald` uses `services:` in four jobs and
GitHub's runner implements those by shelling out to `docker`. So there is a nested rootless podman
inside the lane, and tier 2 is inside tier 1's user namespace rather than beside it.

**The host's podman socket is not reachable from any of it.** That is the same fact the whole
three-tier design in `docs/agents.md` rests on - `container_t -> unconfined_t :
unix_stream_socket connectto` is DENY under enforcing SELinux - and it is why the thing that
forks podman is a plain user unit rather than a quadlet.

## Scope: the organisation, and why not the account

Registration is at **organisation** level, on `avanserv`, into a **runner group scoped to
selected repositories**. One registration covers every repository the group can see.

`brinkflew/*` is out of scope and cannot be brought in. GitHub has no account-level self-hosted
runners - only repository, organisation and enterprise - so a personal repository would need a
registration of its own, per repository. That is a different design.

**The group is not the Default group, and `bin/github-runner.sh` refuses to start without being
told which one it is.** `avanserv` holds nineteen repositories and three are public
(`vsx-antigravity-quota`, `vsx-avanserv-theme`, `dialog`). A self-hosted runner reachable from a
public repository executes fork pull-request code on this host, as `core`, which owns
`/var/home-server` and every credential in it. Defaulting to group 1 would have made the safe
configuration the one somebody has to remember; refusing makes it the only one that starts.

### Organisation state this repository cannot see

Two settings live in GitHub's UI, are not in git, and nothing here can restore them. They are
written down because that is the only thing that can be done about them.

1. **The runner group is scoped to selected repositories, and "Allow public repositories" is
   off.** If a repository in the group is ever made public, that decision has to be revisited in
   the same breath.
2. **The token is a fine-grained PAT with exactly one permission** - Organization permissions ->
   Self-hosted runners -> Read and write. An organisation may require fine-grained tokens to be
   approved before they work at all, and an unapproved one answers 403, which reads as a
   permissions bug rather than as a pending request.

## The lane lifecycle

```
preflight (once)   config, image, lane dirs, net-ci-<n>, seed the runner tree
loop:
  hold             lane 2 only, while a conduct phase is in flight
  gc               if the lane is over its disk budget
  reap             offline registrations this lane left behind
  mint             POST /orgs/<org>/actions/runners/generate-jitconfig
  run              systemd-run --scope ... podman run --rm ... run.sh --jitconfig
  poll             every 30s: busy? idle past the ceiling?
  teardown         DELETE the registration, delete the config, count the job
```

**The loop is in the script rather than in `Restart=`, and that is the whole design of the unit
file.** A finished job is a process exit, so letting systemd cycle the lane would make a completed
job and a crash indistinguishable: `StartLimitBurst` would be counting successful work, and a busy
afternoon would put a lane into `failed` for having done its job. With the loop in the script,
`Restart=` only ever fires when the driver itself died, which is always a fault.

That makes the exit code meaningful, and it is classified rather than uniform:

| Exit | Meaning |
|---|---|
| 2 | the lane argument is not 1 or 2 |
| 3 | configuration missing or empty |
| 4 | the image does not exist |
| 5 | GitHub rejected the credential - 401 or 403 |
| 6 | GitHub rejected the request - 422, almost always a bad runner group |
| loop | 429, 5xx, DNS, a timeout - anything a later attempt could survive |

The middle four are **states, not events**. Retrying them is how a lane spins for ever minting
registrations against a rate limit. An unset token must not look like a fault and a revoked one
must not look like health - the same distinction `docs/agents.md` draws for conduct's token.

## The credential

**The PAT never enters the container.** The lane holds a token that can register runners on the
organisation; it uses that to mint a just-in-time configuration - single use, one job, that
organisation - and hands the container only that.

**Even the header stays out of argv.** `-H "Authorization: Bearer $PAT"` puts the token in
`/proc/<pid>/cmdline`, readable by anything on this host running as `core`. It goes to `curl` over
stdin instead, the same idiom `bin/sync-podman-secrets.sh` uses for the model credential.

**It is deliberately NOT a podman secret**, and that is the inverse of the argument that script
makes. A podman secret exists to get a value *into* a container without it appearing on a unit's
`Environment=` or at a second path on disk. This value must never get into a container at all, so
making it a secret would build the route it must not have.

**A workflow step can read its own JIT credential**, and that is inherent to every self-hosted
runner in existence: the runner writes `.runner` and `.credentials` to disk from it before it does
anything else. What bounds it is that the identity is single-use, scoped to "take one job from
this organisation", and dies with the container - and that the thing which mints more of them is
not there. `bin/github-runner-smoke.sh` asserts that absence with one line rather than assuming
it.

## The nested engine, and the timer that does not exist

**Podman drives healthchecks with transient systemd timers.** On this host that is visible:
`systemctl --user list-timers` shows one hash-named timer per healthchecked container,
twenty-five of them. There is no systemd session inside a container, so `podman create
--health-cmd` only **warns**, the service starts and genuinely serves, and
`.State.Health.Status` stays `starting` for ever.

**That is a six-hour hang, not a cosmetic defect.** GitHub's runner waits on exactly that field
before it will run a job's steps, in a loop with **no retry cap**, and `avanserv/upskald` sets
`timeout-minutes:` on none of its jobs - so the default 360 minutes applies. One pull request
would hold both lanes for the afternoon while every signal on this host read green: the container
running, the service serving, no unit failed, nothing unhealthy.

`apps/github-runner/scripts/podman-healthcheck-loop.sh` is what closes it - `podman healthcheck run` per
container, at the interval that container declared, which is what the timer would have done.
Podman's own retry, start-period and failing-streak logic all live inside that subcommand, so the
loop decides *when* and nothing else.

**The interval is honoured rather than guessed, and the direction of the guess is the point.** A
workflow's `--health-retries 5 --health-interval 10s` gives postgres fifty seconds to come up.
Polling every second would spend those five retries in five seconds and mark a healthy database
`unhealthy` before it had finished starting - and the runner **fails a job** on unhealthy. So an
interval that cannot be parsed falls back to thirty seconds, not to one: too long merely makes a
job wait, too short fails it.

**The obvious alternative fix is worse than doing nothing.** Stripping the health flags in the
shim makes `.Config.Healthcheck` empty, the runner's wait returns immediately, and the job races
Postgres's startup instead - trading a reliable hang for an intermittent failure.

### Three more things the nested engine needs

- **A short name must resolve.** A workflow writes `image: postgres:16-alpine`, unqualified,
  because Docker resolves that to Docker Hub. Podman refuses a short name with no search list, and
  a job log calls that a bad image reference. `apps/github-runner/registries.conf`.
- **The graph root must be a host bind mount.** Native overlay cannot stack on the outer
  container's own overlay rootfs, so an inner store on the container filesystem silently falls
  back to `vfs` - every layer a full copy, at every pull, for ever, with nothing saying why. `/var`
  is XFS with `ftype=1` (measured), so the lane's own directory works. The smoke test asserts the
  driver is not `vfs`.
- **`/dev/net/tun` lands as group 0**, and the nested namespace loses that. Measured inside a
  rootless container here: `/dev/fuse` is `crw-rw-rw-` and any uid can open it, `/dev/net/tun` is
  `crw-rw---- 65534 0`. See the containment section below for why the answer is the runner's
  primary gid and not a chmod.
- **The lane's mounts mask what the image put there.** An empty `$HOME` bind mount hid the base
  image's own engine configuration (`stat /home/runner/.config: no such file or directory`, and
  then a socket that never binds), and the tool-cache mount hid the baked Python. Both are seeded
  at start-up from paths the mounts do not cover - `/etc/containers` and
  `/opt/hostedtoolcache-seed`.
- **`cp -a` carries the SELinux MCS categories** of whichever container did the copying, so the
  next container - with a different pair - cannot read what it was given:
  `ls: cannot open directory '/opt/hostedtoolcache/Python': Permission denied`, on a directory
  plainly present and owned by the right uid. `cp -rp` inherits the destination's label instead.
  Both the tool-cache seed and the runner-tree seed do this.
- **`core` cannot delete a lane from outside the namespace.** Everything under it belongs to the
  subuid container uid 1000 maps to, so the disk reclaim and the smoke test's cleanup both use
  `podman unshare rm -rf`. A plain `rm` produces a wall of `Permission denied` and leaves the
  budget un-reclaimed while reporting nothing.
- **The engine's runtime state must not share a filesystem with the job's scratch.** It did:
  `XDG_RUNTIME_DIR` was `/tmp/podman-run`, so podman's locks, exit files, rootless network state and
  the pause process pid file that owns the user namespace every nested layer is mounted into all sat
  on the 1777, 512 MB tmpfs a workflow's steps write to. It is `/run/podman-run` now, root-owned and
  unreachable by a job. `storage.conf` had asked for a `/run` runroot all along and **podman ignored
  it** - `XDG_RUNTIME_DIR` wins for a rootless engine, silently, the same way `graphroot` loses to
  `rootless_storage_path`. Both name the same path now, and the smoke test asks the engine rather
  than reading the file back.
- **Every tmpfs in a lane is sized, and `/run` was the one that was not.** `--read-only-tmpfs`
  mounts `/run`, `/tmp` and `/var/tmp`; `/tmp` was always capped and `/run` inherited podman's
  default, measured at **7.8G inside a lane whose `MemoryMax` is 3,584M** - a container is not
  memory-namespaced, and a tmpfs is charged to the cgroup that owns it. Capped at 128m **with
  `tmpcopyup`**, because an explicit `--tmpfs` replaces the read-only-tmpfs mount rather than
  adjusting it and the image's own `/run` would otherwise disappear behind an empty filesystem.
- **uid 1000 cannot create those directories.** `/run` arrives 0755 root:root, so `runner-init`'s
  root branch makes and chowns them before it drops, and the unprivileged half asserts rather than
  creates. Under `/tmp` the `mkdir` always succeeded; a tolerant `|| true` carried across would have
  become podman quietly choosing a fallback runtime directory and warning on every invocation for
  the rest of the job.

### `api-checks`, the failure nobody has explained

`avanserv/upskald`'s `API Quality Gate` dies in `Initialize containers`, reliably, on both lanes and
across three builds of this image:

```
docker create  -> ok
docker start   -> crun: open `<graphroot>/overlay/<id>/merged/run/.containerenv`:
                  No such file or directory
                  Docker start fail with exit code 125
```

**Nine synthetic reproductions have failed to fire.** Both service images; `run -d` against
`create`+`start`; the driver's full flag set; a store reused across six container recycles; the
faithful hosting with the systemd scope, `--cgroups=split` and the 3,584M cap; **1,662 verified
`MemoryHigh` breaches** of deliberate slice pressure; `/tmp` filled to 90%; and the user-namespace
hypothesis taken apart three ways in one run - the pause pid file deleted, the pause process killed,
and the whole runtime directory wiped, each between `create` and `start`. All of them started
postgres cleanly.

**The evidence is destroyed every time anyone looks.** Teardown runs within seconds, so a host-side
snapshot polling every 8 seconds still arrived to find the layer deleted, `containers.json` back to
`[]` and a store that looked perfectly healthy - which is what a *cleaned* store looks like, not a
broken one, and after the fact the two are indistinguishable. So the shim dumps a post-mortem from
inside the container at the instant `start` returns non-zero, which is the only place with an
answer.

**And it retries, which is a gate and not a witness.** The shim shipped saying "no retry, no
suppression"; that was written while "find the cause" was still on the table. A failing
`docker start` is now attempted up to three times, 2s then 5s apart, each attempt announced in the
job log with its post-mortem intact. A genuinely broken service costs seven extra seconds; the
alternative is that `services:` does not work on this runner at all.

### The post-mortem was reading the wrong mount namespace, and said so for a day

**This section used to state that the nested podman "mounted nothing", on the strength of
`overlay-mounts=1` and every layer's `merged/` being empty. That was an artefact of the
instrument and is retracted.**

Rootless podman performs every storage operation inside the **pause process's** mount
namespace - which is what the pause process is for, since a mount made in a transient
namespace would vanish the moment the CLI exited and take a detached container's rootfs with
it. The post-mortem read `/proc/self/mountinfo` and `ls -A merged` from the shim's own shell,
which is not that namespace. Measured on a **healthy, running** postgres in a lane:

```
overlay mounts   shim-ns=1   pause-ns=2
merged entries   shim-ns=0   pause-ns=18
```

So `overlay-mounts=1` with every `merged/` empty is exactly what a container that is working
perfectly looks like from where the shim was standing. It never distinguished anything.

**A second reason the old reading proved nothing**, independent of the first: libpod unmounts
the rootfs in its cleanup when the OCI runtime fails at start, so the post-mortem runs *after*
the teardown. `mountpoints.json` back to 2 bytes and empty `merged/` directories are equally
what a container that mounted, failed and was torn down leaves behind. Post-failure state
cannot separate "never mounted" from "mounted, then cleaned up" - which is why the block now
prints the container's `State.Status` and `State.Error`, and reads through
`/proc/<pause>/root`, printing **both** numbers labelled so the old one can still be
recognised.

The honest position is that **nobody has yet established whether the mount happens.**

Chasing that turned up a defect that was making every diagnosis unreadable. **libpod records its
runroot and tmpdir in `db.sql` at the root of the graph root**, and the graph root is a lane bind
mount that outlives every image upgrade. Change `XDG_RUNTIME_DIR` and podman does not complain -
it reads the recorded value and uses it, over the environment *and* over `storage.conf`. The lane
then runs **two engines over one store**:

```
/run/podman-run/libpod/tmp/   pause.pid ONLY          <- from the environment
/tmp/podman-run/libpod/tmp/   alive, events, exits    <- from db.sql
```

`containers/storage` keeps overlay mount refcounts under the runroot, so two engines disagreeing
about it can each believe the other mounted a layer.

**Reproduced on demand, in three passes over one store** - seeded with the old path, together and
clean; same store with the new path, split; same store with `db.sql` deleted, clean again. That
is also the repair: `runner-init` removes a `db.sql` whose recorded runroot does not match the
live one, and **only that file** - the images below it are the reason the store is a mount of its
own. Existing lanes repair themselves on their next restart.

**It is not the `api-checks` fix.** In the reproduction the split was real and `docker start`
succeeded anyway, and `api-checks` was failing before the split existed. Two separate things.

**The gate for it is `ci.runtime_dir` in `bin/verify-host.sh`, not a smoke leg**, and the reason
matters: the smoke test *already* asserted that `RunRoot` sits under `XDG_RUNTIME_DIR` and
reported `ok` on the image whose live lanes were split, because `runner()` builds a fresh lane and
a fresh lane has no stale `db.sql`. Only a running lane can show it. The check was proved to
**fail** against the two deployed lanes before it was trusted to pass, and it measures as uid 1000 -
`podman exec` without `--user` is container root, reports `rootless: false`, and resolves by a
different code path.

Two things it must never do, and the second would have been a real bug:

- **Touch stdout.** `DockerCommandManager.cs` parses container ids off it, so one stray byte breaks
  *every* `services:` job rather than only the failing ones. The retry is safe for a measured reason
  rather than an assumed one: a failing `podman start` writes **zero bytes** to stdout (rc=125,
  len=0), so a second attempt that succeeds prints the id exactly once.
- **Retry an attached start.** `docker start -a` returns the exit code *of the container*, so a
  non-zero result there is an ordinary outcome - and re-running it would execute the container a
  second time and duplicate its output onto stdout. Any `-a`/`--attach`/`-i`/`--interactive`
  disables the retry, combined short flags included.

`bin/github-runner-smoke.sh` asserts all four directions against a container that cannot exist: it
still exits non-zero, stdout stays empty, the **elapsed time** proves the retries actually ran rather
than being merely intended, and `docker start -a` returns in under a second unretried. That leg
exists because the retry is the only thing in this image that can turn a red job green.

### It stopped, on a wipe, and nobody knows what was wiped away

**`api-checks` has passed cleanly since both lanes were emptied by hand on 2026-08-25** - zero
retries, zero post-mortems, `docker start` succeeding first attempt, twice in a row. That is the
first time a `services:` block has ever worked under the real runner on this host, and **it is not
a fix**: nothing was repaired, a person ran `rm -rf`.

**A one-minute reproduction is what got that far**, after eleven that each cost a thirty-minute
job. `lane-probe.yml`, a scratch workflow in upskald triggered by a push to one branch, carrying
`api-checks`' service block verbatim and a body that does nothing. Four variants across an
afternoon eliminated three hypotheses outright: `ports:` and the `rootlessport` child netns, the
runner's own container-init path (the identical eleven calls issued **from a step** behave the
same), and the inherited environment (`env -i` with only what podman needs behaves the same). It
also produced the one positive result there has been: **on wiped lanes all four variants pass; on
lanes carrying ~2.4-2.7 GB of state from twenty-odd real jobs, all four fail.**

**It is not a threshold on size or on job count, which was the obvious next guess and is wrong.**
It failed at 2.4 GB after 21 jobs. It passes at 2.5 GB after 39. Something specific accumulates and
nothing has identified it.

**So the state is bounded rather than explained, and the word used for that in
`bin/github-runner.sh` is "bound".** `gc_lane` resets `runner/_work`, `tmp` and `storage` on three
triggers - the disk budget that was always there, a **50-job window**, and the shim asking to be
healed. The caches are not in what a targeted reset removes: `home/.cache` and `home/.bun` survive,
and `actions/cache` lives on GitHub anyway, so a heal or a window reset costs one re-pull of
postgres, redis and mailpit. **A budget reclaim does take them**, because it has to - measured on
lane 1, home is 1,789 MB against storage's 660 MB, so a reclaim that spared the caches could not
get back under the budget and would fire on every cycle for ever.

**The self-heal is the half that matters.** When `docker start` exhausts its retries the shim
leaves `.docker-shim-start-failed` in `$HOME` - the one part of an ephemeral lane that outlives it,
being a bind mount - and the driver reads it at the top of the next cycle, which is the only moment
it knows no job is running. A red job stops needing a person.

**And the evidence survives it, which the manual remedy did not.** The lanes were wiped in
front of the failure with nothing preserved, and twelve reproductions have since failed to
recreate that state. A reset with a reason now copies `db.sql` and the layer, container and image
json to `$GITHUB_RUNNER_ROOT/forensics/lane<N>-<stamp>-<reason>/` first - kilobytes, against the
2.5 GB a tar of the store would cost every time, and those are the files that would carry a stale
runroot, an orphaned mount refcount or a container the store still believes in. **A routine window
reset keeps nothing**, deliberately: there is no anomaly in it, and fifty of them would evict the
two that matter.

**`ci.lane_store` is what stops the convenience becoming a silence.** Automating the wipe means a
recurrence leaves no red job for anyone to notice, so a lane that healed itself is reported with
the path to its capture. A window reset is not reported at all - it fires on a counter by design,
and reporting it would train the reader to skip the line.

**`bin/github-runner-smoke.sh` cannot see any of this**, and both affected legs now say so.
`runner()` builds a fresh lane every run, and a fresh store is the single condition under which
this failure has never been observed. That is the same blind spot that let the `db.sql` split pass
with a green tick from a leg that already had the right assertion - a smoke test grades an image,
and both of these defects live in a lane.

## Containment: what it keeps, and what it gives up

Read off a live phase container while a `ship` phase was running:

```
CapDrop=[CAP_CHOWN ... CAP_SETGID CAP_SETUID ...]  readonly=true  [no-new-privileges]
```

**A nested podman cannot run inside that**, and the profile it does need was arrived at by
bisecting one flag at a time on this host rather than copied from a guide. The whole of it:

```
--cap-add=SYS_ADMIN
--security-opt label=type:container_engine_t
--security-opt unmask=ALL
--device /dev/fuse --device /dev/net/tun
```

on top of podman's **default** capability set, with SELinux enforcing and the default seccomp
profile. Each was added because something specific refused, and the refusals are worth keeping
because none of them names the flag that fixes it:

| Missing | What it says |
|---|---|
| `container_engine_t` | ``crun: mount `devpts` to `dev/pts`: Permission denied`` |
| `unmask=ALL` | ``crun: mount `tmpfs` to `proc/acpi`: Permission denied`` |
| `SYS_ADMIN` | `crun: sethostname: Operation not permitted` |
| `/dev/net/tun` | `pasta failed: Failed to open() /dev/net/tun` |

**`unmask=ALL` is about locked mounts, not about masking.** The outer container's own `/proc`
masking is inherited by a nested mount namespace and cannot be overmounted from inside it, so an
inner container cannot lay its own tmpfs over `/proc/acpi`. The cost is that a lane sees
`/proc/kcore`, `/proc/acpi` and `/sys/firmware`; reading kcore needs `CAP_SYS_RAWIO`, which is not
granted, so the exposure is bounded.

**`SYS_ADMIN` is the largest concession and it is what `services:` costs.** Capabilities in a
nested user namespace are bounded by the outer set, so a nested container cannot have what the
lane does not - and a detached inner container sets its own hostname in its own UTS namespace.
With it, `--read-only` stops being a boundary and becomes hygiene, since `mount -o remount,rw /`
becomes possible. What that reaches is the job's own ephemeral overlay, which the job can already
write through `$HOME`, `/tmp` and the runner tree, so the loss is smaller than the flag sounds -
but it is the widest capability there is and it is here because the alternative is that
`services:` does not work at all.

**It is still a long way from `--privileged`**: SELinux enforcing under a purpose-built type, the
default seccomp profile, no host path mounted, and no container socket of the host's reachable.

**Why the runner is uid 1000 with primary gid 0**, rather than container root: a nested engine
started by an unprivileged user gets a user namespace of its own, which is what keeps the outer
capability set to podman's default instead of everything. Rootful podman in the container walks a
different chain - `setns`, then a read-only `/proc/sys`, then `cgroup.subtree_control`, then a
`proc` mount - that ends at `--privileged`.

**Gid 0 is not decoration and cost an hour to find.** `/dev/net/tun` arrives group-0 only, and
group 0 inside a rootless container *is* host group `core`, which the host's udev rule grants. But
the NESTED user namespace maps its own gid 0 to the runner's outer gid - so with gid 1000 the
nested pasta loses that access and fails to open a device the outer process can read perfectly
well. Primary gid 0 carries it through. It is the same uid-arbitrary/gid-0 convention OpenShift
uses, for a related reason.

**The chmod that looks like the obvious fix is silently impossible.** `/dev/net/tun` is owned by
an uid that is not mapped into the container's namespace, so container root is not its owner and
`CAP_FOWNER` does not reach it; `chmod` returns EPERM. Written as `chmod ... || true` - which is
how it was written first - it fails invisibly and the only symptom is pasta refusing, two layers
away. `bin/github-runner-smoke.sh` now opens the device rather than listing it.

**`--security-opt label=disable` is forbidden, and the reason is sharper than the house rule.**
`core` is `unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023`, so that flag would run the
lane as `unconfined_t` - SELinux containment not weakened but *gone*, and the one denial the
whole design rests on no longer applying. `vfs` is an acceptable fallback for the graph driver;
this is not an acceptable fallback for anything.

**What does not move**, and what `bin/github-runner-smoke.sh` asserts:

- no host podman or docker socket, at its usual path *or any other* - the smoke test also requires
  `docker info` to report the lane's own graph root, because the path check alone would still pass
  if somebody later mounted the host's socket somewhere else;
- no `config/`, no `/mnt/media`, and **no path under `cache/conduct/`**;
- a per-lane `isolate=true` network, the slice ceiling, the per-lane cpuset, `--pids-limit`,
  `--log-driver=none`, `--no-healthcheck` on the outer container, and the bare
  `io.home-server.ephemeral` label.

**The smoke test's containment legs are deliberately not `bin/conduct-runner-smoke.sh`'s.** Two of
those - "the root filesystem rejects a write" and "no container socket is visible" - are things a
lane half-violates on purpose. Copying that script and deleting the legs that no longer hold would
have produced a gate whose name promised more than it checked, which is this repository's named
failure. They are replaced, not removed.

## Capacity

**The 4,608M on `app-agents.slice` is a ceiling, not usage**, and that is what makes two slices
fit on a 15.8 GB host. Read out of this host's own 30-day store on 2026-08-24:

| Measurement | Value |
|---|---|
| `home_server_agent_slice_memory_bytes` median | **957 MB** |
| the same, p90 | **1,455 MB** |
| the same, 30-day max | 3,584 MB - which *is* `MemoryHigh`, so it is page cache being reclaimed |
| `home_server_agent_phase_in_flight` mean | **0.069** - a phase runs 6.9% of the time |
| `node_memory_MemAvailable_bytes` median | **11,279 MB** |
| the same, p1 / min | 9,645 MB / 6,886 MB |

The fleet is idle 93% of the time holding about a gigabyte. Overcommitting ceilings is already the
house style, and `app-agents.slice` says why: twenty-four quadlets declare 34.5 GiB against
15.5 GiB of RAM and it works, because the peaks do not coincide.

| Level | MemoryHigh | MemoryMax | CPUs |
|---|---|---|---|
| lane scope | 2816M | 3584M | `4-5` / `6-7` |
| `app-ci.slice` | 5632M | 6656M | `4-7` |

The per-lane limits **bind before the slice does** - two lanes at 3,584M is 7,168M against the
slice's 6,656M - so the slice squeezes them rather than the kernel picking a victim by badness
across the whole subtree.

**The cpuset is per lane and not only per slice.** `AllowedCPUs=4-7` on the slice alone would give
*both* lanes `nproc=4` and put eight workers on four cores - the defect `app-agents.slice`
measured at 5x (340-364s with one spurious failure at `nproc=12`, against 69-71s green at
`nproc=4`), at half the magnitude. Verified that a scope property works at all, which is a
different question from a slice property:

```
systemd-run --user --scope -p AllowedCPUs=4-5 --quiet -- nproc   ->  2
```

**Stated honestly: 4-7 is not exclusive.** No other unit here pins a cpuset, so ffmpeg, Jellyfin
and the Tdarr nodes float across all twelve and will take these four whenever they are free.
`nproc=2` is the truth about the quota, not a promise about the hardware.

**And honestly about speed**: `upskald` fans out to about eight parallel jobs, including a
three-shard e2e matrix. Two lanes on four shared cores will be slower in wall-clock than
GitHub-hosted. The win is cost, control, and running the gate on the same kernel and the same
ceilings the agent fleet already uses.

## Accepted risks, recorded rather than left implicit

- **A lane has unrestricted egress**, like a phase runner and for the same reason: `bun install`,
  `uv sync` and `actions/checkout` do not work without it. `isolate=true` blocks bridge-to-bridge
  traffic, so Caddy's 443 and Jellyfin's 8096 time out from a lane, but the internet and **the
  rest of the LAN** are reachable. `bin/github-runner-smoke.sh` probes the router and **records
  whatever it finds as a note rather than grading it** - nothing on this host had ever probed
  another LAN device, and the honest answer, whichever it is, should not block a promotion.
- **The persistent caches are a cross-job channel.** The bun, uv, Playwright and nested-image
  caches are what make a second run cheap, and they are also the one thing that survives between
  two jobs from two different pull requests. That is accepted in a private repository with trusted
  contributors. The mitigation if it stops being acceptable is per-repository cache roots, not a
  bigger warning.
- **A job runs as `core` once removed.** Container uid 0 is `core`, and although the runner drops
  to uid 1000 inside, an escape from the outer container is an escape to the account that owns
  `/var/home-server`. Bounded by who can open a pull request on a repository in the runner group.
- **The lane's caches are NOT the fleet's.** This is the one that would be tempting to
  "simplify": the two images want the same bun, uv and Playwright caches, and sharing them would
  let a workflow poison the gate that decides whether a phase's change is good. `mirrors/` is
  worse, because `git clone --local` hardlinks its object store. The smoke test asserts the
  separation.

## Observability

A lane is invisible to every other reader on this host, and that is why `docs/observability.md`'s
usual answers do not apply. The container carries `io.home-server.ephemeral`, so
`bin/collect-metrics.py` skips it - correct, because its name carries a timestamp that never
repeats and the network series would accumulate under an unbounded label in a 400-day store. The
consequence is that a **wedged lane produces no series, no failed unit and no unhealthy
container**. Work just queues on GitHub's side, where nothing here is looking. That is the
Windmill-worker shape exactly.

So the lane's own marker is the signal: `~/.cache/home-server/ci-state-<n>`, one file per lane
because a whole-file rewrite needs a single owner, in `conduct-state`'s format and under its
contract - **omitted is not zero**, because the collector drops a sample that does not parse.

`bin/verify-host.sh` grows a `ci` section - nine checks, **WARN or NOTE and never FAIL**, on the
Agents section's charter: `bin/reboot-host.sh` refuses to act on a host this battery calls
unhealthy, and nothing a CI lane does wrong is fixed by a reboot.

`ci.runner_version` is the only one with a **deadline** rather than a threshold. GitHub enforces a
minimum runner version and a runner below it stops being given jobs - the symptom is a job that
queues for ever while the runner shows online and idle. It grades **what is on disk in a lane**,
never the image's `ARG`: a JIT configuration carries no `disableUpdate`, so the runner updates
itself into the lane's writable tree and legitimately runs ahead of the seed. That writable tree
is also what stops the update failing, the runner exiting, and the lane minting a fresh
registration on every pass.

The collector's family is `home_server_ci_*` while the battery's facts are `github_runner_*`. That
asymmetry is deliberate: `ci_*` facts would be shadowed by the collector's prefix and fail
`bin/lint-repo.sh` leg 9 - which is the *good* outcome, because a duplicate sample whose values
disagree rejects the whole scrape, and the battery is hourly while the collector runs every 30
seconds, so the two would disagree by construction.

**`agents.runners_leaked` counts CI containers too**, because it filters on the ephemeral label
alone. Its ceiling stayed at 7200s and its message widened to name both fleets - a lane's scope
carries `RuntimeMaxSec=5400` and its driver tears an idle registration down at 1800s, so a healthy
lane cannot reach it. That is precisely why the idle timeout is not an optimisation.

## Gates

`bin/reboot-when-staged.sh` refuses while a lane says `job_in_flight=1` **and** its heartbeat is
under 300 seconds - the flag survives its writer being killed, and a stale flag vetoing reboots
indefinitely is "the host silently stops taking OS security updates" from a third direction.

It gives way after the **second refusal of a morning**, the count idiom the phase gate uses rather
than the encoder's age idiom, and the pricing is the argument: a killed CI job costs one
`gh run rerun` against a branch GitHub still holds, where a killed transcode costs an hour of GPU
time. **It is slightly worse than a killed phase and the code says so**: GitHub does not re-queue
a job whose ephemeral runner disappeared, so a person has to press the button, where conduct's
reconciler reclaims a phase with nobody involved.

`bin/reboot-host.sh` **warns rather than vetoes** - a person is reading that output. It reports
both fleets, because a pre-flight naming a CI job while staying silent about a conduct phase would
read as "nothing else is running", and a reader would be entitled to draw that conclusion.

**`bin/update-when-idle.sh` gets nothing, deliberately.** The lane is not a quadlet, has no
`AutoUpdate=` label and no unit for the nightly container update to touch; the prune removes only
dangling images and `:latest` is tagged. A CI arm there would be a refusal that has never had
anything to refuse - the exact shape where a check that cannot fire looks identical to one that
works.

## Making a repository use it

`runs-on:` is the whole of it, and the opt-in is one Actions variable rather than an edit per job:

```yaml
runs-on: ${{ fromJSON(vars.CI_RUNNER || '["ubuntu-latest"]') }}
```

with `vars.CI_RUNNER` set to `["self-hosted","home-server"]`.

**The point is the escape hatch.** During a host outage, changing one variable in the GitHub UI
moves every job back to `ubuntu-latest` in seconds, with no pull request and no merge to a `main`
that is not branch protected.

**Never label a lane `ubuntu-latest`.** It looks like the zero-edit way to move everything at once
and it is a trap: GitHub falls back to a hosted runner only when no runner with that label is
*connected*, so the same workflow would silently alternate between a hosted Ubuntu image and a
two-core container depending on whether a lane happened to be registered at that instant - flaky,
environment-dependent, and near-impossible to attribute from a job log. It would also capture
`release-please`, `auto-merge` and `pr-recap`, stalling merges behind CI.

**Two workflows stay hosted on their own merits.** `auto-merge.yml`'s header argues that "PR-head
code never runs here, so carrying a write token is safe", and it mints a GitHub App token; that is
reasoning about the workflow, not about the runner. `release-please.yml` is the same shape.

**Cache keys collide, and the poisoning runs both ways.** Every key in `upskald`'s
`setup-toolchains` composite was `...-${{ runner.os }}-...`, and `runner.os` is `Linux` on hosted
and self-hosted alike. `~/.cache/prek` holds hook environments with **absolute interpreter paths**
and `~/.cache/ms-playwright` holds browsers built against a specific glibc - so a self-hosted run
can break the next *hosted* run, and nothing in the workflow can see it. **Closed** by
`${{ runner.environment }}` in all three key families - `bun-`, `playwright-` and `prek-` - in the
same pull request that moved the first job, which is where a discriminator belongs.

**One workflow change that is not `runs-on:`, and the first e2e run off GitHub's hardware found
it.** `e2e-tests` runs `bunx playwright install --with-deps chromium`. `--with-deps` shells out to
`sudo apt-get`, so it supports Debian and Ubuntu and nothing else - and it **does not detect that
it cannot work**. On the lane it warns, falls back to the `ubuntu24.04-x64` dependency list anyway,
and only then fails on the package manager:

```
BEWARE: your OS is not officially supported by Playwright; installing dependencies
        for ubuntu24.04-x64 as a fallback.
sh: line 1: apt-get: command not found
Error: Installation process exited with code: 127
```

All three shards, on the first run that ever reached this step. The libraries were never missing:
`apps/github-runner/Dockerfile` installs the chromium set with `dnf` and **names each one**,
precisely because Playwright cannot install them here.

**Gated on `runner.environment`, not deleted, and this paragraph used to advise deleting it.**
Dropping `--with-deps` outright would leave the hosted path - the escape hatch the whole
`vars.CI_RUNNER` indirection exists to preserve - depending on GitHub's image happening to carry
Playwright's library set, which is the assumption Playwright's own documentation says not to make.
The conditional leaves hosted byte-for-byte as it was and needs no proof run at all:

```yaml
run: bunx playwright install ${{ runner.environment == 'github-hosted' && '--with-deps' || '' }} chromium
```

**A Playwright bump that needs a new library will not fail at that step.** Nothing on the lane
re-derives the list, so the symptom is Chromium failing to launch on a missing `.so` several steps
later, naming the library and not the step. The fix is a line in that Dockerfile. `e2e-full.yml`
carries the same conditional while staying pinned to `ubuntu-latest`, where it is inert - written
so that pointing the nightly matrix at a lane is a `runs-on:` change and not a rediscovery of this.

Suggested order, because it puts the cheap failures first: the compute-heavy jobs with no
`services:` (`pre-commit`, `scripts-tests`, `web-checks`, `web-build`); then `api-checks`, the
first single-service job; then `e2e-tests`, only once a shard has been measured to fit.

### `ai-review` on the lane, which this file used to forbid

**It said: `ai-review` stays hosted - it needs the Anthropic credential, and this host's rule is
that a model credential reaches exactly one container, which is the phase runner.** That was
decided against on 2026-08-26 and every job in `ci.yml` now follows `CI_RUNNER`. Recorded as a
widening rather than quietly deleted, because the sentence it replaces was a boundary.

**The rule it appeared to breach is about a different credential.** "One container" governs *this
host's* model credential - the `claude setup-token` under the phase runner, which is the
account this repository pays for and which `docs/agents.md` bounds. `ai-review`'s key is
**upskald's own repository secret**, injected by GitHub into a job, owned by that repository and
revocable there. A lane already receives `GITHUB_TOKEN` and every other secret its jobs name; this
is one more of them, not the host's.

**What genuinely widens is what runs, not what is held.** `claude-code-action` starts a model-driven
agent inside a lane, with the checkout and network egress. What bounds it is the containment the
rest of this document describes and nothing else: an ephemeral rootless container on an
`isolate=true` network, SELinux `container_engine_t`, a read-only rootfs, no host socket, and a
scope that dies at `RuntimeMaxSec`. That is the same boundary a `pull_request` job already runs
inside - the difference is that this one is *supposed* to be autonomous.

**Two consequences worth saying out loud.** The Anthropic credential now exists in a second place,
so revoking it is a two-repository operation. And the lane's egress is not filtered, so a
compromised action reaches the internet - which was true of `bun install` before it and is why the
network is isolated from every stack segment rather than from the WAN.

## Commands

```bash
systemctl --user status home-server-github-runner@1        # a lane
journalctl --user -u home-server-github-runner@1 -f
cat ~/.cache/home-server/ci-state-1                        # what it thinks it is doing
systemctl --user list-units --type=scope | grep ci-lane    # a job in flight

systemctl --user start home-server-github-runner-build.service   # build, smoke, promote
GITHUB_RUNNER_IMAGE=localhost/home-server/github-runner:next \
  ./bin/github-runner-smoke.sh                             # the gate, by hand

podman ps --filter label=io.home-server.ephemeral          # lanes and phases together
cat /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/app-ci.slice/memory.peak

gh api /orgs/avanserv/actions/runners \
  --jq '.runners[]|{name,status,busy}'                     # what GitHub thinks exists
gh api /orgs/avanserv/actions/runner-groups                # group ids, for GITHUB_RUNNER_GROUP_ID
```

## What is proved, and what is not

**Proved on this host, against a real build of this image**, by running
`bin/github-runner-smoke.sh` from a staging copy:

- every binary a workflow shells out to; libicu, lttng and libmagic; git 2.55.0;
- the seeded runner tree matching the Dockerfile's `ARG`, and the pin being upstream's latest;
- **Python 3.13.15 in the tool cache with its `.complete` marker**, so `actions/setup-python`
  resolves 3.13 without the network and `upskald` needs no change;
- all five lane mounts writable and **not tmpfs**, asserted by filesystem type, on xfs;
- the rootfs rejecting a write;
- **the nested engine starting, on `overlay` and not `vfs`, and pulling an UNQUALIFIED short
  name** - which is what every `services:` block writes;
- **a detached nested container starting and running**, which is the `services:` case itself;
- egress to `api.github.com` from an `isolate=true` network;
- neither host container socket visible, `docker info` reporting the lane's own graph root, no
  `config/`, no `/mnt/media`, no `cache/conduct/`, and **no `GITHUB_RUNNER_PAT` in
  `/proc/1/environ`**.

**SELinux is not the obstacle it was expected to be.** The `newuidmap` refusal that sank the
Ubuntu base was reproduced with `semodule -DB` - dontaudit off - and logged **no AVC at all**.
`virt_sandbox_use_fusefs` and `container_modify_selinux_labels` are both still **off** and neither
is needed; `container_use_devices` was already on. Nothing about this design required a boolean
change.

**Proved by real work, on `avanserv/upskald` PR #253**, which moved all eleven `ci.yml` jobs onto
the lanes behind `vars.CI_RUNNER`:

- **`fromJSON(vars.CI_RUNNER || '[...]')` is accepted in `runs-on:`**, and the fallback keeps a
  repository working when the variable is unset.
- **`podman-docker` satisfies the runner's own `docker` call sequence**, and a service container
  reaches `healthy` through `apps/github-runner/scripts/podman-healthcheck-loop.sh` rather than
  sitting at `starting` for six hours.
- **Per-job cost is not the problem the capacity section feared.** `pre-commit` 248s against 251s
  hosted (1.0x), `scripts-tests` 1.1x, `web-build` 1.2x. Two cores cost almost nothing, and the
  pipeline is dependency-bound - a 1,513s critical path against a 25m32s hosted wall clock - so two
  lanes are enough.
- **Every one of the eleven jobs passes**, as of 2026-08-26. `api-checks` twice in a row with zero
  retries and zero post-mortems, and all three `e2e-tests` shards - three service containers each,
  postgres, redis and mailpit - green on their first run off GitHub's hardware.

**An e2e shard fits, and the numbers that say so are not the peak.** Measured off the transient
scopes' own cgroups, three shards, two of them concurrent, which is the worst case the slice is
sized against:

```
scope memory.peak      2,816-2,818 MB   all three shards, and api-checks too
scope memory.stat anon 2,607 MB worst
scope memory.events    high climbing to 2,197; max 0; oom_kill 0
scope pids.peak        316 of 1,024
slice memory.peak      5,634 MB of 5,632M MemoryHigh
slice pids.peak        623 of 2,048
memory.pressure some   avg10 0.00-4.11%
shard wall clock       6m against the job's own timeout-minutes: 25
```

**Every shard pinned itself to `MemoryHigh` exactly** - 2,816M is the scope's `MemoryHigh` and
three independent jobs landed on it to within 2 MB - which is the throttle doing what it is for
and not a ceiling under strain. `max` stayed 0 and `oom_kill` stayed 0, so no allocation was ever
refused. **Nothing was raised**, and `host/systemd/app-ci.slice` has been rewritten from these
numbers rather than from the guesses it shipped with.

**The margin is what absorbed it and it is tighter here than next door.** `anon` alone is 2,607 MB,
so 93% of `MemoryHigh` is memory genuinely in use rather than reclaimable cache, and the 768M
between `MemoryHigh` and `MemoryMax` is the whole of the headroom - against `app-agents.slice`'s
1,042M for a workload with no browser and no service containers. A heavier suite is what crosses
it, and it arrives as an `oom_kill` rather than as a slow job.

**And raising the scope alone would move the throttle rather than add headroom**: two lanes at
`MemoryHigh` sum to 5,632M, which is the slice's `MemoryHigh` to the megabyte. The pair moves
together or neither does.

**Not yet proved, and none of it can be settled from a workstation:**

- **The cause of the `api-checks` failure.** It stopped on a manual wipe and the state that was
  wiped is gone; the retry is a treatment and the reset is a bound. The two sections above say so
  rather than implying otherwise.
- **That the bound holds.** `gc_lane`'s 50-job window and the shim's self-heal have not yet been
  exercised by a real recurrence - only by a hand-planted breadcrumb. What would prove them is
  `ci.lane_store` firing on its own, which is a thing to hope does not happen.
- **Whether `/run` at 128m is enough for a job that does something unusual with it.** It is two
  orders of magnitude above the engine's own runtime state, and the smoke test grades the ceiling
  rather than the usage, so an overrun would surface as a job failure and not as a warning.
