# Continuous integration on this host

`docs/agents.md`'s sibling. That file is the hosting for the coding-agent fleet; this is the
hosting for GitHub Actions. They share a host, a design language and most of their traps, and
where they differ it is written down here rather than left to be inferred.

Added 2026-08-24.

## What this is

Three **lanes**. Each is a `systemd --user` process that mints a single-use GitHub Actions runner
identity, starts one container, lets that container run exactly one job, tears the registration
down, and does it again. The lanes are `home-server-github-runner@1.service` through `@3`; the driver
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
would hold every lane for the afternoon while every signal on this host read green: the container
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

**So the shim now samples the start instead of only autopsying it.** Every `docker start` forks a
sampler that writes one line every ~100 ms for as long as podman runs, and the post-mortem prints
it - transitions only, with the identical runs counted rather than dropped - when and only when the
start failed. Three numbers, none of which needs an engine: overlay mounts in the pause namespace,
the byte size of `containers/storage`'s `mountpoints.json` in the runroot, and the entry count of
the container's own `merged/`. The layer is resolved out of `overlay-containers/containers.json` by
text scan, so a green job pays four forks and prints nothing.

That is the reading the table below cannot give. If `mounts` reaches 2 and `mp` grows before crun
fails, **the mount was real and something tore it down**; if neither ever moves, **containers/storage
returned a mountpoint it never made**. Those are different bugs and every instrument here so far has
been standing on the wrong side of libpod's cleanup to see which.

Two things about it that were learned by getting them wrong first:

- **The setup has to happen before the fork.** Resolving the pause pid and the layer is four forks;
  a failing `docker start` returns in about 230 ms and the stub used to test this returns in five,
  so a sampler that resolves its own paths *after* being backgrounded is killed before it writes a
  line. Doing it in the foreground also makes `t=0` a reading taken **before** podman was invoked,
  which is the baseline every later sample is read against.
- **The backgrounded subshell must clear the EXIT trap**, which deletes the sample file. Inheriting
  it would delete the samples the instant the sampler is killed - the one file the whole change
  exists to produce.

**And the post-mortem was reaching nobody.** It is `tee`d to a file under `$HOME` *and* to stderr,
which is where a job log reads it - except that the two redirections were written
`2>/dev/null >&2`, and redirections apply **left to right**, so tee's stdout was pointed at the
`/dev/null` fd 2 had just been pointed at. Measured 2026-08-27 against the two lane failures of
2026-08-26: **three post-mortem groups each in the forensic capture, zero in the job logs GitHub
kept.** Nothing failed, nothing was empty, and the `--log-level=debug` block - echoed directly, not
tee'd - was there both times, which is exactly why it went unnoticed. Third defect in that one line.
`bin/github-runner-smoke.sh` now counts post-mortem groups and sample blocks **on stderr**, because
the leg that already existed asserted only the file.

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
job. `lane-probe.yml`, triggered by a push to one branch, carrying `api-checks`' service block
verbatim over a body that does nothing. **It is kept at `apps/github-runner/lane-probe.yml`** -
not deployed by anything, copied into a repository when it is needed - because it is a diagnostic
for this runner rather than a feature of the repository it runs in, and because deleting it would
throw away the one instrument that has ever moved this. Four variants across an
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

### It came back forty minutes later, and this time something was measured

**It recurred on 2026-08-26 at 12:52**, on lane 2, in a re-run of the pipeline that had just gone
green. Same failure, same shape - `docker create` fine, `docker start` 125, crun unable to open
`merged/etc/resolv.conf`. **The whole chain built that morning ran on its first real occurrence**:
the shim retried twice, printed its post-mortem, left the breadcrumb; the driver read it 21 seconds
later, captured the store's metadata and reset the lane; `ci.lane_store` reported it.

**The capture turned out to be nearly worthless, and for a reason already on record.** Compared
against a capture taken from a healthy lane 13 minutes earlier: 20 layers each, `incomplete=0` in
both, no mount state in either, `containers.json` 2 bytes in both, `mountpoints.json` absent from
both, `images.json` byte-identical. **The store of a lane that had just failed is indistinguishable
from the store of one that was working.** The reason is the one the post-mortem section above
already gives for the shim's own block: libpod unmounts on a failed start and the runner then
`docker rm --force`s the container, so a capture 21 seconds later is post-cleanup by construction.
It preserves `db.sql` and `layers.json`, which survive cleanup, and those turned out to say nothing.

