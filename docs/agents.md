# The agent fleet

`conduct`, the orchestrator for the autonomous coding-agent pipeline, and everything on this host
that it runs on. Written 2026-08-20, when the orchestrator first ran a real gate.

The orchestrator's own code is in `brinkflew/agents`, deployed to `/var/agents`. **This file is the
hosting**: what it runs as, what it may reach, what it writes, and the decisions that are easy to
reverse by accident.

## Three tiers, and each one is defined by what SELinux lets it reach

```
tier 0  systemd --user, unconfined_t   home-server-conduct.service   may fork podman
tier 1  container_t, uid0 -> core      conduct-runner (--rm)         the gate, and later `claude -p`
tier 2  container_t, uid0 -> core      db / redis / mailpit          stock images, no bind mounts
        container_t, uid0 -> core      windmill-{db,server,worker}   the control plane
```

**No container here may reach the podman socket**, and that single fact produces most of this
design. `container_t -> unconfined_t : unix_stream_socket connectto` is DENY under enforcing
SELinux, and it is not fixable by relabelling, because `systemd --user` for uid 1000 runs as
`unconfined_t`. The dashboard is read-only for the same reason and says so in its own unit.

Forking podman is the entirety of conduct's job, so conduct runs where the socket is: a plain
`systemd --user` unit, the `bin/collect-metrics.py` pattern, reaching services that are deliberately
unable to reach each other. **It never evaluates model output.** Everything an agent can influence
happens in tier 1.

**The arrow to Windmill is inverted for the same reason.** A host-side listener would need either a
unix socket - the same denial - or a TCP port on the bridge gateway plus a firewalld hole that
`host/butane/ucore.bu` can only add at first boot. Both spend real security to give an
internet-facing container an RPC that spawns `claude`. So `windmill-server` publishes on
`127.0.0.1:${PORT_WINDMILL_HTTP}` and **conduct polls it**. Windmill has no route to the host at all.

## What travels to the phone, and what must never

**A resume URL must never leave this host in a notification.** `ntfy.{$DOMAIN}` is deliberately
outside sign-on, because a phone app has no browser in which to complete a passkey prompt - see
`docs/networking.md`. Windmill's `jobs_u/resume/{id}/{resume_id}/{signature}` carries an HMAC
signature in the path and needs no session, so a signed resume URL in an ntfy message would make
**the ntfy credential sufficient to approve an agent's merge**.

**What travels is the link to Windmill's own approval page**, at `agents.{$DOMAIN}`, which is behind
`import protected` and therefore behind the passkey prompt. The cost is that a Pocket ID outage
blocks approvals, and that is the correct direction: an autonomous agent whose gatekeeper is down
should fail closed.

**conduct itself never needs a signed URL either**, which was found by reading the OpenAPI document
rather than assumed: `POST /w/{workspace}/jobs/flow/resume/{id}` - *"resume a job for a suspended
flow as an owner"* - resumes with an ordinary API token. An earlier note in this build recorded that
no authenticated resume endpoint existed; that was a grep that looked under `jobs_u` and at
`jobs/resume_urls` and missed the path carrying neither spelling.

## Deployment: two checkouts and one mirror, none of them alike

| What | Where | How it gets there |
|---|---|---|
| this repository | `/var/home-server` | `git pull`, anonymous HTTPS - it is public |
| conduct | `/var/agents` | `git pull` over a **read-only deploy key**, nightly at 04:50 |
| the upskald mirror | `cache/conduct/mirrors/upskald.git` | `conduct mirror`, nightly at 04:40, over a **second** read-only deploy key |
| a verified branch | `github.com/avanserv/upskald` | `conduct verify`, over a **third** deploy key, the only one that can write |

**Three GitHub credentials on this host, two of them read-only, all scoped to one repository**, and
none of them ever enters a container. `~/.ssh/agents_deploy` fetches `brinkflew/agents` into
`/var/agents`; `~/.ssh/upskald_deploy` fetches `avanserv/upskald` into the mirror;
`~/.ssh/upskald_push` pushes a verified branch and does nothing else.

**The third one is why `mirror.ssh_command()` takes a KEY and not a project.** With two keys for one
repository the dangerous confusion is not the loud one: a push authenticating with the fetch key
answers `ERROR: The key you are using is a read-only key`. Pointing the FETCH at the write key keeps
working perfectly and silently runs an unattended nightly timer on a write-capable credential. A
function that read `project["ssh_key"]` invited exactly that simplification; naming the key at the
call site does not, and `tests/test_publish.py` asserts the fetch environment never mentions the
push key.

**The mirror is not a cache, and deleting it does not simplify anything.** The obvious
simplification is to let each phase container clone the one branch it needs when it starts. Three
things stop that, and only the first is about credentials:

- **`avanserv/upskald` is private and the runner may hold no GitHub credential in any form** - not a
  token, not a `gh` login, not a `.netrc`, not a credential helper, asserted against the argv by
  `tests/test_phase.py`. A container that clones from GitHub is a container holding a credential for
  GitHub. The mirror is where that requirement was moved to the host side.
- **The base of the diff has to come from a repository the phase cannot write.** Even if the
  container could clone, conduct would still need its own host-side copy to measure against, so the
  copy is not avoidable - only duplicated.
- **One host-side copy is what pins the base.** Worktree and base come out of the same object store
  refreshed at one moment, so the sha a human approves is the sha the gate ran against. Two
  independent clones straddle a push and nothing says so.

**What was never load-bearing is the workstation.** Until 2026-08-22 the mirror arrived by rsync,
because the host had no key for that repository - and the consequence was that re-seeding it stood
in front of every verification as a step written down nowhere. The key removes that; the three
reasons above are untouched.

**`-F /dev/null`, not a second `~/.ssh/config` block, and it is the one mechanical trap here.**
That file pins `Host github.com` to `agents_deploy` with `IdentitiesOnly yes`, so a second key added
the obvious way either loses to that block or races it - and **GitHub answers a valid key for the
wrong repository with `repository not found`**, which reads as a typo in the remote URL rather than
as the wrong identity. Dropping the config file from consideration is deterministic; ordering
identities against it is not.

**A dispatch refreshes the mirror before it clones, so a phase is never running yesterday's code.**
The nightly timer is a backstop for the paths that never dispatch - not the freshness mechanism.
`prepare_worktree` fetches from GitHub, then clones, then checks out `origin/<ref>`, so the code a
phase runs is `main` as it stood the moment the phase started.

**The base is pinned on the run row at that same moment, because `verify` runs later.** It used to
read the base live out of staging, which re-fetches from the mirror on every call - so the nightly
timer, or *any other phase's dispatch refresh*, moved the base of a run that had already finished.
Two ways that hurts, and the second is the expensive one: the diff a human approves is narrower than
the diff the phase produced, since files that landed on `main` in between stop appearing; and once
`main` has advanced at all, `merge-base --is-ancestor base head` fails and a good run is refused with
*"the phase handed back history that does not build on the base it was given"* - **blaming the phase
for what the refresh did**. `verify` prefers the pin, falls back to reading live for a tree conduct
did not dispatch, and reports the move as a **finding** rather than a refusal, because the human at
the gate should know `main` shifted under it.

**The refresh runs at `prepare_worktree` and deliberately NOT inside `verify`.** Refreshing at
verification time looks like the obvious improvement on a 72-hour refusal and is a bug: `main`
advancing after the phase branched makes `merge-base --is-ancestor base head` fail, so a fresher
base turns a good run into *"the phase handed back history that does not build on the base it was
given"*. `conduct/verify.py`'s 72-hour refusal stays as the backstop for the timer having stopped,
and `agents.mirror_fresh` is the detector in front of it - a mirror that quietly stopped fetching is
indistinguishable from one nobody has pushed to, so it reads `FETCH_HEAD`'s mtime, which the fetch
writes for free.

**Two bare repositories, and they stay two.** `mirrors/` holds upstream refs; `staging/` holds
`refs/conduct/runs/<run-id>` and is the only thing conduct pushes into. Collapsing them once conduct
controls the refspec is tempting and the three reasons in `conduct/staging.py` do dissolve - but a
fourth does not: `git clone --local` copies **every** ref, so one repository would hand every future
worktree every prior phase's commits, growing without bound.

**The mirror lives under the fleet root because of SELinux.** `chcon -R -t container_file_t` was
applied to `cache/conduct` once and new files inherit the type from their parent, so an rsynced
mirror and every worktree cloned from it come out readable by a container at no per-start cost.
Anywhere else under `/var` is `var_t` and every phase fails with a permission error naming SELinux
nowhere. **The label is not durable** - a `restorecon -R /var` or a relabelling reboot silently
resets it - and `agents.fleet_root_label` is the only thing that would say so.

**conduct is stdlib-only and has no virtualenv**, which is a constraint rather than a preference.
`/usr` here is read-only, every layered package makes the next rebase slower and able to fail on
dependency solving, and there is no `uv` on this host. `bin/collect-metrics.py`,
`bin/search-missing.py` and `bin/promote-transcoded.py` all hold the same line. It also keeps
`agents.checkout_drift` honest: that check counts **untracked** files, so a `.venv` in `/var/agents`
would be a permanent WARN whose message - *"the orchestrator running is not the orchestrator in
git"* - would be false.

## A phase, and the negatives that are the containment

```
podman network create --opt isolate=true net-conduct-<id>
podman run -d <id>-{db,redis,mailpit}    --network-alias db|redis|mailpit
                                          --no-healthcheck  --label io.home-server.ephemeral
                                          --cgroup-parent=app-agents.slice
git clone --local --no-hardlinks mirrors/<project>.git worktrees/<id>
systemd-run --user --scope --collect --slice=app-agents.slice -p MemoryMax=3G -p TasksMax=1024
            -p RuntimeMaxSec=5400 -- nice -n 10 podman run --rm --cgroups=split --cap-drop=ALL
            --read-only --network net-conduct-<id> ... conduct-runner:latest
```

Five of those are not obvious, and each was measured rather than reasoned about:

- **`--network-alias`, not just `--name`.** The gate addresses its datastores by the bare names its
  compose file uses. A container named `<id>-db` answers to `<id>-db` and to nothing else, so
  without the alias every connection fails on a name that does not resolve, in a namespace that
  never loads the file those names come from.
- **`--no-healthcheck` is the cheapest containment here.** Three checks read the health *state* of
  whatever `podman ps` returns, and each misreads a fleet container that inherited a healthcheck
  from its base image: `containers.healthy` FAILs, which blocks `bin/reboot-host.sh` and so stops an
  OS security update; `containers.probe_binaries` WARNs and pages; `logs.healthcheck_events` reports
  a setting in force as not in force. One flag closes all three at the source. Readiness is asked
  for with `podman exec` instead - which also keeps these out of `home_server_container_health`
  entirely, so the critical `ContainerUnhealthy` rule cannot page for a throwaway. **Do not add
  `--health-cmd`.**
- **`--cgroups=split` for the runner, `--cgroup-parent` for the datastores**, and they are not
  interchangeable. Measured from `/proc/<pid>/cgroup`: the runner reaches `app-agents.slice` through
  its transient scope, but a detached `podman run` lands in `user.slice/libpod-<id>.scope`, outside
  the ceiling entirely. An aggregate limit with three unaccounted members underneath it is worth
  having only if it says so.
- **`nice -n 10` in front of podman, never `-p Nice=`.** `Nice=` is an exec-context property and a
  `--scope` is not started by systemd, so `systemd-run` refuses the *whole invocation* with
  `Unknown assignment: Nice=10`.
- **The runner's ceiling binds before the slice's.** 3G under the slice's 4,608M, because a cgroup
  OOM picks its victim by badness across the whole subtree and rootless podman refuses to lower the
  Windmill workers' `oom_score_adj` - so with the slice binding first the kill could land on a
  worker mid-job rather than on the phase that caused it.
- **`$TMPDIR` is a disk-backed bind mount and must never go back to being a tmpfs.** This entry
  used to read *"`/tmp` is sized below the memory ceiling for the same class of reason: tmpfs pages
  are charged to the cgroup, so a larger `/tmp` turns 'No space left on device' into an OOM kill
  that names nothing."* The mechanism is right; the arithmetic was wrong twice, and on 2026-08-22 it
  cost three full gate runs. It compared **one** filesystem against **MemoryMax**, when the tmpfs
  and the processes draw on **one** budget - so the comparison is against `MemoryHigh` minus the
  working set - and there are **two** tmpfs mounts, because `--shm-size` is one as well. 2g of
  `/tmp` plus 1g of `/dev/shm` was 3G of filesystem inside a 3G hard limit.
  **What that produced was quieter than the OOM kill it was avoiding**, which is the part worth
  remembering: `/tmp` is now `512m`, `TMPDIR=/scratch` is a per-run bind mount under the fleet root,
  and `bin/conduct-runner-smoke.sh` asserts the property by **filesystem type**, because a later
  simplification back to a tmpfs would keep the path and lose the point.

**What is absent is the containment**, and the list stays negative: no podman socket, no
`--privileged`, no `--security-opt label=disable`, no mount from `config/` or `/mnt/media`, and for
the `check` phase no credential of any kind - it makes no model call, so there is nothing to hand
it.

**`--security-opt label=level:s0` is NOT here and must not be added.** The premise for it was that
files in a bind mount inherit the creating container's MCS categories, so a second run gets EACCES
on what the first wrote. Measured over four containers: every file came out `container_file_t:s0`
with no categories. The categories come from `:Z`, which this design does not use. The flag would
have removed per-container MCS separation for nothing.

## The gate is not evidence, and everything else here follows from that

`upskald` carries a PR quality gate: a `PreToolUse` hook that denies `gh pr create`
unless a receipt keyed to HEAD records squash, review and `make check` as passing.
It was going to be most of the fleet's containment. **It cannot be any of it**, and
the reasons are worth stating in order because each one is invisible from the
next.

**`record` mints its own receipt.** `python3 scripts/pr_quality_gate.py record`
with no arguments writes `squash=done review=pass make_check=pass`, and nothing
anywhere cross-checks those three strings against a run that happened. It is keyed
to `head_sha` alone and never to the tree, so an edit after recording leaves it
valid. An agent does not need to defeat the gate; it can satisfy it, with one
command the ship skill already tells it to run.

**A hook fails open.** Measured against Claude Code 2.1.238, which the
documentation does not cover: a hook supplied through `--settings` whose command
does not exist lets the tool call **proceed**. So anything able to stop the hook
being found has already beaten it, and a hook can be a guardrail but never a
boundary.

**And the gate is files on the branch.** `.claude/settings.json`, the hook shim
and `scripts/pr_quality_gate.py` are all tracked, inside the writable mount, and
`make check` never looks at them. Hooks also hot-reload from disk, so the
project's own gate can be disarmed mid-session with nothing ever committed.

**So conduct believes nothing the phase produced** - not the receipt, which is
deleted rather than read, not the exit code it reports, not the gate it says it
ran. `conduct verify` runs on the host afterwards, and the gate is re-run on a
tree built from a repository the phase could not reach.

### Running git in the worktree is running the phase's code

**The sharpest finding in this design, and it applies to two calls that shipped
before any model phase existed.** A git repository's own configuration is
executable surface, and only three options are protected-config-only
(`safe.directory`, `safe.bareRepository`, `uploadpack.packObjectsHook`):

| Option | Executes on |
|---|---|
| `core.fsmonitor` | any index refresh, so `git status` |
| `core.hooksPath`, `.git/hooks/*` | checkout, commit, push |
| `diff.<driver>.textconv` | `git diff`, named from `.gitattributes` |
| `remote.<name>.url = ext::sh -c` | `git fetch` |

The worktree is mounted `:rw` **including `.git`**, so a phase can write all of
those - and `prepare_worktree` then runs `git fetch --all` and
`git checkout --force` **as `core`, on the host, outside every cgroup, network and
SELinux boundary this design has**. It does not need a model phase to reach:
`make install` runs `uv sync` and `bun install` against lockfiles the branch
controls, one postinstall is enough, and because worktrees are reused it fires
during a *later, unrelated* run with nothing in the log naming git.

`conduct/gitsafe.py` removes `.git/hooks` and `.git/info` and rewrites
`.git/config` from a template before the first git command of every run.
Rewriting the file is bounded; `git -c core.fsmonitor= -c ...` on each call is
whack-a-mole against an open-ended list where missing one entry is silent. It
also neutralises the tree-level half for free, since a `.gitattributes` naming
`filter=evil` is inert once no `filter.evil.clean` is defined.

### A diff is only as trustworthy as the ref it is measured against

`git merge-base HEAD origin/main` resolves `refs/remotes/origin/main` **in the
phase worktree**. One `git update-ref refs/remotes/origin/main HEAD` makes the
merge-base equal HEAD, empties the diff and passes every protected-path check -
while `git status` stays perfectly clean throughout, because refs are not tree
state. The first draft of the gate-file check was defeated by a command that
touched none of the files it inspects.

So the base is read from `cache/conduct/staging/<project>.git`, a bare repository
**only conduct writes**, refreshed from the mirror on every verification. Not the
mirror itself, for three reasons: it was made with `git clone --mirror`, so its
refspec is `+refs/*:refs/*` and any refresh - including the `rsync` that seeds it
- prunes anything conduct put there; a per-run ref outside `refs/heads/` also
stops `clone --local` propagating `origin/conduct/*` into every future worktree;
and making the one durable artifact on the host writable by the verification path
is the wrong direction.

### `git clone --local` hardlinks, and `git reset --hard` does not clean

Two more measured rather than reasoned about. **The clone shares inodes** -
`stat` reports `links=2` on one object file reachable from both the mirror and
the worktree - so without `--no-hardlinks` a single write inside a runner
corrupts the mirror every future worktree and every "pristine" verification tree
is built from, surfacing later as what looks like a git bug. The mirror is 13 MB.
**And `reset --hard` leaves untracked files**, of which `playwright-report/`,
`test-results/`, `web/stats*.html` and `api/htmlcov` are all gitignored - so
`git status --porcelain` never mentions them and a "clean" tree is not clean. The
verification tree is rebuilt with `rm -rf .git`, `git init`, a fetch from
staging, and `git clean -xdff` excluding only the dependency directories.

