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
`backup-state` and `metrics-state`. **Four** checks in `bin/verify-host.sh`, **thirteen** series in
`bin/collect-metrics.py` and one refusal in `bin/reboot-when-staged.sh` read it.

That sentence said "twelve checks, twenty-two series" until 2026-08-23, and both numbers were wrong
*and* described the wrong thing: fourteen checks and twenty-one series exist in the agents section,
but only four and thirteen of them read this file. `conduct/marker.py` carried the identical wrong
sentence and moved with it - the same both-halves rule, applied to a count rather than to a finding.

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

**Six modules, three suspends, and only two of them are conduct's.** `f/agents/ship` is the whole
chain; `f/agents/phase` stays what it was, two modules that run one gate and report. Two linear
flows rather than one with a conditional, because the `phase` argument selects the *command a phase
runs* and not whether the flow publishes - a `check` run through the long chain would refuse at
`conduct_verify` for the right reason and read as a fault.

```
0  await_conduct   identity, suspend      runs, Success, then the flow suspends
1  conduct_phase   rawscript              <- WaitingForEvents. conduct answers.
2  await_verify    identity, suspend      runs, Success, then the flow suspends
3  conduct_verify  rawscript              <- WaitingForEvents. conduct answers.
4  await_human     rawscript -> the card, suspend
5  publish_pr      rawscript              <- WaitingForEvents. A PERSON answers.
```

**`publish_pr` is deliberately not prefixed**, and that one string is the only thing between conduct
and its own approval - `user_auth_required: true` does **not** stop it, because conduct resumes with
a workspace-owner token, which satisfies it perfectly. So the guard moved into `poll._resume`, where
it is a property of resuming rather than of one call site. `self_approval_disabled` is deliberately
absent: the workspace has one seat, so it would deadlock every run a person starts by hand.

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

## What is deliberately not built yet

**No gate runs after the model call, and adding one would break a good run.** `make lint` is
`eslint . --fix` and `make format` mutates, so a gate run after the model's last commit leaves the
tree dirty - and `verify.clean()` refuses a dirty tree. The model runs those targets itself, from
the prompt, before it commits. The cheap refusals that catch it getting that wrong are already in
`verify.inspect` and run before the expensive gate does.

**Nothing reaps a branch** whose approval was declined or timed out. Accepted in `publish.py` for
the reasons written there - the namespace is conduct's alone, a ref costs nothing, it is evidence
after the fact - and a ship phase that iterates will make more of them than a `probe` ever did.

**Why `file-download.spec.ts` disagrees between the runner and GitHub Actions is unanswered.** The
base-gate comparison makes it stop costing a refusal, and deliberately does not diagnose it: it is
an upskald question about a suite that passes in one container and fails in another, and the fleet's
job was to stop reporting it as somebody's broken change.

**The Windmill run form renders `task` as a single-line input.** Whether Windmill has a textarea
format is unmeasured, and guessing a schema key is how the `continue_on_disapprove_timeout` drift
happened. `conduct run --task-file` is the path that does not care.