**"`mountpoints.json` absent from both" was not a reading, it was a wrong path**, and the sentence
that explained it away - "absent on an idle lane, and its absence is itself a reading" - made it
look like one. `containers/storage` does not keep that file in the graph root at all: it lives in
the **runroot**, at `$XDG_RUNTIME_DIR/containers/overlay-layers/mountpoints.json`. Verified on a
live lane 2026-08-27 - the runroot holds its `mountpoints.lock`, the graph root holds neither file -
so the copy could never have succeeded on any lane in any state, and four captures recorded a
meaningful-looking absence of the one file that would have shown an orphaned mount refcount.
**Nor can it be fixed by pointing at the runroot**: that filesystem is the lane's own tmpfs and dies
with the container, while the capture is taken from the host at the top of the next cycle. It is out
of the capture list, and the shim's sampler reads it from inside the lane instead.

**What did say something is the shim's block, printed inside the lane at the instant of failure -
and, for the first time, a control beside it.** A postgres started by hand on a healthy lane
thirty seconds later, through the same nested engine:

```
                 merged gid   work gid   overlay mounts (pause ns)   merged entries   mountpoints.json
failing start    65535        65535      1                           0                2 bytes
healthy start    0            0          2                           18               198 bytes
```

Every one of the other eleven layers in that healthy store also reads gid 0.

**Only the two gid rows are a fair comparison, and the other three cannot discriminate at all.**
The failing reading is post-cleanup and the healthy control was taken from a **running** container,
so `mounts 1 vs 2`, `merged 0 vs 18` and `mountpoints.json 2 vs 198 bytes` are three different
spellings of "one of these has been torn down". A gid survives an unmount; a mount count does not.
That is what the sampler in the section above exists to replace.

**The gid reading was right and the interpretation under it was wrong, because it quoted the wrong
namespace's map.** It said the nested engine's gid map is `0 1000 1` / `1 100000 65536`, so 65535
"is inside the mapped range and is a real gid that something deliberately chose". Those two lines
are the **lane's own** map - `/proc/self/gid_map` inside a lane reads exactly that, measured
2026-08-27. The nested engine runs as `runner`, uid 1000 with **primary gid 0**, and `/etc/subgid`
gives it `runner:1:999` and `runner:1001:64535`, so its map - read off the pause process, which is
what holds that namespace - is:

```
0     0     1
1     1     999
1000  1001  64535        nested 1000..65534 -> lane 1001..65535
```

**So lane gid 65535 is the ceiling of that map, and it is what nested gid 65534 maps onto - which is
the nested namespace's own overflowgid.** The post-mortem printed the *lane's* overflowgid, 65534,
and ruling overflow out on that basis is one namespace too high. The question is not what chose
65535; it is **which chown targeted a gid the nested map does not contain**. Both maps are now
printed, labelled, for the same reason the two mount-namespace numbers are.

It remains the first asymmetry anyone has measured between a failing start and a working one, and
it came with its control.

**It also refutes nothing about accumulated state and confirms nothing either.** Lane 2's store had
not been reset; lane 1's had, and lane 1 kept working through the same run. That is consistent with
the correlation and is not evidence for it - two lanes is not a sample.

### Four in one day, and the load it was blamed on was not there for two of them

**2026-08-26 produced four occurrences, not one**: lane 1 at 12:39, lane 2 at 12:53, lane 2 at
20:46, lane 1 at 20:57. Every one of them retried, post-mortemed, breadcrumbed, captured, healed,
and passed its next job with nobody involved. The machinery works. It still does not say why.

**The obvious reading was load, and the data does not support it.** The evening pair happened with
four runs in flight against two saturated lanes and jobs still queued eighteen minutes later; the
midday pair happened hours earlier, in the ordinary run of things. What all four share is a store
with history, which is the correlation already on record - and it is still not a threshold:

| | lane | `store_jobs` | `lane_disk_mb` |
|---|---|---|---|
| 12:39 | 1 | 0 | 3,295 |
| 12:53 | 2 | 4 | 4,474 |
| 20:46 | 2 | 12 | 4,461 |
| 20:57 | 1 | 18 | 3,728 |

**The 12:39 row is not a data point.** Its driver had restarted one second earlier, so the
breadcrumb it healed on was written before the restart and its `store_jobs=0` is a counter reset,
not a store that had served nothing. The three clean readings are 4, 12 and 18 - all far under the
50-job window, which has therefore never fired ahead of a heal and would not have prevented any of
these.