### What verify does, in order, and why the order is the design

```
0  sanitize   .git/hooks and .git/info removed, .git/config rewritten
1  clean      status --porcelain=v1 -uall, rc 0 AND empty, no rebase in progress
2  extract    fetch HEAD into staging under refs/conduct/runs/<id>, fsckObjects
              base read from staging, never from the worktree
3  sanity     base is an ancestor of head, and head is at least one commit ahead
4  diff       REFUSE refuses; FLAG and deleted tests reach the approval card
5  pristine   a tree built from staging, gate run there, THEN assert it is clean
5b base       when the gate went red: artifacts and cleanliness read out of the
              head tree FIRST, then the SAME directory rebuilt at the base and
              the gate run again, and the failing make target compared
6  publish    conduct pushes to agents/<worktree>-<head12> over a write deploy
              key; a person approves; Windmill's flow step opens a DRAFT PR
```

**Step 1 exists because a phase that committed nothing passes everything else** -
the merge-base equals HEAD, the diff is empty, the tree is clean, and a human is
asked to approve an empty pull request. **Step 5's second clean check is worth
more than step 1's**: `check-gate` runs `format` and `lint` before anything that
only reads, `api/pyproject.toml` sets `[tool.ruff] fix = true` and both frontend
`lint` scripts are `eslint . --fix`, so a tree dirty *after* a passing gate is a
tree whose committed form is not the form that passed. **It now runs after a
FAILING gate too**, because step 6 can be reached from one.

**And the phase does not run the full gate at all.** `ship` runs
`make lint type-check unit-test` to iterate; the one full run happens in the
pristine tree. That is not an economy - the phase-side gate attests nothing,
because the tree can lie, the *meaning* of `make check` is agent-controlled
through `web/package.json`, and the receipt is mintable. The phase runs checks to
iterate; verify runs them to produce evidence, and **nothing the phase reports is
read by verify**.

### Two tiers of protected path, because one would refuse every real change

`check-gate` is eight targets and almost every one leaves the Makefile
immediately. So `web/package.json`'s `"lint": "eslint . --fix"` becoming `"true"`
deletes a whole check while the Makefile - which *is* on the short list - never
changes. But refusing on `api/pyproject.toml`, which carries ruff's ignore list
and pytest's `filterwarnings`, would refuse most real work.

`REFUSE` stops a run: `.claude/**`, `.github/**`, `Makefile`, the gate script and
its test, `path_filter.py`, `playwright.config.ts`. **`FLAG` reaches the human**:
the package manifests, `pyproject.toml`, the tool configs, the lockfiles,
`scripts/**`. So does a **deleted test**, which no path list can express because
`check-gate` has no coverage step - deleting a failing test is free and green.

### The hook, and being honest about what it buys

`conduct/hooks/deny.py` is copied into the fleet root at dispatch, mounted
read-only at `/opt/conduct`, and named by a `settings.json` written beside it -
a path rather than inline JSON, because a `--settings` path that does not exist
exits 1 loudly where inline JSON that fails validation does not. Three things
were measured before it was written, because the documentation is ambiguous on
all three: **a `--settings` hook and a project hook both run** on the same
matcher; **a `deny` in `--settings` blocks** a command the project settings tried
to allow; and **a missing hook command fails open**, which is why none of this is
the boundary.

**The directory is per worktree, and that is recent.** It was one shared
`cache/conduct/policy` until 2026-08-24, which was harmless while everything in
it was per-project and identical across runs. It stopped being harmless the
moment it started carrying a **prompt**: one directory then means "phase A runs
phase B's task", silently, and this file tells you to run `conduct run` by hand
while `serve` is looping. `conduct policy` still stages the shared copy, because
`bin/conduct-runner-smoke.sh` has to have something to mount on a host where no
phase has ever run.

`permissions.deny` is the stronger half and should carry any rule expressible as
a pattern, because **it spawns no process and so cannot fail open**. The hook
covers what a pattern cannot - `PR_GATE_BYPASS` anywhere in a command, a nested
`claude` (a child process has no hooks), a write verb aimed at a `REFUSE` path.

**The Bash path rule is blunt on purpose, and it costs a false positive.** It refuses any command
*naming* a `REFUSE` path rather than trying to recognise the ones that write, because enumerating
write verbs is a losing game - `cp`, `mv`, `dd of=`, `ed`, `patch`, `git apply`, `awk -i inplace`
and `rm`, which is not a write at all - while enumerating the paths is a closed set. So `cat
Makefile` is refused. That is deliberate and should not be "fixed" by loosening the rule: reading
those files through the Read tool is unaffected, and the message says which path and why.

**It is defeated by one level of indirection and that is accepted.**
`base64 -d > /tmp/x.sh; bash /tmp/x.sh` contains no protected path and no
suspicious verb, and neither does a `package.json` script or a `conftest.py`. It
is there for drift and for the model doing the obvious thing after reading a
skill file that hands it the bypass string - which `ship/SKILL.md`, `pr/SKILL.md`
and the gate's own deny message all do. Two consequences: **verify must never
read anything the hook produced**, or the weaker layer becomes load-bearing; and
the residual - a deleted test, a `# noqa` spree, a lockfile bump - **is the
approval card's problem**, which is why `FLAG` exists at all.

**A property worth not breaking**: the runner's `HOME` is an ephemeral tmpfs, so
a fleet worktree is never a *trusted* workspace, and an untrusted workspace's
`permissions.allow` entries are ignored outright. The branch cannot widen its own
permissions even before any of this applies. Its hooks do still run, which is the
asymmetry to remember.

**The mount is asserted before any work.** `sha256sum -c /opt/conduct/SHA256SUMS`
runs ahead of the phase command and exits 78 if the policy did not arrive,
arrived stale, or arrived truncated - because the failure it would otherwise
produce is no failure at all. The prompt is covered by the same digest, so the
guard also proves it arrived intact and is *this* run's rather than the one left
behind by whatever ran last.

**And the digest is not enough on its own, which is what exit 79 is for.**
`sha256sum` proves the bytes. It cannot prove the file is still *executable*,
that its shebang resolves, that a read-only mount permits exec, or that SELinux
lets `container_t` run a `container_file_t` file - and every one of those failing
produces the same nothing as a missing mount, because the hook never runs and the
tool call proceeds. So every phase pipes an empty payload through
`/opt/conduct/deny.py` and asserts a deny before it starts. Empty stdin, because
`deny.py` already refuses it by design - *"a call we could not see"* - so the
whole preflight is one line with no JSON quoted through two layers of shell. It
runs on `check` and `probe` too, deliberately: those cost nothing and run far
more often, so a broken exec path should be found there rather than twenty
minutes into a model phase.

### The GitHub credential is two credentials, and the runner holds neither

**conduct pushes with a read/write DEPLOY KEY, not a `contents:write` token**,
and the difference is the whole argument. A deploy key has **no REST API surface
at all**: it cannot open a pull request, comment, react or apply a label, and it
can only move refs. That makes "conduct cannot publish on its own" structural
rather than a scope choice somebody could widen. It also reuses `mirror.py`'s
proved `-F /dev/null -i <key> -o IdentitiesOnly=yes` shape unchanged, and puts no
credential in `.env`, in argv or in `/proc`.

**Windmill holds `pull_requests:write` as a workspace secret**, used by the flow
step that runs *after* the human approval gate. So opening a pull request
requires the approval structurally, rather than requiring conduct to have
honoured it, and deleting one variable in a browser stops the fleet opening pull
requests while leaving everything else running. `windmill-worker` on `net-agents`
reaches `api.github.com` - measured, 200 in 112 ms - which is what makes the
split possible at all.

**What the split buys, said precisely, because the paragraph above overclaimed it
until 2026-08-22.** It is true against **tier 1** and against accident: the runner
holds neither credential and cannot reach Windmill at all. It is **not** true
against a compromised conduct. `WINDMILL_CONDUCT_TOKEN` is a workspace-owner
token - already an accepted risk here, because Windmill CE's scopes cannot express
*"may list and resume jobs and nothing else"* - so conduct can read any workspace
variable and run any job. conduct is tier 0 and trusted by construction; the
design never claimed otherwise, but that sentence did.

**And the pull-request token is wider than its name.** GitHub's fine-grained
**Pull requests: write** includes managing **labels** and creating **reviews**,
and a fine-grained PAT acts as *the user* rather than as a Bot - so
`auto-merge.yml`'s `sender.type != 'Bot'` guard does not exclude it. That token
could therefore add `merge: ready` and approve the pull request it opened.
Nothing in this design does either: the flow is rewritten from git at every
`serve` start and its publish step applies no label and posts no comment. But the
protection is that the flow is the only actor, not that the credential is
incapable, and that is an accepted risk rather than a closed hole. Narrowing it
means a GitHub App installation token minted per call, or excluding the publish
identity in `auto-merge.yml`'s own guard.

**Nothing else follows that secret into Windmill.** No policy, no protected-path
list, no gate configuration: `agents.worker_lanes` exists because a worker's tags
hot-reload from a row in that same database that the UI can edit with nothing in
`git diff`, and a security policy has exactly that shape.

## Placement: conduct must put itself in the slice

`home-server-conduct.service` carries `Slice=app-agents.slice`, so a phase the unit dispatches is
bounded. **A hand-run `conduct run` inherits the caller's cgroup** - started over ssh that is
`session-N.scope` under `user.slice` - so conduct and every podman helper it forks were bounded by
nothing, while the slice measured only the phase scope inside them. Every phase run during step 11's
verification was outside the ceiling in exactly that way.

**A process cannot simply be moved in.** Under cgroup v2 an internal node may not hold processes and
`app-agents.slice` always has children, so writing a pid into its `cgroup.procs` is not available.
`conduct run` and `conduct serve` therefore **re-exec themselves** through
`systemd-run --user --scope --collect --slice=app-agents.slice`, carrying the same
`MemoryHigh=384M`/`MemoryMax=512M` the unit does - identical rather than approximately alike. The
check is `/proc/self/cgroup`, which asserts the effect rather than a flag.

It **fails closed only where it can succeed**: if the slice has a unit file and the re-exec cannot
happen, `run` refuses; if the slice does not exist this is not the fleet host, so it warns and
continues. Refusing everywhere else would make the tool unusable on a workstation.

## The refusal cascade, and the four things that make it wrong if written the obvious way

`conduct` refuses to dispatch while the host is busy, over twelve units across **both** managers.
`conduct doctor` resolves the whole list and exits non-zero when it has drifted.

**The GPU encoder is NOT one of them, and it was until 2026-08-22.** The argument for refusing while
a transcode ran was that the media stack is the tenant with a household waiting on it - which is
true, and is not what that gate measured. **The phase runner has no GPU access at all**:
`phase.command()` passes no `--device`, no CDI reference and no `--gpus`, and `tests/test_phase.py`
asserts the whole invocation. So it refused on contention for a device the fleet cannot address,
while the resources that genuinely contend - CPU, memory and IO - are bounded by
`app-agents.slice`, which is the mechanism, and by `nice -n 10` and `CPUWeight=20`, which make the
media stack win under pressure by design.

**And it failed in aggregate, which is a lesson this repository has already paid for.** The reboot
window's encoder veto was defensible on every single refusal and cost a deployment a whole week,
because a Tdarr job runs for tens of minutes and the window was one instant. Here it was worse,
because dispatch is **continuous**: any transcode queue at all meant the fleet never started.
Measured on the first end-to-end run of the publish path - four files queued, two of them
mid-flight, and the first thing the poll loop said was that it was holding.

**It is recorded rather than gated on**, which is the answer I/O pressure already got in the same
cascade. A run that happened beside a transcode is worth knowing about - the e2e suite is
timing-sensitive and has flaked under load before - and that is a cost of one re-run rather than a
fault to refuse on. `beside: something is mid-transcode` in the journal is what connects the two
afterwards. **The reboot window's own encoder gate is untouched**, and correctly: killing a live
transcode to apply an OS image is a real cost that deserves a real refusal.

- **It has to ask the system manager too.** The cascade asked `systemctl --user` only and was blind
  to every system unit - including `rpm-ostreed-automatic`, which pulls multi-gigabyte layers and
  calls `syncfs`, and `raid-check`, a full array scrub. Neither was in any watchlist on this host,
  and staging a deployment is what the machine was doing when it stalled on 2026-08-20.
  `systemctl show` on a system unit needs no sudo.
- **A missing unit reads as idle, not as an error**, so a misspelt entry is a gate that can never
  fire. `LoadState` comes back in the same round trip and `not-found` is treated as a fault in the
  LIST. **Faults are reported and never refused on** - a wrong name must be loud without wedging the
  fleet, which would trade a blind gate for a stuck one.
- **`rpm-ostreed.service` must never be polled.** `rpm-ostree status` D-Bus-activates it, so a
  cascade watching that unit flips itself to busy on its own first poll. The `transaction` field is
  asked instead.
- **`podman-auto-update` exists as both a system and a user unit here**, and only the user timer is
  scheduled - so watching the system copy alone reads inactive for ever while images are pulled.
  Both are watched.

**I/O pressure is recorded and not gated on.** `/proc/pressure/io` is printed at dispatch and at
exit. The 2026-08-20 outage was an I/O stall so a threshold is the obvious next move, and it would
be invented: nothing here has a baseline for this host's normal. `app-agents.slice` carried exactly
that admission about `TasksMax` until a real gate run measured it at 325.

## The marker, and why it is not in `backup-state`

conduct writes `~/.cache/home-server/conduct-state`, flat `key=value`, in the shape of
`backup-state` and `metrics-state`. **Five** checks in `bin/verify-host.sh`, **fourteen** series in
`bin/collect-metrics.py` and one refusal in `bin/reboot-when-staged.sh` read it.

That sentence said "twelve checks, twenty-two series" until 2026-08-23, and both numbers were wrong
*and* described the wrong thing: fourteen checks and twenty-one series existed in the agents section,
but only four and thirteen of them read this file. `conduct/marker.py` carried the identical wrong
sentence and moved with it - the same both-halves rule, applied to a count rather than to a finding.
One more of each arrived with `agents.intake` on 2026-08-27, and both copies moved together again,
which is the only reason the number is written down rather than left to be recounted.

**It is its own file rather than a section of `backup-state`, and the reason is invisible until
somebody tidies the two together**: `bin/backup-server.sh` rewrites `backup-state` **whole** at
03:00, keeping only the keys it names, so a second writer would have its keys silently dropped every
night. `metrics-state` is the precedent for a job keeping its own.

Three asymmetries in the contract that look like mistakes and are not:

- **`heartbeat_at`** is read by the reboot gate and the collector, and **not** by the battery.
- **`last_ok_at`** is the mirror of that - the battery's freshness check, invisible to the reboot
  gate. It advances only on a *clean* cycle, so "failing since Tuesday" and "has never once run" do
  not look alike.
- **`phase_label`** is read only into a message, never as a metric label. It is the forbidden-label
  family: worktree path, branch, PR number, job id, session id.
- **`quota_window`** is the same, by the same precedent. Which of the four windows the API named is
  worth a sentence and is not worth a label dimension in a store that keeps 400 days.
- **`intake_last_why`** is the third of that family and the most obviously right one: it is a
  sentence about a *task*, unbounded and sometimes carrying a title, so a label dimensioned on it
  would mint a new series for every task the fleet ever declined. `intake_last_at` beside it is a
  stamp and is exported.

**Omitted is not zero.** A key with no value is left out entirely, because the collector drops a
sample that does not parse - so an unmeasured quota *vanishes* rather than reading as healthy, and
`agents.quota_headroom` NOTEs on the absence. `tokens_today` is written as `0` because for a phase
with no model call zero is a measurement.

**The quota keys are a status and not a percentage**, and that is a correction rather than a
preference. They were `quota_5h_pct` and `quota_week_pct`, graded against `GET /api/oauth/usage` -
which does return account-wide percentages, and which answers **403 `permission_error: OAuth token
does not meet scope requirement user:profile`** to a `claude setup-token`, the only long-lived
credential a headless server can hold. Measured from the server with the real token on 2026-08-23,
before anything was built on it. What is available instead is the API's own unified rate-limit
status on the phase's own model call - `allowed`, `allowed_warning`, `rejected`, per window, with
the epoch it clears - so the keys are `quota_status`, `quota_window`, `quota_resets_at` and
`quota_read_at`. See `conduct/quota.py`, which carries the argument in full.

**And a recorded hold expires by itself.** `quota_resets_at` is the API's own answer to when the
window comes back, so nothing here estimates staleness: `conduct` holds while the status is
`allowed_warning` or worse *and* the window has not yet rolled over, and stops holding the moment it
has. `quota_read_at` is still written, because "no model phase has run in a week" is worth being
able to see, but nothing grades it.

## Two constraints the timing creates

- **`agents.conduct_fresh` WARNs past 600 s and a phase scope allows 5,400 s.** So conduct's loop
  must never block on a phase: it dispatches and keeps cycling. An orchestrator that waited would
  raise a warning saying it was wedged through every *successful* run, and `AgentCheckWarning` fires
  at 30 minutes - inside a normal one.
- **Being killed mid-phase is a designed path, not an accident.** `bin/reboot-when-staged.sh`
  refuses while a phase is in flight but escalates past the second refusal in a morning and applies
  the update anyway. The trade is named: a killed phase costs one re-run of minutes, against another
  month on an unapplied OS image. So conduct reconciles at startup - leases, networks, containers
  and the interrupted worktree - and nothing is reaped before 7,200 s, which is
  `agents.runners_leaked`'s own threshold and is what keeps the reconciler away from the Saturday
  smoke run.

## Accepted risks, recorded rather than left implicit