**A `lane_reset` mid-job was ruled out rather than assumed.** `gc_lane` is called from one place, at
the top of the cycle, after the job's `podman run` has been waited on and its registration deleted;
the journal shows the heal two seconds *after* "job finished" in both evening cases.

**`bin/github-runner-smoke.sh` cannot see any of this**, and both affected legs now say so.
`runner()` builds a fresh lane every run, and a fresh store is the single condition under which
this failure has never been observed. That is the same blind spot that let the `db.sql` split pass
with a green tick from a leg that already had the right assertion - a smoke test grades an image,
and both of these defects live in a lane.

### Eighteen more, with the instruments live and the lanes loaded

Every earlier reproduction was run against a lane that had been wiped, or with instruments that
turned out to be pointed at nothing. On 2026-08-27 both conditions were finally right at once: the
post-mortem's `tee`, the ~100 ms sampler and both gid maps deployed at 08:49 in image
`7d6611a71464`, and both lanes were carrying the state that reproduces - lane 1 at 4,746 MB across
33 jobs, lane 2 at 4,706 MB across 40, well past the 2.4-2.7 GB band where all four probe variants
failed on the 25th.

**Eighteen attempts, none fired.** Six serial inside one lane container with the image already in
the store; twelve more with a forced `docker rmi` and fresh pull before every `create`, on both
lanes concurrently, which is the shape the failing job had. The sequence was taken from the failing
job log rather than written fresh - the network create, the pull, `docker create` with `-p 5432:5432`
and the four health flags, then `docker start` - because `-p` and the per-job network are among the
things the nine synthetic reproductions left out. Both stores came through byte-intact: `store_jobs`
and `lane_disk_mb` unchanged, no breadcrumb, no leftovers.

**What is still unreproduced is the container lifecycle, not the container.** All eighteen ran
inside a long-lived lane container. The real workload starts a FRESH one per job over a graph root
that persists and a runroot that is a tmpfs dying with the container. Nothing here has tested that
boundary, and it is the obvious next thing.

**Three readings that look like findings and are not.** They are written down because each one cost
time to check:

- **The 31-32 second gap before three of the four heals is the failure's own duration.** 20:45:54 to
  20:46:26, 20:56:54 to 20:57:26, 12:52:35 to 12:53:06 - which is mint, container start, job
  assigned, shim exhausts its retries, job ends, container exits, driver reads the breadcrumb.
  Successful cycles on the same evening sit 32-33s apart.
- **The load was not there at the instant.** The post-mortem read `pressure(io) some avg10=0.00`,
  `pressure(mem) some avg10=0.00`, `pressure(cpu) some avg10=1.63`, `memory.current` 155 MB,
  `oom_kill 0`, 66 pids of 1024, `/var` 33% used. The lane was idle when it failed.
- **A driver killed without its TERM handler is ruled out.** It would be a real mechanism - no lock
  anywhere in `bin/github-runner.sh`, the job in a sibling scope that outlives the driver,
  `job_in_flight` not restored by `marker_read()`, so a fresh driver could `rm -rf` the graph root
  under a live engine. Both drivers held pids 1405580 and 1405627 continuously from 19:20 through
  20:58, and the whole day carries no `Main process exited` and no signal. `gc_lane` now refuses
  while a `ci-<n>-*` container is running anyway.

One datum does support upskald's store-skew suspicion, weakly: the pull immediately before the
failure took 2.4s, and a genuine cold pull of the same image on this host takes 5.0-5.2s, measured
twelve times. GitHub strips carriage-return progress updates, so the job log cannot say whether
those eleven `Copying blob` lines ended in `done` or `skipped: already exists`. The timing is the
only evidence and it is half.

## The shared artifact store

upskald's CI hands work between jobs - end-to-end shard reports, coverage data, two small files one
workflow writes for another - and was round-tripping about 2.5 MB per run through GitHub artifacts
to do it. One directory, mounted into every lane at `/opt/ci-artifacts` and exported to a job as
`$CI_ARTIFACT_STORE`, replaces that.

```
$FLEET_ROOT/artifacts/            -> /opt/ci-artifacts
  runs/   <owner>/<repo>/<run_id>/<run_attempt>/<name>/   swept at 30 days
  state/  <owner>/<repo>/baselines.json                   swept by nothing, backed up
```