- **A phase runner has unrestricted egress.** `isolate=true` blocks more than was first assumed -
  Caddy's 443 and Jellyfin's 8096 both time out from a fleet network, because reaching a published
  port at the host's LAN address DNATs into the owning container's bridge - but the internet is
  reachable, and has to be, or `bun install`, `uv sync` and `gh` do not work. The phase-2 shape is
  an egress proxy with an allowlist; `bun`, `uv`, `git` and `gh` all honour `HTTPS_PROXY`.
- **A model phase will hold a session credential** visible in `/proc/<pid>/environ` to anything the
  agent runs, including a dependency's postinstall script. That is inherent to running the CLI in a
  container; the mitigation is the egress allowlist, not the secret mechanism. **The `check` phase
  holds none**, which is why it went first.
- **Windmill's `jwt_secret` and instance passwords are readable** by any `podman exec` on this host.
  That is true of every credential here and is bounded by who can reach the host at all.

## Commands

```bash
systemctl --user status home-server-conduct            # the loop
journalctl --user -u home-server-conduct -f
/var/agents/bin/conduct status                         # the marker, the leases, today's runs
/var/agents/bin/conduct run --project upskald --phase check --ref main
/var/agents/bin/conduct run --print-command            # the invocation, running nothing
/var/agents/bin/conduct reconcile --dry-run            # what a killed phase left behind
tail -f /var/home-server/cache/conduct/logs/*.log      # a phase's own output
systemctl --user start home-server-agents-update       # pull conduct's code now
/var/agents/bin/conduct mirror                         # fetch the project mirrors now
systemctl --user start home-server-mirror-update       # the same, through its unit
/var/agents/bin/conduct flow --check                   # has the UI edited the flow?
/var/agents/bin/conduct flow                           # rewrite it from git now
```

**A loop reporting `holding: WINDMILL_CONDUCT_TOKEN is unset` is working exactly as designed and
taking no work**, which is a state worth recognising before it is diagnosed as a fault. Read the
section below before deciding conduct is idle: holding, refusing on a busy host and failing to reach
the control plane look similar in the journal and are three different things.

## Work arrives as a suspended step, which is the human gate's mechanism reused

**conduct polls the control plane; the control plane never calls conduct.** A host-side listener
would need either a unix socket - the same `container_t -> unconfined_t : unix_stream_socket
connectto` denial that stops any container reaching the podman socket - or a TCP port on the bridge
gateway plus a firewalld hole `host/butane/ucore.bu` can only add at first boot. Both spend real
containment to give an internet-facing container an RPC that spawns `claude`. So `windmill-server`
publishes on `127.0.0.1` and conduct reaches *it*: no firewalld change, no new SELinux surface, and
**`paths.ts` carries `conduct` as an outbound-only pseudo-node that may never appear as a `to`** -
which in that file is a modelling rule and here is the security property.

**A Windmill flow step suspends; conduct answers it.** One flow, `f/agents/phase`, two modules:
`await_conduct`, an `identity` step carrying nothing but a `suspend`, and `conduct_phase`, which is
what actually waits. conduct polls `GET /jobs/queue/list?suspended=true`, fetches each suspended job
with `GET /jobs_u/get/{id}`, dispatches the phase named in the flow's arguments, and answers with
`POST /jobs/flow/resume/{id}` - the authenticated endpoint, not a signed `jobs_u` URL, which exists
so a human with no login can approve from a phone and would put a bearer secret in a log line if
conduct minted one for itself.

**Two things about that had to be measured, and the OpenAPI says otherwise on both.**
`jobs/queue/list` **declares** `args` and `flow_status` on `QueuedJob` and returns them **null** -
the list is a lightweight projection, so the schema describes the type and not what the endpoint
fills. And **a `suspend` belongs to the module it precedes**: the module carrying it reads `Success`
once it has run, and the module *after* it reads `WaitingForEvents` and is what `flow_status.step`
points at. The first version of this flow put conduct's name on the module declaring the wait, so
conduct read the id of the module that was waiting, found a name it did not own, and skipped its own
work - **no error, no log line, and a job that would have suspended for its full 24-hour timeout**.
Hence two modules, named for what each one is. `current_module` matches on the type as well as the
index, because `step` alone names whichever module the flow is at rather than one anybody is waiting
on.

Two properties fall out of using suspend, and both are load-bearing:

- **Refusing costs nothing.** A busy host means the step stays suspended and the next cycle picks it
  up. No queue of conduct's own, no work lost, and the refusal cascade can stay as blunt as it is.
- **The address is structural.** Whether a suspended step is conduct's or a human's is decided by
  the **module id**, which comes from the flow definition in git - not from a payload the step
  computed, which a step could get wrong. **conduct never answers a step it does not own**, because
  a conduct that answers approval steps is a conduct that approves its own gate. `tests/test_poll.py`
  asserts it, and that assertion fails the moment the prefix guard is removed.

**The answer is written to the database before it is delivered, never after.** A phase that
succeeded and then could not be reported - `windmill-server` restarting, the token revoked, the
network gone - is twenty minutes already spent, and rediscovering the same suspended step next cycle
would spend it again. A row in `dispatch` with a payload and no `resumed_at` means **retry the
resume and never the phase**. A crash *during* a phase is the opposite case and needs nothing new:
no row was written, the step is still suspended, and the reconciler reclaims the lease, the network,
the containers and the tree - which the reboot window's escalation already requires.

**An unset token holds; a refused one fails the cycle.** That is the *"not-configured and
configured-but-broken must differ"* rule the `pg_dumpall` leg already follows: with no
`WINDMILL_CONDUCT_TOKEN` conduct says so once a cycle and leaves `last_ok_at` advancing, because a
rollout that has not finished must not look like a fault. A **401** does the reverse and stalls the
heartbeat, because a revoked token is a fleet that has stopped taking work while every container is
healthy, every unit is active and nothing else would ever say so. `agents.conduct_fresh`'s 600 s is
far longer than a `windmill-server` restart, which is the only benign cause.

**The flow is rewritten from git at every `serve` start.** A flow is a row in Postgres that the UI
can edit with nothing in `git diff` - the exact shape `agents.worker_lanes` exists to watch - so
`conduct/flows/phase.py` is the source of truth and drift is self-healing rather than merely
detected. That costs no new check and no new metric, and it means a UI edit survives until the next
restart and no longer: the same bargain `.env` already makes. `conduct flow --check` says what a
restart would change - **after stripping Windmill's own additions by name**, because it resolves a
dependency lock into every `rawscript` module and a byte comparison therefore never matches. By name
rather than by "git's keys must match and the server may add anything", since that would also accept
a `retry:` or a `cache_ttl:` somebody added in the UI, which is the drift the check is for.

**`agents.approvals_pending` counts conduct's suspended steps as well as a human's**, and cannot
separate them in SQL - both are `suspend > 0` on the same mechanism. It is left counting both, and
its message says so: conduct claims its own within one 60s poll, so anything old enough to reach the
12-hour threshold is genuinely stuck whoever it was waiting on, which is the finding either way.

**The token is a workspace-owner token, and that is an accepted risk rather than an oversight.**
Windmill CE's scopes do not express *"may list and resume jobs and nothing else"*. What bounds it is
that `windmill-server` is on loopback, so the token is usable only from this host - and deleting it
in the UI is a browser-reachable kill switch for the fleet's ability to take work at all.

**The verify lane stopped being the semaphore when the arrow inverted**, and that is worth recording
because the quadlet still says otherwise. `windmill-worker-verify` was built as the *one verify at a
time* mechanism, on the source design where Windmill dispatched. Under polling, **conduct's
one-lease-per-project is the semaphore** - a suspended step occupies no worker at all - so the lane
is bookkeeping and spare capacity rather than a limit. See the last item under *what is deliberately
not built yet* for why the `verify` tag was **not** added to make it routable.

## The publish path, and the two live defects finishing it exposed

**Six modules, three suspends, and only two of them are conduct's** - *as this flow shipped*.
`f/agents/ship` is the whole chain; `f/agents/phase` stays what it was, two modules that run one
gate and report. Two linear flows rather than one with a conditional, because the `phase` argument
selects the *command a phase runs* and not whether the flow publishes - a `check` run through the
long chain would refuse at `conduct_verify` for the right reason and read as a fault.

```
0  await_conduct   identity, suspend      runs, Success, then the flow suspends
1  conduct_phase   rawscript              <- WaitingForEvents. conduct answers.
2  await_verify    identity, suspend      runs, Success, then the flow suspends
3  conduct_verify  rawscript              <- WaitingForEvents. conduct answers.
4  await_human     rawscript -> the card, suspend
5  publish_pr      rawscript              <- WaitingForEvents. A PERSON answers.
```

**THAT DIAGRAM IS THE HISTORICAL ONE AND `f/agents/ship` NOW HAS FOURTEEN MODULES.** The round added
the plan, dev, review and squash steps and the retry module; autonomous publish added `publish_auto`.
The current list is in *The round* below and in `conduct/flows/ship.py`, which is the only copy that
cannot go stale. This block is kept because the argument above it - two linear flows rather than one
conditional - is still the reason there are two, and because a reader who stops here should be told
they are looking at 2026-08-22 rather than left to infer it. Corrected 2026-08-27, having been the
wrong flow in this file for five days.

**`publish_pr` is deliberately not prefixed**, and that one string is what stands between conduct
and its own approval. So the guard lives in `poll._resume`, where it is a property of resuming
rather than of one call site. `self_approval_disabled` is deliberately absent: the workspace has one
seat, so it would deadlock every run a person starts by hand.

**There was a second lock, and on 2026-08-29 it was deliberately removed.** `user_auth_required:
true` on `await_human` made the owner resume endpoint fail as *"Approvals for logged in users is an
enterprise only feature"* - measured 2026-08-27, correcting an earlier draft of this paragraph that
claimed an owner token "satisfies it perfectly" - so conduct was unable to answer the human gate by
a mechanism underneath the prefix guard entirely.

**It also blocked the only mechanism by which the DASHBOARD could answer**, and reading the card
somewhere it cannot be answered is half a feature. The board now renders the full card and posts to
`/api/approve/*`, which starts `f/agents/approve`. So the prefix refusal in `poll._resume` is now
**the only thing keeping conduct off its own gate** - which is what `conduct/flows/ship.py` said to
rely on all along: *"The lock above is Windmill's and could change under an edition; that one is
ours and is asserted in tests."* Those tests are consequently run inverted before they are trusted:
break the guard and exactly two go red, `test_resuming_a_module_conduct_does_not_own_raises` and the
negative control `test_the_retry_loop_cannot_deliver_a_human_gate_answer`.

**The new flow carries the mirror of that refusal, and without it this would be a hole.**
`f/agents/approve` reads the target job and refuses unless the step waiting on it is `HUMAN_MODULE`.
conduct answers `conduct_*` and nothing else; the dashboard answers `publish_pr` and nothing else;
both read the name from `conduct/flows/common.py` so they cannot drift into being able to do each
other's job. Without that clause the route would be a way for a browser to forge a verification
result - a hazard this design did not previously have - and `tests/test_approve.py` proves the point
by removing the clause and watching a `conduct_verify` job get answered.

**What was given up, stated rather than implied.** A signed resume URL that escaped would now be
sufficient where before it still needed a session. Nothing in either repository mints one, three
layers refuse to carry one and three tests assert it - but that is now the whole of the defence
rather than the outer of two. And the approval record still cannot name a person: the route injects
one token server-side and the owner endpoint records `resume_id: 0`, which is the same limit
`control.py` already carries for every command the dashboard sends.

**A REPORT IS A VALUE, NOT A STATUS**, and this shipped wrong in the polling round. `conduct_phase`'s
body was `def main(report: dict): return report`, so a payload saying `{"ok": false, "exit_code": 1}`
is a module that **succeeded** - nothing raises, and Windmill records the whole flow green. A failed
gate has looked like a successful flow since the transport landed. Harmless while the flow was two
modules long; the moment a verification and an approval sit behind it, a failed phase would flow
straight into twenty minutes of verifying a tree that had already lost and then ask somebody to
approve it. Both conduct modules **raise** on `ok: false` now. Raising rather than `stop_after_if`,
because a stopped flow is recorded *successful* and a failed gate is not a success.

### The branch carries the head sha, and that is not cosmetic

The obvious name is `agents/<worktree-id>`. A worktree id is deliberately **reused** between runs -
it is what holds the `node_modules` that make the gate minutes rather than half an hour - so one
branch would carry every run that project ever does. The failure is not the obvious one: run N+1
force-pushes while run N's approval is still suspended, **a person approves a card describing run N,
and the pull request opens on run N+1's commit.** Every check passes and nothing anywhere notices.

`agents/<worktree-id>-<head12>` is immutable, so the sha on the card **is** the sha in the pull
request by construction. There is no `--force` and therefore nothing to lease, git's own
non-fast-forward rejection is the guard, and a re-push of the same head is `Everything up-to-date` -
which is the correct answer to running verify twice. The cost is branch litter: a declined or
timed-out approval leaves a branch, nothing reaps it, and that is accepted rather than undecided -
the namespace is conduct's alone, a ref costs nothing, it is evidence afterwards, and
`delete_branch_on_merge` is on for the ones that land.

**One guard is the entire boundary, measured rather than assumed.** `main` is **not** branch
protected on `avanserv/upskald` - `GET .../branches/main/protection` answers 404 - and GitHub has no
ref-scoped deploy key, so nothing on the far side refuses a push to the default branch. What refuses
it is the name check in `conduct/publish.py`, which is why the prefix must be non-empty and end in
`/` (an empty one passes `startswith` against everything, and would have turned the boundary into a
no-op with every other test still passing) and why the computed name goes through
`git check-ref-format` rather than a second regex - `poll.WORKTREE_RE` admits `.`, so `a..b` is a
legal worktree id and an illegal ref component, and git owns that question.

### What a person sees, and the four ways it would have arrived as nothing

The card is rendered **once**, in `conduct/card.py`, and shown in two places: the full markdown
version is `await_human`'s result, sitting directly above the approve button, and a plain-text
summary goes to the phone. Four things about ntfy force that split, and each fails by delivering
nothing while everything exits 0:

- **It is not markdown.** ntfy renders markdown in its web app only; the Android and iOS apps show
  the source, so a formatted card arrives as a page of asterisks.
- **`X-Message` cannot carry a newline**, so the message travels as a JSON body and the link travels
  in `click` rather than in the text.
- **The default message limit is 4096 bytes** and an oversized one is answered with a 400, so the
  summary is truncated to a budget and says that it was.
- **A once-ever notification is lost for ever.** ntfy caches for **12 hours** and the human gate
  waits **seven days**, so a phone that was off for thirteen hours would never see the card, the
  gate would time out, and nothing would go red. The notice repeats every six hours while the step
  is still suspended, and closes when it is not. It is the only thing here that repeats itself.

**It is sent at answer time, not from a second discovery pass.** conduct knows a human gate is next
at the instant it answers `conduct_verify` - it has the card in its hand - so sending there dedups on
a key it already owns, needs no second `jobs_u/get` to dig the card out of a child job's result, and
**cannot notify about an unrelated flow somebody wrote in the UI**, because a notice exists only for
a gate conduct created. The six-hourly re-send needs no Windmill read beyond the suspended-id list
the cycle already fetches, and it runs **before** the dispatch pass: both `return`s in the dispatch
loop cut it short, and a phase would otherwise block a notification for twenty minutes.

**A refusal is notified too**, with no approval link. Not symmetry - an errored flow is otherwise
completely silent: there is no suspend, so `agents.approvals_pending` cannot see it, and the only
other record is a journal line nobody is reading.

**The connection is forced to Caddy on this host** while the URL, the TLS name and the Host header
stay public, so the certificate verifies normally. ntfy is on `net-metrics` and publishes no host
port, so a host-side publisher has to come in through the front door - and going out to the WAN to
do it would put DNS, DuckDNS, the WAN address, the router's hairpin and the ISP into the path of the
fleet's only notification, **none of which the hourly battery looks at**: `routes.ntfy` is behind
`--routes`, which is opt-in and run by hand. Measured: 28 ms forced against 178 ms round the houses,
both 200.

**A broken notifier never fails a cycle**, and it needs no signal of its own - which is worth saying
because the instinct is to add one. ntfy being down is already measured twice, by `routes.ntfy` and
`metrics.alert_bridge`. What those cannot see is conduct's own password being wrong, and the backstop
for that is already built: `agents.approvals_pending` WARNs at twelve hours and `AgentCheckWarning`
pages at twelve and a half **through Alertmanager's own ntfy account**, so a bad password here still
reaches the phone by a different credential within half a day.

### The two live defects this exposed, both of them from the polling round

**A phase killed mid-run wedged its own step for ever.** `poll.py` opens the `dispatch` row *before*
it dispatches, so a SIGKILL mid-phase left a row with a NULL payload: the retry pass skipped it
because it has no payload, and the discovery pass skipped it because a row exists at all. The lease,
the network, the containers and the tree were all reclaimed and the flow step stayed suspended for
its whole 24-hour timeout with nobody owning it, while `agents.approvals_pending` blamed a person at
twelve hours. **Being killed mid-phase is a designed path** - the reboot window escalates past its
second refusal - so this was reachable every Sunday morning, and `state.py`'s own comment asserted
the opposite in as many words: *"A crash DURING a phase is the opposite case and needs nothing: no
row was written"*. The reconciler clears the row now, bounded by `REAP_AFTER_SEC` so a live phase's
row - which exists for its whole duration - is never touched.

**The resume retry loop had no prefix guard.** The rule that conduct never answers a human's gate
existed exactly once, on the discovery path; the retry loop resumed every row `dispatch_unresumed`
returned with no check on `module_id` at all. Nothing could put a human-gate row in that table, so it
was safe by accident rather than by construction - and one plausible way of recording a sent
notification, a `dispatch` row keyed `(job_id, "publish_pr")`, would have made the next cycle
**approve the gate and open the pull request**. That is why the notice has its own table, and why the
guard is now inside `poll._resume` with a test that plants exactly that row and asserts the cycle
raises.

### Proving it without a model, and why a planted commit could not

`prepare_worktree` resolves `origin/<ref>` and does `checkout --force --detach` then `reset --hard`,
so a commit planted by hand in a worktree is **orphaned before the phase starts**. A planted-commit
proof of the chain would reach `conduct_verify`, refuse *"the phase committed nothing"*, and
demonstrate only the refusal.

So the descriptor carries a **`probe` phase** whose command is `git commit --allow-empty`. It makes
no model call and holds no credential, its diff is empty so nothing is refused or flagged, and the
gate then runs on a tree byte-identical to a known-green base - which passes because the code is
good rather than because anything was skipped. `rev-list --count` sees 1, which is what the
"committed nothing" refusal keys on. One gate run, zero quota, and the whole chain from phase to
draft pull request is exercised end to end.

## The phase with a task in it

**`ship` was a deterministic gate run until 2026-08-24, wearing the name of the thing it stood in
for.** Its command was `make install && make lint type-check unit-test`. Those targets have not gone
away so much as moved inside: the model runs them now, as often as it needs, to iterate. The
argument that makes that safe is the one the descriptor always carried - **the phase-side gate
attests nothing**, because the tree can lie and the meaning of `make check` is agent-editable
through `web/package.json`, so running it in the phase buys iteration and running it once in
conduct's pristine tree buys evidence.

**There was no route by which work could arrive.** The flow schema carried `project`, `phase`,
`worktree` and `ref` and nothing else, and `poll.envelope` read exactly those four. A fifth field
now carries the task, from the Windmill run form or from `conduct run --task-file`, into `prompt.md`
in the phase's own policy directory - which means it is hashed into `SHA256SUMS` and the guard that
was already at the head of every phase proves the phase is running **this** run's task and not the
one left behind by whatever ran last.

**Which phases take a task is the template's own question, and there is deliberately no list.**
`phase.needs_task` reads `conduct/prompts/<phase>.md` for `{{TASK}}`. A second list naming them
would drift in the silent direction - a phase added to `prompts/` and forgotten in the list gets
dispatched with an unsubstituted marker in front of the model - and `hello`, which has a prompt and
takes no task, is exactly the case such a list would have got wrong first.

**It refuses in both directions, and the second one is why it is code.** A template wanting a task
and given none is loud however it is handled: the model reads `{{TASK}}` and says so. A task given
to a phase that cannot read it is **silent** - the run proceeds, the model never sees the work, and
the only evidence is an expensive transcript of it doing something else. It is refused in
`poll.envelope` as well as in `stage_policy`, which is not belt and braces: without the first one a
ship step dispatches, spends fifteen minutes on `make install`, and discovers the missing task at
the most expensive moment available.

### The fleet had no git identity, and a model's first commit would have failed

`/usr` is read-only so there is no system config, the runner's `HOME` is an ephemeral tmpfs so there
is no global one, and a repo-local config would write into the very tree `conduct/verify.py` judges.
So `git commit` would have failed with *"Please tell me who you are"* - after every minute of the
work was already spent, and with the whole run lost, because verify refuses a phase that committed
nothing. `probe` never surfaced it because it sidesteps it inline with `-c user.email=`, and that
stays exactly as it is: it is the one phase that can tell a git failure apart from a model one.

**All four variables or none.** git wants the committer pair as well as the author pair, and setting
two of the four fails with the identical unhelpful message that setting none does - so a
half-configured identity is indistinguishable from no identity. `config.GIT_IDENTITY` carries them
and `phase.command` emits them **after** the descriptor's own env, because podman takes the last
`-e` for a repeated name: the order is what stops a project changing who its commits are attributed
to. `bin/conduct-runner-smoke.sh` proves the image's git accepts an identity from the environment
at all.

### An allow list, which `tests/test_policy.py` said there must never be

That assertion was right for as long as every model phase ran with `--tools ''`: nothing needed
allowing, so anything in the list could only widen. In `-p` **there is nobody to answer a prompt**,
so a call with no allow entry is simply refused - a ship phase cannot run `make` without one and
would burn its budget discovering that.

**What survives of the old rule is the part that mattered, and both halves are asserted.** Every
entry in `policy.ALLOW_BASH` names `Bash`, so nothing in it can reach a path at all - the
file-writing half is governed by `--permission-mode acceptEdits` and by the refuse-derived deny
rules. And **deny wins wherever the two overlap**, which is the CLI's own rule for PreToolUse:
`Bash(git:*)` allowed beside `Bash(git push:*)` denied resolves the safe way round.

**AND THE LIST IS NOT A BOUNDARY.** `make`, `python3`, `node` and `uv` are general-purpose
interpreters; a Makefile target runs anything and one `python3 -c` defeats every other entry. It
bounds typos and drift, and it makes an unusual command land in the result event's
`permission_denials` where it is a signal worth having. The boundary is `conduct/verify.py`, on the
host, afterwards - the same sentence `DENY_COMMAND` has always carried, and it is written into the
module because the next reader will assume otherwise.

`--permission-mode acceptEdits` is the value `hello` deliberately did not set, because `--tools ''`
made every mode indistinguishable. `acceptEdits`, `plan` and `manual` are the measured ones;
**`auto` and `dontAsk` have semantics stated nowhere**, and shipping one would be exactly the guess
the flag was deferred to avoid. `bypassPermissions` is the one mode that turns `permissions.deny`
off, `DENY_COMMAND` refuses the model for typing it, and `tests/test_model.py` asserts conduct does
not type it either.

**`--tools` names seven and omits three on purpose.** No `WebFetch` or `WebSearch`: the container
has DNS and egress, a code task does not need the web, and `hooks/deny.py` sees a Bash call and a
file write and nothing else - a fetch is outside what the in-container guardrail can observe at all.
No `Task`: subagents multiply spend under one budget ceiling and inherit a policy nothing here has
measured them against. No `NotebookEdit`: nothing in this project is a notebook.

**The accepted risk is now larger than it was and is restated rather than left where it was
written.** The model credential arrives as `--secret ...,type=env` and therefore sits in
`/proc/1/environ` inside the container - readable by anything the phase runs, which as of this
change includes arbitrary Bash rather than nothing at all. What bounds it is unchanged and is
structural: the container drops every capability, mounts a read-only rootfs, sits on its own
`isolate=true` network, holds no GitHub credential, and the token it does hold buys model calls
against a subscription that is already paying for the phase.

### The verdict carries only what git cannot measure

`--json-schema` makes the phase's final message a structure: `status` (`done`/`partial`/`blocked`),
`summary`, `reasoning`, `concerns[]`, `blocked_reason`. **The omission is the design.** Commit
count, changed files, refused and flagged paths and the test-line delta all come out of
`verify.inspect` on a repository the phase could not write, so a field here carrying any of them
would put a number a reader might believe beside a number that is actually evidence.

**`concerns` is the field this exists for.** A phase that half-did the work and said so is worth
more at an approval gate than one that claims success, and there was nowhere for it to say it -
verify reads nothing the phase reports, by design, and the card's other half is mechanical.

**It is labelled where it is read**, not in a comment: the card's section says its own account,
nothing here was verified, and the verification above read none of it. The Evidence block that
follows still says nothing the phase reported was read, which stays true and is now visibly true.

**Stored raw, parsed only on the way out.** `quota.observe` runs from a `finally` and must not
raise, so parsing there would turn a rendering problem into a lost record. A model fallback
retracts structured output - the pinned binary carries the string - so a plain-text answer is a
thing that happens: the card shows it verbatim and says the schema was not followed. **An absent
verdict renders as a line saying it is absent**, by the rule the dashboard's dead man's switch
established - hiding a missing signal hides that it is missing.

**The schema is a staged file, not an argument.** `--json-schema` takes inline JSON and no path, so
the obvious spelling puts it on conduct's own command line where `sha256sum -c` cannot see it. It is
staged as `verdict.json` and read with `$(cat)` inside the container instead, which puts it behind
the digest guard that was already there.

**`make install || exit $?` rather than `&&`.** With `&&` a failed install skips the model call,
leaves no `SessionStart` sentinel, and is therefore reported as **exit 80** - the number that means
the settings file was silently ignored. A dependency failure and a disarmed guardrail need
completely different responses and would have worn one number.

### What that list was, and why it is kept

**The quota half was the last item to fall, and what unblocked it was measuring the
thing everyone had assumed.** `conduct/quota.py` reads the API's own unified
rate-limit status out of the `rate_limit_event` that `--output-format stream-json`
emits on the phase's own model call, because `GET /api/oauth/usage` returns the
percentages this section promised for months and answers 403 to a `claude
setup-token`. See "The marker" above and `conduct/quota.py`.

**It ran to nine items, then one, and is now none.** Recorded rather than deleted, because the shape
of it is the useful part - every entry was a thing that would have failed silently:

- **The prompt's route in.** It arrives on **stdin**, `< /opt/conduct/prompt.md`, so the task text
  never becomes a shell word, never reaches argv and never appears in `/proc/<pid>/cmdline`. It is
  staged into the phase's own policy directory and hashed into `SHA256SUMS`, so the guard that was
  already there proves it arrived intact and is *this* run's.
- **The podman secret** shipped in `0dd9a9d` and reaches a phase as
  `--secret conduct-claude-token,type=env,target=CLAUDE_CODE_OAUTH_TOKEN`, on a phase in
  `model_phases` and no other.
- **`--settings` on a command line.** The file was rendered, hashed and mounted, and named by
  nothing; a model phase now names it.
- **`--setting-sources ''` and `--strict-mcp-config`**, which stop the branch loading its own hooks
  and its own MCP servers. Neither appeared in either repository.
- **The pin and `DISABLE_AUTOUPDATER`**, both in `ce4c7c6`.
- **The `settings.json` -> `deny.py` exec path**, tested in the smoke run and asserted on every
  phase as exit 79.
- **`quota.refusal()` in the two dispatch paths**, which is what actually makes the fleet hold - a
  hold in `poll.cycle` and a refusal in `conduct run`.

**Two things it did not name and should have.** `--verbose`, which is not optional: the CLI refuses
`--output-format stream-json` under `--print` without it, so a model phase would have exited before
its first request and `quota.py` would have parsed an empty log for ever. And **`--max-budget-usd`**,
the one containment this design had no form of - memory, CPU, time, network reach and filesystem are
all bounded, and nothing bounded spend.

**`conduct verify` works today and can be run by hand on any worktree**, which is deliberate: it is
the half that had to exist before there was anything to verify, so that it was written against an
adversary rather than around one.

**`verify` is still not selectable as a tag, and the polling step DECIDED NOT TO ADD IT.**
`global_settings.custom_tags` reads `["chromium"]` and there is no `worker__verify` row in `config`,
so the lane exists, is pinned by its quadlet, and nothing can route a flow step to it. That was
carried here as a problem for the polling step to solve; solving it turned out to be the wrong move.

**The lane stopped being a semaphore when the arrow inverted.** It was built as the *one verify at a
time* mechanism on a design where Windmill dispatched. Under polling, **conduct's
one-lease-per-project is the semaphore** and a suspended step occupies no worker at all - so routing
`f/agents/phase` to the verify lane would serialise nothing, and would couple every flow to one
worker being up. Adding the tag would be **runtime state in Postgres added for decoration**, which
is the exact shape `agents.worker_lanes` exists to distrust.

So the lane is spare capacity and bookkeeping, `agents.worker_lanes` keeps asserting it listens to
`verify` alone - which stays worth knowing, and stays a row in Postgres rather than the quadlet -
and the tag lands when something genuinely needs serialising at the Windmill layer rather than at
conduct's.

## The gate learns what the base was doing

**The first live `ship` run was refused for something it did not do, twice.** Run 25 produced
`e4aba978 test(api): Cover the cursor pagination primitives nothing tested` - one file, 91
insertions, clean tree, exit 0, $0.716. `conduct verify` then failed on
`e2e/tests/records/file-download.spec.ts`, which **GitHub Actions calls green on the identical base
commit**. It refused twice, and the second refusal was correct about the gate and wrong about who to
blame.

**`git log` in that worktree is the whole finding:**

```
e4aba978 test(api): Cover the cursor pagination primitives nothing tested   <- the phase's commit
e2406a4f test(e2e): Cover the file upload and download round trip           <- the BASE
```

The base commit is the one that **added** the failing test. verify ran `make check` on base+commit
and had no measurement of the base alone, so a gate that was already red could only be reported as a
change that broke it - and it was, about a pagination test that cannot reach a download suite.

### The base is measured in the same directory, which is what makes it affordable

A second gate run sounds like doubling the cost of every verification. It is not, for two reasons
that are both about *when*:

- **Only when the head gate has already failed.** A passing verification never reaches it, and a
  failing one has already spent the time and produced no usable answer.
- **The same worktree, rebuilt at the base.** `verify.pristine` takes a ref now, and
  `keep_untracked` - `node_modules`, `api/.venv` - survives `git clean -xdff`, so the second run
  pays the gate and a near no-op `make install` rather than the fifteen minutes it costs cold.
  Measured: runs 26 and 27 took 12m49s and 14m19s; a failing verification now costs about twenty.

**THAT REBUILD DESTROYS THE HEAD TREE, AND THAT ORDERING IS THE DESIGN.** Everything that has to be
read out of it is read first - the Playwright artifacts, and the after-the-gate clean check. Written
the obvious way round, both would come back empty and read as *nothing to report* rather than as
*not measured*, which is this repository's whole failure catalogue in one line.

**The clean check now runs on the failing path too**, and it is not a formality there. `check-gate`
runs `format` and `lint --fix` before anything that only reads, so a tree dirty after the gate is a
tree whose committed form is not the form that was tested - an argument that does not weaken when
the gate went red, and this path can now end in a push.

**The datastores are replaced between the two runs.** Reusing the head run's Postgres would let a
row the head run wrote decide whether the base run passes, and the whole value of the measurement is
that the two runs differ in the tree and in nothing else. `phase.setup` could not simply be called
twice - `podman.network_create` is `check=True` and raises on a network that already exists - so the
datastore half is `phase.datastores` now, and making `network_create` idempotent instead was refused
because a real collision between two worktrees is worth failing on.

### What the two runs are compared on

**The failing `make` target, which is a make convention rather than anything this project chose.**
Run 27's log ends:

```
make[1]: *** [Makefile:518: e2e-test] Error 1
make:    *** [Makefile:589: check] Error 2
```

The **first** match in file order is the innermost, because make prints one line per level as the
failure propagates outward; the outermost is always the uninformative `check`. Comparing exit codes
instead would say `2` on both sides of every comparison, and comparing test names would be a parser
per test runner - three of them here - maintained against output formats nothing in this repository
controls.

| base | head | what happens |
|---|---|---|
| green | red on X | **refuse** - "the base passes the same gate, so this is the change" |
| red on X | red on X | **publish**, with the card saying the gate proved nothing either way |
| red on X | red on Y | **refuse**, naming both |
| unmeasurable | red | **refuse**, saying which of the two questions went unanswered |

**`None` IS NOT A TARGET AND MUST NOT MATCH ANOTHER `None`.** A gate killed by the 5400s ceiling, an
OOM, or a container that never started leaves a log with no make failure line in it at all - so
`head_target == base_target` would be `True` for two runs that each died of something nobody
measured, and it would read as agreement. `dispatch.judge_base` is a pure function precisely so that
rule can be asserted without a container, a network, three datastores and twenty minutes.

**And this does not fix a flaky test.** It distinguishes a broken base from a broken change; a test
that fails on head and passes on base still refuses and still blames the phase. A retry would hide
flakes rather than find them, so there is no retry.

### Publishing something the gate did not measure

**The gate proving nothing is not the same as the change being good, and the card says so in those
words.** A run published on this path carries the loudest section on the card - `THE GATE WAS
ALREADY RED ON THE BASE` - and the Evidence block stops claiming a passing gate, which it used to do
unconditionally and which would have been false in its most important half on exactly the card where
a reader most needs it to be true. The phone's copy says it **before** the verdict, because it
changes what every line after it means.

What stands behind such a push is what always stood behind one: a person reading the card and
approving it, a **draft** pull request rather than an open one, and GitHub's own checks on the far
side - which in the case that motivated all of this are green.

**The gate's exit code stopped being the verification's outcome.** A run that published despite a
base that was already red did its job, and recording it as `failed` because `make check` exited 1
would put the fleet's own failure count out of step with what it actually did.

### The answer is remembered, keyed on the image as well as the base

`state.base_gate` is a cache of an expensive answer and never a schedule. **The runner image id is
part of the key, not a column beside it**: the toolchain, the browser and the interpreters all live
in that image and `home-server-conduct-runner-build.service` rebuilds it on a timer, so a result
measured under a different image answers a different question and no version string anywhere would
have said so. A seven-day expiry sits on top of that, because `make install` resolves from the
network, which is free to serve something different under a lockfile that did not change.

**A nightly gate run on `main` was the other shape and was not built.** It would answer the same
question unconditionally, every night, about whatever `main` was at the time - which is not
necessarily the base any given run was pinned to. On-demand-plus-cache answers it about the exact
base, for nothing on the passing path.

## Who answers which step, and the boundary that only existed in one direction

**conduct approving its own gate has been guarded since the publish path landed. A person
approving conduct's step was guarded by nothing at all.** The asymmetry was invisible until it cost
a run: on 2026-08-24, nine minutes into a gate, `await_verify` was resumed by approver `avs` with no
payload. `conduct_verify` got an empty report, raised, and the flow completed as a failure while the
verification behind it still had fifteen minutes to run.

**Windmill renders EVERY suspended step as an approval form.** conduct's own waiting steps are
suspended steps, so each one carries an Approve button - and the summary above it read:

```
declare the wait for the verification
[ Approve ]  [ Deny ]
```

Nothing there says whose step it is. **And the record cannot tell either**: conduct resumes with a
token belonging to the same account, so the approver reads `avs` whichever answered.

### Three layers, and the two that had to be measured are the two that failed

What shipped is entirely on the human's side of the screen, because that is the only side that
turned out to be reachable:

- **The summary is the warning.** Every conduct step opens `DO NOT APPROVE - conduct answers this
  itself` and says roughly how long it takes. The human gate opens `APPROVE THIS ONE`.
- **A `resume_form` removes the bare button.** With one, Windmill asks for the fields before it will
  submit. `ok` is the required field because it is exactly what conduct's report always carries, so
  the form costs conduct nothing and cannot drift from what it sends. **The human gate keeps its
  bare form deliberately** - it is the one click that should be easy, from a phone.
- **The refusal names the mistake.** `conduct did not succeed: None` blamed conduct, arrived after
  the damage and explained nothing. An empty resume and a genuine `ok: false` are told apart by
  whether `ok` is **present**, because conduct always sets it.

### Nothing on the server can separate them, and that was measured twice

The obvious fix is to make the server refuse. It cannot, and both attempts were run against a
scratch flow rather than reasoned about:

| constraint | conduct's owner resume | a person clicking Approve |
|---|---|---|
| `user_groups_required: ["conduct-only"]`, group empty | **worked**, `resume_id: 0` | **allowed**, `resume_id: 22534` |
| `self_approval_disabled: true` | **worked**, `resume_id: 0` | **allowed**, `resume_id: 50739` |

**The two paths are different endpoints and the record shows it.** conduct resumes on
`POST jobs/flow/resume/{id}` - `resumeSuspendedFlowAsOwner` - which bypasses both constraints and
records `resume_id: 0`. A UI click goes through the approval path and records a non-zero one. So a
constraint that bound the UI and not the owner endpoint would have been exactly the asymmetry
needed.

**Neither binds a workspace admin, and this workspace has one seat which is an admin.** There is no
group `avs` can be kept out of, because being an admin is enough; and `self_approval_disabled` did
not stop the account that started the run either. The only remaining route is a **separate Windmill
identity for conduct** - a service user, its own token in sops, its own way to wedge the fleet when
it expires - and that buys a guard against one accidental click. It is not worth that, and it is
written here so the next person does not spend the afternoon measuring it again.

**So the boundary stays one-directional and is now honest about it.** `poll._resume` refuses any
module id without the `conduct_` prefix, which is real enforcement in code conduct controls. The
other direction is a warning a person can override, and the cost of overriding it is now bounded
rather than silent - see the undeliverable-answer path below.

### An answer with nowhere to go must not be silence

A flow can end underneath a running phase, which is what makes the above more than a lost click.
The verification finished, pushed its branch, and then could not hand its report over:

```
cycle failed: POST jobs/flow/resume/...: 500 Error: parent flow job not found
```

**That retry loop sits at the top of `poll.cycle`, ahead of the notification sweep and the dispatch
pass, and it was unguarded** - so one dead flow job stopped the fleet taking work or sending
anything, every cycle, until `reconcile` forgot the row two hours later. The run it silenced was the
one that had just discovered the flow was dead.

- **Per-row now**, and a transient failure is left alone rather than swallowed: if the control plane
  is really down, `windmill.suspended()` two lines below fails and the cycle fails properly.
- **Terminal is asked, not matched.** `windmill.job(job_id)` returning a `CompletedJob` is a fact;
  keying on `"parent flow job not found"` would couple the decision to a line number in somebody
  else's Rust. **False on any doubt**, including on its own failure - a wrong True throws an answer
  away, a wrong False costs one retry.
- **`undeliverable_at`, not `resumed_at`.** Whether the answer was delivered is the one thing that
  table exists to know. `dispatch_forget` cannot be reused either: it carries `AND payload IS NULL`
  so that nothing can drop an answer that was computed and never handed over.
- **And it notifies, naming the branch.** conduct pushes inside verify, *before* the answer is
  delivered, so the commit is on GitHub even when the flow that asked for it is gone - and a
  notification that did not say where would read as "the run was lost".

## The loop ran, end to end, on 2026-08-24

**Everything above was built for this and none of it had ever run together.** `avanserv/upskald#249`
is a draft pull request opened by the fleet: a task typed into the Windmill run form, a model phase
that wrote and committed it, a verification on a tree the phase could not write, a person approving
on a phone, and a PR opened by a token conduct itself does not hold.

```
19:41  ship dispatched at base 6268220f78c2
19:52  exit: 0 after 665s
19:53  verify: head 53bc429883a7 (1 commit, 1 file)
20:09  base: gate failed on e2e-test at 6268220f78c2, recorded 18:36:35Z   <- cache hit
20:09  base: 6268220f78c2 fails on e2e-test too - this change did not break it
20:09  pushed: agents/upskald-ship-53bc429883a7 (created)
20:09  poll: told a person about 01a0354a (approval)
```

**The base gate is why that pull request exists.** The head gate went red, as it has on every run
against this base, and before that morning a red gate was an automatic refusal blaming the phase.
The cached base reading came from a measurement 90 minutes earlier, so the verification cost 15
minutes rather than 30.

**It took three ship runs to land one pull request, and neither wasted run was the fleet doing its
job badly.** One was lost to a person answering conduct's own suspended step; one to a phase that
backgrounded its own type-check and had no tool to read it back. Both were defects in how the fleet
was SET UP rather than in what it did - and both are in `docs/known-state.md` now, which is the only
reason they cost an evening once rather than an evening each time.

**What that run proves and what it does not.** It proves the transport, the containment, the
verification, the gate and the publish path work together on real work. It does not prove the model
is reliable at the task: the same task on three runs produced one commit needing a `type: ignore`
that the phase reported as a concern, one carrying three type errors that the phase reported as
`done`, and one that passed. **The gate told them apart, which is the entire design.**

## A phase that was given what a workstation session is given

**The fleet's first pull request was written by a phase with none of the project's
context.** It ran with `--setting-sources ''`, `--strict-mcp-config` and seven tools: none of
upskald's eleven skills, not its `CLAUDE.md`, none of the 148 memory files the workstation has
written about that codebase, and - measured on 2026-08-25 and news to everybody - **not even the
same model**. With `--model` unset the CLI takes the token's default, which a probe caught as
`claude-sonnet-5` while every workstation session was on Opus. The fleet had been running a
different model from the one its output was being judged against, and no file said so.

### The flag has three values and only one of them is safe

`--setting-sources` was measured against the pinned CLI rather than read out of the documentation,
because what it does is not what its name suggests:

| value | `CLAUDE.md` | `$HOME/.claude/skills` | the branch's `.claude/` |
|---|---|---|---|
| `''` | no | no | no |
| `user` | **yes**, from `$HOME/.claude/CLAUDE.md` | **yes** | no |
| `project` | yes, the branch's | no | **yes, and its hooks run** |

`project` is the one that must never appear. An untrusted workspace's `permissions.allow` entries
are ignored already, but its **hooks still run**, and that asymmetry is the whole reason the flag
was set to `''` in the first place.

**`user` is safe for a reason specific to this design rather than a general one.** The container's
`HOME` is an ephemeral tmpfs at `/tmp/home`, created empty by the image's entrypoint, holding
exactly what three lines of shell copy into it out of a read-only mount. There is no user
`settings.json` in the container for `user` to find.

### Everything it is given comes from the mirror, not the worktree

`phase.stage_policy` reads the skills and `CLAUDE.md` out of **conduct's mirror at the pinned base**
and stages them into `/opt/conduct/project/`, which is mounted read-only. That is the same argument
that put the policy there: **instructions a phase can rewrite mid-run are not instructions.** They
go through the same `SHA256SUMS` as everything else in that directory, so a stale or truncated skill
file is exit 78 before the phase does any work.

It forced one reordering. `stage_policy` now runs **after** `prepare_worktree` and `pinned_base`,
because it cannot read a base nothing has resolved yet. Staged earlier it would ship one run's
instructions with another run's tree, silently.

**Eight of eleven skills, and the three that are absent are absent for a reason.** `pr` opens a pull
request with a credential the container does not hold, and `next-task` and `groom-task` are nothing
but `mcp__odoo-mcp__` calls. A skill whose first instruction will be refused costs a turn and a
confused verdict.

**The project's `CLAUDE.md` and conduct's addendum are one file**, concatenated, because that is what
a workstation session actually has: one merged memory, not two documents disagreeing about which
applies. The addendum goes last so it wins, and it says so in its first paragraph. It exists because
upskald's own `CLAUDE.md` actively misleads a phase - its first section is about MCP tools, and until
the graph shipped the container had none.

### The memory is the one thing no repository can restore

148 files, about a megabyte, written continuously by workstation sessions and in no git repository
at all. `bin/sync-agent-assets.sh` rsyncs it to `$FLEET_ROOT/memory/<project>` and the phase mounts
it **read-only** - which is not tidiness. **A phase that could write to the memory would be writing
the next phase's instructions**, which is the one way an agent in this design could reach past the
end of its own run.

**The mount was not enough, and the first live run is what said so.** Every answer came back correct
and `permission_denials` said why that was luck: four of the five were `Read` and `Glob` against
`/opt/conduct/memory`. Claude Code confines those tools to the working directory, so a directory that
is mounted and not declared is one the model can see in an `ls` and cannot open - and the addendum
was telling it to read files it would then be denied. `--add-dir` is what declares it, and it is safe
here for the same reason `--mcp-config` is: what it names is conduct's, and the bind mount is `:ro`,
so a write fails at the kernel whatever the tool layer decides.

**The failure mode is silence**, because the sync is a script somebody runs rather than a timer: the
mount stays, the files stay, and they quietly describe a codebase from a month ago.
`agents.memory_age` is what makes that loud, and conduct puts the age on the approval card.

### rtk, and the signal it costs

A 9.8 MB `static-pie` binary, so the workstation's copy runs unchanged in a Debian trixie container -
measured with `file`, not assumed. It is mounted over the read-only rootfs rather than baked, so
there is no image rebuild and the phase runs byte-for-byte the same rtk the workstation does.

**Its hook was measured before it shipped**, because a `PreToolUse` hook answering `allow` bypasses
the permission system outright and `permissions.deny` is the half this design calls stronger. It
answers `updatedInput` and no decision at all, so it rewrites and never permits.

**What it costs is a signal, and that is written down rather than discovered.** `ALLOW_BASH` needs
`Bash(rtk:*)` or every rewritten command is refused - and rtk proxies arbitrary commands, so that one
entry is `Bash(*)`. Capability was never bounded by that list (one `python3 -c` saw to that), but
`permission_denials` was how the fleet learned the model had reached for something new. **Expect it
to be empty from now on, and do not read the silence as safety.**

**`deny.py` now inspects a string that is not always the string that runs.** rtk rewrites after
deny.py has looked. The rewrites are mechanical proxies of the same command so this is theoretical
rather than live, but the disclaimer at the head of `DENY_COMMAND` says it, because the boundary it
points at - `conduct/verify.py`, on the host, afterwards - is unchanged and is what actually holds.

### The knowledge graph is conduct's server, not the branch's

`--strict-mcp-config` is exactly as it was and `.mcp.json` is still in `REFUSE_DEFAULT`; what changed
is that conduct supplies **one** server, at a version conduct pinned. `uvx code-review-graph==2.3.8`,
because a floating name is a package that changes under a run with nothing in `git diff` - the same
argument the Dockerfile makes for the CLI.

It is built **once before the model call**, not per edit as the workstation does: in a container that
would be a `uvx` spawn on every `Edit`. Cold build measured at **12 seconds** and 38 MB, into a
`--data-dir` outside the worktree so `git clean -xdff` in the verification tree cannot take it.

**One data directory per WORKTREE, and the first live run is what taught that.** Per project was the
obvious economy - same repository, same commits, one build amortised - and it is wrong, because
**the graph stores absolute paths**. A graph built while the cwd was `.../worktrees/upskald-hello`
is a graph about that directory, and `code-review-graph` refuses to update it from another one,
naming a file it holds. It refuses *loudly*, which is the only reason that cost one run rather than
a fortnight of a phase navigating a different tree's code. `|| true`, because a graph that failed to build must degrade to
Grep - which is what the skills already say to do - and must never fail a phase that has not started.
**That flag did exactly what it is for and is also what made the above expensive**: the plan phase
started with no graph, fell back to reading files, and spent its whole budget doing it - 32 turns,
$2.14, no answer. A degradation that costs a run is still the right trade against a phase that
cannot start, but it is a degradation and the card now says so.

**Which is how the second thing surfaced.** A phase that hit `--max-budget-usd` exits non-zero
identically to one whose `make install` failed, and the two want completely different responses: a
ceiling to raise or a task to split, against a tree to fix. The result event has named it all along
- `error_max_budget_usd` - and nothing read it, so every model failure reached a person as a bare
exit code. `quota.why_it_stopped` translates it, and an unknown subtype is still reported: the
catalogue is a translation, never a filter.

**And on 2026-08-28 the same subtype stopped being only a sentence.** Naming the cause was still
leaving the round dead: a dev phase that crossed the ceiling by eleven cents lost twenty minutes and
everything it had committed, the round closed, and the task parked in Implementation where
`odoo.IN_PROGRESS` excludes it from every future candidate pool - so a person had to move it back by
hand. `quota.RETRYABLE_STOPS` names the two subtypes that mean **ran out** rather than **broke**,
and they now take `_repair`: the plan survives, the commits survive, and dev CONTINUES the tree it
had already written to. `error_during_execution` is deliberately not one of them - a broken CLI
gives no reason to think a second run of the same thing ends differently. **The flag is keyed on the
subtype and never on the prose**, which is written for a phone and is free to change, and
`MAX_ATTEMPTS` bounds it exactly as it bounds a red gate's repair.

**It is a new accepted risk**, recorded beside the existing one: `uvx` executes a PyPI package inside
a container that holds the model credential in `/proc/1/environ`. The version pin and the mounted
`UV_CACHE_DIR` bound it; the egress allowlist named above is what would close it.

## The plan is made by a phase that cannot write

A task used to go straight to a phase with an editor open, which is the one part of a workstation
session the fleet had not copied: the reading and the deciding happened *with* the ability to change
things, in the same twenty minutes, under the same budget.

**A separate phase rather than a subagent.** `Task` stays off `--tools` for the reason already
recorded - subagents multiply spend under one ceiling and inherit a policy nothing here has measured
them against - and a phase is the only unit this design can bound, price, place in a slice and
observe. It is also what makes "Planning" a stage with a start and an end rather than a mood.

**What it costs, measured rather than guessed.** The ceiling started at $2.00 and was not enough
twice: the second attempt ran 41 turns, read 1.7 million cached tokens and spent $2.25 without
answering - and it reached `StructuredOutput` twice before the ceiling cut it off, so the money went
on the work rather than on a loop. It is $5.00 now, against dev's $25.00. **What made it expensive
is worth knowing**: 27 shell calls against 3 uses of the knowledge graph, on a phase whose entire
advantage is the graph. The MCP server had connected and offered all 37 tools; the model reached for
grep anyway. The prompt now says which questions each answers and that running out of budget
produces nothing at all rather than a partial plan.

**It cannot write, and that is said twice on purpose.** Withholding `Write` and `Edit` is half of it;
`policy.ALLOW_BASH_READONLY` is the other half, because `cp`, `mv` and `sed -i` are a shell away from
anybody who only lost an editor. That is what makes sharing the ship worktree safe rather than merely
cheap. **It is still not a boundary** - `python3` is on the list - and what actually makes the plan
phase safe is that nothing it produces is trusted: the plan is text handed to the next phase, and
`prepare_worktree` resets the tree before that phase starts.

**The plan rides the run row, not the flow.** `quota.observe` already stores a model's final message
there, so a plan needed no column and no new plumbing - but it did need `last_verdict` to learn about
it. That function's docstring already predicted this: the filter existed "so that stays true the day
anything else writes a row between the two", and `plan` is that day. Without it, a ship phase that
died before answering would put its plan on the approval card labelled as the verdict.

Both directions of `{{PLAN}}` raise, exactly like `{{TASK}}`. A phase wanting a plan and given none
reads a literal marker and improvises; a plan given to a template with nowhere to put it is dropped
and the phase runs anyway - **that is the silent one**, and it is why this is code rather than a
convention.

## The tracker, and the one thing it must never be able to do

A flow run carries an Odoo task id. conduct reads the title and the acceptance criteria out of it,
renders them into the phase's prompt, and moves the task **Pending -> Planning -> Implementation ->
Review** as the run progresses.

**conduct is the only thing here that talks to Odoo.** The workstation reaches it through an MCP
server and a phase deliberately does not: that would put a second credential in a container that
already holds the model token in `/proc/1/environ`, and it would make moving a task something a model
decides rather than something the pipeline does.

**Never past Review, and never backwards out of it.** `odoo.move` refuses any target that is not one
of the three stages the fleet owns, and refuses to touch a task already in Review or Closed. What
happens after a review is a person's, and re-running a flow must not quietly undo it. Stages are
resolved **by name, every time** - a hardcoded id is what went stale last time.

**Two failures that look alike are treated as opposites, and the line between them is the point.**
Reading the work is not bookkeeping: a phase whose task could not be fetched has nothing to do, so
the step refuses before a container starts. Moving a task between stages *is* bookkeeping, and a
tracker that is down must never throw away twenty minutes of work that already happened - so every
stage failure becomes a line on the card and nothing else. **An unset `ODOO_URL` is a rollout rather
than a fault**, the same distinction `WINDMILL_CONDUCT_TOKEN` already draws.

**Review is moved by a pass in the poll cycle rather than by the flow.** `publish_pr` holds the only
write credential in the workspace and its whole defence is that it contains no logic worth attacking,
so an Odoo write in there would weaken the one module that has to stay boring. conduct remembers the
job in a `publication` row instead and asks Windmill whether it finished - which works on both paths,
because the flow's result carries the pull request either way. **That pass runs after the deliver
pass and guards every row on its own**: one bad row at the top of a cycle stopped the whole fleet for
two hours on 2026-08-24.