**It is a sibling of `lanes/`, not a child, and that is the only real guarantee it has.**
`lane_reset` deletes `runner/_work`, `tmp` and `storage` out of `$LANE_ROOT`; a store a reset could
reach would lose the coverage ratchet on the first self-heal, of which there were four in one day.
Nothing in `lane_reset` knows this path exists and it must stay that way.

**One directory for every lane, deliberately.** upskald's producing job and its consuming job land
on different lanes routinely - that is the entire reason they asked for it. A per-lane store would
not error; it would answer with somebody else's data most of the time, and a third lane made that
worse rather than better: the chance a producer and its consumer share one is a third, not a half.

**Not under `config/`, even though that is where the backup already reaches.** This file states, and
`bin/github-runner-smoke.sh` asserts, that no path under `config/` is mounted into a lane. Putting
the store there turns that assertion into "no `config/` except this one", which is the shape every
eroded boundary starts out as. `state/` reaches the backup instead by the mechanism
`bin/backup-server.sh` already uses for the Prometheus snapshot and the SQLite dumps: staged into
the backup tree by a step of its own. That needs no new `restic backup` path and no change to
`bin/verify-restore.sh`, which asserts against both repositories.

**`CI_ARTIFACT_STORE` is declared in the image's `ENV`, never passed with `-e`.** The driver passes
no environment into a lane at all - the argument for that is at the top of `bin/github-runner.sh`
and it is about the registration token - and this value is a CONTAINER path, a property of the
image rather than of the host. The host half is the `-v` in the driver, and the two agree by
reading, the same way `storage.conf`'s `runroot` and `XDG_RUNTIME_DIR` do.

**Being always set is the point.** upskald's side branches three ways: unset means no store and
their coverage gate passes; set-and-readable means a baseline and the gate enforces it;
set-and-unreadable means `unavailable` and the gate FAILS. So a store that is mounted but broken
turns their pull requests red rather than quietly passing every surface at once. The
set-but-absent case cannot arise from the mount itself, because podman does not create a missing
bind-mount source - it refuses to start the container.

**Thirty days on `runs/`, and seven would have failed in the worst possible distribution.** One of
their consumers runs when a pull request merges and reads the artifacts of that pull request's LAST
CI run, which may be weeks old if the branch sat. A 7-day sweep would break exactly the slow-moving
pull requests and nothing else. Sizing: about 2.5 MB per run against 153 GB free on `/var`.

**The sweep is `bin/ci-artifacts-sweep.sh` on its own daily timer, not part of `gc_lane`.** Every
other reclaim in `bin/github-runner.sh` operates on a `$LANE_ROOT` exactly one process owns; this
tree is shared, and two drivers sweeping it on independent schedules have no lock between them. It
sweeps at whole-run granularity, because a run's artifacts are written by several jobs at several
times and a half-swept run reads to a consumer as "never uploaded" rather than "expired". It
refuses a retention under seven days, refuses to operate on any path not ending in `/runs`, and
writes its own timestamp - `ExecMainExitTimestamp` is wiped by a reboot, so "has never run" and
"has not run since boot" read alike through it.

**`state/` is why the backup treats an empty capture as fatal.** `scripts/check_coverage.py` in
upskald returns PASS on `absent` and FAIL only on `unavailable`, and a runner with no store reads
`absent` - so losing the baseline does not turn their gate red, it turns it into a gate that
silently enforces nothing, on every surface at once. A stale copy is worth far more than none.

**Everything under the store belongs to the subuid container uid 1000 maps to**, so `core` cannot
traverse it and a plain `rsync` or `du` reports success having read nothing. Every path that
touches it - the sweep, both backup scripts, `ci.artifact_store` - goes through `podman unshare`,
which is the same lesson that once had `gc_disk` reading 1,383 MB against 2,500 MB actual.

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
| lane scope | 2816M | 3584M | `4-5` / `6-7` / `8-9` |
| `app-ci.slice` | 8448M | 9984M | `4-9` |

The per-lane limits **bind before the slice does** - three lanes at 3,584M is 10,752M against the
slice's 9,984M - so the slice squeezes them rather than the kernel picking a victim by badness
across the whole subtree. The shortfall is 256M per lane, the same rate it was at two lanes
(7,168M against 6,656M).

**The cpuset is per lane and not only per slice.** `AllowedCPUs=4-9` on the slice alone would give
*all three* lanes `nproc=6` and put eighteen workers on six cores - the defect `app-agents.slice`
measured at 5x (340-364s with one spurious failure at `nproc=12`, against 69-71s green at
`nproc=4`). Verified that a scope property works at all, which is a different question from a
slice property:

```
systemd-run --user --scope -p AllowedCPUs=4-5 --quiet -- nproc   ->  2
```

**Stated honestly: 4-9 is not exclusive.** No other unit here pins a cpuset, so ffmpeg, Jellyfin
and the Tdarr nodes float across all twelve and will take these six whenever they are free.
`nproc=2` is the truth about the quota, not a promise about the hardware.

**And honestly about speed**: `upskald` fans out to about eight parallel jobs, including a
three-shard e2e matrix. Three lanes on six shared cores will still be slower in wall-clock than
GitHub-hosted. The win is cost, control, and running the gate on the same kernel and the same
ceilings the agent fleet already uses.

### The third lane, and which of the three refusals actually held

**This section said no on 2026-08-27 and the lane was added the same day.** It is rewritten rather
than deleted because the interesting part is which of its arguments survived: one was right and is
now the reason there is no fourth lane, one was wrong about how a cpuset works, and one was never
the constraint. Its own closing paragraph named *"moving the slice's cpuset"* as one of two honest
options, and that is the option that was taken.

**Memory was right, and it is now what refuses a fourth.** The original argument - three lanes at
`MemoryMax=3584M` is 10,752M against a slice ceiling of 6,656M - was an argument about *ceilings*,
and ceilings are what moved: `app-ci.slice` went to 8,448M/9,984M, preserving the rule that the
slice's `MemoryHigh` is the sum of the lanes' and its `MemoryMax` sits below theirs. What made that
safe rather than reckless is measured rather than argued. Over the 24 hours before the change:

| Measurement | Value |
|---|---|
| `node_memory_MemAvailable_bytes` median | **10,358 MB** |
| the same, minimum | **5,639 MB** - and the minimum occurs *while both lanes are busy* |
| `home_server_ci_lane_memory_max_events_total` | **0** on both lanes, lifetime |
| `home_server_ci_lane_oom_kills_total` | **0** on both lanes, lifetime |
| `app-ci.slice` `memory.pressure some total` | **60s**, lifetime |

So the third lane's 2,816M comes out of roughly that 5,639 MB, leaving ~2.8 GB plus 4 GB of zram.
Nothing has ever been *refused* an allocation here, which is the reading that justifies a ceiling -
the peak is not, and `app-agents.slice` records that same reading being misread once already. A
fourth lane is 11,264M of `MemoryHigh` against that measurement, and `bin/github-runner.sh` refuses
it by name.

**CPU was wrong, and the error is worth keeping.** It said *"widening to `4-9` takes two cores from
where Jellyfin - this host's largest CPU consumer - already floats"*. **A cpuset is not exclusive**,
which this file says two paragraphs above about `4-7` and then forgot one section later: widening
does not take 8-9 from anything, it shares them, and everything unpinned keeps all twelve. Measured
over the same 24 hours, cores 8-11 ran **7-10% busy** and every core on the host 6-16%.

**Disk was never the constraint** and remains the number that looks worst: each lane store sits
around 4.7 GB against a 20 GB budget, and `/var` has 153 GB free of 233 GB.

**What the lane buys is width, not speed, and that was measured too.** The obvious reading of a
lane at 45% mean CPU across its two cores is "it is waiting on the network", and the obvious
remedy is a wider cpuset. Both are wrong here. `make coverage-api` runs `pytest` with no `-n`, and
`e2e/playwright.config.ts` is `workers: 1` under CI - so **the two longest jobs on upskald's
critical path are single-threaded**, and one busy worker beside three service containers is exactly
the 1.0-1.4 cores observed. No cpuset can shorten them. A third *shard* can, and a third shard is
what needed a third lane: upskald cut its e2e matrix from three to two hours earlier with the
comment *"TWO BECAUSE THERE ARE TWO LANES"*.

**What upskald observed remains the documented trade rather than a fault.** Jobs from runs started
at 20:35 were still queued at 21:04, and `Pre-commit Hooks` went from about two minutes hosted to
8m27s on a lane. `4-9 is not exclusive` above says why. Note that queueing was never the large
number: measured across a full eleven-job run on 2026-08-27, the *total* wait for a lane was 171
seconds against 29m24s of wall clock.

**If a fourth lane is ever wanted**, the two honest options are the ones this section named for the
third: a smaller per-lane ceiling, or moving the slice's cpuset again - and this time the cpuset
would have to come out of `app-agents.slice`'s `0-3`, which changes a phase's `nproc` from 4 to 3
against a measurement `host/systemd/app-agents.slice` records. Neither is an adjustment.

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