**Follow-ups are filed only once the pull request is open, capped at five.** A task invented by a run
nobody accepted is litter in somebody else's backlog, and the tracker is the one place here where
litter outlives the run that made it. They land in Backlog rather than Pending: Pending means
somebody looked at it and decided it was ready, and nothing here has done that.

## A green run opens its own pull request

Six clauses, **every one measured by conduct on a tree the phase could not write**: the descriptor's
switch, a gate that passed in the pristine tree, nothing flagged, no test file gone and no test lines
lost, no executable git state left behind, and a verdict of `done`. Fail any one and a person sees
exactly the gate they saw before, and **the card names the clause that sent it to them** - a person
being asked should not have to work out which measurement did it.

**`concerns` deliberately does not gate.** The prompt tells the model an empty list is a real answer
and an invented one is not; making an honest concern cost the run its autonomy teaches it to report
none, which destroys the one field the verdict exists for.

**A base-red run does not qualify**, and that is worth restating because it makes the feature look
inert: upskald's `main` fails `e2e-test` in this runner today, so almost nothing will publish itself
until that is fixed. The branch is still pushed and a person is still asked; all that changes is who
opens the pull request.

### `stop_after_if` is the mechanism, and it was the third one tried

Measured on a scratch flow on 2026-08-25, because the obvious answer is wrong in a way nothing warns
about:

- **`skip_if` on the human gate disables that module's `suspend` whatever the predicate evaluates
  to.** Proved with a literal `false`: the module still ran, the suspend never armed, and the flow
  went straight through to the end. A `skip_if` gate could only ever publish and never ask.
- **`skip_if` on the module that *waits* does not prevent the wait.**
- **A `branchone` does contain a suspend, but in a SUB-JOB** where the parent reads `InProgress` and
  `windmill.current_module()` returns `None` - so it would mean teaching conduct's whole discovery
  path about nesting for one conditional.

`stop_after_if` on a `publish_auto` module in front of the gate does it, drift-clean, and **nothing
about conduct's discovery changes**: the module that suspends is still `publish_pr`, still
unprefixed, still what `poll._resume` refuses to answer. The `conduct_` prefix boundary is exactly
where it was; what changed is that some runs no longer have a human step for it to guard. The cost is
two instances of the publish script, both rendered from one constant in git and told apart by a
static argument.

**The blast radius is one draft pull request.** conduct holds a deploy key with no REST surface,
`publish.push` refuses any branch outside `agents/`, the pull request is always a draft, and
upskald's auto-merge arms on a label or a `/merge` comment that this flow applies neither of. Nothing
on this path can reach `main`.

**There was a second lock, and it was spent on purpose.** `user_auth_required: true` on
`await_human` made `jobs/flow/resume` fail with *"Approvals for logged in users is an enterprise
only feature"*, so conduct was structurally unable to answer that step by a mechanism underneath the
prefix guard entirely. It was removed on 2026-08-29 because it also blocked the dashboard, which now
shows the card and answers it. **The prefix guard is the only lock now**, the approve flow carries
its mirror, and the UI path is unchanged - a person approved through it on 2026-08-24 and still can.
The full argument is above, under *Who answers which step*.

## The round: a change goes back to the plan until a reviewer has nothing left to say

The pipeline was a straight line - plan, ship, verify, publish - and `ship` did three jobs at once:
it made the change, squashed it, and wrote the pull request. So there was no moment where the change
existed, had been gated, and had not yet been tidied, which is exactly where a review belongs.
Nothing reviewed anything: `make check` cannot tell a passing suite from a good change, and the dev
phase's own `concerns` deliberately do not gate, because making a self-report gate teaches a model to
report none.

**Four phases now, and the split is the point.**

| Phase | Writes? | Budget | What it does |
|---|---|---|---|
| `plan` | no | $5.00 | reads the tree, triages the last round's findings, answers a plan |
| `dev` | yes | $25.00 | makes the change and commits it. Today's `ship`, renamed |
| `review` | **no** | $8.00 | reads the change and reports findings. Cannot fix one |
| `ship` | git only | $3.00 | squashes the run into one commit and writes the PR text |

**A reviewer that can edit fixes quietly and reports nothing**, and a review that always comes back
clean cannot be told from a real one. So `review` gets no `Write`, no `Edit` and
`policy.ALLOW_BASH_READONLY` underneath, exactly as `plan` does, and the only route from a finding to
a change is back through the planning phase.

**Three severities and only two of them cost a round.** `error` and `warning` send the change back;
`note` does not, and reaches the card and the pull request body instead. Without the third level
every observation a reviewer wanted to make would cost an hour, so it would learn to make none - the
same trap `concerns` records one schema over.

**The planning phase triages, and is told it may disagree.** `remediate` puts it in this round's
steps, `follow_up` makes it a Backlog task, `dismiss` says the reviewer was wrong and why. Dismissing
is free and deferring is the right answer more often than it feels like: a change that grows to
absorb every observation made about it stops being reviewable.

### The loop is a chain of runs, because Windmill has no way to do it inside one

Both mechanisms were measured and both are unavailable here.

- **`skip_if` cannot skip a step conduct answers.** On the module *carrying* a suspend it disables
  that suspend whatever the predicate evaluates to - proved on a scratch flow with a literal
  `false`, which ran straight through - and on the module that *waits* it does not prevent the wait.
  Neither position works.
- **A `whileloopflow` puts its body in a sub-job**, where `windmill.current_module()` reads `None`.
  That is what `branchone` was rejected for: teaching conduct's discovery path about nesting means
  editing the one function the `conduct_` prefix guard lives behind, which is the last code here
  that should grow a special case.

So the flow runs **one round and stops**, and conduct starts the next. `f/agents/ship` is fourteen
modules; `retry` sits between the review and the squash and is two lines long, because conduct
decides and the flow only carries the answer:

```
 0 await_plan     1 conduct_plan     read the tree, triage, answer a plan
 2 await_dev      3 conduct_dev      write the change
 4 await_verify   5 conduct_verify   the gate on a pristine tree, the push, the card
 6 await_review   7 conduct_review   report findings, fix nothing
 8 retry          stop_after_if results.retry.again      <- THE LOOP
 9 await_ship    10 conduct_ship     squash, and the tree assertion
11 publish_auto   stop_after_if results.publish_auto.opened
12 await_human   13 publish_pr
```

**`stop_after_if` after a resumed suspend was measured before any of this was written**, 2026-08-25,
both directions: `again` true stopped the flow at `retry` with `{"again": true}` as the flow's result
and the module below it never ran; false carried through to the end. `publish_auto` only ever proved
it after a plain rawscript, and the `skip_if` trap is exactly what "a suspend nearby changes the
meaning of the key beside it" looks like when it goes wrong.

**Exhausting the rounds is not a failure.** `again` is false once the chain has used
`config.MAX_ATTEMPTS`, so the flow carries straight on to the squash and the publish path - which is
also where a red gate the base already failed goes. A change that could not be made clean still
reaches a person, with the findings on its card. The fleet does not give up on work it has paid for.

**Three things make `again` false, and the last two matter as much as the first**: no blocking
findings; the rounds are used up; or **the head gate failed on a target the base already fails**.
`dispatch.judge_base` already tells those apart, and no round of planning can fix somebody else's
broken base - looping on it would burn every remaining round on a change that is not at fault.

**A red gate skips the review entirely**, and the skip is recorded rather than silent. Asking a model
to read a change whose tests do not pass costs $8 to be told what `make check` already said. But *a
review that ran and found nothing* and *a review that never ran* look identical from outside, and one
of them means nobody has read the change - so the payload says which, and the card has a review
section even when there is nothing in it.

**A review that did not complete neither loops nor passes.** Another round would run the same phase
against the same tree and fail the same way; carrying on silently would publish something nobody
read. It goes to a person with the autonomy withdrawn.

### The counter is conduct's, and deliberately not the flow's

The obvious place is the flow's arguments - conduct starts the next round, so it could hand itself
`attempt: 2`. **It must not.** A flow's run form is editable in a browser, so an argument is a number
anybody can reset to 1 for ever, and the bound it drives is the only thing between a review that
never comes back clean and an unbounded spend. It lives in `state.chain`, keyed on the worktree,
which the lease already guarantees holds one run at a time.

**The continuation pass sits beside `_publications` and after it**, and that order is load-bearing: a
round going back to planning stops a flow that has *already* opened a publication row, so the row has
to be closed - no pull request, nothing to move - before the next round starts, or the new round's
planning step refuses itself over its own predecessor's row.

**Clearing the marker before starting is the only ordering that cannot double-dispatch.** Clearing it
afterwards means a crash between Windmill accepting the run and the row being written starts the same
round twice: two containers, two rounds counted against a limit of two. A failed start restores the
marker, so a transient failure retries and a crash costs a round rather than duplicating one.

**A round left open is reaped after six hours**, not the eight days a publication gets. A chain is
opened by the planning step and closed when the run reaches the publish path, so one left open means
the flow died in between - and left alone it makes the *next* change on that worktree get one round
instead of two, silently.

### The worktree is prepared once per run, and that was a bug waiting to happen

`phase.prepare_worktree` does `checkout --force --detach origin/<ref>`, `reset --hard` and
`clean -xdff`. **Calling it before the review deletes the commits under review**, and calling it
before round two's dev phase throws away the work the plan has just triaged rather than remediating
it. Neither failure raises: the phase runs happily on a clean checkout of `main` and answers "no
findings" or "nothing to do", which is the most convincing wrong answer available.

Two descriptor tuples, because what each drives is a refusal:

- **`continues`** - `dev`, `review`, `ship` - get `phase.continue_worktree`, which sanitizes the git
  config and touches nothing else. The sanitize still runs, and it is the one thing that must: a
  previous phase in this same tree could have written `.git/config`, and `core.fsmonitor`,
  `core.hooksPath`, a `textconv` filter and `remote.url = ext::sh -c` all exec from a repository's
  own configuration.
- **`needs_commits`** - `review`, `ship` - additionally *refuse* a tree with nothing on it. `dev` is
  deliberately absent: on the first round it legitimately starts from an empty tree, and refusing
  there would mean no change could ever be written.

**A continuing phase inherits the base pin rather than taking one.** `pinned_base` reads the mirror,
which `prepare_worktree` refreshed - and a phase that did not prepare did not refresh, so asking
again would hand the review or the squash a base newer than the change was written against. That is
the bug the pin on the run row already exists to prevent, one phase later.

**The planning phase is the one exception and cannot be a tuple.** Round one prepares - it is the
first step, and preparing is what gives the whole round a clean base and one pinned commit. Round two
must not, or it resets away the very commits it is triaging findings about.

### The squash happens after the gate, and the gate still holds

Everything the verification measured was measured against a commit the ship phase is about to
destroy, because a squash rewrites history. Re-running the gate afterwards costs another 15-30
minutes to learn nothing; skipping the question means publishing a commit nothing looked at.

**The tree is what survives.** A commit is a tree plus a history; a squash keeps the tree and throws
the history away. So `conduct_verify` records `tree_sha`, and conduct fetches the squashed commit into
its own staging repository and refuses unless the tree behind it is byte-identical. **A squash that
changes the tree is not a squash.** One `rev-parse`, in a repository the phase cannot write.

**Nothing on that path can lose a change.** The verification already pushed the un-squashed commits
and already built the card, so every failure here degrades to "a person looks at it": the report keeps
pointing at the commit that was actually verified, autopublish is withdrawn, and the reason leads the
card. A tidy-up phase must not be able to throw away an hour of verified work.

**The report does not travel through the flow.** conduct's handlers see the flow's *arguments* and
never its results, so the ship step reads what the verification measured out of `state.report` - the
same rule that already keeps an 8 KB plan off a job argument.

### The branch has a name a person can read

`agents/<type>/<odoo-task>-<slug>`, so `agents/fix/1572-file-download-spec`. The type and the slug
come from the plan - the only phase that has read the task and the tree and written nothing - the
task id comes from the flow's arguments, and the prefix comes from the descriptor. **The `agents/`
prefix is unchanged and is still the whole boundary**: `main` is not branch protected on the remote,
measured 2026-08-22, and a deploy key has no ref scoping, so `publish.branch_name` refusing anything
outside that namespace is the only thing between conduct's write key and the default branch. An
unknown change type becomes `chore` rather than a refusal, because a branch name is not worth losing
an hour of verified work over.

**Dropping the head sha from the name gives back a hazard it closed**, and `publish.py` says what it
was: a stable branch means run N+1 can move the ref while run N's approval is suspended, so a person
approves the card for run N and the pull request opens on run N+1's commit with every check passing.
Two guards replace it, neither of which needs GitHub API surface conduct does not already have:

1. **An open publication for the same task refuses a new run** at the planning step. That row is open
   from the moment the verification pushes until the flow ends, so the overlap window *is* its
   lifetime - and refusing there closes it before a container starts rather than at the push.
2. **Every push that could move an existing ref is leased.** `--force-with-lease` naming the sha
   conduct itself last put there is strictly stronger than the old "no force at all", because it
   names the value it expects to replace instead of relying on a name that can never repeat.

### The tracker moves with the phase, and only at four moments

| Moment | Written by | Stage |
|---|---|---|
| the flow starts | - | Pending |
| `conduct_plan` claims its lease | `_plan_step` | **Planning** |
| `conduct_dev` claims its lease | `_dev_step` | **Implementation** |
| review, squash, publish | nobody | Implementation |
| the pull request exists | the publication pass | **Review** |

Review and opening the pull request are both Implementation, so the only two moves inside a round are
the two at the top - and **a change that goes back to the plan goes visibly back to Planning**, which
is a true statement about where the work is. **Review is entered when a pull request exists and never
before**, written by the publication pass, which is the only thing that ever learns one was opened -
and never by `publish_pr`, which holds the one write credential in the workspace and must keep
containing no logic worth attacking. Nothing ever moves past Review.

**IT IS ALSO THE ONLY THING THAT WRITES THE PULL REQUEST DOWN, AND FOR A LONG TIME IT DID NOT.** The
pass read `result["url"]` off the finished flow, moved the tracker and posted a chatter note - and
then dropped it, so **a sentence in Odoo was the only durable record that this fleet had ever opened
a pull request**. Nothing on the host could answer which PR a round produced. `publication` carries
`pr_url` and `pr_number` now, and three details of that shape are load-bearing:

- **Both arguments are optional, and a closed row carrying neither is a REAL state.** The flow ended
  without opening a pull request, which is what a declined approval and a seven-day timeout both
  look like. Requiring them, or defaulting them to anything but NULL, would erase the difference
  between "it declined to publish" and "it is still waiting to".
- **`COALESCE` rather than a plain SET.** `reconcile` closes stale rows with no arguments at all,
  and this pass's own per-row guard leaves a row to be closed again next cycle if the tracker work
  raises after the url has been recorded - either would blank it on the second close.
- **The number is coerced rather than trusted.** It arrives off a REST response through Windmill's
  JSON, and SQLite stores `"249"` in an INTEGER column without complaint, after which every reader
  comparing it against an int loses.

Migrated on `pragma_table_info` and not on the exception a first UPDATE would raise, which is the
trap already on record two sections down.

**A tracker outage must never throw away work that already happened**, and the rule needed one more
clause for this. Reading the work still *refuses* the planning and dev steps: a phase whose task
cannot be fetched has nothing to do. By the review and the squash the commits exist and the gate has
passed on them, so those steps fall back to the task text conduct recorded on the run row when it
dispatched the phase that did the work, and say so.

**Follow-ups are merged from two phases, checked against the tracker, and filed once.** The plan's
triage and the dev phase's verdict both name follow-ups, and both are looking at the same findings -
so they are deduplicated against each other by word set, then against every open task in the project,
then capped at five, and filed only after a pull request exists. A declined run still files nothing.
**The cap applies to what survives the dedup**, not to what was asked for.

### What the reviewing phase is allowed to run, and the one command that lies

`ALLOW_BASH_READONLY` had **no git at all**. The line was drawn at "no git" on an argument about
`git checkout` and `git stash` moving the tree - which is about those verbs rather than about git -
and it cost nothing while the only read-only phase was `plan`, which reads source rather than
history. **The reviewing phase's first instruction is `git diff <base>...HEAD`**, so a list without
these would have denied the first command in its own prompt, and the phase would have fallen back to
reading files it was never told to read.

Named read-only verbs now - `log`, `diff`, `show`, `status`, `blame`, `shortlog`, `rev-list`,
`rev-parse`, `merge-base`, `ls-files`, `cat-file`, `grep`, `describe` - two words each, because
`Bash(git:*)` is the whole of git and the point is that this is not. `checkout`, `switch`,
`restore`, `reset`, `clean`, `stash`, `apply`, `add`, `commit`, `rebase` and `merge` are absent, and
`git push` is refused outright by `DENY_BASH` for both lists.

**And `rtk proxy git diff`, never `git diff`.** Every command a model phase runs is rewritten into
`rtk <command>`, which summarises output to save tokens - so a review told to run `git diff` reads a
SUMMARY of the patch and reports findings about code it never saw. upskald's own `self-review` skill
says this in one line and the fleet's prompt did not. Nothing would have failed; the findings would
have been confident and unfounded.

**The squash phase needs `git commit -F`.** There is no terminal in the container, so a bare
`git commit` opens an editor and fails - and that phase holds no `Write` tool, so the message reaches
a file through a shell heredoc. Recoverable by retry, and a retry is a turn of a three-dollar phase
spent learning what the prompt already knew.

**The subset test had to learn that these rules are command prefixes.** It compared strings, and the
full list's `Bash(git:*)` is *wider* than the read-only list's `Bash(git log:*)` - so set difference
reported the narrower entry as "something the full one does not have".

### Two bugs the graph flag and the review found in each other

**Keying the graph build on `needs_task` made the squash phase rebuild 38 MB it never opened**, on
every publish. It is keyed on the phase's own `--mcp-config` now, which is the flag that actually
makes the server reachable - so a second list cannot disagree with it, and it disagreed silently in
both directions: a pointless build, or a phase told to reach for the graph before grep with no server
behind it.