`bin/verify-host.sh` grows a `ci` section - **fourteen** checks, **WARN or NOTE and never FAIL**,
on the
Agents section's charter: `bin/reboot-host.sh` refuses to act on a host this battery calls
unhealthy, and nothing a CI lane does wrong is fixed by a reboot.

That count said "nine" until 2026-08-28, which is the ordinary fate of a number written in prose
next to a list that grows - `docs/observability.md` records the agent tally getting it wrong twice
for the same reason. Count `say ci` to the next `say` in `bin/verify-host.sh` rather than trusting
this sentence.

**Since 2026-08-28 there is somewhere to look that is not `jq`.** `/ci` on the dashboard renders
the lane markers, the two budgets, the slice and all fourteen checks - see `docs/dashboard.md`. It
shows **passing** checks as well as failing ones, which the System page deliberately does not,
because `github_runner_runtime_split` and `github_runner_root_label` are string facts that mint no
series: the check's own status is the only route to them anywhere. It carries nothing from
GitHub's API, and says so on screen rather than letting three lanes read as the whole picture.

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

## The nightly browser matrix, and the two libraries that are not Fedora's

Asked for by upskald on 2026-08-27 as item 3 of five: the Firefox and WebKit system libraries, so
that `e2e-full.yml`'s `[chromium, firefox, webkit]` matrix can leave `ubuntu-latest`. They expected
Firefox to be routine and WebKit to be the hard one, and offered to leave WebKit hosted if it could
not be made to launch. Both halves of that guess were right; WebKit was made to launch anyway.

**Nothing in their workflow has to change except `runs-on:`.** `e2e-full.yml` already carries
`bunx playwright install ${{ runner.environment == 'github-hosted' && '--with-deps' || '' }} ${{ matrix.browser }}`,
written that way when the `--with-deps` trap was closed for `ci.yml` so that pointing the nightly at
a lane would not rediscover it. It did not.

### Why a Fedora image has to satisfy Ubuntu's sonames

**Playwright serves the Ubuntu 24.04 build to every distro it does not recognise.**
`packages/utils/hostPlatform.ts` ends its Linux branch with an unconditional
`return 'ubuntu24.04-x64'`. So a lane downloads `firefox-ubuntu-24.04.zip` and
`webkit-ubuntu-24.04.zip` - binaries linked against Ubuntu 24.04 - and prints
`BEWARE: your OS is not officially supported by Playwright; downloading fallback build for
ubuntu24.04-x64` while doing it. chromium is unaffected because Playwright ships Google's own
distro-agnostic build for it, which is the entire reason chromium has worked here since the first
e2e run and the other two were an open question.

That single line is the load-bearing fact, and it generalises past Playwright: **a tool that "falls
back" to another distribution's build is a tool that has made that distribution's ABI your
problem.**

### Firefox was routine. WebKit needed two libraries Fedora does not have

Every soname in Playwright's `nativeDeps.ts` table was resolved against Fedora 44's own repodata,
and then checked the only way that settles it - `ldd` over the installed bundles in a throwaway
container, with the bundle's own libraries subtracted:

| | result |
|---|---|
| chromium | already satisfied |
| firefox | five packages - `gtk3 gdk-pixbuf2 cairo-gobject libX11-xcb libXcursor` - and it launches |
| webkit | twenty-one more, plus **five sonames no Fedora package provides at any version** |

Four of them are `libicuuc.so.74`, `libicui18n.so.74`, `libicudata.so.74` and `libjpeg.so.8`.
Fedora 44 ships ICU 76 and 77, and has shipped libjpeg's 6.2 ABI (`libjpeg.so.62`) for its entire
history. This is **soname skew, not missing functionality** - there is no package to install and
there never will be - so the Ubuntu libraries are vendored into `/opt/pw-webkit-compat/lib` from
pinned, sha256-checked `.deb`s and registered through `/etc/ld.so.conf.d/`.

**The fifth is `libx264.so`, and it is a different problem wearing the same coat.** Nothing links
it: measured, no file in the webkit bundle has it as a `DT_NEEDED`, and with
`PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` webkit 26.5 launches and renders without it. It is in
webkit's **dlopen** list - literally `['libGLESv2.so.2', 'libx264.so']` in Playwright's registry -
and `validateDependenciesLinux` throws on launch when a dlopen library is absent, so the browser is
refused for a codec it has not tried to use. Fedora excludes x264 deliberately, being
patent-encumbered, and it lives only in RPM Fusion; there is no dnf name for this one and there will
not be. It is vendored rather than skipped because turning the validator off would also stop it
naming the next library that goes genuinely missing. The measured cost of not having it is one line:
`canPlayType` returns `""` for H.264 and `"probably"` for VP8.

**Its unversioned symlink is not optional.** Playwright dlopens `libx264.so` exactly, and Ubuntu
ships that name only in `libx264-dev` - the runtime package has `libx264.so.164` alone. `ldconfig`
builds soname links from the ELF and will not invent the bare one, so it is made by hand and
asserted with `test -e` rather than `ldconfig -p`, which does not list it.

**Why that is safe rather than reckless, and it is one sentence: the dynamic linker matches by
exact soname.** Nothing on Fedora asks for `.so.74` or `libjpeg.so.8`; its own consumers ask for
`.so.76`, `.so.77` and `.so.62`. Measured rather than asserted - on the built image
`libicuuc.so.77` still resolves to `/lib64` and only `libicuuc.so.74` resolves into the compat
directory. Only those four files are copied; the ICU deb also ships `libicuio`, `libicutest` and
`libicutu`, and leaving them out is what keeps the guarantee narrow enough to state.

**`ld.so.conf.d` rather than `LD_LIBRARY_PATH`**, which is the more obvious spelling and the wrong
one: `LD_LIBRARY_PATH` outranks a binary's own `DT_RUNPATH` for every process in every job step,
while `ld.so.conf` is consulted after both and can only ever satisfy a lookup that was going to
fail. It also stays out of the environment, which the smoke test asserts over `/proc/1/environ` and
which the `docker` shim passes into nested containers.

### `ldd` clean is not Playwright-clean, and the difference is worth three packages

After the twenty-six dnf names and the compat layer, `ldd` reports **no missing soname in any of
the three bundles**. Playwright's own `validateDependenciesLinux` still refused, naming `libgles2`
and `gstreamer1.0-libav` - both **dlopen** dependencies, which no `ldd` can see: WebGL, and media
decode. The same category as the `libavcodec60` that Playwright lists for Firefox with no
`lib2package` entry, which is deliberately *not* installed because Firefox launches without it and
this suite plays no video.

`libglvnd-gles`, `gstreamer1-plugins-good` and `gstreamer1-plugin-libav` are installed anyway, and
the reason is not the feature. (`gstreamer1-plugin-libav` is installed and ships `libgstlibav.so`,
and Playwright still asked for `gstreamer1.0-libav` - because that name is a **heuristic**: its
table maps the missing `libx264.so` onto it, with a source comment explaining that libav's own
library is not linked directly so x264 is used as a proxy for it. Chasing the package name rather
than the soname would have gone in a circle.) **Playwright's validator throws on launch, not just on install**, so
leaving them out means webkit does not start at all - and even where it merely warns, a framed
"Host system is missing dependencies" box on every e2e job for ever is a warning nobody reads, so
the next library that goes genuinely missing would arrive inside noise this image had chosen to
keep.

### The maintenance surface, stated because it is real

The library list is hand-maintained - `playwright install-deps` supports Debian and Ubuntu only -
and nothing on a lane re-derives it. A Playwright bump that moves WebKit's ICU forward fails as
**"WebKit will not launch"**, naming the `.so` and not this file. Two things reduce that to a
one-line fix: `bin/github-runner-smoke.sh` now **launches all three engines** and reports
Playwright's own message verbatim, so the missing soname is in the build log rather than in an e2e
job three days later; and the compat layer ends in four `ldconfig -p` assertions, so a copy that
matched nothing fails the build instead of shipping.

There was no browser assertion in that smoke test at all until this change, while the Dockerfile
comment and `docs/known-state.md` both predicted, in those words, the failure it would have caught.

### What the nightly costs this host

**It does not cost this host anything today, and that correction matters more than the sums
below.** `e2e-full.yml` is pinned to `runs-on: ubuntu-latest` on both jobs and is the one workflow
that deliberately does *not* read `vars.CI_RUNNER` - its own comment says the condition around
`--with-deps` is there "so that pointing this matrix at the self-hosted lane later is a one-line
`runs-on:` change". Everything in this section is therefore what it *would* cost, and the browser
work in `apps/github-runner/Dockerfile` is what makes that one line possible rather than what makes
it true.