**`review` and `ship` had to join `ANSWERS_TO_A_TASK`.** Both answer on the same worktree and both
run *after* the dev phase, so both would be the newest answering row - and the approval card would
show a review object, or a squash receipt, labelled as what the phase said it did. That is the exact
failure `plan` was added to that tuple for, twice more.

## A run that failed part-way starts again from where it got to

**The first full run of the round proved the pipeline and then threw it away**: task 1266 planned,
changed, gated and cleared its base-gate comparison - forty-five minutes and about twenty dollars -
and lost the whole flow to a transient `exit 128` on the push. The push retries now, which closes
that cause and not the class.

**Almost everything expensive already survives a failed flow**, because the round was built to keep
it. The plan is on a run row. The commits are on the worktree, which a `continues` phase never
resets. The gate's report is in its own table. The review is on another run row. **The only thing
genuinely lost is the Windmill job** - a `CompletedJob` is terminal, there is no endpoint that
resumes one, and none that pretends to.

So a resume is not "restart the flow". It is **a new flow run in which conduct answers the steps its
own `chain` row records as finished**, without starting a container.

```
conduct_plan     $5   skipped when the round recorded it done
conduct_dev     $15   skipped when the round recorded it done AND HEAD still matches
conduct_verify    0   ALWAYS RUNS
conduct_review   $8   skipped when the round recorded it done
conduct_ship     $3   ALWAYS RUNS
```

**The gate is never skipped and that is the whole safety argument.** It costs no model spend, it is
what the pull request rests on, and `publish.push` lives inside it - so a run whose push failed has
nothing on the remote to open one from and must re-run it regardless. Reusing a stored report would
add the one code path in this design whose bug publishes unverified work, to save wall-clock nobody
is billed for. The three model phases are the money, and they are what a resume skips.

**Recorded, never derived.** The cheap version asks `run.result = 'ok'` - and a run row says `ok`
for a plan phase that exited 0 and answered nothing, which `_plan_step` correctly treats as a
failure. Deriving would skip a step that never produced what the next one needs, so each entry in
`chain.done` is written by the handler at the moment it decided the step had succeeded.

**Nothing skips unless a person asked.** `resume` is a flow argument with no default, so every
existing path is byte-for-byte what it was. Without the flag a re-dispatch would silently reuse a
plan the operator may have re-dispatched precisely to replace.

### Three things that would have been wrong and are not

- **`_plan_step` called `chain_open`, which counts a round.** A resume would have been counted as
  round two and left the change one round short of what it was promised. Moving the call behind the
  skip also makes the counter mean what it always should have: **planning phases actually run**.
- **`done` says a dev phase finished; it does not say its commits are still in the tree.** A
  worktree is a directory a person can reach, and the skipped alternative is publishing whatever
  happens to be sitting there - so the skip compares HEAD against what the round recorded and runs
  the phase again if it moved.
- **The review skip goes *behind* the red-gate branch.** A resumed run re-runs the gate, so it can
  come back red on a tree whose stored review was written when it was green; answering with that
  review would report on a state that no longer holds.

### One automatic attempt, and only when conduct broke

**The discriminator is structural, not a message** - the rule `publish._worth_retrying` follows one
module over. `run_verify` *returns* `rc 3` with a populated `refused` when the change is at fault,
and *raises* when conduct itself could not do its job; `cycle()` turns a raised handler into a
payload carrying `error` with `exit_code` left null.

> **`error` present, `refused` empty, `exit_code is None`** means the orchestrator broke. A red
> gate, a refused diff, a non-zero exit and a spent budget all fill one of the other two in, and an
> answer is not worth retrying: it is the same answer, more slowly.

`is None` rather than falsy, because a phase that exited 0 is a different thing entirely.

Three guards, each closing a way this could spend money on its own: **`resumed_at`** bounds it to
one attempt, so a deterministic fault stops rather than restarting for ever; **`done` must be
non-empty**, or there is nothing to skip and the "resume" is the fleet re-running a failed run from
scratch; and the marker is **cleared before the start and restored if it fails**, the same ordering
the round continuation uses and for the same reason.

**Giving up now tells somebody, and it did not.** `_note_for_a_person` fires only when a human gate
is next, so a run that died at the gate reached nobody and the only trace was one journal line - and
a person who dispatched a task and heard nothing cannot tell that from one still running.
`notify.failed` names the step, the reason and the worktree, and carries no link at all.

### `conduct ship`

There was **no way to start a flow from a terminal**: `windmill.run_flow` existed for the
continuation pass, and every hand dispatch was a written-out `python3 -c`. A command that spends
twenty dollars should be one somebody can type, read back and dry-run.

```bash
conduct ship --task 1266                  # start the publish flow for an Odoo task
conduct ship --task 1266 --resume         # ... skipping what the round already has
conduct ship --text "do the thing"        # a one-off with no tracker entry
conduct ship --task 1266 --resume --dry-run
```

`conduct status` shows what a resume would skip, so the question is answerable without opening the
database.

## The pull request follows the project's template, and used to be the approval card

`avanserv/upskald#252` opened with `## upskald verify on upskald-ship`, `### Why you are being
asked` and `### Evidence` where its description should have been. `card.pr_body()` was
`card.render()` with the log paths stripped - **one artefact serving two readers**. The card answers
*"should this be published at all"*, for one person, at one moment, beside evidence, behind a
passkey. A pull request answers *"is this right"*, for whoever reads it, possibly months later.
Neither is a draft of the other.

**The template is upskald's and the ship phase writes it.** `.claude/skills/pr` is now shipped,
having been excluded for its step 4 - `gh pr create`, which `DENY_BASH` refuses. Withholding it did
not stop the fleet writing a body; it stopped the fleet writing the *right* one, and put the
convention in a second repository. `conduct/prompts/ship.md` carries an override table:

| The skill says | Here |
|---|---|
| step 1, `detect_changes` from the knowledge graph | `rtk proxy git diff` - the ship phase loads no MCP server |
| step 2, fetch the task with `mcp__odoo-mcp__` | the task is in the prompt, in full, with its acceptance criteria |
| step 2, build the `Task:` line | conduct builds it from the id it dispatched |
| step 4, `gh pr create` | conduct opens it from the host; the phase holds no credential that could |
| "confirm the draft with the user" | there is nobody to confirm with |

That is the pattern `prompts/addendum.md` already uses for `CLAUDE.md`, and it means the project can
change its template with no change on this side.

**`SHIP_SCHEMA` carries the shape and the skill carries the convention.** A phase that ignored the
skill still cannot answer something conduct has nowhere to put: `summary`, `changes[]`, `notes` and
`verification[]` are enforced by `--json-schema`. **The acceptance criteria needed no parser** -
`odoo.prompt_text` already renders the task's description in full, and it carries them as
Given/When/Then bullets, which is the form the skill asks for. That is the whole reason this belongs
in the phase rather than in conduct.

**conduct assembles, bounds, and adds only what it alone knows**: the `Task:` link, built from the
id it dispatched rather than one a model retyped; and a compact provenance block after the footer.

```
---
Opened by the agent fleet - conduct, on brinkflew/home-server. ...
base `6268220f78c2` -> head `bed4b387a872` on `agents/feat/1266-cap-request-body-size`
**GATE: RED.** `e2e-test` fails at the base as well, so it proved nothing about this change.
Changes what the gate MEANS: `api/pyproject.toml`
Squashed to one commit, and conduct proved the tree behind it is byte-identical ...
```

**The red-gate line must never be dropped.** A draft that looks green whose gate proved nothing is
the most misleading thing this fleet can produce, and a reviewer cannot learn it any other way. The
flagged-path and deleted-test lines appear only when there is something to say.

**A fallback that is still template-shaped.** A run reaches `pr_body` without the phase's prose
whenever the squash failed, or a person approved one that never got that far. The dev verdict has a
summary, the diff has a file list, and the manual checkbox stands alone - because a pull request that
opens on those paths should still look like this project's pull requests.

**The card is unchanged.** It still builds what the Windmill gate and the phone show. The problem
was reusing it, not writing it.

### The flag that cost a pull request its own identity

git documents six `--porcelain` flags - `*` created, ` ` updated, `=` up to date, **`+` forced
update**, `-` deleted, `!` rejected - and `publish._FLAGS` listed three. `+` is unreachable until
something pushes with `--force`, so it did not exist here until the leased re-push landed, and the
table was not revisited on the day the flag became possible.

Measured on #252: the squash rewrote two commits into one, **the push succeeded** and force-updated
the branch to `bed4b387`, and `_status` raised `git refused the push` on the `+`. conduct took its
own withdraw path, so the pull request opened describing `09c2968f` - a commit the branch no longer
held - with a compare link to the wrong sha, the pre-squash commit's subject as its title, and an
error that never happened at the top of the reasons a person was being asked. The tree behind
`bed4b387` was byte-identical to the one the gate measured, so the **content** was right the whole
time; only everything said about it was wrong. Every check green.

That is the run-N/run-N+1 class this design has two explicit guards against, arriving through a
dictionary literal. `-` stays out deliberately: conduct never deletes a ref, so a deletion reported
here means a push doing something nothing in that module writes.

### Two follow-ups filed twice

Five follow-ups reached Odoo on the first run that filed any, and two pairs were one task each: 1577
and 1580 differ by the word "API", 1578 and 1581 by "response". `_merge_follow_ups` deduplicated on
the case-folded title, and **two model phases looking at one finding do not name it the same way** -
one adds a qualifier the other left out.

It compares **word sets** now, minus a short closed stopword list, and merges when one set contains
the other. Exact, untuned, and matched to the shape this actually takes. The asymmetry of the cost
settles the direction: over-merging loses a follow-up nobody had written down twice anyway, and
under-merging puts a duplicate in a backlog for ever - the one place here where litter outlives what
made it.

### A backlog is a corpus, and neither the parent nor an epic belongs in it

`_merge_follow_ups` deduplicates the two sources of **one run** against each other. It has never
asked Odoo what already exists, so a task re-run after a failure re-filed everything it filed the
first time, and a follow-up duplicating a task **a person** had written was never checked at all.
`odoo.open_titles()` closes that: every open task as `(id, title)`, excluded by `state` rather than
by stage name, because stage names are a person's to rename and that module already refuses to
remember any of them.

**The rule is the same; the corpus is what changes the arithmetic.** Five candidates from two phases
describing one change is a place where a bare subset test is exact and cheap. Nine hundred tasks is
not. Measured over the 905 open non-epic tasks, the bare rule collides **9 times**, and everything it
invents is one shape: `Public status page` inside `Include the public API in SLOs and on the status
page`, `Audit Logs` inside `Retain audit logs at least twelve months`. Short, epic-ish titles
swallowing real work.

**Two exclusions, and a floor, each earned separately:**

- **The Epics stage is dropped.** An epic is a container and is named like one, which is exactly the
  title half a backlog is a superset of.
- **A floor of four distinguishing words, on BOTH sides.** At four the rule collides **3 times across
  905 titles and all three are genuine duplicates**, two of them the 1577/1580 and 1578/1581 pairs
  the fleet filed itself. The dangerous direction is the short EXISTING title swallowing a long
  candidate, so testing only the candidate's length would have left the failure the measurement
  found. Three in nine hundred is what makes comparing against a whole backlog safe at all; the test
  for the floor fails when the floor is removed.
- **The source task is not in its own corpus.** Found by running the deployed check against the live
  tracker rather than by reading it: with 1266 `Cap the size of a request body` back in Pending, a
  candidate of that name matched it. A follow-up is deferred work FROM its task and shares that
  task's vocabulary by construction - and the parent is usually the SHORTEST phrasing of the subject,
  which makes every narrower follow-up a superset of it. The relationship is already recorded;
  `odoo.follow_up` writes "Filed by the agent fleet while working on task N" into the body.

**A failed search files anyway, and says so.** The asymmetry runs the other way from the one
`_merge_follow_ups` reasons from: a duplicate in Backlog is something a person deletes, and a finding
dropped because a search timed out is gone. The tracker must never be able to stop the fleet, and
that includes stopping it quietly - so the note is what keeps the degradation visible.

## The fleet chooses its own work, and the claim that stops it choosing twice

**Until 2026-08-27 exactly one thing in this pipeline was still a person: deciding what to work on.**
`windmill.run_flow` had three call sites and none of them chose anything - `bin/conduct ship` (a
human at a terminal), `_continuation` (the next round of a change already chosen) and `_failed_flow`
(one automatic resume of a run conduct broke). The fourth path was somebody filling the run form.
The workstation ran the `next-task` skill, read the answer, and typed the id into `conduct ship`.

**It is a fourth pass in `poll.cycle()` and deliberately not a second Windmill flow.** That was the
obvious shape and three measured facts rule it out. conduct polls Windmill and **Windmill has no
route to this host at all** - a listener needs the podman-socket SELinux denial or a firewalld hole,
which is the same argument that inverted the arrow in the first place - so a flow choosing work
would need its own Odoo credential in a worker, breaking the one rule `conduct/odoo.py` opens with.
Everything the decision reads is conduct's sqlite: the quota reading, the leases, the open chains,
the pending publications. And conduct already ticks every 60 s. **There are also no Windmill
schedules anywhere on this host**; adding one would be the first, and it would be exactly the drift
`reconcile_flow()` exists to eliminate - a row in Postgres with nothing in `git diff`, and unlike a
flow, nothing would rewrite it.

The requested fifteen-minute cadence is `config.INTAKE_SEC`, not a second timer. The pass runs on
the 60 s tick and short-circuits on a free local check before it ever calls the tracker.

**It runs LAST, after every pass that services work already in flight**, and the position is
load-bearing in both directions. `_publications` and `_continuations` create the conditions it
reads, so running ahead of them would see a fleet that looks idle for one tick out of every round.
And the dispatch loop's two early returns - the busy-host gate and the quota hold - skip it
entirely, which is right: a fleet holding because the backup is running must not answer by starting
something new.

**Falling out of the dispatch loop is not by itself idle, and that is the trap the idle test exists
for.** The loop `continue`s past a suspended `await_human` because that module is unprefixed - it is
a person's gate and conduct may not read it - so a run waiting on somebody reaches the bottom of the
cycle looking exactly like a quiet one. Taking a second task there puts two changes on one worktree
and `prepare_worktree` deletes the first. So `_intake_idle` asks seven questions, all local and all
free, before the tracker is contacted at all: nothing else happened this tick, no claim is open, no
step is suspended, no answer is undelivered, no round is open, no publication is pending, and the
cadence has elapsed.

### The claim, and the double dispatch it closes

After `run_flow` the flow takes seconds to reach `await_plan` and suspend, and `chain_open` does not
run until `_plan_step` a tick later. **In that window nothing in the database says a task has been
taken.** Without a claim the next cycle sees an idle fleet and picks a second task - and that is not
two runs: `state.chain_open` supersedes on a differing `odoo_task`, so the second pick would
silently *close* the first one's round and shorten a change nobody was watching.

So the `intake` table carries one row per project, written **before** `run_flow` and restored on
failure, which is the rule `_continuation` already follows for the round counter. Claiming
afterwards means a crash between Windmill accepting the run and the row being written leaves the
fleet free to choose again. `INTAKE_CLAIM_MAX_SEC` is the backstop: a job Windmill no longer knows
about answers 404 for ever, so without an age bound one lost run would wedge intake permanently
while every other signal read healthy.

### Selection: conduct queries, a phase judges, conduct re-checks

The `next-task` skill needs `mcp__odoo-mcp__*`, which no phase can hold, so the work splits along
the line this design already draws everywhere else.

**conduct narrows, on the host, with the credential.** `odoo.milestones()` reads the ladder,
`odoo.candidates()` the pool, `odoo.dependencies_closed()` the blockers, and `odoo.shortlist()` -
a pure function over rows already read, so the whole narrowing is assertable without a network -
drops epics, work already in `Planning` or `Implementation`, and anything blocked, then keeps the
earliest milestone rung with open work and caps what survives at twenty.

**The ladder is ordered by the M-number in the NAME and by nothing else.** `deadline` is unset on
every milestone and `is_reached` is false on every milestone, so neither can order it - and the id
is the one that looks like it would work and does not: `M0b Scaleway estate` has the highest id in
the project. A ladder read off ids works the backlog backwards while every query returns exactly
what it was asked for. **Priority is not a milestone signal either**: the whole `M0` tree sits at
priority 0 because nobody re-starred it after grooming.

**The `select` phase judges what conduct offers it**, with the shortlist substituted into its prompt
before the container starts. It holds no tracker credential, it is read-only, it prepares its tree
rather than continuing one - "has this already been built?" is a question about current `main` - and
it runs on **its own worktree**, because `prepare_worktree` resets and cleans, so choosing the next
task on the ship worktree would delete the last one's commits.

**And nothing it answers is trusted.** `dispatch.judge_selection` re-checks the id against the
shortlist conduct itself built, against the stages, and against the dependencies. A phase naming a
task outside that list picks nothing. The stage and dependency clauses look redundant beside a list
built minutes earlier and are not: the phase runs for minutes, so a person moving a task into
`Implementation` while it thinks is a real race.

**One candidate is not a choice**, so nothing is spent making it - the phase's whole value is
judgement between alternatives, and the premise check is one the planning phase repeats anyway with
the full description in front of it.

### The two brakes, and why one of them had to be invented

**A blocked plan now stops the run, which it did not until this landed.** `blocked` has been in
`policy.PLAN_SCHEMA` and in `prompts/plan.md` since the planning phase existed - the prompt calls a
false premise "a good outcome, not a failure" - and `_plan_step` read only the exit code and whether
a plan was produced. So a blocked plan exited 0, the plan was non-empty, and the flow carried
straight on into a $15 dev phase to implement a task the planning phase had just said could not be
implemented. Harmless while a person chose the task and was watching; the most likely way a round is
wasted the moment conduct chooses.

The task is **not** moved back, because it cannot be: `odoo.move` refuses any stage outside the
fleet's three, and putting work back in the ready pile is a person's decision. It stays in
`Planning`, which the candidate pool already excludes - so a blocked task removes itself from
intake's reach until somebody looks at it, and the chatter note is how they find out why.