**When it does move, it is the worst memory case this host is sized against.** Three jobs,
`fail-fast: false`, each with Postgres, Redis and Mailpit - so with a third lane they no longer
queue, they run *at once*. That is 8,448M of `MemoryHigh`, which is `app-ci.slice`'s `MemoryHigh`
to the megabyte, with three browsers in it. The two-lane arrangement this section used to describe
(two run, one queues, roughly twice a shard's wall clock) was gentler on memory precisely because
it was serialised.

**And its cron collides with the backup.** `e2e-full.yml` is `0 3 * * *` and `home-server-backup`
runs at 03:00 UTC, so moving the matrix onto the lanes without moving the cron would put the two
heaviest things on this host in the same slot, while restic walks the config tree. The fix is one
line of cron on their side, and 02:00 is empty.

**The browser downloads land in `home/.cache/ms-playwright`**, which a heal or a window reset keeps
and a **budget** reclaim takes - the same rule as the bun and uv caches, for the same reason. Three
engines is about 390 MB per lane, against a 20 GB budget where `home/` already measured 1,789 MB.

## Commands

```bash
systemctl --user status home-server-github-runner@1        # a lane
journalctl --user -u home-server-github-runner@1 -f
cat ~/.cache/home-server/ci-state-1                        # what it thinks it is doing
grep -H . ~/.cache/home-server/ci-state-[123]              # all three at once
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
- **`gh` present, and the two things about it that are not "is it installed"**: that it can write
  `~/.config/gh` on a rootfs the same run asserts rejects writes, and that it resolves a credential
  from `GH_TOKEN` with no login and no config file;
- **the tool cache's seed stamp matching the image's**, which is the mechanism that lets a changed
  seed reach a lane that already has one - though see below for what this leg cannot see;
- all six lane mounts writable and **not tmpfs**, asserted by filesystem type, on xfs, including
  the shared artifact store with `CI_ARTIFACT_STORE` naming it and both subtrees present;
- the rootfs rejecting a write;
- **the nested engine starting, on `overlay` and not `vfs`, and pulling an UNQUALIFIED short
  name** - which is what every `services:` block writes;
- **a detached nested container starting and running**, which is the `services:` case itself;
- egress to `api.github.com` from an `isolate=true` network;
- neither host container socket visible, `docker info` reporting the lane's own graph root, no
  `config/`, no `/mnt/media`, no `cache/conduct/`, and **no `GITHUB_RUNNER_PAT` in
  `/proc/1/environ`**.

**What the smoke test structurally CANNOT prove, restated because it has now cost twice.**
`runner()` builds a fresh lane on every invocation, so any defect that needs a lane with existing
state is invisible to it and it passes. That is how the `db.sql` split shipped with a green tick,
and on 2026-08-27 it is how the tool cache did: the seed guard keyed on existence, a fresh lane
always seeds, and the leg above passed on an image whose two deployed lanes were serving an
interpreter with no pip. The checks that can see a deployed lane are `ci.runtime_dir` and
`ci.toolcache_seed` in `bin/verify-host.sh`, and adding a leg here instead would have been the
wrong repair both times.

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

**And raising the scope alone would move the throttle rather than add headroom**: the lanes at
`MemoryHigh` sum to 8,448M, which is the slice's `MemoryHigh` to the megabyte. The pair moves
together or neither does.

**Not yet proved, and none of it can be settled from a workstation:**

- **The cause of the `api-checks` failure.** It stopped on a manual wipe and the state that was
  wiped is gone; the retry is a treatment and the reset is a bound. The sections above say so
  rather than implying otherwise. **What is now instrumented for it** is the one question none of
  the existing readings can answer - whether the mount happens at all - and the answer arrives on
  the next occurrence rather than needing a reproduction.
- **That the bound holds.** ~~Not yet exercised by a real recurrence.~~ **Proved 2026-08-26**: four
  occurrences, four heals, four next-jobs green, no human. The window itself is still unproved and
  is now known to be the wrong size to matter - it fires at 50 jobs and the three clean failures
  came at 4, 12 and 18.
- **That the sampler measures anything.** It has been tested against a stub that fails a `docker
  start` in five milliseconds, which proves it writes its baseline and survives the race; it has
  never run against the real failure, because the real failure cannot be summoned.
- **Whether `/run` at 128m is enough for a job that does something unusual with it.** It is two
  orders of magnitude above the engine's own runtime state, and the smoke test grades the ceiling
  rather than the usage, so an overrun would surface as a job failure and not as a warning.