**`config.REVIEW_CAP` is the only thing here that bounds the fleet as a whole.** Every other refusal
in this document is about the health of one run. The fleet moves a task to `Review` when its pull
request opens and never past it, so that number only goes down when a human acts - and the failure
it prevents is not a crash. It is twelve open draft pull requests, each cut from a `main` that has
moved further since the last, all of them conflicting, and a person who has stopped reading them. A
hold rather than a refusal, like the quota: nothing is consumed and merging one clears it.

### Armed by hand, after watching it choose

`"intake": False` sits beside `"autopublish"` in the descriptor and ships **off**, for the reason
that one was armed only after the whole chain had run end to end and reached a person. `conduct
intake --dry-run` runs the entire pass - ladder, pool, closure, cap, and the selection phase itself
- and stops one call short of `run_flow`. Run it against the real backlog several times, compare
what it picks against the workstation `next-task` skill, and only then set the switch. There is
deliberately no `--start` flag on it: starting a run by hand is what `conduct ship` is for, and a
second, less careful way to spend twenty-eight dollars is not worth the convenience.

**`agents.intake` grades the LOOK and not the run**, because an intake that has stopped looks
exactly like an empty backlog - both are "no run started", both leave every unit active and every
container healthy. conduct stamps `intake_last_at` on every look including one that picked nothing,
so a stamp that stops advancing is the fault and a fresh stamp with a reason beside it is health.
Holding is `ok` with the reason in the message; the two are told apart by the age, never by the
string. The bound is four cadences rather than one, because a look is skipped while anything is in
flight and a round is most of an hour.

**Pausing it is the same word and one restart, and the restart is the part with a cost.** The
descriptor is read at import, so `"intake": False` moves nothing until `systemctl --user restart
home-server-conduct` - and `reconcile` keys a lease on **conduct's own pid** with no grace period on
that branch, so restarting on top of a live phase reaps its network, its datastores and its worktree
while the container is still running. Read `phase_in_flight` out of the marker and restart on a `0`.
Nothing else needs unwinding: a round already open runs to its gate, the run form still works, and
every continuation, publication and approval is untouched - the pass this skips is the only writer
of the claim row.

**A pause must not read as a fault, and it did.** The `intake` table outlives the flag, so a project
armed once keeps `intake_last_at` at its last look for ever - which ages past `agents.intake`'s hour
and reaches `AgentCheckWarning`, the catch-all over the whole section, every thirty minutes.
`serve._intake_keys` skips a disarmed project for that reason, so the keys go absent with the switch
and the check lands on its silent `note` branch. That branch names the switch and not the history,
because absence cannot tell a fleet that has never chosen from one that was stopped - and the
docstring promising exactly this behaviour had been there, unimplemented, since before anything
could be turned off.

## What is deliberately not built yet

**No gate runs after the model call, and adding one would break a good run.** `make lint` is
`eslint . --fix` and `make format` mutates, so a gate run after the model's last commit leaves the
tree dirty - and `verify.clean()` refuses a dirty tree. The model runs those targets itself, from
the prompt, before it commits. The cheap refusals that catch it getting that wrong are already in
`verify.inspect` and run before the expensive gate does.

**Nothing reaps a branch** whose approval was declined or timed out. Accepted in `publish.py` for
the reasons written there - the namespace is conduct's alone, a ref costs nothing, it is evidence
after the fact - and a ship phase that iterates will make more of them than a `probe` ever did. One
evening of it left three: `agents/upskald-ship-` at `e4aba978`, `a11d5439` and `53bc4298`, of which
only the last became a pull request.

**Why `file-download.spec.ts` disagrees between the runner and GitHub Actions is unanswered.** The
base-gate comparison makes it stop costing a refusal, and deliberately does not diagnose it: it is
an upskald question about a suite that passes in one container and fails in another, and the fleet's
job was to stop reporting it as somebody's broken change.

**The Windmill run form renders `task` as a single-line input.** Whether Windmill has a textarea
format is unmeasured, and guessing a schema key is how the `continue_on_disapprove_timeout` drift
happened. `conduct run --task-file` is the path that does not care. `odoo_task` makes this matter
less: the work now arrives as a task id and the prose comes from the tracker.

**Nothing checks whether the plan was followed.** verify measures the diff against the base and
reads nothing either model wrote, which is the property the whole gate rests on - so a ship phase
that ignored its plan entirely produces exactly the same evidence as one that followed it. The plan
is on the card for a person to compare; there is no mechanical version of that and it is not obvious
there should be.

**The memory is synced by hand.** `bin/sync-agent-assets.sh` runs from the workstation because that
is where both of the things it ships live, and nothing runs it on a schedule. `agents.memory_age`
turns the resulting silence into a warning after seven days, which is a detector rather than a fix.

**`agents.tracker_configured` asks whether the credential is present and never whether Odoo
answers.** An hourly POST to a third party would put that party's uptime in the path of this
battery, which is the same reason `routes.ntfy` sits behind `--routes`. A revoked API key therefore
shows up as a line on an approval card and not as a check going amber.

### The gate's own formatting closed the round, and the loop that should have caught it could not

**Three rounds died on 2026-08-28, all on the same sentence**, from the journal:

```
chain upskald-ship: closed, the flow failed at conduct_verify:
  ['after the gate ran, the tree is not clean: web/bun.lock - the committed tree is not what was tested']
```

`make install && make check` regenerates `web/bun.lock`, and `format` rewrites whatever prettier
disagrees with - one of the three also carried `IntakeForm.vue` and two spec files. So the tree
conduct committed stopped matching the tree the gate tested, and `dispatch.py`'s second clean check
refused. **That refusal is terminal**: `_conduct_broke` is false for a payload carrying `refused`,
so `_failed_flow` closes the chain and tells a person.

**Committing the gate's output is sound because of the ORDER, and the order was measured:**

```
check-gate: version-check format lint deadcode deps type-check unit-test verify-site e2e-test
```

`format` and `lint` are prerequisites of every target that reads, `bun.lock` is written by `install`
before `check` starts, and make runs prerequisites left to right. **Every test ran against the
mutated tree.** The commit conduct makes therefore IS what was tested - it satisfies the assertion
rather than weakening it. `verify.gate_output` captures the diff with `add -A` (so a file the gate
CREATED is carried too, and .gitignore keeps `playwright-report/` and `test-results/` out of it) and
`verify.apply_gate_output` commits it in the PHASE worktree, not the verification tree, because that
is the tree the next phase continues. `staging.take` runs again afterwards: `head_sha`, `tree_sha`
and the card's two numbers all have to describe the new commit or the round publishes the one before
it.

**Two things are still refused, and one of them is not hypothetical.** `format` runs over the whole
tree and `Makefile` is in it, so a diff touching a `REFUSE_DEFAULT` path is refused rather than
committed - a gate that rewrites what verifies it is exactly where "the gate wrote it" stops being
an argument. The other is size: `GATE_DIFF_MAX` is 2 MB, sized from this repository's own lockfiles
(`api/uv.lock` 353 KB, `web/bun.lock` 181 KB, `e2e/bun.lock` 71 KB, so about 1.2 MB if every one is
rewritten whole). **A first draft set it to 512 KB**, which would have refused the exact case the
repair exists for while reading as a sensible number.

**And the retry loop was unreachable.** `_review_step` has carried `again = rounds_left and not
base_red` since it was written, with the sentence *"the gate failed and the base passes it, so the
change is what broke it"*. That sentence could never print. `judge_base` refuses **precisely when
the base passes the target the head fails** - the one case a dev phase can fix - so a red gate that
was the change's fault returned `ok: false` and never reached the review step at all. The only red
gate that ever got there was one the base already failed, where `base_red` is true and `again` is
false. The verification now sets `report["retryable"]` off `measured is not None`, which is its own
measurement rather than the wording of a reason, and `_failed_flow` starts a repair.

### A repair is not a round, and the difference is the planning phase

| | round | repair |
|---|---|---|
| what earns it | the review's blocking findings | a red gate, or a refusal the change can fix |
| runs | plan, dev, verify, review | dev, verify, review |
| the tree | continues (`chain_restart` clears `done`) | continues, and `plan` survives in `done` |
| counted by | `chain_open`, inside the planning phase | `state.chain_repair`, before the flow starts |

**A review's findings are a judgement that may invalidate the plan**, which is why a round re-plans
and why `chain_restart`'s comment says so. **A red gate is mechanical** - `make check` named the
target it died on - so re-planning buys a second planning phase to be told what the gate already
said. That is the same argument `_review_step` makes for skipping the review on a red gate, one step
earlier.

**`resume: True` is the whole mechanism, and it is the only thing `_may_skip` reads.** Nothing else
in the flow or the handlers looks at that argument.

**The count has to move with it.** `chain_open` counts a round from inside the planning phase,
deliberately, so that a resume is not counted - and a repair skips that phase for the same reason a
resume does. Without `chain_repair` counting, the bound would stop existing and a gate that stayed
red would loop for as long as the model kept exiting zero. It is put back if `windmill.run_flow`
raises: otherwise an outage spends a change's whole allowance in three cycles and closes it as "the
rounds are used up", which names the wrong thing entirely.

**`MAX_ATTEMPTS` is 3.** Two was one attempt and one remediation pass, which was the whole loop
while a refusal ENDED the run. Leaving it at two would have converted the fix above into a cut in
what a review is allowed to ask for. **One counter, still**: a second allowance for repairs was
considered and refused, because two bounds are two things to reason about at the moment somebody is
asking why a change stopped.

### The branch is pushed after dev, and a refused round now leaves one behind

The gate takes fifteen to thirty minutes and the change is finished before it starts, so a person
who wanted to read the code had been waiting half an hour for a branch that was ready at the
beginning. `dispatch.push_after_dev` runs at the end of `_dev_step`, behind `verify.inspect` - which
needs no container, answers in about a second, and is where "the phase committed nothing", "the head
does not descend from its base" and "the change touches what verifies it" already live. Those are
the refusals where pushing would be **wrong** rather than merely early, and skipping here costs a
person nothing because the verification makes the same ones a minute later with the full card.

**The lease needed no change.** The verification already reads `expect =
last_report["pushed_sha"]`, so it leases on what dev pushed instead of creating the branch itself.

**What is genuinely different is the posture.** Until now nothing left the host until the gate had
spoken. conduct never deletes a ref - `-` is deliberately absent from `publish._FLAGS` - so `agents/`
now accumulates branches for rounds that were never published. That is the price of being able to
read the code, and it was asked for.

**A transport failure here is not a failure of the dev step.** The change is committed on the
worktree and the verification pushes again in a minute; losing a finished phase to `ssh: connection
reset` would be the most expensive way to be tidy.

### `run.error` and `run.branch`, because neither `report` nor `chain` is a log

Both tables are keyed on `worktree_id`, and the worktree is REUSED - so each holds exactly one row
and answers about the newest round whichever round is asked about. That is the same premise that
drew one row on the run board where there should have been eleven. `run` is the only append-only
table conduct has.

- **`error`** is written by `state.finish_run(detail=)` and is null on success. A list of refusals is
  joined to prose on the way in, because a bare `str()` of one is a Python repr - which is what
  `chain.closed_why` stores and what a reader has to unpick by eye. `COALESCE`, so `abandon_runs`
  closing a row later cannot blank a reason an earlier close recorded.
- **`branch`** is written by both pushes. `publication.branch` opens with the pull request, so a
  round that was refused or is still in flight had a branch nowhere.

**Null means "not recorded", never "nothing went wrong"** - an inspect-level refusal returns before
`start_run`, so there is no row at all to carry one.

### A command is a suspended step, which is the same mechanism work already uses

**The fleet had no controls at all.** Arming it meant editing `conduct/config.py` and restarting a
unit; there was no `pause`, no `stop`, no `cancel`, no `kill` and no `restart` verb anywhere. The
last deploy ended with the repair path unproven for exactly that reason - nothing could arm intake
from anywhere but a text editor.

**What was refused is an inbound RPC to the host**, and it stays refused. Five files carry the same
sentence: a listener needs either a unix socket - the `container_t -> unconfined_t :
unix_stream_socket connectto` denial that stops any container reaching the podman socket - or a TCP
port plus a firewalld hole, and both spend real containment to give an internet-facing container an
RPC that spawns `claude`.

**So a command travels the way work travels.** `f/agents/control` carries an action and a target;
conduct sees the suspended step on its next poll and answers it like any other `conduct_` module.
The dashboard starts that flow through one Caddy route on `home.{$DOMAIN}` which **rewrites** to a
single literal path and injects a token server-side. Nothing new reaches the host, `paths.ts` still
carries `conduct` as outbound-only, and the `caddy -> windmill-server` edge the route uses was
already drawn for `agents.{$DOMAIN}`.

**`rewrite` is a stronger guard than an allowlist**, and that is why the route has one rather than a
path matcher. Whatever the client asked for is discarded, so there is no traversal to find and no
second endpoint to reach. Measured with requests rather than `caddy validate`, which cannot see this
class of mistake: `GET` answers 405; `POST /api/control/api/v1/admin/tsdb/snapshot` reaches the
control flow with the path thrown away; a client-supplied `Authorization` is replaced rather than
forwarded; and the token appears on no other upstream. A bare `/api/control` with no trailing
segment falls through to the bundle, which is why the client posts to `/api/control/run`.

**A COMMAND IS ANSWERED FROM INSIDE THE PHASE WAIT, WHICH IS WHERE THE LOOP SPENDS ITS TIME.**
conduct is single-threaded: `poll.cycle` takes one snapshot of suspended jobs and then blocks in the
dispatch, so a command created after that snapshot cannot be seen until the phase exits. Measured on
2026-08-28, a disarm waited **33m 47s** - with `last_ok_at` two seconds old throughout, because
`_await_phase` refreshes the heartbeat every 15s whether or not the loop is looking at anything. So
`_sweep_control` is hoisted beside `_sweep_notices`, on that function's own argument, and
`_await_phase` calls it on the 15s tick it already had. **No thread.**

**`restart` is excluded by an allowlist rather than by a comment.** It cancels a flow and starts
another, which from inside the phase wait is conduct cancelling the flow whose phase it is running;
the other four only write a row. A sixth action added to `flows/control.py` is deferred by default,
which is the failure direction worth having. **A command outside the allowlist is left suspended and
untouched - "not yet", never "no"** - while a refusal is answered whatever the allowlist says,
because an action conduct cannot read has no boundary to wait for. And every failure inside that
wait is swallowed, which is the opposite of `cycle`'s rule and deliberate: the caller is holding a
phase twenty minutes in, and a control-plane blip must cost the tick and nothing else.

**The record is the Windmill job** - its arguments, its timestamp, its result, kept for thirty days
by `JOB_RETENTION_SECS` - plus a `control` row carrying `at` and a note. That is the argument, the
duration and the record the Alertmanager silence refusal asks for. **What it cannot say is which
person**: the route injects one token, so every command arrives under the same identity. That is the
limit the approval record already has, and it is not papered over anywhere.

### The switch moved out of a restart, and a hold is bounded by something else

**`config.py` is read at import**, so moving `"intake"` used to mean `systemctl --user restart
home-server-conduct` - and `reconcile` keys a lease on **conduct's own pid** with no grace period, so
a restart on top of a live phase reaps its network, its datastores and its worktree while the
container is still running. A button that could do that is not a button worth having. So a `control`
row overrides the descriptor and is read every cycle, on `quota.refusal`'s precedent of a decision
driven by a row rather than by a constant.

**The descriptor is still the default and still where the argument lives** - forty lines about what a
pause is and is not. `poll.intake_armed` is the tri-state read, `serve._intake_keys` asks the same
question so the marker cannot report a disarmed fleet that is busy choosing work, and `conduct
status` prints which source is in force.

**Absent is not `off`, in three places.** A missing row means "nobody has said", which is what keeps
the descriptor the default rather than a value the table duplicates at install time; a value that is
neither `on` nor `off` defers rather than guessing; and an **action conduct does not recognise is
refused rather than ignored**, because a command that silently does nothing sends the person away
believing the fleet is held.

**A hold stops dispatch for one worktree and nothing else.** It is a `continue` and not a `return` -
the quota and the busy host are conditions of the whole machine, a hold is one round's - and it is
the one refusal `--force` does not override, because force means "I know, go anyway" and a hold is
somebody having already said the opposite.

**And it is bounded by something the person setting it does not control.** conduct does not answer a
held step, and `CONDUCT_TIMEOUT` is 86400 - so a hold left over a weekend does not pause a round, it
**fails** one. The row says so with a countdown, and `agents.control_holds` grades it: a `note` while
it is young, because a deliberate pause must not read as a fault, and a `warn` past 20 hours, because
the inverse is a hold that expires in silence.

### A restart cancels first, and the ordering is the only thing that is not interchangeable

Closing the chain stops conduct's bookkeeping and leaves the Windmill job exactly where it was -
suspended, for its full 24 hours, still visible to the dispatch loop. Starting a second flow on the
same worktree then puts two rounds on one tree, and the next `prepare_worktree` deletes the first
one's commits. That is the failure `_intake_idle` exists to prevent, arriving from the other
direction. **So the cancel goes first, and if it will not go, nothing is started.**

`windmill.cancel` wraps `POST jobs_u/queue/cancel/{id}`, measured against the deployed OpenAPI on
1.792.2 rather than assumed: `reason` is a required body field, and the `_u` means no **session** is
required, not no credential. Not `force_cancel`, which is the sibling one line down in that document
- reaching for it first would mean never learning that the ordinary one works.

**`CONTROL_RESTART_MIN_SEC` is correctness before it is economy.** A double click is two flows on one
worktree, which is the hazard above. The spend needs no gate of its own: a restarted round dispatches
through the same loop, so `quota.refusal` and `REVIEW_CAP` both still apply, and a ceiling denominated
in dollars is refused here on principle.
