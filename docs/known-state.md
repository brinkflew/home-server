# Known state

Conclusions from auditing the running host. **Do not rediscover these.**

`CLAUDE.md` carries a one-line index of every entry below, under its own `Known state` section.
That index is what is always in context; this file is the detail behind each line, and the reason
each conclusion is held. Read the entry before changing anything in the area it names - most of
them record a failure where every visible signal read green.

**Append here rather than in `CLAUDE.md`, and add the matching index line when you do.** An entry
nothing points at is one nobody reads.

## The rename, and the three things that did not follow

- **Two things bit during the 2026-08-15 rename, and both would bite again on any move of the
  checkout.** The one-shot script that carried them has been deleted, so they live here:
  - **A symlink from `/etc/greenboot/check/required.d/` into the checkout dangles the instant the
    checkout moves.** A dangling entry there cannot be exec'd, so the next boot is RED and greenboot
    rolls back a deployment that was never bad - and the reboot is inside the greenboot binary, so
    no unit file hints at it. An *empty* `required.d` is green by default; a broken symlink in it is
    not. Remove it before moving anything and restore it after.
  - **Renaming a unit out from under a running timer leaves the OLD name in systemd's runtime state
    as `not-found`/`failed`** - phantoms that nothing on disk explains, that `daemon-reload` does not
    clear, and that `verify-host.sh` correctly counts as failed units for ever. Only
    `systemctl --user reset-failed` clears them, and only once the new names are linked.
- **The project was `media-stack` until 2026-08-15.** The checkout moved `/var/media-stack` ->
  `/var/home-server`, five timers and five services were renamed, `/var/lib/`, `/var/backups/` and
  `~/.cache/` followed, and `MEDIA_STACK_*` became `HOME_SERVER_*`. **Three things deliberately did
  not follow, so `git grep media-stack` still finds them and they are not misses:**
  - **The Tdarr plugin**, `Tdarr_Plugin_avs1_MediaStackStreamPolicy.js`. Its filename *is* its `id`,
    and `apps/tdarr/flows/avsOnePass1.json` references it as `Local:Tdarr_Plugin_avs1_...` - but the
    flow that actually runs lives in Tdarr's SQLite database, not in git. Worse,
    `tdarr-server.container` copies plugins with `cp -a`, not `rsync --delete`, so a rename would
    leave *both* files in `Plugins/Local/` and transcodes would keep working off the stale one until
    a config restore, then fail. The name still describes what it is: a media stream policy.
  - **The four Stage 0/1 paths in `host/RUNBOOK.md`**, which record the Fedora 37 host destroyed on
    2026-08-12 - they sit beside `/home/avanserv`, `/var/lib/docker` and `docker compose`.
  - **Git history.** Use `git grep` on the working tree as the gate, never `grep -rn .`, which
    descends into `.git/`.

  The restic snapshot identity (`--tag`/`--host`) *did* follow, but only via `restic tag --add`
  and `restic rewrite --new-host`, which rewrite the existing chain in place. **Do not simply edit
  those strings**: `forget` groups by host *and paths*, so a plain edit orphans every existing
  snapshot from the retention policy. `paths` is the one field `rewrite` cannot change, so the
  workstation's chain - staged at `~/.cache/<name>/staging` - forks regardless, exactly as the
  two-chain note under Backups describes. The old group is retired once, by hand, after the new
  one has been restored successfully.

## Podman is not Docker

- **`firewalld` now governs published ports, which is the reverse of the Docker host.** Under
  Docker a published port stayed reachable whatever the zone allowed, because Docker's DNAT ran
  ahead of firewalld's filtering. Rootless Podman publishes through a userspace `rootlessport`
  process that binds like any other daemon, so firewalld's INPUT rules apply normally - and the
  `FedoraServer` zone ships allowing only `ssh`, `cockpit` and `dhcpv6-client`. **Ports are now
  closed by default rather than open by default.** A new published port needs a matching
  `firewall-cmd` rule in `firewall-stack-ports.service`, or it is unreachable while the container
  looks perfectly healthy. The symptom is `No route to host` - firewalld rejects rather than drops
  - on a port whose container is logging that it is serving.
- **SELinux blocks `/dev/net/tun` until `container_use_devices` is on.** The udev rule and
  `AddDevice=` are both necessary and neither is sufficient. It presents as gluetun's
  `ERROR checking TUN device: TUN device is not available`, with **no AVC logged**, while opening
  the same node as `core` on the host succeeds - and it takes qBittorrent and JOAL down too. Note
  `container_use_dri_devices` is already on in uCore, so the GPUs work while the tunnel does not.
- **Podman does not create missing bind-mount source directories; Docker did.** A fresh host has
  none of the scratch or log paths that no backup restores. With `Restart=always` this is a silent
  5-second retry loop rather than a visible failure - the Tdarr units reached restart 126. Audit
  with: expand every `Volume=` in `stacks/` against `.env` and test each host path.
- **Podman will not guess a registry.** An unqualified `FROM caddy:2` fails under systemd with
  `short-name resolution enforced but cannot prompt without a TTY`. Every image reference must be
  fully qualified; all of them are, and are digest-pinned.
- **Every quadlet that interpolates a variable needs its own `EnvironmentFile=`**, `.network` units
  included. Unlike Compose's `${VAR:?err}`, systemd expands an unset variable to an empty string
  and logs it at info level, so the visible error is podman's - `Error: invalid CIDR address:` -
  three units away from the cause.
- **`/mnt` is a symlink to `/var/mnt` on CoreOS**, as `/home` is to `/var/home`. systemd refuses a
  mount unit whose path is not canonical, so the unit is `var-mnt-media.mount` with
  `Where=/var/mnt/media`. Consumers can still say `/mnt/media`. It fails on a completely healthy
  disk, with `vgs`, `lvs` and `/dev/disk/by-uuid` all looking correct.
- **Quadlet's `Environment=` splits on whitespace.** Compose took a value with spaces as one string;
  quadlet reads the line as space-separated `KEY=VALUE` pairs and **silently truncates at the first
  space**. Three settings were cut on migration - the OIDC scope list, a display name, and gluetun's
  port-forward command. Any literal containing a space must be quoted:
  `Environment="KEY=a b c"`. `${VAR}` references are safe; systemd substitutes those into
  `ExecStart` as single arguments. Audit with: every `^Environment=` line whose value contains a
  space and does not start with a quote.

## Reaching a service, and restoring one

- **A 302 from an admin route proves the proxy and sign-on, not the service.** An unauthenticated
  request never reaches the backend, so the whole route battery passes with a backend that is down.
  qBittorrent was crash-looping while `torrent` returned a healthy-looking 302. Check backends by
  connecting to them from their own network.
- **Restoring a config taken from a running stack can carry live lock files.** qBittorrent's Qt
  lockfile stores the pid, hostname and machine id; on a host where the hostname does not match, Qt
  assumes the lock is held and qBittorrent **exits one second after starting, logging only
  "termination initiated"** - no error, nothing naming the lock. `bin/backup-config.sh` now excludes
  them.
- **`WebUI\LocalHostAuth` must be `false` for the port-forward push to work**, and it was `true`
  - so `VPN_PORT_FORWARDING_UP_COMMAND` had been getting a 403 and the forwarded port never reached
  qBittorrent. This predates the migration; it came in with the restored config. "Localhost" here is
  inside gluetun's namespace, which only gluetun, qBittorrent and JOAL share, so this is not the
  same as exposing the API.
- **BUT JOAL IS INSIDE THAT NAMESPACE, AND THAT IS THE PART THE SENTENCE ABOVE UNDERSTATES.**
  Re-examined 2026-08-19. The three containers share one network namespace, so `127.0.0.1` is common
  to all of them - and `bypass_local_auth: true` means anything in that namespace reaches
  qBittorrent's WebUI **with no credential at all**. gluetun is the one that needs it:
  `VPN_PORT_FORWARDING_UP_COMMAND` posts to `/api/v2/app/setPreferences` unauthenticated on every
  reconnect. JOAL gets the same reach for free, and JOAL is third-party software whose whole job is
  talking to trackers - so it is the least trustworthy thing in the pod holding an unauthenticated
  path to the client that owns the download directory.
  **It is recorded rather than fixed, and the reason is worth keeping.** The obvious repair is to
  make the up-command authenticate, and it does not work cleanly: gluetun ships busybox `wget`,
  which has no `--save-cookies`, so acquiring and replaying a qBittorrent SID means scraping
  `Set-Cookie` out of `-S` stderr inside a quoted systemd `Environment=` line - more moving parts in
  the path that keeps the kill-switch working than the exposure justifies. The alternatives are
  worse: a subnet whitelist cannot separate two containers that share an address, and moving JOAL
  out of the pod would have it announce from the host's own IP, which is the reason it is in there.
  **What would actually close it is dropping JOAL**, and that is a decision about whether ratio
  padding is wanted at all, not a networking fix.
- **THE DAILY PASSKEY PROMPT WAS A STOCK DEFAULT NOBODY CHOSE, AND IT IS ABSOLUTE RATHER THAN
  IDLE-BASED.** Tinyauth's `sessionExpiry` is 86400 - one day - and nothing in this repository set
  it, so sign-on had inherited the value since the day it was built. The expiry is stamped at login
  and never refreshed, which is the part that makes it feel like a fault: using the stack constantly
  does not extend it, so the prompt arrives every day no matter what. Three independent
  measurements, because the first plausible theory was wrong: `tinyauth config` read back
  `sessionExpiry: 86400` from the running process; both rows in `tinyauth.db` had
  `expiry - created_at` of exactly `86400`; and Pocket ID's audit log showed sign-ins 24.05h,
  24.57h, 24.76h and 24.25h apart, **drifting later each day** and jumping to 48.09h on a day the
  stack went unused - the signature of a rolling clock rather than a scheduled event.
  **It is NOT the nightly `AutoUpdate=registry` recreating the container**, which is the theory that
  fits at a glance and predicts a fixed time of day rather than a drift. Sessions live in
  `tinyauth.db`, a bind mount, so they survive a restart: `tinyauth.service` and `pocket-id.service`
  both read `NRestarts=0` across a pair of sign-ins a full 24h apart inside one unbroken uptime.
  That is also what makes revoking a session a `DELETE` from that table plus a unit restart rather
  than a wait. Now `TINYAUTH_AUTH_SESSIONEXPIRY=2592000`, thirty days.
- **The passkey CEREMONY, as opposed to its frequency, is a second clock - and it was left alone.**
  Pocket ID's own `SESSION_DURATION` is also unset, default 60 minutes, so by the time Tinyauth's
  cookie dies Pocket ID has long forgotten the browser and cannot answer the redirect silently.
  Raising it would make the rollover a silent redirect and was **declined**: the whole value of this
  design is that renewal costs a real WebAuthn signature from the device rather than a cookie
  renewing itself unattended. Worth knowing before someone reads the 60-minute default as an
  oversight and "fixes" it.
- **A session's expiry is written at creation, so changing the setting does not touch sessions that
  already exist.** After the deploy above there was one more daily prompt before the first
  thirty-day session existed. A rollover on the old schedule is therefore not a failed deploy, and
  the clock is the wrong thing to check - read `expiry - created_at` off the new row instead.

## The host: image, driver, and which updater is armed

- **The host is uCore `stable-nvidia-lts`, immutable and rpm-ostree managed.** `/usr` is read-only, so
  host-level tools go in `~/.local/bin` (which is where `sops` and `age` live). Host configuration
  belongs in `host/butane/ucore.bu` - anything applied only over SSH is undocumented state that the
  next reinstall loses. Ignition runs **once, at first boot**, so editing `ucore.bu` does not change
  the running machine; a change has to be applied by hand *and* committed there.
- **`-lts` is the NVIDIA DRIVER branch, not an LTS kernel**, and this is easy to get backwards.
  Both deployments run the identical kernel (`7.1.4-200.fc44`); the rebase moved the driver
  **610.57.04 -> 580.173.02**, NVIDIA's production branch, as deliberate conservatism rather than in
  response to a fault. `rpm-ostree db diff` is what proves it. Anyone "fixing the documentation" by
  reverting the tag to `stable-nvidia` would silently reinstall 610.
- **Zincati and `bootc-fetch-apply-updates.timer` are MASKED, not merely disabled.** Three updaters
  are installed and exactly one may be armed - two would each write a deployment into a `/boot` that
  holds two kernels, and the loser fails overnight with nobody watching. Masking matters because
  `disable` only removes the `.wants` symlink and a `Wants=` elsewhere silently re-enables it, the
  same trap that had `home-server-promote` starting Tdarr every 10 minutes. Masking zincati also
  removes `--bypass-driver` from the migration.
- **`AutomaticUpdatePolicy=stage` is uCore's own default, not something anyone set** - `/etc/rpm-ostreed.conf`
  is byte-identical to `/usr/etc/`. It is restated in `ucore.bu` anyway so the policy is a decision
  in this repo rather than an inherited default that can change underneath it. The only deliberate
  act was enabling `rpm-ostreed-automatic.timer`, whose preset is `disabled`.
- **The OS image ref is `ostree-image-signed:docker://`.** `/etc/containers/policy.json` ships from
  the image with a `sigstoreSigned` scope for `ghcr.io/ublue-os` and both cosign keys in
  `/etc/pki/containers/`, so this needed no file changes - only a rebase. Do **not** ship your own
  policy or key through Ignition: it becomes a permanent `/etc` override that ostree preserves, so a
  ublue key rotation would pin you to a dead key and every update would fail silently. Note the
  `docker` transport has a `""` -> `insecureAcceptAnything` catch-all, which is why ordinary
  container pulls work unverified; a typo'd scope would fall through to it and verification would
  silently pass. `podman image trust show` prints the scope that actually matches.

## Container auto-update, and the rollback it rests on

- **Images follow tags and `podman-auto-update` runs nightly** (since 2026-08-13). Digest pinning was
  dropped because nothing maintained it - thirteen of eighteen images were three months old. See
  `stacks/README.md` for the tag choices, which are the remaining risk control. Two things about it
  are load-bearing and non-obvious:
  - **`Notify=healthy` is what makes the rollback fire.** auto-update restores the previous image
    only if the unit fails to **start**, and systemd otherwise calls a container started the moment
    it runs - so a broken-but-running image passes and nothing is restored. Proven by pointing a
    test unit at a deliberately broken image and watching the journal restore the old one.
    **What it cannot protect is anything that migrates its datastore on start** - see the entry
    two below, where this bullet is the direct cause of the longest outage recorded here.
  - **auto-update does not trigger a `.build` unit.** Caddy is `AutoUpdate=local`, which notices a
    new image without producing one, and a `.build` unit only runs when its image is absent - so
    without `home-server-caddy-build.timer` Caddy alone would never update. That unit also needs
    `Pull=newer` in `caddy.build`, because podman build's default pull policy is `missing` and it
    would otherwise reuse a stale local `caddy:2` for ever while succeeding in four seconds.
- **A ROLLBACK RESTORES THE IMAGE AND CANNOT RESTORE THE DATA, so `Notify=healthy` protects nothing
  that migrates its datastore on start.** That bullet is the safety net this whole tag-following
  design rests on, and on **2026-08-19** it was the direct cause of a nine-and-a-half-hour outage of
  the service gating **every** sign-on here. The sequence is worth having in full, because every
  step in it is individually correct:
  - **00:14:50** auto-update pulls Pocket ID **2.14.0**. It starts, **migrates its SQLite schema** to
    `20260814120000`, logs `Server listening`, registers its cron jobs and completes a SCIM sync -
    i.e. it is up and serving.
  - **The startup probe never passes.** 2.14.0 **removed curl from its Dockerfile** (*"remove
    unnecessary curl dependency from Dockerfile"*, commit `987d1a8`) and the quadlet probed with
    `curl -fsS http://localhost:1411/healthz`, so it exited **127**. Sixty retries at 5s expire,
    `Notify=healthy` never fires, systemd kills the unit at **5min 12.9s** -
    `Failed with result 'protocol'`.
  - **00:20:03** auto-update does exactly what it is designed to do and re-tags **2.13.0** onto `:v2`.
  - **00:20:04 onwards** 2.13.0 refuses the migrated database - *"database version (20260814120000)
    is newer than application version (20260802120000), downgrades are not allowed"* - and exits 1
    every five seconds. Restart counter **6108** by the time it was found, in a browser, as a 502.

  Four things follow, and the first is the general one:

  - **The rollback is a safety net for STATELESS upgrades only.** Restoring an image cannot
    un-migrate a database, so for anything with forward-only migrations a rollback converts a failed
    start into a **permanent** deadlock that no restart clears. Pocket ID, the \*arr apps, Jellyfin
    and Tdarr all migrate on start. Nothing here detects it and nothing can undo it: the remedy is
    always to go *forward* to the version matching the schema, never back.
  - **`ALLOW_DOWNGRADE=true`, which the error message itself suggests, is the WRONG lever.** It does
    not restore the old version's compatibility - it lets that version destructively rewrite the
    schema.
  - **A HEALTH PROBE THAT SHELLS OUT TO `curl` IS AN UNDECLARED DEPENDENCY ON A BINARY THE IMAGE
    MERELY HAPPENS TO SHIP**, and its absence is indistinguishable from the application being down.
    This is the **second** time an image dropped curl here - `bin/collect-metrics.py`'s `api_get`
    already falls back to wget because gluetun and jellyseerr ship only that. **Prefer the image's
    own declared `HEALTHCHECK`**, which `skopeo inspect --config` reads without pulling. Pocket ID
    has shipped `CMD ["/app/pocket-id", "healthcheck"]` all along and the quadlet was overriding it
    with something strictly worse; `gluetun.container` already had the right shape. **Ten other
    quadlets still probe with `curl` and eight with `wget`.**
  - **Detection worked, and is not what failed.** `containers.units_active` - added the day before,
    for the Caddy outage below - reported `quadlet service(s) NOT running: pocket-id.service`
    `(activating)`, and `CheckFailing` went **critical in Alertmanager at 00:55:02Z** and stayed
    there. The gap was between the notification and anyone acting on it, which is a different
    problem from the ones this file usually records.
- **The nightly prune does not eat the rollback.** The shipped `podman-auto-update.service` runs
  `podman image prune -f` afterwards, but a superseded image keeps its repository digest and is
  therefore not *dangling* - verified: every pre-update image survived. Only `prune -a` would remove
  them, so **never run that**; the previous image in local storage is the only rollback there is.
- **THAT SAME PRUNE FAILS THE UNIT, AND THE FAILURE NAMES THE ONE COMPONENT THAT WAS WORKING.**
  A `.build` unit interrupted mid-run leaves a **buildah working container** in storage. It holds
  the build-cache layer it was made from, so that image is both dangling *and* in use, and
  `podman image prune -f` exits **125** on it rather than skipping it. podman ships that prune as
  `ExecStartPost=` on `podman-auto-update.service`, and an `ExecStartPost` failure fails the unit -
  so on 2026-08-17 and 2026-08-18 `podman auto-update` exited **0**, all eighteen containers
  updated correctly, and systemd reported the updater broken:

  ```
  Main PID: ... (code=exited, status=0/SUCCESS)          <- the update
  Control process exited, code=exited, status=125/n/a    <- the prune
  Error: image used by 06fc6c080d43...: image is in use by a container
  ```

  Seven had accumulated across two occasions, four of them stamped inside the reboot transition of
  the 2026-08-16 unattended window. They held 2.1 GB of dangling images and blocked **12.1 GB** of
  reclaim, and nothing measured any of it - the only visible signal was `containers.failed_units`
  naming `podman-auto-update.service`, three scripts from the cause and pointing at the wrong
  component. Two changes, and **neither works without the other**:
  `host/systemd/podman-auto-update.service.d/` makes the prune non-fatal, because housekeeping that
  can be skipped for a night must not overrule the update `Notify=healthy` protects; and
  `containers.storage_orphans` WARNs on the leftovers directly, which is what makes the first a
  correction rather than a silencer. **`ExecStartPost=` must be cleared with an empty assignment
  before the `-` form is added** - it is a list directive, so a drop-in that only adds appends, and
  the original fatal line still runs first. Clear them with `podman rm --storage <name>`; **buildah
  is absent on uCore**, so `buildah rm` is not the tool. Note this does not reopen the bullet above:
  it is still `prune -f`, never `prune -a`.
- **uCore ships NVIDIA's own `nvidia-cdi-refresh.{path,service}`**, writing `/run/cdi/nvidia.yaml` on
  tmpfs, with the `.path` unit watching `modules.dep` and `nvidia-ctk` so a driver change regenerates
  the spec with no reboot. `ucore.bu` used to define a second unit writing `/etc/cdi/nvidia.yaml`.
  The files were byte-identical, which is exactly why it was invisible - but a spec names the driver
  version in dozens of paths, so the first driver-changing update would have left two files defining
  `nvidia.com/gpu=1` with different library paths, which the resolver **rejects rather than merges**.
  Both Jellyfin and tdarr-node-01 consume that device. Removed 2026-08-13; `bin/verify-host.sh`
  asserts exactly one spec exists and that it names the running driver.

## `/boot` holds two slots and cannot be grown

- **`/boot` costs one slot per distinct KERNEL+INITRAMFS, not per deployment**, holds exactly two
  (2 x 146 MB + 11 MB GRUB = 303 MB of 350 MB), and **cannot be grown** - `nvme0n1p4` is XFS, which
  cannot be shrunk by any tool, so enlarging it means repartitioning the disk that carries `config/`.
  Five corrections learned by doing it wrong, on 2026-08-14 and again on 2026-08-16:
  - **`ostree admin pin 0` is wrong whenever something is staged.** Index 0 is then the *staged*
    deployment and the command fails with `Cannot pin staged deployment`. Derive the booted index:
    `rpm-ostree status --json | jq '[.deployments[]] | map(.booted) | index(true)'`.
  - **Pinning the booted deployment is free only until you reboot.** It already owns the slot it
    runs from - but if the deployment you boot into carries a different initramfs, the pin is
    suddenly holding a second full slot. **A firmware bump alone is enough**: the signed rebase
    changed no kernel package, only `linux-firmware` 20260622 -> 20260810, and `/boot` went 171 MB ->
    **26 MB** free until the old deployment was unpinned and `rpm-ostree cleanup -r` run. So
    unpinning after verifying is not tidying, it is what lets the next update write its kernel.
    Reproduced exactly on the 2026-08-14 reboot: 171 -> 26 -> 171 MB.
  - **`rpm-ostree db diff` CANNOT TELL YOU WHETHER A SLOT IS NEEDED, and reading it as if it
    could is how the bullet above gets talked out of.** On 2026-08-24 the staged deployment
    diffed against the booted one as `perl-URI 5.35 -> 5.36` plus one added noarch package:
    no kernel, no firmware, same `kernel-7.1.6-201.fc44` in both, and `regenerate-initramfs`
    false on every deployment. Every visible signal said "this needs no new boot entry". The
    initramfs was rebuilt anyway - different ostree object, different sha256, and a size
    differing by **one byte** (133486447 against 133486446) - so the bootcsum differs and
    finalizing it writes a full 146 MB slot into 26 MB of free space.
    **uCore rebuilds the initramfs on every image build**, so a *content* diff of the packages
    is simply not the question. The question is whether the two deployments' kernel and
    initramfs are the same objects, and the only honest way to ask it is to compare them:
    `sudo sha256sum /ostree/deploy/*/deploy/<checksum>.0/usr/lib/modules/<kver>/initramfs.img`
    for the booted and the staged one. A staged deployment has no `/boot/loader/entries/`
    entry yet - it is written at finalization - so the absence of a third entry proves nothing
    either. `bin/reboot-host.sh`'s gate is right to refuse on "something is staged" alone.
  - **A low `/boot` WITH something pinned is a different finding from a low `/boot` on its own**, and
    `verify-host.sh` now distinguishes them: the first is a WARN naming the remedy, the second is a
    FAIL. Conflating them cost a false alarm on the first scripted reboot - the pin the script had
    just set tripped the check, and the script concluded the new deployment was bad and recommended
    a rollback. **`bin/reboot-host.sh` gates on `verify-host.sh --greenboot`, not the full battery**,
    for the same reason: containers, backups and the checkout can all be unhealthy for reasons a
    rollback would not fix.
  - **UNDER `--greenboot` IT IS A WARN WHATEVER THE CAUSE, pinned or not, and that was learned the
    expensive way.** The bullet above narrowed the FAIL to "low `/boot` with nothing pinned" and
    stopped there, which left the general case wrong: **a rollback cannot fix a full `/boot`, it
    makes it worse**, because the deployment being rolled back to needs a slot of its own. On
    2026-08-16 the unattended window applied a deployment, three deployments accumulated, `/boot`
    hit **26 MB**, this check FAILed and greenboot rejected a **perfectly healthy boot** - then
    could not act on its verdict: *"Boot counter exhausted but no rollback trigger set - manual
    intervention required"*. `rpm-ostree cleanup -r` reclaimed it to 171 MB, the same figure as
    2026-08-14. Nothing is lost by softening it there: the full battery still FAILs hourly into the
    MOTD and `status.json`, and **both reboot paths refuse on their own `df`** - each re-checks
    `/boot` itself against its own `BOOT_MIN_MB=160`, independently of the battery. (Since
    2026-08-17 `bin/reboot-host.sh` hard-gates its pre-flight on `--greenboot` rather than the full
    battery, and prints the rest; that `df` is what still covers `/boot` there.)
  - **`rpm-ostree cleanup -r` removes TWO deployments, not one**, when something is staged: it takes
    the pending update along with the rollback (`deployment count change: -2`), and `greenboot.armed`
    then warns "only 1 deployment, nothing to roll back to" until another stages.
  - **AND THE UPDATE IT TOOK DOES NOT COME BACK ON ITS OWN.** This entry used to say "nothing is
    lost - `rpm-ostreed-automatic.timer` re-stages nightly", which was assumed rather than measured,
    and is false. After the 2026-08-16 `cleanup -r`, the next two automatic runs staged **nothing**,
    the later one exiting in 9 seconds, while a newer amd64 manifest sat on ghcr.io throughout.
  - **`cleanup -r` CANNOT RECLAIM A SLOT HELD BY A PENDING DEPLOYMENT**, which is the case that
    looks identical from `df` and is not. `-r` removes the **rollback**; a deployment that was
    finalized and then not booted sits at index **0**, is not a rollback, and the command exits 0
    reporting *"Deployments unchanged"*. Seen on 2026-08-18 with `/boot` at 26M. The remedy there is
    to **boot it** - see the GRUB fallback entry below - after which it becomes the booted
    deployment, the old one becomes a real rollback, and `cleanup -r` frees the 146 MB.

## The nightly OS updater can silently skip a real update

- **`rpm-ostree upgrade --check` CAN BE WRONG, AND THE NIGHTLY UPDATER BELIEVES IT.** This is the
  mechanism behind the entry above, and it was measured rather than reasoned about: on 2026-08-17,
  within the same minute, `rpm-ostree upgrade --check` reported *"No updates available"* (exit 77)
  and `sudo rpm-ostree upgrade` **staged an update immediately**. The tool warns about this itself -
  *"Note: --check and --preview may be unreliable"*, rpm-ostree issue 1579 - and the consequence is
  not cosmetic, because `rpm-ostreed-automatic.service` is driven by the same check and had
  therefore been skipping a real update every night, in 9 seconds, exiting 0. **So the host can stop
  taking OS security updates indefinitely while every signal reads green.**
  `deploy.update_timer` and `deploy.update_run` prove the timer is armed and that it ran; neither
  can see this, and both were green throughout. `deploy.image_digest` is the check that closes it -
  see the digest trap below, which is the part that is easy to get wrong. **The remedy is
  `sudo rpm-ostree upgrade` by hand**; it worked first try here, and neither `cleanup -m` nor a
  re-`rebase` was needed.

## Checks that could not see the thing they measured

- **`conduct verify` cannot tell a change that broke the gate from a gate that was already broken,
  and it reports both as the phase's fault.** It runs the full `make check` on base+commit in a
  pristine tree and has no reading of the base ALONE, so the two causes are indistinguishable in the
  only output it produces. Measured on the fleet's first real ship run, 2026-08-24: refused for
  `e2e/tests/records/file-download.spec.ts`, which **GitHub Actions reports green on the identical
  base commit** - including the very commit that added the test - and whose subject is a
  `Content-Disposition` filename that a diff of one file under `api/tests/` cannot reach. The
  approval card said the phase failed. It did not; the fleet runner and GitHub Actions disagree
  about that test, and nothing in this design can say so. **CLOSED 2026-08-24, and the sentence that
  used to end this entry was wrong.** It said a recorded base result was "only cheap as a by-product
  of something already running", which assumed the gate would have to run on every dispatch. It does
  not: the base is measured only when the head gate has ALREADY failed, and it rebuilds the same
  worktree, so `keep_untracked` survives and `make install` is a near no-op. A passing verification
  costs nothing at all; a failing one goes from ~14 minutes to ~20.
- **THE BASE COMMIT WAS THE ONE THAT ADDED THE FAILING TEST**, which is the whole finding in one
  line: `e2406a4f test(e2e): Cover the file upload and download round trip` sat directly under the
  phase's `e4aba978 test(api): Cover the cursor pagination primitives`. A test added on `main` was
  failing in the runner and passing in CI, and a pagination test was refused for it.
- **The comparison is the failing `make` TARGET, and the FIRST match in the log is the one that
  matters.** Make prints one line per level as a failure propagates outward, so `make[1]: *** [...:
  e2e-test] Error 1` precedes `make: *** [...: check] Error 2` and the outermost is always the
  uninformative one. Exit codes would have said `2` on both sides of every comparison; test names
  would have been a parser per test runner, three of them, against formats nothing here controls.
- **`None` IS NOT A TARGET AND MUST NOT MATCH ANOTHER `None`.** A gate killed by the 5400s ceiling,
  an OOM or a container that never started leaves a log with no make failure line at all, so
  `head_target == base_target` is True for two runs that each died of something nobody measured -
  and it reads as agreement, on the one code path that publishes without a passing gate.
  `dispatch.judge_base` is a pure function so that rule can be asserted without a container.
- **Measuring the base DESTROYS the head tree, because it rebuilds the same directory.** That is
  what makes it affordable and it inverts an ordering: the Playwright artifacts and the
  after-the-gate clean check are both read out of the head tree first, and written the obvious way
  round they would each come back empty and read as "nothing to report".
- **A cached gate result is keyed on the RUNNER IMAGE as well as the base.** The toolchain, the
  browser and the interpreters all live in that image and a timer rebuilds it, so a reading under a
  different image answers a different question - and no version string anywhere would have said so.
  A seven-day expiry sits on top, because `make install` resolves from the network under a lockfile
  that did not change.
- **This does not distinguish a flaky test from either cause.** A test that fails on head and passes
  on base still refuses and still blames the phase. A retry would hide flakes rather than find them,
  so there is none.
- **The pinned base held on its first live exposure.** `origin/main` advanced from `e2406a4f` to
  `6268220f` while that same run was in flight, and the diff stayed measured against the base the
  phase was dispatched with. That is the trap `run.base_sha` exists for, and it is the first time it
  had a chance to fire.
- **`verify.preserve` earned itself on first use.** The e2e refusal above left 4.8 MB of `trace.zip`,
  `video.webm` and `error-context.md` beside the log, out of a tree `reconcile` would have reaped
  two hours later. Without it the finding above would have been a one-line assertion message and the
  disagreement with CI would have been unprovable.
- **A CHECK THAT COUNTS THE UNIT EXECUTING IT WILL BLOCK THE REMEDY FOR ITS OWN CONDITION**, and
  `host.failed_units` did exactly that. `greenboot-healthcheck.service` is what execs
  `verify-host.sh --greenboot`, and a failed unit stays failed for the rest of the boot - so one red
  boot made that check FAIL for ever after, which made `--greenboot` exit 1, which made
  `bin/reboot-host.sh` and `bin/reboot-when-staged.sh` both refuse. **The reboot they were refusing
  is precisely what clears the runtime state.** Escaping it took `systemctl reset-failed` by hand on
  2026-08-16, after the underlying cause was already fixed. That unit is now filtered from
  `host.failed_units` **under `--greenboot` only**, which costs nothing: whatever made greenboot fail
  is measured by that same battery in that same run and reported directly, so the failed unit adds
  no information - it only carries a verdict past the point where its cause was repaired. At real
  boot time it is `activating` rather than `failed`, so the filter is a no-op there and only affects
  the later gated runs, which is where it bit. Same shape as the phantom units the rename left
  behind, and as the self-liveness trap `verify-host.sh` documents about its own timer.
- **THE HOURLY BATTERY SPENT THREE MINUTES A RUN ASKING EVERY REGISTRY A LOCAL QUESTION.**
  `update.policy_count` counted containers carrying an auto-update policy by running
  `podman auto-update --dry-run` - which contacts **every registry for every container** to work
  out whether a newer image exists. Measured 2026-08-18: **3m02s wall against 4.2s of CPU**, i.e.
  essentially the entire runtime of the battery, all of it network wait. Hourly, that is ~500
  registry round trips a day for a number that changes only when a quadlet does - and
  `bin/reboot-host.sh` runs the full battery in its pre-flight, so a human waited three minutes
  for it at the moment they wanted an answer. The policy is a **label**
  (`io.containers.autoupdate`, set from `AutoUpdate=`), so it reads locally in **0.055s**.
  - **It is now exact rather than `>= 20`**, with both sides derived from `stacks/` - the same
    authority `containers.units_active` and the topology lint use. A floor is a magic number
    someone has to remember when a service is added, and this one silently tolerated three
    missing policies.
  - **`podman ps -a`, deliberately**: `podman auto-update` only ever saw RUNNING containers, so
    the number read 21 instead of 23 while caddy and dashboard were down - moving for a reason
    that had nothing to do with what it claims to measure. Whether a container is running is
    `containers.units_active`'s question.
  - **`$repo` WAS READ SEVERAL HUNDRED LINES BEFORE IT WAS ASSIGNED**, found immediately after.
    It lived in the Checkout section, below two checks that now read it; under `set -u` the
    command substitution failed into an empty string and `update.policy_count` reported **"not
    measured"**. A check reading inconclusive from a variable that does not exist yet is the
    quietest way for one to stop measuring - it is not even a WARN. It is defined at the top now.
- **CADDY WAS DOWN FOR 35 MINUTES AND THE BATTERY REPORTED "22 containers up, none unhealthy".**
  The sharpest instance yet of the pattern this file keeps rediscovering, and it took every
  public service down while every signal read green. `caddy-build.service` failed on the
  truncated `policy.json`, so systemd skipped `caddy.service` entirely - *"Dependency failed for
  caddy.service"*. Three checks looked straight at it and none could see it:
  - **`containers.failed_units` counted zero, correctly.** A dependency failure leaves the unit
    `inactive (dead)`, **not `failed`** - there was nothing in a failed state to count. This is
    the one that looks like it should have caught it and cannot.
  - **`containers.healthy` counted what IS running.** A container that never started is not
    unhealthy, it is **absent**, and absent is indistinguishable from "not part of this stack".
    It cheerfully reported 22 up and none unhealthy while the number should have been 24.
  - **`routes.*` only runs under `--routes`**, which is not the hourly path.
  - **The fix is to compare against what SHOULD run**, and the expected set comes from the unit
    files in `stacks/` rather than a list in the script - a hand-maintained roster is the most
    driftable thing here and would need editing in lockstep with every new service.
    `containers.units_active` is that check. Verified by stopping a service: `failed_units` and
    `healthy` both stay green and only the new one fires.
- **`routes.ntfy` ASKED FOR `/`, WHICH IS NTFY'S PUBLIC WEB UI**, so it answered 200 whether the
  instance was deny-all or wide open. The check could therefore only ever FAIL on a correctly
  configured server, and could never have detected anonymous access being opened - a check that
  is wrong in both directions at once. The property lives on a **topic** path, where deny-all
  answers 403 to anonymous including for a topic that does not exist. Measured: `/` -> 200,
  `/home-server/json` -> 403, `/verify-host-probe/json` -> 403.
- **`ContainerRestartLoop` COULD NOT FIRE, AND HAD NEVER BEEN ABLE TO.** It read
  `home_server_container_restarts_total`, which the collector took from podman's per-container
  `Restarts` field - and a quadlet **recreates the container on every unit restart**, so the counter
  resets each time round a loop rather than accumulating. Measured against the one event it was
  written for: through all 6,224 of Pocket ID's restarts on 2026-08-19 the series read **0**, for
  nine and a half hours. The rule was `increase(...[1h]) > 5` against a gauge that is structurally
  pinned at zero. `source_units()` now reads systemd's `NRestarts`, which belongs to the **unit** and
  therefore outlives the containers it creates, and the rule is `UnitRestartLoop`. The old series is
  kept, because it does say one thing the new one cannot - a container restarting *without* its unit
  restarting - but its help text no longer claims to be the restart count. **The general shape: a
  counter that resets is not a counter, and the reset condition here was the exact condition being
  measured.**
- **`Restart=always` AT `RestartSec=5` CANNOT REACH SYSTEMD'S START LIMIT, SO NO UNIT HERE EVER GAVE
  UP.** The shipped ceiling is 5 starts in 10s; five-second spacing produces at most two, so the
  limit was arithmetically unreachable on all 23 quadlets and none of them set their own. Pocket ID
  oscillated between `failed` and `activating` 6,224 times over nine and a half hours rather than
  coming to rest. **This was NOT a detection failure and must not be recorded as one** -
  `containers.units_active` and `containers.failed_units` both went FAIL within the hour and stayed
  there, and `CheckFailing` went critical. What was missing was an end state: `StartLimitIntervalSec=600`
  with `StartLimitBurst=20` now stops it after ~100 seconds, which is what makes `home_server_unit_state`
  worth reading, and a slow dependency at boot still gets twenty attempts before it counts.
- **ALERTMANAGER WAS A DESTINATION AND NEVER A SCRAPE TARGET, SO THE LAST HOP TO THE PHONE WAS
  UNMEASURED.** It appears in `prometheus.yml` under `alerting:`, which makes it somewhere to *send*
  alerts - a different relationship from being collected from, and the two look alike enough in that
  file that nobody noticed. The consequence is precise: `alertmanager_notifications_failed_total` is
  exactly the 401-against-the-read-only-mount that `alertmanager.yml` warns about **in its own
  comments**, and it existed nowhere anything could read it. `AlertDeliveryFailing` covers
  Prometheus -> Alertmanager and was the only hop watched, of four.
  **It is also why 2026-08-19 cannot be reconstructed.** Four critical alerts fired continuously
  from 01:00 to 09:30; `ntfy-alertmanager` does not log the webhooks it receives, so there is no
  record on this host of whether a single page was delivered - and both counters that could have
  said so were reset by a restart before anyone looked. Now scraped, with `AlertBridgeFailing` and
  `metrics.alert_bridge`, plus a `Watchdog` that always fires at a 24h repeat so a **silent** phone
  means a broken chain rather than a quiet stack.
- **THE ONE JOB THAT PROVES THE BACKUPS RESTORE WAS THE ONE JOB WITH NO RECORD.** Every other leg
  writes a marker and `verify-host.sh` grades it - `local_at`, `offsite_at`, `offsite_pruned_at`,
  `offsite_policy_ok_at`, `tsdb_snapshot_at`, `pre_update_db_at`. `bin/verify-restore.sh` wrote
  nothing, so "nobody has run this since March" and "this ran last night" were the same observable
  state. CLAUDE.md states the rule in the abstract - an automated job needs a durable record of its
  last success - and this was the job it had never been applied to. **`RestoreNeverProven` keys on
  the CHECK and not on the marker's age**, because a staleness rule needs the series to exist and the
  state that has to be covered is a marker never written at all.
  **Running it immediately found something.** `bin/verify-restore.sh` with no arguments verifies the
  WORKSTATION's copy at `~/backups/home-server` - the third copy, written by hand by
  `bin/backup-config.sh` - and its newest snapshot was **2026-08-15**, four days old and predating
  ntfy, so it FAILed on a missing `ntfy/auth.db`. Nothing tracks the freshness of that third copy:
  `offsite_pruned_at` records the workstation's *prune*, and there is no marker for the copy itself.
- **A DUMP OUTLIVES ITS OWN ACCURACY, AND TWO CORRECT DECISIONS ARE WHAT MAKE IT DO SO.**
  `windmill-db` is Postgres, so it is excluded from the file copy and captured by `pg_dumpall` into
  the shadow tree instead. Two properties that are right on their own combine badly: the shadow tree
  is **deliberately never deleted** between runs, so restic only transfers what changed, and
  `--filter='protect /windmill-db/'` **deliberately keeps last night's staged copy**, so
  `--delete-excluded` cannot remove it. Together they mean that if the database stops, its last dump
  stays in both places and is re-snapshotted every night, **indefinitely, looking exactly like a
  fresh one**. A restore verification would pass on it a year later.
  The split is the fix, and it is why the two halves live in different scripts on different machines:
  `bin/verify-restore.sh` asserts only that a dump EXISTS and is whole - present, ends with
  pg_dumpall's own `-- PostgreSQL database cluster dump complete`, carries a `CREATE ROLE` - and says
  nothing about age. `backup.windmill_dump_age` asserts recency, on the server, because that is the
  only place where "is the container even running" can be answered. **The marker is therefore written
  by `bin/snapshot-databases.sh` and only on a real dump**, never on a skip: it is the one place that
  can tell the two apart, since the exit status cannot and neither caller can.
  It also NOTEs rather than warns when `windmill-db` is down, because a stopped database is
  `containers.units_active`'s finding and a second WARN would only block the reboot window over
  something a reboot does not fix.

- **And `LoadState` cannot tell you whether that unit file exists.** Found on 2026-08-21 while
  teaching `conduct` to place itself in the slice: **systemd SYNTHESISES slice units on demand**, so
  `systemctl --user show app-agents.slice -p LoadState` returns `loaded` on a workstation that has
  never heard of it, while a missing `.service` on the same machine correctly returns `not-found`.
  The discriminator is `FragmentPath`, which is empty exactly when no file backs the unit. This is
  the same fact as the entry above seen from the querying side: there is nothing to fail, so nothing
  fails, and the obvious check reports success.

- **`systemctl show` reports a unit that does not exist as `inactive`, with exit status 0.**
  Identical output to a real unit sitting idle - `LoadState=not-found` is the only difference, and
  nothing forces you to ask for it. So any hand-maintained list of units to watch is a check that
  stops working silently the moment a name is renamed or misspelt: it reads "nothing is busy" for
  ever and can never fire. `conduct`'s refusal cascade fetches `LoadState` and `ActiveState` in one
  round trip for that reason, treats `not-found` and `masked` as faults in the LIST rather than as
  states of the host, and `conduct doctor` resolves the whole watchlist on demand. **The faults are
  reported and never refused on**: a wrong name must be loud without wedging the fleet, which would
  trade a blind gate for a stuck one. `is-active` is worse and not the fix - its exit codes are not
  uniform, 3 for real-but-inactive against 4 for missing.

- **Asking `rpm-ostree` a question starts the daemon you were asking about.**
  `rpm-ostreed.service` read `inactive`; after a single `rpm-ostree status` it read `active` /
  `running` and stayed that way. It is D-Bus-activated, so **a monitor polling that unit's
  `ActiveState` to decide whether an OS update is in progress flips itself to "busy" on its own
  first poll**, and then stays busy. The question that survives being asked is the `transaction`
  field in `rpm-ostree status --json` - `null` when idle, however often it is read - or the
  `ActiveTransaction` property on the Sysroot object. `rpm-ostreed-automatic.service` is safe to
  poll and is the complementary signal, being the unit that actually stages a deployment.

- **Two `RemainAfterExit` oneshots read `active` for the entire boot while being permanently idle**:
  `greenboot-healthcheck.service` and `ostree-remount.service`. That is the exact mirror of the
  oneshot trap `bin/reboot-when-staged.sh` records - there a oneshot was `activating` for its whole
  working life and never `active`; here one is `active` for the whole life of the boot having
  finished in seconds. Anything treating `active` as busy would refuse for ever, so `conduct` keeps
  an explicit never-watch list with a test rather than widening its allowlist.

- **A `Slice=` naming a slice with no unit file does not fail - systemd instantiates it with
  defaults, and every signal reads correct.** `host/systemd/app-agents.slice` is the aggregate
  ceiling the coding-agent fleet runs inside, and the only thing that bounds it: its phase runners
  are `podman run --rm`, so their count is a variable and no sum of per-unit ceilings can reach it.
  If the unit file is not symlinked into `~/.config/systemd/user/`, systemd creates the slice
  anyway, with no limits at all - and every member then starts, stays healthy, stays fully observed
  by Prometheus and is contained by nothing. **This is the `io`-delegation failure one directive
  over**, which was inert here for months for the same reason: the directive is accepted and does
  nothing. `agents.slice_limits` is what closes it, and it reads `memory.max`, `memory.high`,
  `cpu.max`, `io.weight` and `pids.max` back out of the cgroup rather than out of the unit file -
  `systemctl --user show` would report what the file SAYS, which is the half that was never in
  doubt. It asserts they are *set*, not their exact figures, because an exact assertion would be a
  second copy of the slice in a place nothing reconciles. Unlimited spells itself differently per
  controller and all five spellings were read off this host: `max`, `max`, `max 100000`,
  `default 100`, `max`.
  **The symlink loop in `host/systemd/README.md` globs by EXTENSION, which is its blind spot.** It
  was `*.service *.timer` and was widened to `*.slice` in the same commit. A glob cannot drift
  within the extensions it names and is completely blind outside them - and the README's own
  argument for globbing ("a glob cannot drift") reads as though it covers this, and does not.
- **The collector's cgroup join was flat, so the first unit ever placed in a slice would have gone
  dark.** `bin/collect-metrics.py` built one path, `CGROUP + "/" + unit`, where `CGROUP` ends in
  `app.slice` and `unit` is podman's own `PODMAN_SYSTEMD_UNIT` label. `Slice=app-agents.slice` puts
  the cgroup one level deeper, `os.path.isdir` misses, and the container is counted in
  `home_server_container_identity_unresolved` and otherwise dropped. **What is lost is 32 of
  `windmill-db`'s 43 series** - working set, rss, cache, the inactive/active split,
  pgscan/pgsteal/refault, both memory ceilings, all four `memory.events`, CPU, PSI for three
  controllers, `io.stat` per device, pids. The 11 that survive are the ones `podman ps` and
  `systemctl` answer, so the container looks entirely normal on every other signal.
  `_unit_cgroup()` resolves it: the flat path first, so nothing that resolves today can move, then
  **one level** of `*.slice`. One level rather than a walk because systemd derives the hierarchy
  from the dashes in the name, so the depth is knowable - and because a recursive search would also
  match the `libpod-payload-<id>` cgroup nested INSIDE the directory being looked for, which is a
  different set of numbers that would look entirely plausible.
  **Not `/proc/<pid>/cgroup`, which is the obvious authoritative answer and is wrong here.**
  `torrent-infra` reports the POD's cgroup, `user@1000.service/user.slice/user-libpod_pod_<id>/...`,
  which contains its unit name nowhere; the flat join resolves it to `app.slice/torrent-pod.service`,
  the unit's own cgroup. Switching would have silently changed what the four pod members' numbers
  mean while every one of them kept reporting.

- **"A container" meant "a quadlet" everywhere, and six readers each assumed it away differently.**
  `conduct` starts its phase runners and their datastores with `podman run --rm`: no
  `PODMAN_SYSTEMD_UNIT`, a lifetime of minutes, and a name carrying a worktree id. Measured with one
  throwaway busybox on `net-agents`, against the code as it stood: `home_server_container_identity_
  unresolved` went 0 -> 1 (a counter whose help text says that means the join has broken, and which
  the Services page renders as *"N container(s) could not be mapped to a systemd unit, so they are
  absent from this table"*); `home_server_containers` went 25 -> 26; `containers.healthy` reported
  *"26 containers up"*; and two `home_server_container_network_*` series appeared labelled with the
  throwaway's name. **The `container` label had exactly twenty-five values and had never grown.**
  The skips are keyed on the PRESENCE of `io.home-server.ephemeral`, never its value: a bare
  `--label io.home-server.ephemeral` yields `""`, and a truthiness test would read that as "not
  ephemeral" and silently restore all of it. `podman ps --filter label=<key>` matches on presence
  too, so the shell and the Python agree without either restating the rule.
  **The two collector skips look identical and are different bugs.** `source_containers` already
  emitted nothing for an unlabelled container, so its damage was purely the lying counter;
  `source_container_network` has no unit check at all, so its damage is real cardinality - and
  retention here is **400 days** while `metrics.series_count` grades `prometheus_tsdb_head_series`,
  live series only, compacted out after about two hours. **The budget check cannot see persisted
  churn**; only `metrics.tsdb_size`, at its 18 GB ceiling, would ever notice.
- **Three of those seven readers are closed by a flag rather than by code, and that is the better
  fix.** `containers.healthy`, `containers.probe_binaries` and `logs.healthcheck_events` all read
  the health *state* of whatever `podman ps` returns, and only misbehave when a container inherits a
  `HEALTHCHECK` from its base image - which the fleet's datastores plausibly do and nobody controls.
  `--no-healthcheck` on every `podman run` `conduct` issues closes all three at the source, where
  three defensive filters would each have to stay correct for ever. **`containers.healthy` is
  filtered as well anyway**, because it is the only one of the seven whose failure is a FAIL rather
  than a WARN, and a FAIL blocks `bin/reboot-host.sh` and therefore an OS security update.
  **`grep -vxF ""` matches every line**, so the subtraction has to short-circuit when nothing is
  ephemeral - otherwise the normal case filters out all twenty-five containers and PASSes with
  *"0 containers up, none unhealthy"*. The failure appears only when nothing is wrong.
- **DO NOT "FIX" THE SKIP BY GIVING A RUNNER A UNIT LABEL.** This is the trap the skips create and
  it is invisible for thirty days. `apps/dashboard/src/pages/SystemPage.vue` renders the **worst
  five** containers by 30-day availability, sorted ascending on
  `avg_over_time(home_server_container_running[1h])`. A runner that lived twenty minutes and emitted
  that series would score about 0% for its day, **evicting a real row from the strip for a month** -
  and the next runner would evict another. The strip's own sizing comment says "twenty containers",
  which is the assumption that quietly stops holding. Runners must stay absent from
  `home_server_container_running` entirely, which is what the skip in `source_containers` guarantees.
- **A WINDMILL WORKER'S TAGS ARE UNVERSIONED STATE THAT HOT-RELOADS, so the one-verify-lane
  invariant does not live in the file named after it.** `windmill-worker-verify.container` carries
  `WORKER_TAGS=verify`, and that is a **bootstrap**: Windmill keeps worker-group configuration in
  its `config` table - which ships with `worker__default`, `worker__native` and `worker__reports`
  already seeded, each holding an explicit `worker_tags` array - and workers watch that table and
  reload from it. Create a `worker__verify` row from the UI and it **wins, at run time, with no
  restart, and `git diff` shows nothing**. Measured with a throwaway worker before either unit
  shipped: with no such row, `WORKER_TAGS=verify` produces `custom_tags={verify}` and no row is
  auto-created - so the bootstrap works today and would be silently superseded tomorrow. One file
  enforces one container; it does not enforce what that container listens to. `agents.worker_lanes`
  reads `custom_tags` back out of the database hourly, which is the same argument
  `agents.slice_limits` makes one level up. Note also that **advertising a tag is not the same as
  being able to select it**: `global_settings.custom_tags` is Windmill's "Assignable Tags" and reads
  `["chromium"]`, so routing a flow step to this lane needs the tag added there too.
- **A WINDMILL WORKER SERVES NO HTTP, so the probe every other unit here uses does not exist - and
  the failure it would have to catch is invisible to every other reader.** `windmill --help`, read
  out of the image, documents `PORT` as the "**server**/indexer/MCP" port and `METRICS_ADDR` as EE
  only; the binary contains no `healthz` route. A worker does start an HTTP server, on a **random**
  port bound to `127.0.0.1` - measured at 42881 - which is unreachable and unpredictable. The
  tempting answer is no healthcheck at all, where `duckdns` and `unpackerr` sit. It is the wrong one
  here: these units follow a floating **patch** tag and are restarted nightly, so without
  `Notify=healthy` the auto-update rollback is decorative, and what it would miss is a worker that
  starts, registers nothing and takes no jobs - **no unit failed, no container unhealthy, nothing in
  `podman ps`, and work simply queues**. So the probe is a `psql` query asserting a fresh row in
  `worker_ping`, which makes it the only health probe on this host that asks a **second** container
  whether the first one is doing its job. `psql` is safe to depend on for the reason `curl` was in
  `windmill-server`: upstream installs `postgresql-client` **by name** in its final runtime stage.
  Two things it deliberately does not do - it does not assert the tags (that would fail a start
  after a UI change and roll back an image that was never the problem), and it does not use
  `$DATABASE_URL`, because systemd expands `$VAR` in the generated `ExecStart` from
  `EnvironmentFile=` **only**, and `DATABASE_URL` is assembled in `[Container]`, so it would reach
  podman as the empty string.
- **`worker_ping` HOLDS A ROW PER WORKER *NAME*, AND THE NAME IS REGENERATED ON EVERY START**, so
  anything that counts rows over-counts for the whole freshness window after a restart - including
  every nightly `podman auto-update`. Windmill mints `wk-<group>-<host>-<random>` at boot and never
  deletes the old row; it only goes stale. Measured immediately after a deliberate restart: two
  containers running, **four** fresh rows, and `/api/health/status` reporting `workers_alive:4`.
  `agents.worker_lanes` was written the obvious way and duly reported the verify lane as *"drifted
  to [verify verify]"* - a check firing on the thing working, which is the failure mode that gets a
  check switched off. It asserts the **set** of tag lists per lane now, never the count; the count
  is a property of there being one quadlet file per lane and `containers.units_active` already
  covers it.
- **A `chcon` is what lets a phase read its own worktree, and nothing versions it.** The runner
  bind-mounts the worktree with neither `:z` nor `:Z`: `:z` relabels the *source*, which by the
  second phase holds a 607 MB venv and a 368 MB `node_modules`, and `:Z` locks out every other
  container mounting the same tree. So the fleet root is relabelled once by hand and SELinux type
  inheritance carries it - **measured, not assumed**: a file created under a `container_file_t`
  directory comes out `container_file_t` whether `conduct` creates it from the host as
  `unconfined_t` or a phase creates it from inside a container. `chcon` is not durable, though: a
  `restorecon -R /var` or a relabelling reboot resets the tree, every phase then dies on a
  permission error naming SELinux nowhere, and `git diff` shows nothing because the label was never
  in git. The durable form needs `semanage`, in a package this host's rules argue against layering,
  so `agents.fleet_root_label` is what says the label has been undone.
- **`--security-opt label=level:s0` was specified to fix a trap this design does not have, and
  shipping it would have made containment WORSE.** The premise was that podman assigns each
  container a random MCS pair, so run 2 gets EACCES on a venv run 1 wrote - a failure that appears
  only on the second run and reads as corruption rather than as permissions. Measured over four
  consecutive containers with pairs `c540,c855` / `c85,c222` / `c38,c807` / `c42,c357`: **every file
  each one created came out `container_file_t:s0` with no categories at all, and every run read
  every earlier run's files.** The categories come from `:Z`, which relabels the mount source with
  the container's pair - the control case produced `container_file_t:s0:c282,c750` - and this design
  uses neither `:z` nor `:Z`. So the flag would have bought nothing and cost the per-container MCS
  separation that is there for free. Dropped, on the measurement, exactly as `BASE_INTERNAL_URL`
  was.
- **`isolate=true` blocks more than "other podman bridges", and the plan asserted the weaker
  claim.** It was written down that an agent could reach `https://192.168.0.100/` and everything
  Caddy fronts, because a host publish is not a bridge. Measured from an isolated bridge against a
  plain one: **Caddy's 443 and Jellyfin's 8096 both time out on the isolated network and both
  connect on the plain one.** Reaching a published port at the host's LAN address DNATs into the
  owning container's bridge, so it is a bridge-to-bridge flow after all. What is genuinely not
  blocked is the host itself - port 22 is **refused** from both, which means the packet arrived -
  and the internet, which is what makes `bun install`, `uv sync` and `gh` work at all. Read the
  distinction the way `docs/networking.md` insists: **124 from `timeout` is a blocked edge, 1 is a
  shut port.**
- **`Persistent=true` does not cover the first install, and a unit comment here claimed it did.**
  `systemctl --user enable --now` writes `~/.local/share/systemd/timers/stamp-<timer>` immediately,
  so there is no missed elapse to catch up on and the timer does not fire - measured, with the stamp
  dated the second the timer was enabled and `list-timers` showing `LAST -`. Harmless for every
  other timer here, because each built image is pulled into the dependency graph by a `.container`
  that names it. **Nothing references `conduct-runner`**, so on a host that has never run that unit
  the phase runner image does not exist and nothing produces it before the first Saturday - at which
  point `conduct` has no `:latest` to run. The one-time `systemctl --user start` is part of the
  setup in `host/systemd/README.md`, beside the symlink loop.
- **`Nice=` cannot be set on a transient scope**, and `systemd-run` says so with `Unknown assignment:
  Nice=10` rather than ignoring it - which is the good outcome, since the phase runner's whole
  invocation would have failed to start. It is an exec property, and a `--scope` is not started by
  systemd; the process is the caller's. `nice -n 10 podman run ...` is the replacement, and the same
  applies to every other exec-context directive somebody is tempted to pass with `-p`.
- **A read-only rootfs turns every cache environment variable into a required mount.** The runner
  image sets `UV_CACHE_DIR`, `BUN_INSTALL_CACHE_DIR` and `PLAYWRIGHT_BROWSERS_PATH` to fixed `/opt`
  paths precisely so they are mountable, and with `/opt/bun-cache` left unmounted `bun add` dies
  with `bun is unable to write files to tempdir: ReadOnlyFileSystem` - naming neither the variable
  nor the path, and reading as a broken image rather than as a missing `-v`.
  `bin/conduct-runner-smoke.sh` runs one `bun add` to cover the whole class.
- **`node:24-trixie-slim` ships no `python3`, no `git` and no `make`** - `ca-certificates curl wget
  gnupg dirmngr xz-utils libatomic1` is the entire apt list, read out of `nodejs/docker-node`'s own
  Dockerfile. Six of upskald's eight `make check-gate` targets shell out to `python3`, so the
  obvious base image fails the gate at its first line. Every import in those scripts is stdlib, so
  one apt package settles it and there is no pip layer. Trixie also renamed `libmagic1` to
  **`libmagic1t64`** in the 64-bit `time_t` transition, and `api/pyproject.toml` depends on
  `python-magic`.
- **Two writers share one exposition file, and a name collision rejects THE WHOLE SCRAPE.**
  `bin/verify-host.sh` records facts; `source_status` in `bin/collect-metrics.py` mints
  `home_server_<fact key>` for every numeric one; and that file's own `m.add()` names land beside
  them. Prometheus tolerates a duplicate sample whose value matches and rejects the entire scrape
  when it does not - and these two disagree by construction, because the battery is hourly and the
  collector runs every thirty seconds. So the failure is not one wrong panel: it is every metric on
  the host disappearing, waiting on whichever pair of samples first drifts apart. The collector
  carries `FACT_OWNED_ELSEWHERE` for the one collision it wants, and that comment records how the
  trap was found - "by reading the exposition rather than by the check, which stayed green
  throughout". **`bin/lint-repo.sh` leg 9 is now that check**, statically, because the runtime
  version needs the two writers to disagree first.
- **The battery's agent facts and the collector's agent metrics are ONE LETTER APART.** The facts
  are `agents_*`, plural, and become `home_server_agents_*`; the collector's family is
  `home_server_agent_*`, singular. Two files, neither mentioning the other's spelling at the point
  it matters, and the penalty for confusing them is the entry above.
- **A lint leg that greps for `m.add("literal")` cannot see a name built by concatenation**, and the
  first version of leg 9 proved it by passing with a deliberate collision planted in front of it.
  Most names in `bin/collect-metrics.py` are built as `"home_server_agent_" + suffix` inside a loop,
  so the grep captures the PREFIX and never the name. The leg reads every `home_server_` string
  literal instead and treats one ending in `_` as a prefix that shadows every key beneath it -
  **except the bare `home_server_`**, which is `source_status`'s own bridge and, left in, matches
  every candidate and fails all ninety. Passing on everything and failing on everything are the same
  uselessness in opposite directions, and the negative control is what tells them from a check that
  works.
- **`ActiveState` reads `active` for a long-running unit whether it is busy or idle**, which is the
  exact mirror of the trap `bin/reboot-when-staged.sh` already carries about `home-server-backup`:
  a `Type=oneshot` is `activating` for its entire working life and never `active`. Both are the
  obvious question to ask systemd, both read correctly, and both are dead. So the phase-in-flight
  refusal reads a marker `conduct` writes about itself - **and only believes it while the heartbeat
  is fresh**, because a conduct killed mid-phase leaves the flag set for ever and a stale veto is
  the "host silently stops taking OS security updates" failure from a fourth direction.

## The orchestrator, and four assumptions its first live run contradicted

**`Environment=` does not expand `${VAR}` from `EnvironmentFile=`, and the failure is silent.**
The obvious unit - `EnvironmentFile=/var/home-server/.env` plus
`Environment=CONDUCT_STATE_DB=${DOCKER_VOLUME_CONFIG}/conduct/conduct.db` - hands the process that
dollar-sign string verbatim. Measured with a throwaway unit on the host: `$DOCKER_VOLUME_CONFIG`
read correctly in `ExecStart=` and the interpolated `Environment=` value came through as the literal
`${DOCKER_VOLUME_CONFIG}/conduct/conduct.db`. Expansion happens in `ExecStart=` and nowhere else.

What makes it worth an entry rather than a fix is which direction it fails in. `os.makedirs` on a
path beginning `${DOCKER_VOLUME_CONFIG}` does **not** raise - it creates a directory of that literal
name, in whatever the working directory happens to be. So the state database would have existed, and
been written, and been outside the tree `bin/snapshot-databases.sh` walks, and nothing anywhere would
have reported a problem. Units here pass no interpolated `Environment=`; the program reads
`DOCKER_VOLUME_CONFIG` and `DOCKER_VOLUME_CACHE` itself.

**A detached `podman run` lands outside `app-agents.slice`, and the runner does not.** Read out of
`/proc/<pid>/cgroup` during a live phase: the phase runner resolves to
`.../app.slice/app-agents.slice/conduct-check-<id>.scope/libpod-<id>.scope`, because it runs under a
transient scope with `--cgroups=split`; its three datastores resolved to
`.../user@1000.service/user.slice/libpod-<id>.scope`, outside the fleet ceiling entirely. They have
no scope, so they need `--cgroup-parent=app-agents.slice`, and an aggregate limit with three
unaccounted members underneath it is worth having only if it says so.

That flag has the failure mode this repository already names one directive over: **if the slice is
not loaded, podman creates a transient slice of that name with no limits at all, silently.** Which
is why `agents.slice_limits` reads the limits back out of the cgroup and never out of the unit file.

**`--name` is not a DNS alias.** A gate run inside a namespace addresses its datastores by the bare
names its compose file uses - `db`, `redis`, `mailpit` - and a container started as `<id>-db`
answers to `<id>-db` and to nothing else. Without `--network-alias` every connection fails on a name
that does not resolve, in a namespace that never loads the file those names come from. The mirror of
the `torrent:<port>` lesson: a name proves one address and the unit files look identical either way.

**An environment variable that a config file uses VERBATIM is a different hazard from one it
derives.** `playwright.config.ts` falls back to a derived `E2E_REDIS_URL` on logical database **1**,
but uses an environment `REDIS_URL` exactly as given. Passing the dev URL - database 0 - collapses
the split that isolates the e2e suite from everything else, and every test still passes while doing
it. The runner passes `/1` explicitly, and `SMTP_HOST`/`SMTP_PORT` are the same family one variable
over: overriding only the host yields a name that resolves and a port that refuses.

**A safety guard that keys on "is the database on loopback" refuses inside a container namespace.**
upskald's `api/scripts/seed_demo.py` deliberately uses the narrow `LOCAL_DATABASE_HOSTS`
(`127.0.0.1`, `::1`, `localhost`) rather than the wider set that admits `db`, and its comment gives
the reason: *"This runs on the host, where the DSN `provision_database` resolves names a loopback
address, so it gains nothing from `db`."* **That premise is exactly what a phase runner breaks** -
the whole gate runs inside the namespace, so `db` is the address. Six tests fail with `assert 1 == 0`
and the refusal is only in captured stderr. Proved to be environment-specific rather than a broken
test: `database_is_local` returns `(True, '127.0.0.1')` for the workstation's URL under both sets,
and `(False, 'db')` under the narrow set for the runner's.

**THE RECONCILER REAPED A LIVE VERIFICATION, 27 SECONDS BEFORE IT FINISHED**, and `conduct/dispatch.py`'s
own module docstring names the hazard it walked into. That docstring says the lease is claimed with
*conduct's* pid rather than the phase's, because building the network and three datastores takes a
minute or two and a lease with a dead pid looks stale to the reconciler. Twelve lines later,
`set_pid` **overwrote** it with the container's. So the setup window was covered and the teardown
window never was: from the moment a gate process exits until the run row closes, the lease pointed at
a dead pid - and that branch of `reconcile.run` has **no `REAP_AFTER_SEC` grace at all**, deliberately,
because a stale lease is what makes everything under it an orphan.

Measured 2026-08-24 on a live run, not reasoned about: at 17:49:49 it released the lease, tore down
the network and datastores and deleted the worktree, on a verification that finished at 17:50:16. It
did no damage **only because everything after the gate reads staging and the database rather than the
tree**. The window had been seconds; the base-gate measurement had just widened it to minutes -
`preserve` copying 6 MB of artifacts, the clean check, the tree rebuild and the datastore
recreation all sit between the two gate runs. Ninety seconds earlier it would have torn the
datastores out from under the base gate, and **a false "the base is red" would have been cached for
seven days** - the one lie that makes verify publish what it should refuse. `pid` is conduct's own
and outlives the run; `runner_pid` is the container's. Neither reader needed changing.

**A PERSON CAN ANSWER A STEP THAT BELONGS TO conduct, AND NOTHING ON THE SERVER CAN STOP THEM.**
Windmill renders every suspended step as an approval form, so conduct's own waiting steps carry an
Approve button - and on 2026-08-24, nine minutes into a gate run, one was pressed. `conduct_verify`
was resumed with no payload, raised `conduct did not succeed: None`, and the flow completed as a
failure while the verification behind it still had fifteen minutes to run. The summary above that
button read *"declare the wait for the verification"*, which says nothing about whose step it is,
and **the record cannot tell either**: conduct resumes with a token belonging to the same account,
so the approver reads `avs` whichever answered.

**Both server-side fixes were measured on a scratch flow, and both failed.** conduct resumes on
`POST jobs/flow/resume/{id}` - `resumeSuspendedFlowAsOwner` - and a UI click goes through the
approval path; the two are different endpoints and the record proves it, conduct's resumes landing
as `resume_id: 0` and a person's as a non-zero id. So a constraint binding one and not the other was
exactly what was needed:

| constraint | conduct's owner resume | a person clicking Approve |
|---|---|---|
| `user_groups_required`, group with no members | worked, `resume_id: 0` | **allowed**, `resume_id: 22534` |
| `self_approval_disabled: true` | worked, `resume_id: 0` | **allowed**, `resume_id: 50739` |

**Neither binds a workspace admin, and this workspace is one seat which is an admin.** There is no
group `avs` can be kept out of, and `self_approval_disabled` did not stop the account that started
the run. The only route left is a separate Windmill identity for conduct - a service user, a second
token in sops, and a credential whose expiry wedges the fleet - to guard against one accidental
click. **Declined, and written down so it is not re-measured.** What shipped is a `DO NOT APPROVE`
summary on every conduct step, a `resume_form` so there is no bare button, and a refusal that names
the mistake instead of blaming conduct.

**ONE DEAD FLOW JOB STOPPED THE WHOLE FLEET FOR TWO HOURS, AND THE RUN IT SILENCED WAS THE ONE THAT
FOUND IT.** The verification above finished anyway and pushed its branch, then could not deliver its
report - `500 Error: parent flow job not found`. That retry pass sits at the TOP of `poll.cycle`,
ahead of the notification sweep and the dispatch pass, and was unguarded, so every cycle failed
until `reconcile` forgot the row at `REAP_AFTER_SEC`. Three things fix it and each is a rule rather
than a patch: the loop is per-row; terminal is decided by ASKING (`type == "CompletedJob"`) rather
than by matching a Rust error string, and is false on any doubt including its own failure; and the
row closes into `undeliverable_at` rather than `resumed_at`, because whether an answer was delivered
is the one thing that table exists to know. `dispatch_forget` could not be reused - it carries
`AND payload IS NULL` precisely so nothing can drop a computed answer.

**A HALF-GRANTED TOOL COST A WHOLE RUN, AND THE PHASE REPORTED SUCCESS.** `--tools` named `Bash`
and not `BashOutput`. The Bash tool offers `run_in_background`, a gate run takes minutes, so a ship
phase backgrounded `make lint type-check` - and then had no first-class way to read the result, so
it never did:

```
make -C ... lint type-check   ->  "Command running in background with ID bopas403w"
...  BashOutput never called, bopas403w never read  ...
git add api/tests/api/test_pagination.py && git commit
```

The commit carried three `basedpyright` `reportCallIssue` errors and the phase answered
**`status: done` with an empty `concerns` list**. `verify` refused it in 91 seconds - `type-check`
runs before `e2e-test`, so the failure came early and the base gate was a cache hit. Adding
`BashOutput` grants nothing new: it reads the output of a Bash call the model already made and that
`hooks/deny.py` already saw. **The lesson generalises past this tool** - granting a capability
without granting the thing that observes its result is a grant that fails silently and expensively.

**AND THE VERDICT IS ONLY AS GOOD AS THE PHASE'S OWN KNOWLEDGE, WHICH IS WHY NOTHING READS IT.** An
earlier run of the IDENTICAL task added the `# type: ignore[call-arg]` that basedpyright wants and
reported it as a concern; this one omitted it and claimed none. Same task, same model, same prompt,
opposite self-assessment - and the only thing that told them apart was a gate run on a tree neither
phase could write.

**A REFUSAL FOR THE RIGHT REASON, PROVED BY THE COMPARISON REFUSING TO EXCUSE IT.** Head failed
`type-check`; the base is red on `e2e-test` and not on `type-check`. Different targets, so the base
did not account for it and the change was correctly blamed - which is the row of that table that
protects the fleet from publishing its own mistakes under cover of somebody else's.

**It is a hand run that exposes this, and only a hand run can.** `serve` reconciles and verifies in
one process, so it cannot reap a lease it is itself holding - but `docs/agents.md` explicitly tells a
reader to run `conduct run` by hand while `serve` is looping, and that is two processes with one
database between them.


## The gate the fleet was going to trust, and six ways it was not a gate

- **RUNNING GIT IN A DIRECTORY IS RUNNING ITS OWNER'S CODE, AND TWO OF THE CALLS ALREADY SHIPPED.**
  A repository's own `.git/config` is executable surface and only three options are
  protected-config-only (`safe.directory`, `safe.bareRepository`, `uploadpack.packObjectsHook`).
  `core.fsmonitor` is a pathname git execs on any index refresh, so `git status` runs it;
  `core.hooksPath` and `.git/hooks/*` fire on checkout, commit and push; `diff.<driver>.textconv`
  fires on `git diff`; and `remote.<name>.url = ext::sh -c '<payload>'` fires on `git fetch`,
  because `protocol.ext.allow` defaults to `user` and a direct invocation leaves
  `GIT_PROTOCOL_FROM_USER` unset. The phase worktree is mounted `:rw` **including `.git`**, and
  `conduct`'s `prepare_worktree` runs `fetch --all` and `checkout --force` **as `core` on the host**
  - so a `--cap-drop=ALL --read-only` container on an isolated network with no podman socket was
  escapable by the routine whose purpose is not to trust that directory. **It needed no model
  phase**: `make install` runs `uv sync` and `bun install` against lockfiles the branch controls, one
  postinstall is enough, and because worktrees are reused it fires during a *later, unrelated* run
  with nothing in the log naming git. The fix is to remove `.git/hooks` and `.git/info` and rewrite
  `.git/config` from a template before the first git command; `git -c core.fsmonitor= -c ...` per
  call is whack-a-mole against an open-ended list where a miss is silent. Rewriting `config` also
  neutralises the tree-level half, since a `.gitattributes` naming `filter=evil` is inert once no
  `filter.evil.clean` is defined.
- **A DIFF IS ONLY AS TRUSTWORTHY AS THE REF IT IS MEASURED AGAINST.** `git merge-base HEAD
  origin/main` resolves `refs/remotes/origin/main` **in the worktree being inspected**, so one
  `git update-ref refs/remotes/origin/main HEAD` makes the merge-base equal HEAD, empties the diff
  and passes every protected-path check - with `git status --porcelain` clean throughout, because
  refs are not tree state. The first version of the gate-file check was defeated by a command that
  touches none of the files it inspects. Proved on the host: the worktree's own merge-base was
  forged to its HEAD and the refusal still landed, because the base is read from a bare repository
  only the orchestrator writes.
- **`git clone --local` HARDLINKS THE OBJECT STORE.** Measured: `stat` reports `links=2` on one
  inode reachable from both the mirror and the clone. With `.git` inside a writable bind mount, one
  `printf > .git/objects/pack/*.pack` inside a container corrupts the mirror every future clone -
  and every "pristine" verification tree - is built from, and it surfaces later, in an unrelated
  run, looking like a git bug rather than an attack. `--no-hardlinks` costs 13 MB here. The
  docstring that had to be corrected said the hardlinks "cost almost nothing", which was true and
  was the hole.
- **A RECEIPT ITS OWN SUBJECT CAN MINT IS NOT EVIDENCE.** `scripts/pr_quality_gate.py record` with
  no arguments writes `squash=done review=pass make_check=pass`, and nothing cross-checks those
  three strings against a run that happened. It is keyed to `head_sha` alone and never to the tree,
  so an edit after recording leaves it valid. The bypass hole everyone looks for is beside the
  point: an agent does not need to defeat that gate, it can satisfy it with one command the ship
  skill already tells it to run.
- **A HOOK WHOSE COMMAND CANNOT BE FOUND FAILS OPEN.** Measured against Claude Code 2.1.238, which
  the documentation does not cover: a `PreToolUse` hook supplied through `--settings` whose command
  does not exist lets the tool call **proceed**. So a hook can be a guardrail and never a boundary,
  and "python3 moved in the base image" or "the policy never got staged" produce a phase running
  unguarded that says nothing about it. Two things that ARE reliable, measured the same way:
  `--settings` hooks and project hooks both run on the same matcher, and a `deny` in `--settings`
  blocks a command project settings tried to allow. **`permissions.deny` spawns no process**, so it
  cannot fail this way and should carry any rule expressible as a pattern. A free property: the
  runner's `HOME` is ephemeral tmpfs, so a fleet worktree is never a *trusted* workspace and an
  untrusted workspace's `permissions.allow` entries are ignored outright - though its hooks still
  run, which is the asymmetry to remember.
- **A `PreToolUse` HOOK MUST NOT ANSWER `allow`, AND THAT IS NOT PEDANTRY.** An `allow` decision
  BYPASSES the permission system for that call, so a hook written to "allow what is fine and deny
  what is not" auto-approves everything the session does. The correct answer for a command with no
  rule against it is **silence** - print nothing, exit 0 - which defers to the normal flow.
- **UPSKALD'S CI TREATED `.claude/**` AS DOCS.** `scripts/path_filter.py` classifies it into an area
  that never feeds `shared`, and omits `scripts/pr_quality_gate.py` from `PIPELINE_CRITICAL_SCRIPTS`
  - so the pull request that guts the gate is the one CI barely runs. `make check` does not help:
  it never hashes, diffs or verifies any of the nine files that define the gate, and the only
  behavioural cover is a test file living on the same branch as the thing it tests.
- **`git reset --hard` DOES NOT MAKE A TREE PRISTINE.** It leaves untracked files, and
  `playwright-report/`, `test-results/`, `web/stats*.html` and `api/htmlcov` are all gitignored - so
  `git status --porcelain` never mentions them and the next run inherits the last one's output.
  `rm -rf .git` plus `git init`, a fetch, and `git clean -xdff` excluding only the dependency
  directories is what makes it pristine while keeping the fifteen minutes `make install` costs.
- **A PHASE THAT COMMITTED NOTHING PASSES EVERY OTHER CHECK.** The merge-base equals HEAD, the diff
  is empty, the tree is clean, and a human is asked to approve an empty pull request. `rev-list
  --count >= 1` is the only thing that catches it, and `merge-base --is-ancestor` is its sibling,
  for a phase that hands back unrelated history.
- **THE FILE THAT DECIDES WHAT A CHECK MEANS IS USUALLY NOT THE FILE A SHORT LIST NAMES.**
  `check-gate` is eight targets and almost every one leaves the Makefile immediately, so
  `web/package.json`'s `"lint": "eslint . --fix"` becoming `"true"` deletes a whole check while the
  Makefile - which is on every sensible protected list - never changes. But refusing on
  `api/pyproject.toml`, which carries ruff's ignore list and pytest's `filterwarnings`, would refuse
  most real work. Hence two tiers rather than one: a list that refuses, and a list that reaches the
  human. **And one class neither tier catches**: `check-gate` has no coverage step, so deleting a
  test is free and green, and no path list can express "fewer assertions than before".

## Two defects in one uCore image

- **THE SAME IMAGE ALSO SHIPPED AN UNPARSEABLE `policy.json`, AND THAT IS WHY THE PCP MASK WAS
  NOT THE WHOLE STORY.** ucore `e5bf6651` shipped `/usr/etc/containers/policy.json` as **256 bytes
  of the generic containers-common default followed by ~2.5 KB of NUL padding** - the right
  length, the wrong content. It was found only after masking PCP let the image boot.
  - **Nothing could be pulled or built.** Go's JSON decoder rejects trailing NULs -
    `invalid character '\x00' after top-level value` - so every `podman pull`, both `.build`
    units and `podman-auto-update` fail. **22 running containers stayed healthy throughout**,
    because a running container needs no policy, which is exactly why this was invisible.
  - **And the part that DID parse had no `sigstoreSigned` scope at all**, so had the padding not
    been there, ublue's cosign verification would have been silently off while
    `deploy.image_signed` reported it as on. That check reads the **ref**, a string in
    rpm-ostree's metadata; verification depends on a **separate file** that can be absent,
    permissive or unparseable while the ref says `ostree-image-signed:`. `deploy.image_policy`
    is the half that measures it, and it FAILs under `--greenboot`: the breakage ships in the
    image and a rollback is the fix.
  - **DO NOT TEST A POLICY FILE WITH `jq`. It ACCEPTS the broken one** - it stops at the end of
    the top-level value and ignores the padding - so the obvious check passes on precisely the
    input it exists to catch. Python's decoder rejects it the same way Go's does.
  - **The good copy is in the same image**, at
    `/usr/share/ublue-os/signing/usr/etc/containers/policy.json`, and the keys and
    `registries.d/` entries were all byte-identical to pristine - **only `policy.json` was
    damaged**. The repair is `install`ing that copy over `/etc/containers/policy.json`.
  - **THAT REPAIR IS A LOCAL `/etc` OVERRIDE AND OSTREE KEEPS IT FOR EVER**, which is the exact
    thing the image-ref entry below says not to do - a ublue key rotation would then pin this
    host to dead keys and every update would fail. It is accepted here only because the
    alternative was a host that could pull nothing at all. **`deploy.image_policy` now reads BOTH
    files and carries the removal trigger**, because a sentence in this file is the thing nobody
    acts on: it PASSes while the image's own copy is still broken (naming the override as
    load-bearing) and **WARNs the moment the image ships a valid policy that differs**, which is
    exactly what a key rotation looks like. Remove the override then - `sudo rm
    /etc/containers/policy.json` - and confirm podman still pulls.
  - Two independent defects in one build - unlabelled binaries and a truncated file - so treat
    `e5bf6651` as a bad image rather than a bad package. **greenboot's original rejection was
    right for more reasons than the one it named.**
- **PERFORMANCE CO-PILOT IS MASKED, AND IT BLOCKED AN OS UPDATE BEFORE IT WAS.** uCore enables
  `pmcd`, `pmie` and `pmlogger` by default and the two `_farm` units are pulled in by those.
  **Nothing here reads any of it** - cockpit is inactive and the metrics layer is Prometheus,
  node-exporter and `bin/collect-metrics.py`. On **2026-08-18** the published image `e5bf6651`
  shipped `/usr/libexec/pcp/lib/{pmcd,pmie,pmie_farm,pmlogger,pmlogger_farm}` with **no SELinux
  label**, so PID 1 could not exec them - `status=203/EXEC`, `Permission denied`, with
  `avc: denied ... scontext=init_t tcontext=unlabeled_t tclass=file` behind it.
  `host.failed_units` caught it, greenboot rejected the deployment four boots deep and rolled
  back. **That is the system working, and the rollback's first real firing.** But the standing
  consequence was that the host would take **no OS security update at all** while that image was
  published, over a telemetry daemon nobody reads - and no fix was published.
  - **The defect was NARROW, which is what makes masking defensible rather than a shortcut.**
    Exactly those five paths were unlabelled; everything else in the image was fine. Masking
    removes them from `host.failed_units`' view and nothing else, so any *other* unlabelled
    binary a unit execs is still caught. Filtering `pm*` inside the check was the alternative and
    was rejected: it blinds the last line of defence permanently, and the units would go on
    failing, restarting and writing archives.
  - **THE TIMERS ARE `disabled` AND WERE RUNNING ANYWAY**, which is the trap this file already
    names about `Wants=`. `pmie_check`, `pmlogger_check`, their `_farm` and `_daily` variants all
    report `disabled` from `list-unit-files` and were **active and scheduled**, pulled in by the
    three enabled services. Masking the services does not stop them in the running boot - they
    have to be stopped too. Check `list-timers`, not `list-unit-files`.
  - It also reclaimed **268 MB** from `/var/log/pcp` on `nvme0n1p4`, the disk that carries
    `config/`, `/var/backups` and the checkout, and stopped a continuous writer on it.

## greenboot, GRUB, and the red boot that arms the fallback

- **A RED BOOT ARMS *GRUB*, NOT JUST OUR MARKER, AND IT STAYS ARMED UNTIL THE MACHINE BOOTS
  GREEN - WHICH SILENTLY TURNS THE NEXT REBOOT INTO A ROLLBACK.** This is the most expensive
  thing in this file to rediscover, because every signal reads correct while it happens.
  `/boot/grub2/custom.cfg` selects the **previous** deployment whenever `boot_counter` is set and
  `boot_success` is `0`, and `boot_success` is set to 1 only by a green greenboot run. So the pair
  survives the repair: on **2026-08-18**, `bin/reboot-host.sh` was run deliberately, two days after
  the 2026-08-16 red boot, after `/boot` was fixed and `red_boot_at` cleared by hand and the whole
  battery was green. It printed `PASS back after 73s` and `PASS host-level checks pass` - and the
  host came back on the deployment it started from. Four separate things went wrong at once:
  - **THE MARKER NOW RECORDS *WHICH* DEPLOYMENT, NOT ONLY WHEN.** Refusing on a timestamp alone
    was right for the image that failed and wrong for its fix: once a corrected image is
    published nothing could tell the two apart, so the Sunday window kept declining until a
    human cleared the marker by hand - the "host silently stops taking OS security updates"
    failure from a third direction. `50-record-red-boot.sh` writes `red_boot_csum=` from the
    `booted_checksum=` the check wrapper already put in the same file this same boot (no second
    rpm-ostree call on a path that runs when things are already going wrong), and
    `bin/reboot-when-staged.sh` refuses only when `.deployments[0]` carries that checksum.
    **A marker with no checksum still blocks everything** - markers written before this change
    carry no identity, and treating "no checksum" as "no match" would silently release every one
    of them.
  - **`red_boot_at` is ours; `boot_counter` is GRUB's, and only the first was documented.** The
    clearing recipe was `sed -i '/^red_boot_at=/d'`, which disarms the unattended window and leaves
    GRUB pointed at the fallback. `bin/clear-red-boot.sh` now clears both, and
    `greenboot.boot_target` reports the second - it is the check whose absence cost the update.
  - **`ostree admin status` says `(pending)`; `rpm-ostree status --json` says `.staged=false`.**
    ostree has TWO pre-boot states and this repo knew one: **staged** (written, not finalized, no
    `/boot` entry, `/run/ostree/staged-deployment` exists) and **pending** (finalized at shutdown,
    `/boot` entry **written and holding a slot**, `.staged` **false**, and it is what boots next).
    **Six sites selected on `.staged`** and went blind together - the MOTD banner,
    `deploy.image_digest`, the `reboot-host.sh` pre-flight, and worst,
    `bin/reboot-when-staged.sh`, which would have refused *"nothing is staged"* every Sunday for
    ever while the deployment sat ready. All six now use `.deployments[0] | select(.booted | not)`:
    **index 0 is what boots next**, correct in all four shapes, with no state enumeration.
  - **`deploy.image_digest` reported the exact opposite of the truth** - *"a NEWER image is
    published and nothing has staged it ... 'sudo rpm-ostree upgrade' is the first thing to try"* -
    about a deployment that was staged, finalized and entered in `/boot`, while naming the one
    action that could not help. It now separates "nothing has applied it" from "applied but has
    not booted".
  - **A reboot script that verifies HEALTH cannot see this, because a rollback is healthy.**
    `bin/reboot-host.sh` now captures index 0's checksum before rebooting and asserts the booted
    checksum matches it afterwards. On a mismatch it says so and **still unpins** - the deployment
    is fine and merely was not selected, and leaving a pin would hold a third `/boot` slot on a
    partition that has two, making the condition worse.
- **A FINDING WITH NO REMEDY THE ALERT CAN NAME IS AN ALERT THAT TEACHES PEOPLE TO IGNORE ALERTS**,
  and `greenboot.verdict` was one. A red boot writes `greenboot_result=red` into
  `/var/lib/home-server/boot-state`, and that is a fact about **this boot** - only a reboot rewrites
  it. So the check FAILed indefinitely, firing `CheckFailing` at critical every 4h, for up to a
  week given the Sunday window. Everything around it cleared normally: `/boot` was repaired,
  `deploy.boot_free` went green, `red_boot_at` was cleared by hand, `greenboot.red_boot` went green -
  and this one kept shouting about an event from two days earlier that nobody could act on. Exactly
  the "send enough of them that the critical ones stop being read" failure the Alerting section is
  written against.

  **The acknowledgement already existed; the check simply did not read it.** `red_boot_at` is the
  actionable FAIL - it holds unattended reboots and has a documented clearing procedure that asks
  the only question worth asking. `greenboot.verdict` is the descriptive half. It now FAILs while
  `red_boot_at` is present and **WARNs once a human has cleared it**, naming that the next boot is
  what rewrites the verdict. One event, one FAIL.

  **THAT DOWNGRADE WAS UNSOUND UNTIL A SECOND, MISSING CHECK WAS ADDED, and the gap is the more
  serious half of this entry.** An absent `red_boot_at` has two readings - acknowledged, or the
  `red.d` hook never ran - and boot-state cannot tell them apart. `greenboot.armed` asserts the
  check is in `required.d` and that the GRUB counter exists; **nothing asserted
  `50-record-red-boot.sh` was symlinked into `/etc/greenboot/red.d/`**, which is the hook that
  breaks the loop FCOS's own documentation names: after a rollback nothing tells the updater the
  image was bad, so it stages the same digest again within the day. Its absence is silent in the
  worst way - every greenboot check still passes, a red boot still rolls back, and the only
  consequence is that the mark is never written, so the unattended window re-applies the same
  rejected deployment the following Sunday, for ever. `greenboot.red_hook` now asserts it, and is a
  prerequisite for the softening above rather than a nicety. Both live outside `--greenboot`, so
  neither can block a reboot.

## A digest that is not comparable, and a marker a reboot wipes

- **TWO SHA256 DIGESTS NAME THE SAME IMAGE, AND COMPARING THE WRONG PAIR IS WRONG FOR EVER.** The
  obvious way to ask "is the booted OS image current" is to compare `rpm-ostree status --json`'s
  `container-image-reference-digest` against `skopeo inspect`'s `.Digest`. **Those are different
  kinds of digest**, so that check fires on every host, on every run, on a perfectly current
  machine - and it looks completely reasonable while doing it. Verified by fetching each back:
  rpm-ostree records the **platform manifest** (`application/vnd.oci.image.manifest.v1+json`), while
  `skopeo inspect` reports the **image index** (proved by `skopeo inspect --raw | sha256sum`, which
  equals it). `ucore:stable-nvidia-lts` is a two-entry index, `arm64/linux` and `amd64/linux`, so
  the remote side must be resolved through `skopeo inspect --raw` to **this host's architecture**
  before it means anything - and the architecture must come from `podman info` (`amd64`), not
  `uname` (`x86_64`). This is the same class as the `home_server_container_memory_high_bytes` naming
  decision: **a wrong number under a right name is undetectable from a dashboard.** Assert the two
  sides are comparable before believing a digest check.
- **`ExecMainExitTimestamp` is runtime state and a reboot wipes it**, so "this nightly job has never
  run" and "it has not run in the twenty minutes since boot" look identical. `bin/verify-host.sh`
  therefore only treats a missing run as a finding once uptime exceeds the timer's period -
  otherwise every reboot produced a day of false warnings, which is precisely how someone learns to
  ignore the one line that matters.

## Disks, and where things must not be put

- **`/mnt/media` is a single disk with no redundancy**, holding only re-downloadable media. It is
  treated as disposable and is deliberately not backed up. `config/` is the part that matters.
- **Transcode scratch must stay off the media disk.** `DOCKER_VOLUME_CACHE` points at the SSD
  because the Tdarr node would otherwise read source media and write scratch to the same spindle and
  contend for seeks. Do not "simplify" it back under `DOCKER_VOLUME_MEDIA`.
- **`nv-patch.sh` has been deleted, and should not come back.** It lifted the NVENC
  concurrent-session limit, which NVIDIA raised to 8 for consumer GPUs in Jan 2024, and two Tdarr
  nodes cannot reach that ceiling. On an immutable host, patching a driver library in `/usr` would
  fight OSTree every update.
- **`config/` is on `nvme0n1p4`, not `p3`.** `p3` is the 350 MB `/boot`; `p4` is the 233 GB `/var`
  that carries the OS, the checkout, `config/` (5.6 GB) and now `/var/backups`. `/mnt/media` is a
  separate 7.3 TB XFS volume on LVM on `sda` and survives a reinstall only because it is a different
  device. The pre-migration numbering said `p3`, and the uCore install repartitioned. **Back up and
  verify a restore before booting any installer** - `bin/verify-restore.sh` is now what does the
  second half of that.

## The segmentation, and what it buys

- **The bridge is no longer flat, and the forbidden edges are verified.** FlareSolverr cannot reach
  Sonarr on either of its addresses, nor the torrent namespace, tested by IP from inside the
  container rather than by name resolution alone. Jellyfin, the Tdarr nodes and DuckDNS are
  likewise sealed off. **The applications' own logins must still stay enabled**: segmentation is
  defence in depth, and `net-arr` remains flat *within itself* - anything on it reaches every other
  member. See Target architecture for when `AuthenticationMethod=External` becomes defensible.
- **The remaining internal exposure is Prowlarr.** It is the only service on `net-solver`, so it is
  the single hop between a compromised FlareSolverr and everything else. That is the reason its own
  login matters more than the others', not less.
- **SMT is on, and that is a decision rather than a default.** FCOS ships
  `mitigations=auto,nosmt`, which left 6 usable threads of 12 on the i7-8700K - silently, since
  `lscpu` still reports 12 CPUs while `nproc` says 6 and cores 6-11 sit in the offline list.
  `host/butane/ucore.bu` now removes it. **The mitigation it disables is not theoretical here**:
  `nosmt` defends against cross-thread side-channel attacks, which need hostile code on a sibling
  thread, and FlareSolverr runs attacker-controlled JavaScript in headless Chrome by design. The
  judgement is that `net-solver` isolation is the barrier that matters and the threads are worth
  more. If that stops looking right, the `kernel_arguments` block is the thing to revert.
- **Gluetun's HTTP and Shadowsocks proxies are off** (`HTTPPROXY=off`, `SHADOWSOCKS=off`) and the
  container publishes no host port at all. They were unauthenticated and bound to `BIND_LAN`, which
  made them an open proxy into the VPN for any LAN device. Turning them off was cheaper than
  giving them credentials nothing used.
- **Services must address each other over their shared network, never a public hostname.** Flood was
  configured with `https://torrent.avanserv.com`, so its polling left the network and came back
  through the proxy - and stopped working entirely once that route required a session. A container
  reaching another container through the front door is always a mistake; it is slower, it depends
  on DNS and NAT hairpinning, and it breaks the moment authentication is added.
- **Tinyauth now obeys that rule.** Its `TOKENURL` and `USERINFOURL` are `http://pocket-id:1411/...`
  on `net-ingress`; only `AUTHURL` and `REDIRECTURL` stay public, and they have to, because the
  browser is what follows them. Sign-on no longer depends on NAT hairpinning. The feared `iss`-claim
  mismatch did not materialise.

## Logs, and why priority is not a signal

- **A container's stdout is journal priority 6; its stderr is priority 3.** That is podman's
  journald driver, and it means an application that logs to stderr has every line - access logs,
  successful 200s, cheerful startup banners - recorded as a journal **error**. Caddy and Tinyauth
  both did, at ~1950 lines a day, which is enough to make `journalctl -p err` worthless and any
  alerting built on it worse than nothing. Caddy is now pointed at stdout in *both* the global block
  and the `(base)` snippet; Tinyauth's duplicate HTTP stream is off and its audit stream is on.
  **Check where a new service logs before trusting a priority filter.**
- **`journalctl -p err` is STILL not a usable signal, and this entry used to imply otherwise.**
  Fixing Caddy and Tinyauth fixed the two services that had a knob for it. Measured on 2026-08-14,
  what is left: **Jellyfin emits 2,644 priority-3 lines a day** that are ffmpeg decoder chatter
  (`Duplicate POC in a sequence`), and unpackerr another 228 that are s6-overlay `info:` messages at
  startup. Both are the container writing to stderr, neither application can be told otherwise from
  outside, and `LogDriver=`/`LogOpt=` do not remap priority. **So alerting keys on unit state and
  container health - which is what `status.json` carries - and priority is at best a secondary
  filter with a known-noisy allowlist.**
- **Podman emits a `health_status` event per check, carrying the image's whole label set** - the
  Jellyfin one is ~1.5 KB, and the median is 3.8 KB. Sixteen containers at 30s tripled journal
  volume, so the interval was cut to 60s (120s for the Tdarr nodes, 5s for gluetun, the
  kill-switch). **That helped and was not enough.** Measured over a 3-hour full-field
  `journalctl -o export` on 2026-08-14: 34,738 events a day, **47.3% of all journal bytes**, every
  one of them saying `healthy`. They are now off entirely - `healthcheck_events = false` in
  `host/containers/containers.conf` - which drops only `health_status` and keeps every lifecycle
  event. See "Logs and status" below for what that costs.

## The media spindle, measured

- **The media disk gets SLOWER with concurrency, and this is measured.** O_DIRECT sequential reads
  off `sda`: **1 reader 127.5 MB/s, 2 readers 70.9 MB/s aggregate, 3 readers 71.4, 4 readers 66.5.**
  Going from one reader to two costs **45% of total throughput** and quadruples `await` (7.7->28 ms).
  Three readers on the *same* LBA region run at full speed (124.7 MB/s), 6 GiB apart inside one file
  costs 37%, three different files 40% - so **the penalty is head travel, not filesystem layout**,
  and no readahead or scheduler change will fix it. This is why the answer to "it's slow" here is
  *fewer* concurrent jobs, not a bigger bandwidth cap.
- **Tdarr's spindle reads are a burst at job ingest, not a sustained load.** Sampled mid-transcode,
  `tdarr-node-01` read **0.00 MB/s from `sda`** and 16.8 MB/s from the NVMe: it stages the source
  into its cache work directory and then works entirely from SSD. Limit concurrency, not bandwidth.

## Jellyfin and the transcode pipeline

- **JELLYFIN is the stack's largest CPU consumer, and it is not serving anybody.** **Trickplay has
  its OWN hardware-acceleration switches, independent of playback's**, and all three shipped off:
  `EnableHwAcceleration`, `EnableHwEncoding` and `EnableKeyFrameOnlyExtraction` were `false` in
  `config/jellyfin/system.xml` (with `ProcessThreads=1`), so every frame of every file was decoded
  on the CPU - `ffmpeg -loglevel error -threads 1` with no `-hwaccel` anywhere. One file took ~20
  minutes; 223 of 485 were done, leaving **~87 hours** still to run. `cpu.stat` showed `nice_usec` at
  **92.5% of all Jellyfin CPU**, and systemd logged 9h37m of CPU over 15h38m wall. It runs at
  `nice 10` so it does not directly delay the UI, but it streams whole files off the spindle
  continuously. **`podman stats` showing Jellyfin near the top is this, not usage.**
  `EnableKeyFrameOnlyExtraction` is the big lever - it stops decoding every frame.
- **Playback hardware decoding was NEVER off, and the way that was misdiagnosed is the lesson.**
  `grep -E 'HardwareDecodingCodecs' encoding.xml` prints the opening and closing tags on adjacent
  lines and hides the seven `<string>` children between them, so it reads as an empty element. It is
  not: h264, hevc, vc1, av1, vp9, vp8 and mpeg2video are all enabled, confirmed against
  `/System/Configuration/encoding`. **Read a config through the API, or with `sed -n '/<tag>/,/<\/tag>/p'`
  - a line-matching grep cannot show you an XML element's contents.**
- **An IRREGULAR KEYFRAME INTERVAL breaks browser playback, and the symptom names neither cause.**
  Watching *Backrooms (2026)* in Chrome, the picture jumped forward a few seconds at 42:18 and the
  subtitles then no longer matched the audio; reloading the page fixed it until the next time. That
  is not corruption - the file is clean, all streams start at 0.000, no `Non-monotonous DTS`, and
  ffmpeg's frame count matches its playlist to 0.1 s. It is two grids disagreeing:
  - **Jellyfin plays an MKV in a browser as DirectStream** - `-codec:v copy`, audio E-AC3 to AAC
    because Chrome cannot decode E-AC3, packaged as fMP4 HLS.
  - **Its playlist advertises one segment per source keyframe**, from the `KeyframeData` table in
    `jellyfin.db`, because `AllowOnDemandMetadataBasedKeyframeExtractionForExtensions` lists `mkv`.
  - **ffmpeg is told `-hls_time 6` and can only cut on a keyframe**, so it MERGES consecutive
    shorter GOPs. Segment N stops being segment N from the **second segment of every session**, and
    the error accumulates: measured +3.838 s after one segment, +22.397 s after twenty-five.

  So `currentTime` stops matching the picture. Text subtitles are stripped from the stream
  (`-map -0:s`) and timed against `currentTime`, which is why they detach and stay detached, and why
  a reload - a fresh ffmpeg whose first segment is aligned - appears to fix it.

  **We caused it.** `hevc_nvenc` with no `-g` uses a 250-frame cap plus scene-cut I-frames; this
  file's keyframes ran 0.375 s to 10.427 s apart. The plugin now pins the interval - see The
  transcode policy. **`bin/verify-media.sh` is the check**, and it found **9 of the first 10 films
  affected**, so this is library-wide rather than one bad encode. *Flow (2024)* passes with a flat
  10.000 s grid, because it is a restored original that our pipeline never re-encoded.

  Three things that will waste time if not written down:
  - **Throttling is not the cause.** `EnableThrottling` does fire (`Transcoding is paused. Press [u]
    to resume.`), and it only pauses a process - it moves no timestamp, and the drift is measurable
    inside one uninterrupted session. It was the obvious suspect and it is innocent.
  - **The `-ss` values in the FFmpeg logs are `keyframe + 0.500 s` exactly, and that is by design.**
    `-noaccurate_seek` snaps back to the keyframe. It looks like a systematic half-second error and
    is not; do not chase it.
  - **The fix only applies to files encoded after it.** Everything already in `transcoded/` keeps
    its irregular grid. A native Jellyfin client direct-plays the MKV with no HLS involved, so the
    problem is browser-only, which is why re-transcoding the library has not been done.
- **Jellyfin sits AT its `MemoryHigh` with a fast-climbing throttle counter, and that is FINE.**
  `memory.current` 3.00G against `MemoryHigh=3G`, `MemoryPeak` **2 MB above the watermark**, and
  `memory.events` `high` at 6,398 within seven minutes of a restart. It looks exactly like the
  `tdarr-node-01` problem, and **it is not the same thing** - `MemoryHigh` was deliberately left at
  3G after measuring. What settles it is `memory.stat`, not the event counter:

  | | Jellyfin |
  |---|---|
  | `anon` (its actual working set) | **0.385 G** |
  | `file` / of which `inactive_file` | 2.543 G / **2.338 G** |
  | `pgscan` vs `pgsteal` | 2,776,855 vs 2,776,829 |
  | `memory.pressure some` | **avg10/60/300 all 0.00**, 65 ms total stall, ever |

  Jellyfin needs under 400 MB. The rest is cold, clean page cache from streaming media, which the
  kernel reclaims at essentially zero cost - `pgsteal` tracks `pgscan` to five digits, so every page
  scanned is successfully freed, and nothing ever stalls. **A cgroup doing file I/O will always sit
  at its `MemoryHigh` and always accumulate `high` events**, because that is what the watermark is
  for; raising the ceiling would only let more cold cache pile up before the same free reclaim.
  **`memory.events high` on its own proves nothing. Read `anon` vs `inactive_file`, and read
  `memory.pressure`** - real starvation shows a large `anon`, `pgsteal` falling short of `pgscan`,
  a climbing `workingset_refault_file`, and nonzero pressure.
- **Jellyfin 10.11's own queries are slow, and it is not this stack's fault.** The real home-screen
  query takes **29-79 ms in-container** for a 522-item library and a 26 KB response, against ~1 ms
  for Sonarr's equivalent, and the log carries EF Core's `Compiling a query which loads related
  collections for more than one collection navigation` warning. Inherent to the 10.11 EF Core
  rewrite. Recorded so nobody re-investigates it as a configuration problem.
- **Two NVENC sessions already pin the encoder block at 100%** while the SM sits at 10%. A third GPU
  worker cannot encode faster; it only adds cache and spindle pressure. Worker limits are therefore
  `transcodegpu:2, transcodecpu:0, healthcheckgpu:0, healthcheckcpu:0`. `transcodecpu` is 0 because
  `libx265 -preset medium` measured **0.54x realtime** - about 4.5 hours a film - while competing for
  the same disk that NVENC's source ingest needs.
- **`queueSortType: sortPathAZ` is how episodes come out in order.** Sonarr names files
  `<Series> - S01E02 - ...` inside `Season 01` folders, so alphabetical path order *is* season/episode
  order. It is a single global setting, not per-library; `prioritiseLibraries` is on so the library
  `priority` field is honoured instead of round-robin.
- **The community "5 steps" flow was actively destructive and is retained only as a rollback.** Its
  audio node ran `-c:a:0 libopus` with **no `-map`**, so exactly one audio track survived - which one
  depended on the stream reorder, so it deleted the French dub on the Harry Potter films and the
  Latvian VO on *Flow*. It ran `mkvpropedit` three times and two full `-c copy` remuxes (27 minutes
  of pure I/O before the first frame), used work directories of **53 GB per worker** where the
  one-pass flow uses **1.0 GB**, and its net effect across all four libraries since 2025-03-15 was
  **-141.6 GB, i.e. the outputs were 141.6 GB larger than the inputs**. 707 of 2027 transcodes
  errored, averaging 44.7 min each. Flows `htpX8Ypt1`...`25kSD__gW` are left in place, unused;
  rollback is pointing a library's `flowId` back at `htpX8Ypt1`.
- **A Tdarr health check is a full-file decode, not a metadata read**, and queueing 470 of them took
  the whole host down. Moving 470 episodes into a watched folder was enough: that is the entire
  library read end to end off one 7200rpm spindle. **The kernel stayed healthy throughout** - it
  answered ICMP and completed TCP handshakes on 22, 80, 443 and 8096 the entire time - while no
  userspace process could be scheduled. sshd never got far enough to send a banner; Caddy and
  Jellyfin accepted connections and answered nothing. With no console, it took a power cycle.
  **A wedged box and a healthy one are indistinguishable from a ping.**

## cgroup limits, and the controller that was not delegated

- **`CPUQuota` protects the host and tells the guest nothing, which made the gate 5x slower and
  reproducibly WRONG.** `app-agents.slice` caps the fleet at `CPUQuota=400%` on a 12-core host, and
  that half was right and deliberate. But a container is not CPU-namespaced, so `nproc` and node's
  `os.availableParallelism()` inside a phase both read **12** while the cgroup will only ever
  deliver **4** - and every tool that sizes a worker pool from those (vitest, playwright, esbuild,
  tsc, any `make -j$(nproc)`) starts three times the workers the quota can run. The kernel then
  enforces the difference by throttling all of them. Measured, same suite, same tree:
  **`nproc=12` -> 363.54s with one test FAILED; `nproc=4` -> 69.45s, all 4,457 green**, three runs
  each way. Three times the workers should raise the per-worker sums about threefold; they were
  **nineteen** times higher, so each worker was also six times slower. **The cost was not the wall
  clock**: the failure was a component spec timing out at 5000ms that takes 1.8s alone, so
  `conduct/verify.py` refused a correct change and reported it as the phase's fault. A slow gate is
  an annoyance; a wrong one is worse than no gate. Fixed with `AllowedCPUs=0-3` **on the slice**, so
  the number sits three lines from the quota it must agree with rather than in the other
  repository - and `cpuset` had to be confirmed delegated first, because that is exactly how `io`
  was inert for months. `agents.slice_limits` reads it back as a sixth control.
- **`--cpus=4` would NOT have fixed it and is the flag everybody reaches for.** Measured on this
  host: `--cpus=4` gives `os.availableParallelism()` 4 and leaves `nproc` at **12**, because
  coreutils reads the affinity mask and libuv reads the cgroup quota. `--cpuset-cpus=0-3` fixes
  both. Anything shelling out for `nproc` keeps oversubscribing under the obvious flag.
- **`io` is NOT delegated to the user manager by default; `cpu memory pids` are.** An undelegated
  controller is accepted silently and does nothing, so every `IOWeight=` and `IOReadBandwidthMax=`
  in `stacks/` was inert - the control aimed squarely at the cause above was the one not working.
  `host/butane/ucore.bu` now ships `/etc/systemd/system/user@.service.d/10-delegate-io.conf`. It
  takes effect on `daemon-reload` with no session restart. `sda` runs BFQ, which is what makes
  `io.weight` meaningful rather than advisory. **Verify rather than assume - the failure is silence:**
  `systemctl show user@1000.service -p DelegateControllers`.
- **Every service quadlet carries `MemoryHigh`/`MemoryMax`**, and the Tdarr units additionally carry
  `CPUWeight`, `IOWeight` and `IOReadBandwidthMax`. These are systemd cgroup directives in
  `[Service]`, not podman flags, because a quadlet *is* a systemd unit and that is the layer that
  can starve it. Ceilings are sized to catch a runaway, not to tune anything.
- **Tdarr is back in `default.target` and running.** There are **two** units, `tdarr-server` and
  `tdarr-node-01`; both carry `WantedBy=default.target` and both come up at boot. There is no
  `tdarr-node-02` - it existed only in the deleted Compose file. This entry used to say all three
  were commented out and stopped, pending throttles; the throttles are in place (worker limits
  `transcodegpu:2, transcodecpu:0`, `CPUWeight`/`IOWeight`/`IOReadBandwidthMax`, and the `io`
  controller actually delegated) and the units were re-enabled. **The warning that came out of that
  period still stands: a `Wants=` on a disabled unit silently re-enables it**, which is how
  `home-server-promote.service` started Tdarr every 10 minutes. `After=` for ordering, never
  `Wants=`.

## A filesystem that counts against the memory ceiling, and a browser that fills it

Diagnosed 2026-08-22, after `conduct verify` failed three times in a row and the first two readings
of it were both wrong.

- **A tmpfs inside a container is part of that container's MEMORY budget, not separate from it.**
  Its pages are charged to the cgroup that dirties them and, with no swap reachable, they cannot be
  reclaimed - so a full tmpfs pins `memory.current` at `MemoryHigh` and the kernel throttles the
  allocator instead of freeing anything. The runner mounted `/tmp` at **2g** and `/dev/shm` at
  **1g** under a `MemoryMax` of **3G**: the two filesystems could reach the hard limit between them
  with every process behaving perfectly. The sizing comment in `conduct/phase.py` had reasoned about
  exactly this hazard and then compared **one** filesystem against **MemoryMax**, when the test is
  the **sum** against **`MemoryHigh` minus the working set**.
- **`--shm-size` was inert, and `/dev/shm` reading zero is what proves it.** podman mounts
  `/dev/shm` `noexec`; Chromium's `GetShmemTempDir()` falls through to `GetTempDir()` when it needs
  an executable mapping, and `GetTempDir()` reads `$TMPDIR`. So the 1 GB it was given went unused
  across three full gate runs while it put **1,925 MB across 969 unlinked fds** into `/tmp` - which
  the invocation had mounted `exec` deliberately, because `noexec` there breaks uv's managed
  interpreters and node's temporary binaries. **The flag that made `/tmp` work is the flag that made
  Chromium prefer it.**
- **The failure was invisible to every signal this stack has.** `memory.events max` and `oom_kill`
  both stayed **0** for the whole run - `MemoryHigh` throttles, it does not kill - so no unit
  failed, no container went unhealthy, no check fired and no alert reached the phone. `cpu.stat`
  `nr_throttled` was **0**, which retired the CPU-starvation theory on a number. What the browser
  reported was `net::ERR_INSUFFICIENT_RESOURCES` on 88 and 101 Vite module requests, so the SPA
  never mounted and Playwright said **`element(s) not found`** - not "not visible". A page that
  renders late and a page that never renders produce different words, and the difference is the
  whole diagnosis.
- **`du` cannot see an unlinked file, and that is why two readings were wrong.** `df` reported
  2,047 MB used while `du -x -d2 /tmp` summed to 49 MB, because a deleted-but-open file has no
  directory entry. Only `df` and `/proc/<pid>/fd` can see it. Anything reasoning about container
  disk usage from `du` is reasoning about a different number.
- **A container is not memory-namespaced or CPU-namespaced, so everything inside sizes itself for
  the HOST.** `/proc/meminfo` shows 15.8 GB and `nproc` returns 12, while the cgroup grants 3 GB and
  four cores' worth of quota. Chromium sizes its shared-memory pools from
  `AmountOfPhysicalMemory()`, node and esbuild size their thread pools from `nproc`. This is not
  Chromium misbehaving and it is not fixable in the application - it is the reason the hosting side
  has to leave room, and the reason upskald's `playwright.config.ts` was deliberately **not**
  changed.
- **The fix made it faster, which no part of the diagnosis predicted.** With `TMPDIR` on a
  disk-backed bind mount the e2e leg went from 9.0-9.9 minutes to **4.7**, the whole gate from
  ~1,160 s to **888 s**, `/tmp` peaked at **17 MB** instead of 2,047, and Chromium held **38 MB** of
  shared memory instead of 1,925. The likely reading - offered as a reading, since it was not
  measured directly - is that most of that 1.9 GB was self-inflicted: with the cgroup pinned,
  Chromium could not evict its own discardable segments, so it kept allocating more. On disk the
  loop never starts.

## The mirror is not a cache, and the second key cannot go where the first one is

Built 2026-08-22, when PR #241 merged and the fleet could not see it: the mirror still read a commit
from two days earlier, and re-seeding it existed only as a hand step written down nowhere - standing
in front of every verification from that day on.

- **A phase container cannot simply clone the branch it needs, and the mirror is where that
  requirement was moved to.** Three reasons, and only the first is about credentials.
  `avanserv/upskald` is **private** and the runner may hold no GitHub credential in any form - not a
  token, not a `gh` login, not a `.netrc`, not a credential helper, asserted against the argv by
  `tests/test_phase.py` - so a container that clones from GitHub is a container holding a credential
  for GitHub. The **base of the diff has to come from a repository the phase cannot write**, so
  conduct needs a host-side copy whatever the container does; the copy is not avoidable, only
  duplicated. And **one host-side copy is what pins the base**: worktree and base come out of the
  same object store refreshed at one moment, where two independent clones straddle a push with
  nothing saying so. What was never load-bearing is the workstation, and that is the half that went.
- **A second deploy key must not be added to the existing `Host github.com` block**, and the failure
  if it is does not name the cause. `~/.ssh/config` pins that host to `~/.ssh/agents_deploy` with
  `IdentitiesOnly yes`, so a second `IdentityFile` either loses to it or races it - and **GitHub
  answers a valid key for the wrong repository with `repository not found`**, which reads as a typo
  in the remote URL. `conduct/mirror.py` passes `-F /dev/null -i <key> -o IdentitiesOnly=yes` and
  drops the config file from consideration entirely: ordering identities against it is not
  deterministic, and ignoring it is. Proved in all four directions - each key reaches its own
  repository and neither reaches the other.
- **Refreshing the mirror at verification time is the obvious improvement on a 72-hour refusal, and
  it is a bug.** `main` advancing after the phase branched makes `git merge-base --is-ancestor base
  head` fail, so a fresher base turns a good run into *"the phase handed back history that does not
  build on the base it was given"* - a refusal that names the phase for something the refresh did.
  The fetch goes in `prepare_worktree`, where it gives the phase a fresh base and lets verification
  measure against the same one.
- **A dispatch refreshes the mirror itself, and the base has to be PINNED at that moment or it moves
  under the finished run.** `prepare_worktree` fetches before it clones, so a phase never runs
  yesterday's code and the nightly timer is only a backstop. But `conduct verify` runs later and read
  the base **live** out of staging, which re-fetches from the mirror on every call - so the nightly
  timer, or any other phase's dispatch refresh, changed the base of a run that was already over. The
  narrowed diff is the quiet half; the loud half is that once `main` advances at all,
  `merge-base --is-ancestor` fails and a good run is refused with *"the phase handed back history
  that does not build on the base it was given"*, **naming the phase for what the refresh did**. The
  base is a column on the run row now, and a pin that no longer resolves - a force-push on the base
  branch - is reported rather than silently replaced.
- **`CREATE TABLE IF NOT EXISTS` does not add a column to a table that already exists**, and the
  failure is not at deploy time: the statement is a no-op, the column is silently absent, and the
  first `UPDATE` naming it raises inside a phase that has already run. Migrate by inspecting
  `pragma_table_info` rather than by catching the exception - "duplicate column name" and a real SQL
  error arrive as the same `OperationalError`.
- **A mirror that stopped fetching is indistinguishable from one nobody has pushed to.** Its refs
  are valid, every clone works, every phase runs, and the only thing that is wrong is that the diff
  a human approves is against a base GitHub moved past. `conduct/verify.py` refuses at 72h, which is
  the backstop and not the detector - by then three nightly fetches have failed silently.
  `agents.mirror_fresh` reads **`FETCH_HEAD`'s mtime**, which dates the *attempt* rather than the
  change, so "nothing moved upstream" does not read as "the timer stopped".
- **The two bare repositories stay two, and the reason survives the credential.** Three of the
  reasons `conduct/staging.py` gives for not reusing the mirror dissolve once conduct controls the
  refspec. A fourth does not: `git clone --local` copies **every** ref, and staging accumulates
  `refs/conduct/runs/<run-id>` for ever, so a single repository would hand each new worktree every
  prior phase's commits, growing without bound.

## The control plane's arrow, and three states that look alike in the journal

Built 2026-08-22 with the polling half of the orchestrator.

- **conduct polls Windmill and Windmill has no route to conduct, which is containment rather than
  style.** A host-side listener needs either a unix socket - the same `container_t -> unconfined_t :
  unix_stream_socket connectto` denial that stops any container reaching the podman socket - or a
  TCP port plus a firewalld hole `ucore.bu` can only add at first boot. Both spend real containment
  to give an internet-facing container an RPC that spawns `claude`. In `paths.ts` this shows up as
  `conduct` being a pseudo-node that may **never** appear as a `to`; there it reads as a modelling
  rule and it is the security property.
- **Work arrives as a suspended flow step, so the transport is the human gate's own mechanism** -
  and what is conduct's and what is a human's is decided by the **module id**, which comes from the
  flow definition in git rather than from a payload the step computed. **conduct answering an
  approval step would be conduct approving its own gate**, so the guard is asserted by a test that
  fails the moment it is removed, and proved live against a planted human gate that conduct left
  suspended and never once mentioned. Refusing costs nothing either, because a refused step simply
  stays suspended - so the cascade can stay as blunt as it is.
- **`jobs/queue/list` DECLARES `args` and `flow_status` and returns both null.** The OpenAPI
  describes `QueuedJob`'s type, not what that endpoint populates; the list is a lightweight
  projection. Discovery is therefore one call plus one `jobs_u/get` per suspended job, which is
  cheap only because the normal number of suspended jobs is zero. Reading the schema is not
  measuring the endpoint.
- **A `suspend` belongs to the module it PRECEDES, which is the reverse of the obvious reading.**
  The module carrying it reads `Success` once it has run and the module *after* it reads
  `WaitingForEvents` and is what `flow_status.step` points at. The first flow put conduct's name on
  the module declaring the wait, so conduct read the id of the module that was waiting, found a name
  it did not own, and skipped it - **no error, no log line, and a job that would have sat suspended
  for its full 24-hour timeout**. Match on the module type as well as the index: `step` alone names
  whichever module the flow is at, and only `WaitingForEvents` means somebody is being waited on.
- **A drift check that fires on every flow the server has ever stored is not a check.** Windmill
  resolves a dependency lock into each `rawscript` module, so comparing a deployed flow against git
  byte-for-byte never matches. Strip the generated keys **by name**: "git's keys must match and the
  server may add anything" would also accept a `retry:` or a `cache_ttl:` added in the UI, which is
  the drift the check exists for.
- **`agents.approvals_pending` counts conduct's steps as well as a human's**, and cannot tell them
  apart in SQL, because both are `suspend > 0` on the same mechanism. It is left counting both and
  the message says so: conduct claims its own within one 60s poll, so anything reaching the 12-hour
  threshold is genuinely stuck whoever it was waiting on.
- **The answer is written to the database before it is delivered, and the order is the whole point.**
  A phase that succeeded and then could not be reported is twenty minutes already spent;
  rediscovering the same suspended step next cycle spends it again. A row with a payload and no
  `resumed_at` means retry the **resume** and never the phase. A crash *during* a phase is the
  opposite case and needs nothing: no row was written, so the reconciler's existing path covers it.
- **Not-configured and configured-but-broken must differ, and here they are one variable apart.**
  An unset `WINDMILL_CONDUCT_TOKEN` **holds** the poll and leaves `last_ok_at` advancing, because a
  rollout in progress must not look like a fault. A **401** stalls the heartbeat, because a revoked
  token is a fleet that has stopped taking work while every container is healthy, every unit is
  active and nothing else would ever say so. Do not "fix" a 401 by clearing the value.
- **A flow is a row in Postgres the UI can edit with nothing in `git diff`** - the same shape
  `agents.worker_lanes` exists to watch. `serve` rewrites it from git at every start, so drift is
  self-healing rather than detected, which is why there is no `agents.flow_drift` check: nothing has
  to grade a difference it can simply undo.
- **The verify lane stopped being the semaphore when the arrow inverted.**
  `windmill-worker-verify` was built as the one-verify-at-a-time mechanism on a design where
  Windmill dispatched. Under polling, conduct's one-lease-per-project is the semaphore and a
  suspended step occupies no worker at all - so the lane is bookkeeping and spare capacity. The
  quadlet still reads as though it were a limit.

## Indexers

- **The ISP resolver returns a blocking page for several indexer domains.** All three distinct
  1337x hostnames resolved to one address, `193.191.210.104`, and four indexers failed as "DNS/SSL
  issues" while every container looked healthy. `prowlarr` and `flaresolverr` therefore carry
  `DNS=9.9.9.9` / `DNS=1.1.1.1`. Measured from a throwaway container: the request that dies at the
  sinkhole reaches the real Cloudflare-fronted host and returns a 403 challenge, which is exactly
  what FlareSolverr is on `net-solver` to solve. **A DNS failure here looks like an application
  fault, so compare a suspect hostname against a public resolver before believing the site is down.**
- **THE DNS OVERRIDE WORKS, AND IT IS NO LONGER THE EXPLANATION FOR A DOWN INDEXER.** The entry above
  is why the override exists and stays true as history; it stopped being the diagnosis. Checked on
  2026-08-15 when `home_server_indexer_up` read 0 for six of seventeen: `DNS=9.9.9.9` **is** in
  effect - aardvark-dns records `9.9.9.9,1.1.1.1` as prowlarr's upstream, and a container's
  `resolv.conf` naming the bridge gateway is normal rather than evidence against it - FlareSolverr
  was healthy and solving challenges in ~11 s, and every failing hostname resolved to a plausible
  public address. **The six zeros were five unrelated causes**, none of them DNS: a dead mirror
  (`1337x.st`, cert name mismatch), its exact duplicate, two Pirate Bay entries that query the same
  `apibay.org` host as a third and so tripled the load on something already returning 503, a 502 and
  a 403. Four entries were deleted; the remaining zeros are other people's sites being down, and are
  now *correct*.
- **Prowlarr pushes every indexer to every application and retries the refused ones for ever.** One
  indexer, `Nyaa Trusted - Live Action`, returned results in Prowlarr category `129933` - the
  unmapped `>=100000` range - which is neither `5000:TV` nor `2000:Movies`, so Sonarr and Radarr both
  refused it correctly and Prowlarr re-offered it every six hours, four `400 BadRequest` at a time,
  at WARN. It had never delivered anything. **The gap is invisible by design**: nothing compares the
  three indexer counts, which is why `home_server_arr_indexers{service=...}` now reports all three.
  **Some gap is correct** - a movies-only indexer belongs in Radarr and not Sonarr - so read the
  three numbers and the log; do not alert on equality.

## Discovery: three ways to find nothing while everything is green

Audited on 2026-08-19, after "Sonarr and Radarr cannot find some of the requested media" and the
obvious question of whether to add indexers. **None of it was indexer coverage**, and adding
indexers would have made two of the three worse. The pool was 13 configured, 12 enabled, 9 actually
answering; four had never served a single query and were deleted.

- **MOST OF WHAT IS "MISSING" IS NOT RELEASED YET, and the field that says so is not the obvious
  one.** Sixteen of Radarr's twenty-one wanted films were `status=announced` - Avengers: Doomsday,
  The Legend of Zelda, a 2027 Narnia. **Do not filter on `isAvailable`**: every movie here carries
  `minimumAvailability: announced`, so `isAvailable` reads **true for all twenty-one**, a film two
  years from a cinema included. It answers "may Radarr grab this", not "does this exist", and the
  two coincide only by accident. `status`, plus `digitalRelease`/`physicalRelease` against now, is
  the honest test. Reporting one total would have read as twenty-one things going wrong; five is
  the real number, and the gap between the two counts is the only one worth looking at.
- **THE `[VO]` PROFILE FLOOR WAS UNREACHABLE, AND CLAUDE.md ASSERTED THE OPPOSITE.** That file
  said "a VO-only release scores ~50, so it is grabbable". Measured against profile 9:
  `Lang: Original` is worth **10**, not 50, and the whole scale is `Audio: Surround` 10,
  `Codec: x264` 10, `x265` 20, `AV1` 30, `Lang: Original` 10, `Lang: Original + French` 500.
  Against `minFormatScore: 30`, **Silent Hill: Revelation 3D returned 124 releases and approved
  ZERO**; the best-scoring non-3D candidate among them scored 20. Every rejection was profile-side,
  so more indexers would only have produced more releases to reject. `Lang: Original` is now **30**,
  which makes the documented intent true rather than loosening the profile: a release with
  identifiable original-language audio clears the bar alone, one with no language information at all
  (score 0) still does not. After the change: 2 approved at score 40. **A number quoted in prose is
  not a measurement** - this one was wrong for as long as the profile existed, and the symptom was
  indistinguishable from "no release exists".
- **A BACK-CATALOGUE TITLE IS SEARCHED ONCE, AT ADD TIME, AND NEVER AGAIN.** Neither application has
  a scheduled missing search; everything automatic afterwards is RSS sync, which only ever sees what
  an indexer published **recently** - `Reports found: 411, Reports grabbed: 0` against a series that
  ended in 2004. Sex and the City was added 2026-08-18 18:50 and had 0 of 94 episodes; an
  interactive search on S01E01 returned **three releases, all three approved**, Remux / Bluray /
  WEB-DL 1080p at 5-21 seeders. The releases were there the whole time and nothing asked twice.
  `bin/search-missing.py` on `home-server-search.timer` is the fix.
- **AND IT SEARCHED BY SEASON, WHICH WAS THE OBVIOUS ECONOMY AND RETURNED NOTHING.** One query
  instead of thirteen, against a Prowlarr that was already answering Sonarr with
  `429 TooManyRequests` - written as the first rule, and disproved by the first live run. All six
  seasons came back `Season search completed. 0 reports downloaded`, having processed 4 to 10
  releases each, **because a season query asks an indexer for a season PACK** and these trackers
  index a 1998 series one episode at a time. The identical episodes searched individually queued
  all twelve of season one inside the hour. Measured cost of doing it the working way: 12 episodes
  x 8 indexers = 96 queries in about seven minutes, **zero 429s and zero indexers backing off** -
  against the ~770 a day RSS sync already does unattended. **A cheaper query that returns nothing
  is not cheaper**, and the per-run cap is counted in episodes because an episode is what costs a
  query.
- **A STALLED DOWNLOAD BLOCKS EVERY ALTERNATIVE RELEASE, AND REPORTS ITSELF AS `downloading`.**
  Kaamelott: The First Chapter had sat at 5.5 GB remaining of a 29.8 GB remux since 2026-08-14,
  "stalled with no connections". Because the queued item already meets cutoff, Radarr refused all
  **49** candidates with `Quality for release in queue already meets cutoff` - including six at
  score 870 with 48 and 68 seeders. So the most effective way to be unable to find something is to
  already be failing to download it, and nothing in the queue view says so. `search.stalled_queue`
  now warns. **It is named and never cleared**: removing the item deletes a partial download, which
  is a person's decision and not a timer's.

## The publish path, and two ways a killed phase never came back

- **A REPORT IS A VALUE, NOT A STATUS.** A Windmill flow module whose body is `return report`
  succeeds whatever the report says, so a payload of `{"ok": false, "exit_code": 1}` is recorded as
  a **green flow** - nothing raises, `CompletedJob success=true`. A failed gate had looked like a
  successful run since the transport landed, and the live proof did not catch it because the gate it
  ran passed. Harmless at two modules; the moment a verification and an approval sit behind it, a
  failed phase flows into twenty minutes of verifying a tree that already lost and then asks a person
  to approve it. The module raises now - and raises rather than `stop_after_if`, because a stopped
  flow is recorded *successful* and a failed gate is not a success.
- **A PHASE KILLED MID-RUN WEDGED ITS OWN STEP FOR EVER, and the code's own comment denied it.**
  `poll.py` opens the `dispatch` row before it dispatches, so a SIGKILL leaves a row with a NULL
  payload: the retry pass skips it (no payload) and the discovery pass skips it (a row exists). The
  lease, the network, the containers and the tree are all reclaimed and **the flow step stays
  suspended for its full 24-hour timeout with nobody owning it**, while `agents.approvals_pending`
  blames a person at twelve hours. Being killed mid-phase is a **designed** path here - the reboot
  window escalates past its second refusal - so it was reachable every Sunday morning, and
  `state.py` said *"A crash DURING a phase is the opposite case and needs nothing: no row was
  written"*. A row was written. The reconciler clears it, bounded by `REAP_AFTER_SEC` so a live
  phase's row is never touched.
- **THE RESUME RETRY LOOP HAD NO PREFIX GUARD.** The rule that conduct never answers a human's gate
  lived at exactly one call site, on the discovery path; the retry loop resumed every unresumed row
  with no check on `module_id`. Nothing could put a human-gate row there, so it was safe by accident
  - and one plausible way to record a sent notification, a `dispatch` row keyed
  `(job_id, "publish_pr")`, would have made the next cycle **approve the gate and open the pull
  request**. The guard belongs to resuming, not to a call site, and the notice has its own table.
- **`main` IS NOT BRANCH PROTECTED and GitHub has no ref-scoped deploy key**, so nothing on the far
  side refuses a push to the default branch from a write-capable credential. The name check in
  `conduct/publish.py` is the entire boundary - which is why an empty branch prefix is refused
  outright (`startswith("")` is true of everything, so it would silently make the guard a no-op with
  every test still passing) and why the name goes through `git check-ref-format` rather than a second
  regex: `WORKTREE_RE` admits `.`, so `a..b` is a legal worktree id and an illegal ref component.
- **A BRANCH NAMED FOR A REUSED WORKTREE LETS A PULL REQUEST CHANGE UNDER AN APPROVAL.** Worktree
  ids are reused deliberately - they hold the `node_modules` that make the gate minutes - so
  `agents/<worktree>` would carry every run. Run N+1 force-pushes while run N's approval is still
  suspended, a person approves a card describing run N, and the pull request opens on N+1's commit,
  with every check passing. The head sha goes in the branch name: immutable, no `--force`, nothing
  to lease, and `Everything up-to-date` is the correct answer to verifying twice.
- **A DEPLOY KEY HAS NO REST SURFACE AND A `pull_requests:write` PAT HAS MORE THAN ITS NAME.** The
  key cannot open a pull request, comment or label at all, which makes half the credential split
  structural. The token is the other half and it includes **labels** and **reviews**, and a
  fine-grained PAT acts as *the user* rather than a Bot - so `auto-merge.yml`'s `sender.type != 'Bot'`
  guard does not exclude it and that token could arm auto-merge on its own pull request. Accepted and
  recorded; what protects it is that the flow is the only actor, not that the credential is
  incapable. The same honesty applies one level up: a workspace-**owner** token can read any variable
  and run any job, so the split contains tier 1 and accident, never a compromised conduct.
- **ntfy WOULD HAVE DELIVERED NOTHING IN FOUR DIFFERENT WAYS, all of them exiting 0.** It renders
  markdown in its **web app only** - the phone apps show the source; `X-Message` cannot carry a
  newline, so the body must be JSON; the default message limit is **4096 bytes** and an oversized one
  is refused with a 400 rather than truncated; and it caches for **12 hours** against a human gate
  that waits seven days, so **a once-ever notification is lost for ever** if the phone was off for
  thirteen. The notice repeats every six hours while the step is still suspended.
- **A HOST-SIDE PUBLISHER HAS TO COME IN THROUGH THE FRONT DOOR, AND THE HOURLY BATTERY NEVER LOOKS
  AT THAT ROUTE.** ntfy is on `net-metrics` and publishes no host port, and `routes.ntfy` lives
  behind `--routes`, which is opt-in - so DNS, DuckDNS, the WAN address, the router's hairpin and the
  ISP would all sit in the path of the fleet's only notification with nothing hourly measuring any of
  them. Forcing the connection to Caddy on this host keeps the URL, the TLS name and the certificate
  and deletes all of it: 28 ms against 178 ms, both 200. The edge in `paths.ts` is therefore
  `conduct -> internet` and **not** `conduct -> ntfy` - the direct route does not exist, and the lint
  cannot catch that lie because it short-circuits any edge touching a pseudo-node.
- **A PLANTED COMMIT CANNOT PROVE THE CHAIN.** `prepare_worktree` resolves `origin/<ref>` and does
  `checkout --force --detach` then `reset --hard`, so anything committed by hand is orphaned before
  the phase starts - the run reaches verification, refuses "the phase committed nothing", and proves
  only the refusal. A `probe` phase running `git commit --allow-empty` produces a real commit with no
  model call and no credential, an empty diff that flags nothing, and a gate that passes because the
  tree is identical to a known-green base.
- **THE BASE PIN READ THE REPOSITORY THE PHASE WAS NOT CLONED FROM, and it blamed the phase for
  other people's commits.** `dispatch` pinned with `staging.base(project)`, which defaults to the
  **staging** repository - and staging is only fetched from the mirror by `staging.ensure()`, which
  runs later, inside verify. So the pin captured staging's PRE-refresh state while the worktree had
  just been cloned from the freshly refreshed mirror. The diff is then measured from a base older
  than the one the phase branched from, and **every commit somebody else pushed in that window is
  attributed to the phase**. Found on the first end-to-end run of the publish path: a phase whose
  entire output was `git commit --allow-empty` was refused for touching `Makefile` and
  `e2e/playwright.config.ts`, neither of which it had gone near. **The other direction is the one
  nobody would have caught** - a stranger's changes on the approval card as the agent's work. The
  worktree is cloned from the mirror, so the mirror defines the base; verify still reads staging,
  because that is where the phase's commits were fetched to and where the diff is computed. Two
  callers, two repositories, which is what the argument is for.
- **THE ENCODER GATE REFUSED ON A DEVICE THE FLEET CANNOT ADDRESS.** A phase runner is given no
  `--device`, no CDI reference and no `--gpus`, so refusing to dispatch while a transcode ran was
  contention for hardware the fleet has no route to - while CPU, memory and IO, which do contend,
  are bounded by `app-agents.slice` and by `nice -n 10`/`CPUWeight=20`. **And it failed in
  aggregate**, the same way the reboot window's encoder veto did: defensible on every individual
  refusal, and because dispatch is CONTINUOUS, any transcode queue at all meant the fleet never
  started. Found on the first end-to-end run - four files queued, two mid-flight, and the first
  thing the poll loop said was that it was holding. Recorded now rather than gated on, which is what
  I/O pressure already gets. The reboot window's gate is untouched: killing a live transcode to
  apply an OS image is a real cost that deserves a real refusal.
- **A DRIFT CHECK CAN FIRE ON A KEY THE SERVER REFUSES TO KEEP.** Windmill does not store a suspend
  key whose value is its default, so sending `continue_on_disapprove_timeout: false` made
  `conduct flow --check` report DRIFTED for ever on a flow that was exactly right - git held a key
  the server had dropped. **The mirror image of the `lock` trap**: that one is the server ADDING what
  git did not send, stripped by name; this is the server DROPPING what git did send, and the fix is
  not to send it. Detection is unharmed, because a UI edit setting it to `true` is not the default
  and therefore IS stored. Caught on the first deploy of the flow, the only run where it would have
  been obvious rather than ambient.
- **A FOLDER PATH IN WINDMILL IS A STRING, NOT A REFERENCE.** `f/agents/phase` deployed happily into
  a folder that does not exist, so a secret placed under the same path would carry no folder ACL.
- **`render-template.py` EXITS ON AN UNSET VARIABLE**, so adding one to `apps/ntfy/server.yml` makes
  ntfy refuse to start until `.env` carries it - and ntfy is the alert path, so that failure cannot
  page you about itself. `sops` and the push have to land before the server renders, which is the
  order CLAUDE.md's secrets block already gives; the hazard is restarting ntfy after a `git pull` and
  before `./bin/render-env.sh`.
- **DRAFT PULL REQUESTS ARE A PAID-PLAN FEATURE ON PRIVATE REPOSITORIES**, and none of a repository's
  merged pull requests proves the plan allows them - `avanserv` is on `team`, checked. Opening as a
  draft is the right posture anyway: `ai-review` is the **only** draft-gated job in `ci.yml`, so a
  draft gets the whole pipeline without a robot reviewing a robot, and auto-merge cannot arm on it.
  Note that `CI Passed` counts a skipped job as a pass.

## A restart that cut a stream, and the gate that was looking at the wrong device

- **THE NIGHTLY CONTAINER UPDATE INTERRUPTED A LIVE JELLYFIN SESSION, and the series recorded the
  whole thing.** `podman-auto-update` runs at ~00:00 UTC and Jellyfin follows `:latest`, so it is
  recreated whenever the image moves. On 2026-08-19 that was 00:20:30. Reading
  `sum(home_server_jellyfin_sessions)` and `home_server_jellyfin_sessions_total` at one-minute
  resolution: `playing=1 total=3` steady from 00:10 to 00:20, **no sample at all at 00:21** because
  the collector could not reach a container that was down, `playing=0 total=0` at 00:22, then
  `playing=1 total=1` from 00:23 onward. One client resumed; the other two never came back. It is
  the ONLY night in ten that Jellyfin's image actually moved, which is what makes this worth a gate
  rather than a reschedule - the exposure is roughly weekly, and moving the hour changes the odds
  without removing them.
- **`podman auto-update` HAS NO PER-CONTAINER FILTER.** podman 5.8.4 offers `--authfile`,
  `--dry-run`, `--format`, `--rollback` and `--tls-verify`, and nothing else - so "update everything
  except Jellyfin" is not a thing that can be asked for. Dropping `AutoUpdate=` from the quadlet is
  not the same request: it turns Jellyfin's updates off permanently rather than conditionally, gives
  up podman's rollback (which `Notify=healthy` exists to arm), and trips `update.policy_count`,
  which derives both sides of its count from the same authority and FAILs on a mismatch. So the
  whole run is gated, which costs nothing: nothing here needs an image on the night it ships.
- **`ExecCondition=` IS THE PRIMITIVE, NOT `ExecStartPre=`.** A non-zero `ExecStartPre=` FAILS the
  unit; a non-zero `ExecCondition=` (1-254) SKIPS it and leaves it not failed, while 255 or a signal
  still fails. That is exactly the property `bin/reboot-when-staged.sh` gets from `refuse()` exiting
  0, and it is why `bin/update-when-idle.sh` exits **1** to refuse - the one place the two scripts
  invert. A deferral that marked the unit red would be a night when everything worked correctly and
  the host reported a fault.
- **THE REBOOT WINDOW HAD THE SAME HOLE FROM A DIFFERENT DIRECTION, and the existing gate could not
  see it.** `bin/reboot-when-staged.sh` asked `nvidia-smi --query-gpu=utilization.encoder`, which is
  a perfectly good question about transcoding and says nothing about playback: **a DirectPlay
  session hands the file to the client untouched and opens no encode session at all**, so the
  encoder reads 0% while a film is playing. Measured on this host. For as long as that section was
  one gate, the Sunday 05:00-09:00 window could cut a stream with every check passing.
- **THE SAME MEASUREMENT IS PRICED TWO WAYS ON PURPOSE, and getting this backwards is the trap.**
  `bin/jellyfin-watching.sh` exits 2 for "running but unaskable". The reboot gate treats that as a
  refusal, because unknown is not idle and the cost of a wrong reboot is a car journey. The update
  gate treats it as go, because failing closed there means a broken Jellyfin API silently stops all
  twenty-seven containers updating while every unit reads healthy - the "host stops taking updates
  and nothing says so" failure arriving from yet another direction. `update.playback_probe` is what
  keeps the open direction from being a blind spot. A container that is NOT RUNNING is 0 rather than
  unknown in both, since there is no session to interrupt in one that is already down.
- **A STALENESS FILTER AND A CEILING CATCH DIFFERENT THINGS, AND BOTH ARE NEEDED.** A client that
  vanishes without telling the server lingers in `/Sessions` with a frozen `LastPlaybackCheckIn`, so
  a session counts only if it checked in within 300s. That drops ghosts and does nothing at all
  about the case the data actually shows: **one unbroken run of 18.4 hours**, which a browser tab
  left open on a paused episode sustains with perfectly fresh check-ins. Only the 3-day ceiling
  breaks that. Three days rather than the encoder's fourteen because the trade is priced
  differently - a dropped stream costs about fifteen seconds with the position already saved, where
  a killed transcode costs an hour of GPU time.
- **THE HOST IS ON UTC AND THE HOUSEHOLD IS NOT**, which makes every `OnCalendar=` in
  `host/systemd/` easy to read wrongly. `timedatectl` reports UTC, so podman's stock `OnCalendar=daily`
  was already firing at 02:00 local rather than midnight, and "move it to 5am" would have landed it
  at 03:00 UTC - exactly on `home-server-backup`, restarting containers underneath restic, which is
  the partial-snapshot-and-a-lock condition `reboot-when-staged.sh` already refuses over. The window
  is 00:00/01:00/02:00 UTC: three attempts, the quietest band in the session series, and stopping
  one hour short of the backup.
- **WIDENING A `Persistent=true` TIMER'S CALENDAR FIRES IT IMMEDIATELY ON THE NEXT
  `daemon-reload`**, which is the mirror image of the trap one entry over - there, enabling a
  Persistent timer writes its stamp straight away and it does NOT fire. Observed on deploy: the
  stamp held `Sat 00:00:49` from the last run under `OnCalendar=daily`, the new
  `00,01,02:00` made `Sat 02:00` a scheduled elapse that had been missed, and systemd ran the unit
  at 19:16:57 the instant the drop-in loaded. **A new calendar creates missed elapses in the past,
  and Persistent catches up on them.** Harmless here because the gate refused it - the whole
  deployment was a live test of the gate - but the same reload on an UNGATED unit would have
  restarted twenty-seven containers on a Saturday evening. Deploy a widened update timer when you
  would be content for it to run there and then, or clear the stamp first.
- **A skipped unit reports `Result=exec-condition`, not `Result=success`.** It is still
  `ActiveState=inactive`, still absent from `list-units --failed`, and `is-failed` still says no -
  which is the property that matters and the one the design rests on. Recorded because a reader
  checking `Result` after a deferral would otherwise read `exec-condition` as a fault.
- **A SKIPPED RUN CLEARS `ExecMainExitTimestamp` RATHER THAN LEAVING IT STALE**, and that is the
  sharpest edge in this whole change. After one `ExecCondition=` refusal the unit reported an empty
  `ExecMainStartTimestamp` AND an empty `ExecMainExitTimestamp` under a fresh `InvocationID` - on a
  day it had genuinely run and finished at 00:01:45. So `check_timer_run` does not go gradually
  stale over its two periods: it reports **"container update has never run"** and FAILs from the
  FIRST deferral, on a host that updated eight hours earlier.
  **This was got wrong twice before it was measured.** The first version of `update.podman_run`
  assumed "never advances" and WARNed whenever a streak was open, which fired on a single night's
  deferral - the gate working correctly - and took `summary.status` with it. The fix for THAT
  assumed the stamp would merely be old and required it to be past 48h, a condition that can never
  be true because the field is empty, so every deferral went straight to FAIL. The check is graded
  on the DEFERRAL age now, and touches nothing that reads the unit's own timestamps.
- **THE SYMLINK LOOP GLOBS BY EXTENSION, AND THIS IS THE THIRD TIME THAT HAS COST SOMETHING.**
  `host/systemd/README.md` linked `*.service.d` only, so the first `*.timer.d` in this repository
  was invisible: `daemon-reload` succeeded, `systemctl cat` showed podman's stock timer, and the
  retry window did not exist. Same shape as the `Slice=` entry above. The glob now covers both, and
  an existing host needs the link made by hand once.

## The dashboard measured one thing twice, and drew another thing two ways

- **`sum(rate(node_disk_read_bytes_total))` COUNTED THE MEDIA SPINDLE TWICE, and the number looked
  entirely plausible.** node-exporter's diskstats collector drops partitions by default but not
  device-mapper, and `dm-0` is stacked on `sda` - so the sum added the same traffic at two layers.
  Measured on 2026-08-22: `dm-0` at 782.41187 GB read against `sda` at 782.41410 GB, which is one
  workload seen twice rather than two workloads. The System page had reported roughly double the
  host's disk throughput for as long as the chart existed, on a metric nothing else cross-checks.
  `device!~"dm-.*"` is the fix. **The general shape is the one this file keeps recording**: an
  aggregate over a label set nobody enumerated, where every individual series is correct.
- **A BYTE AXIS STEPPED IN BASE TEN IS ROUND BEFORE THE UNIT CONVERSION AND RAGGED AFTER IT.** The
  first labelled y axis picked 1/2/5-times-a-power-of-ten ticks, which `fmt.bytes` then divided by
  1024 to print: a 16 GiB frame came out "0 B / 5 GB / 9 GB / 14 GB". Nothing was wrong with the
  data or with the tick placement; the scale was simply unreadable, and it read as a rendering bug
  in the chart rather than as a unit mismatch. Byte and rate axes step on powers of two now
  (`tickBase: 1024` in `MetricChart`), and read "0 B / 4 GB / 8 GB / 12 GB / 16 GB".
- **THE SAME FINDINGS WERE DRAWN TWICE, IN TWO VISUAL LANGUAGES THAT DISAGREED.** A strip of tinted
  cards at the top of the System page and a list below the metrics both read `host.problems`. The
  strip was capped at three, so which findings existed depended on which half of the page you looked
  at; and a `note` rendered **amber** in the strip and **grey** in the list, because the strip bound
  `:class="c.status"` and only `.fail` had an override, so `note` fell through to the warn
  treatment. `checkTone()` in `src/health.ts` is the single mapping now, beside `containerTone` and
  for the same reason. No fixture had a `note` in it, so neither the fixtures nor `bin/lint-repo.sh`
  could have caught this; one has now.
- **THE DEAD MAN'S SWITCH WAS RENDERED AS A WARNING, WHICH IS THE ONE THING IT MUST NEVER LOOK
  LIKE.** `Watchdog` is `expr: vector(1)` at `severity: heartbeat`, so it always fires and firing is
  the healthy state. `src/api/alerts.ts` fetched with no filter and the page coloured anything that
  was not `critical` as `warn`, so the alert meaning "the notification chain works" sat permanently
  above the real ones and inflated the firing count. It is filtered out now - but **hiding it must
  not hide its absence**, which is the only thing it was ever able to say, so a response that does
  not contain it raises a `fail` line in its place.

## The credential that could not read the number, and four defects on the path to it

- **A `claude setup-token` cannot read `GET /api/oauth/usage`**, and that is the finding the whole
  quota design turned on. The endpoint returns exactly what three consumers had promised since the
  observability tier shipped - account-wide `five_hour.utilization` and `seven_day.utilization`, in
  0.26 s - **with the credential a signed-in workstation holds**. From the server, with the real
  token, it answers `403 permission_error: OAuth token does not meet scope requirement
  user:profile`. An interactive credential carries that scope; the only long-lived credential a
  headless machine can hold carries what is needed to run the model and no more. **Measuring the
  endpoint with the wrong credential and calling it available is the mistake that was one step
  away** - the first measurement did use the interactive one, and the design would have been built
  on it.
- **The signal that IS available comes from the model call itself**, which is better than a
  fallback: `--output-format stream-json` emits a `rate_limit_event` carrying the API's own unified
  rate-limit headers - `allowed` / `allowed_warning` / `rejected`, per window, with the epoch that
  window clears. No second credential, account-wide because it is the API's accounting rather than
  a tally anybody keeps, and it cannot drift from what the model saw because it **is** what the
  model saw. The same stream carries the `result` object, so one output format serves the pacing
  and the accounting both. The cost is that it is a status rather than a number, and that it only
  updates when a phase runs - so **absence must PROCEED rather than refuse**, or the fleet can
  never produce the reading that would unblock it. That is the exact inverse of the rule the
  endpoint design had, and the two are one line apart in the same function.
- **`resets_at` removes the need for a staleness heuristic entirely.** A percentage goes out of
  date silently, which is why the old check graded the age of the reading before the reading. A
  status carries the moment its window rolls over, so a hold expires by itself and nothing has to
  estimate.
- **`shutil.rmtree` on a symlinked directory deletes NOTHING and raises where you cannot see it.**
  CPython's fd-walk does an lstat/fstat samestat check and raises `OSError("Cannot call rmtree on a
  symbolic link")` before the scandir that would unlink anything - so with `ignore_errors=True` the
  call is a silent no-op, and `os.path.isdir` had already followed the link and said yes. In
  `gitsafe.sanitize` that meant a planted `.git/hooks -> ./real` survived, and `git checkout` then
  ran `post-checkout` as `core` on the host, outside the cgroup, the namespace, the capability set
  and SELinux - reachable with no model phase in existence, by a lockfile postinstall, because
  worktrees are reused and mounted `:rw` including `.git`. **And the report lied in the same
  breath**: `removed` was built from `os.listdir` BEFORE the rmtree, so verify printed "the phase
  left executable git state behind and it was removed before any git command ran". Ask about the
  link, never the target; and never `ignore_errors` on a removal something else will report.
- **A drift check that compares half of what it deploys reports "matches git" on the other half.**
  `conduct flow --check` compared the flow's `value` and never its `schema`, while `flow_push` sends
  both - so a UI edit to a run form was invisible for ever. Harmless while the form was four strings
  with sane defaults; not harmless once one of its fields becomes a model's prompt. Measured before
  fixing: both deployed schemas came back byte-identical to git's, so this one compares whole rather
  than stripping generated keys the way the `value` comparison must.
- **`core.quotePath` is on by default, so a protected path can escape classification by being
  spelled with an accent.** `git diff --name-only` returns `"api/tests/test_caf\303\251.py"` -
  C-quoted and wrapped in double quotes - and every `fnmatch` glob then fails against a string that
  begins with a quote. The refused-path list IS the boundary in `conduct verify`, so the boundary
  was byte-dependent, and the card showed the mangled name to the human being asked to make up for
  it. `-c core.quotePath=false` on every diff that feeds a path decision.
- **A `# noqa` on one imported name does not cover the import.** `flows/ship.py` carried
  `# noqa: F401` on `CONDUCT_PREFIX,` rather than on the `from .common import (` line, so `SCHEMA`
  read as unused - and it is not unused, it is read from outside as `flow.SCHEMA`. `ruff --fix`
  would have deleted it and the ship flow would have lost its run form, surfacing as one non-fatal
  "flow: not reconciled" line at startup while the other flow deployed perfectly. A lint comment
  that is itself wrong is not caught by the lint.
- **`git reset --hard` does not remove untracked files, and this repository already knew that.** It
  is the whole reason `verify.pristine` does `rm -rf .git; git init; git clean -xdff` - and the
  lesson had never been applied to `prepare_worktree`, where it was harmless only because every
  phase was deterministic. Worktrees are deliberately reused, so a model's `git add -A` commits the
  previous run's abandoned scratch, and a phase killed mid-edit - a designed path - poisons the
  worktree permanently while `verify.clean()` blames each later run in turn.
- **Starting an MCP server is a process spawn, not a tool call.** In `-p` mode a discovered
  `.mcp.json` is auto-approved and its servers started before the first turn, so no `PreToolUse`
  hook fires and no permission rule applies. A guardrail that only sees tool calls cannot see the
  thing that starts first; `--strict-mcp-config` closes it at run time and `.mcp.json` in the
  refused-path list closes it where the boundary actually is.
- **`--bare` skips hooks**, and `--permission-mode bypassPermissions` is the supported spelling of
  the bypass the deny list already refuses the model for typing. Both are one flag away from
  disarming the in-container guardrail entirely, and neither is caught by a rule written against
  `--dangerously-skip-permissions`.
- **`--setting-sources ''` is accepted and loads nothing** - not user, not project, not local - so a
  phase can be given no on-disk settings at all while `--settings` still installs conduct's own.
  Measured: the hook fired and blocked a Bash call that `--allowed-tools` had explicitly permitted,
  so **a hook outranks an allow-list**. The cost is that it also drops the project's skills, which
  is a trade to make deliberately rather than absorb.
- **`-p` silently ignores a settings file that FAILS VALIDATION** while a settings file that is
  MISSING exits 1 loudly. `sha256sum -c` proves the bytes arrived and cannot prove Claude Code
  accepted them, so the digest gate has a blind half.
- **A one-word reply costs about $0.12** because the system prompt is ~29,000 cache-creation tokens
  on every run. There is no such thing as a cheap model phase, which is what makes a spend floor a
  number rather than a gesture.

## A runner that cannot be contained the way a phase runner is, and a health status nobody sets

Added 2026-08-24, building the CI lanes. Everything here was measured on this host unless it says
otherwise, and three of them were nearly shipped as assumptions.

- **Podman drives healthchecks with transient systemd timers, and there is no systemd inside a
  container.** Visible on this host: `systemctl --user list-timers` shows twenty-five hash-named
  timers, one per healthchecked container, firing at the intervals the quadlets declare. Inside a
  container `podman create --health-cmd` only WARNS, the service starts and genuinely serves, and
  `.State.Health.Status` stays `starting` for ever.

  **That is a six-hour hang rather than an error, and every signal on this host reads green while
  it happens.** GitHub's runner waits on exactly that field before running a job's steps, in a loop
  with NO RETRY CAP - it exits only on a status change - and `avanserv/upskald` sets
  `timeout-minutes:` on **zero** of its jobs across all seven workflows, so the default 360 minutes
  applies. The container is running, the service is serving, no unit is failed and nothing is
  unhealthy. `apps/github-runner/scripts/podman-healthcheck-loop.sh` is the fix: `podman healthcheck run` per
  container, at the interval that container declared.

  **The interval has to be honoured rather than guessed, and the safe direction is LONG.** A
  workflow's `--health-retries 5 --health-interval 10s` gives postgres fifty seconds; polling every
  second spends those retries in five and marks a healthy database `unhealthy` before it has
  started - and the runner FAILS a job on unhealthy. An unparseable interval therefore falls back
  to thirty seconds, not to one.

  **The obvious alternative fix is worse than doing nothing.** Stripping the health flags in the
  docker shim empties `.Config.Healthcheck`, the runner's wait returns immediately, and the job
  races Postgres's startup - trading a reliable hang for an intermittent failure.

  The template itself is fine: `podman inspect --format="{{if .Config.Healthcheck}}{{print
  .State.Health.Status}}{{end}}" node-exporter` returns `healthy`, rc 0. Only the timer is missing.

- **`--cap-drop=ALL`, `no-new-privileges` and `--read-only` do not merely sit awkwardly with nested
  podman - they forbid it, by three independent mechanisms.** `newuidmap`/`newgidmap` are
  setuid-root, so `no-new-privileges` makes them inert, and a multi-line `uid_map` needs
  `CAP_SETUID` in the parent namespace anyway; without it the inner engine gets a single-ID map and
  `postgres:16-alpine` (uid 70) and `redis:7-alpine` (uid 999) cannot even be extracted. This
  host's default seccomp profile ERRNOs `setns` unless the container holds `CAP_SYS_ADMIN` - read
  out of `/usr/share/containers/seccomp.json` - and rootless podman joins an existing user
  namespace via `setns` for every command after the first, so the failure is LATE AND INCONSISTENT:
  `docker create` may work and `docker inspect` then fail.

  **`--security-opt label=disable` is not the answer and the reason is sharper than the house
  rule.** `core` is `unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023`, so that flag runs the
  container as `unconfined_t` - SELinux containment is not weakened, it is gone, and
  `container_t -> unconfined_t : unix_stream_socket connectto` stops applying at all. That is a far
  larger concession than the `label=level:s0` idea this file already records as measured-and-
  rejected. A `vfs` graph driver is an acceptable fallback; this is not.

- **`--read-only` breaks the runner before podman is involved.** `--jitconfig` is not held in
  memory: the runner base64-decodes it and writes `.runner`, `.credentials` and
  `.credentials_rsaparams` into its own root, then reads `.runner` back to derive the label it tags
  every container and network with. So the runner tree must be writable, per lane.

  **That writable tree is also what stops a mint storm.** A just-in-time configuration carries no
  `disableUpdate`, so the runner WILL self-update; on a read-only tree that fails, the runner exits,
  the driver mints a fresh registration and it repeats - which is the `Restart=always` "never comes
  to rest" trap wearing new clothes, against a 5,000/hour rate limit.

- **The subuid range inside a rootless container is 0..65535, not 100000..165535.** Rootless podman
  on the host maps a container's uid 0 to `core` and uids 1..65536 to core's own subuid range, so
  the conventional `100000:65536` written into a container's `/etc/subuid` is entirely outside the
  valid space and `newuidmap` refuses with `Invalid argument` - an error naming neither the file
  nor the reason.

- **`/dev/fuse` and `/dev/net/tun` land differently inside a rootless container, and only one of
  them is usable by a non-root user.** Measured:

  ```
  crw-rw-rw-  65534 65534  /dev/fuse       <- any uid inside can open it
  crw-rw----  65534     0  /dev/net/tun    <- group 0 only
  ```

  The nested engine needs the tap device to give its containers a network at all, and a runner
  running as uid 1000 cannot open a 0660 root-group node. The entrypoint therefore starts as
  container root, chmods that node inside the container's own `/dev` tmpfs, and drops with
  `setpriv`. Adding the user to group 0 instead would have granted group-0 access to every
  root-owned file in the image to buy one device.

- **Native overlay cannot stack on the outer container's own overlay rootfs**, so a nested graph
  root on the container filesystem silently falls back to `vfs` - every layer a full copy, at every
  pull, for ever, reported nowhere but `podman info`. It works; it is just several times slower to
  start a service, which reads as "CI is slow" rather than as a misconfiguration. `/var` is XFS
  with `ftype=1`, so the lane's own bind mount keeps the driver on `overlay`, and
  `bin/github-runner-smoke.sh` asserts that rather than hoping.

- **A scope property is a different question from a slice property, and this one works.**
  `systemd-run --user --scope -p AllowedCPUs=4-5 --quiet -- nproc` prints **2**. Cpuset delegation
  was already proved for a slice by `app-agents.slice`; that it also applies to a transient scope is
  what lets each lane see the cores it will actually get, rather than both lanes reading the slice's
  four and putting eight workers on them.

- **A ceiling is not usage, and reading it as one nearly cost a second slice.** `app-agents.slice`
  reserves 4,608M, which against a worst-observed `MemAvailable` of 9,715 MB looks like there is no
  room for CI at all. The store says otherwise: median agent-slice memory **957 MB**, p90 1,455 MB,
  and a phase in flight **6.9%** of the time, against a median `MemAvailable` of 11,279 MB. The
  30-day maximum is 3,584 MB, which is exactly `MemoryHigh` - page cache being reclaimed, the design
  working, not pressure. Overcommitting ceilings is the house style and `app-agents.slice` says why;
  what makes it safe here is that the driver holds the SECOND lane while a phase is in flight.

- **`agents.runners_leaked` filters on `io.home-server.ephemeral` alone, so it now watches two
  fleets.** A CI lane must carry that label - without it the 30-second collector mints network
  series under a name that never repeats, into a 400-day store. The 7200s ceiling stayed and the
  message widened: a lane's scope carries `RuntimeMaxSec=5400` and its driver tears an idle
  registration down at 1800s, so a healthy lane cannot reach it. **Raising the number to make room
  for CI would have blinded the check for the agent fleet too**, on a threshold neither fleet owns -
  which is why the idle teardown is not an optimisation.

- **`agents.runner_isolation` derives the stack networks from `stacks/common/*.network`**, which is
  a positive reason to create a lane's network from the driver rather than as a quadlet: `net-ci-*`
  then stays out of that list, a lane is not misread as a phase runner on a stack segment, and
  `topology.ts`, `paths.ts`, `update.policy_count` and `containers.units_active` all stay out of the
  change. `stacks/infra/conduct-runner.build` documents that invisibility as a property to rely on.

- **`bin/reboot-host.sh` said nothing at all about work in flight, and adding only the CI half would
  have been worse than adding neither.** The unattended gate has refused on a conduct phase since it
  was written; the attended one never mentioned it. A pre-flight that names a CI job while staying
  silent about a phase reads as "nothing else is running", and a reader would be entitled to draw
  that conclusion. It now warns on both, and warns rather than refuses because a person is reading
  the output.

- **A killed CI job is not a killed phase, and the escalation comment prices it honestly.** GitHub
  does NOT re-queue a job whose ephemeral runner disappeared - somebody runs `gh run rerun --failed`
  - where conduct's reconciler reclaims a phase on the way back up with nobody involved. Still
  minutes, still far cheaper than another week on an unapplied image, so the same "give way after
  the second refusal of a morning" shape holds. It is not free, and the code says so.

- **A CONTAINER ENGINE OLD ENOUGH TO SHIP IN AN LTS CANNOT RUN A CONTAINER HERE, AND A NEWER ONE
  CAN WITH ALMOST NOTHING.** The image was Ubuntu 24.04 first, chosen so `actions/setup-python`
  could resolve its Ubuntu-specific assets. Its podman is **4.9.3**, and as an unprivileged user
  inside a rootless outer container it refuses with

      newuidmap: write to uid_map failed: Operation not permitted

  with every requested range inside the outer namespace's own map, with `CAP_SETUID` present, with
  `newuidmap` setuid-root on a rootfs mounted `rw`, and - checked with `semodule -DB` so dontaudit
  could not hide it - **with no AVC logged at all**. Running the inner engine as container-root
  instead walks a chain of refusals (`setns`, then a read-only `/proc/sys`, then
  `cgroup.subtree_control`, then a `proc` mount) that ends at `--privileged`.

  **podman 5.8.4 does it with podman's DEFAULT capabilities and SELinux enforcing.** So the base is
  `quay.io/podman/stable` - Fedora 44, which is what uCore is built from, so it is the same podman
  the host runs rather than a second opinion. What that costs is one thing, and it is closed by
  baking Python into `RUNNER_TOOL_CACHE`, which `actions/setup-python` checks before it downloads
  anything.

  **The base's own user is the right one to keep.** It has `podman` at uid 1000 with
  `/etc/subuid` ranges that FIT inside a rootless outer container - `1:999` and `1001:64535`,
  under 65536 and stepping over uid 1000 itself. A hand-written `runner:100000:65536` is entirely
  outside the map and `newuidmap` refuses with `Invalid argument`.

- **Three Fedora package names are not what they are called on Debian**: `libmagic1t64` is
  `file-libs`, `liblttng-ust1t64` is `lttng-ust`, and `liberation-fonts` does not exist at all
  (`liberation-sans-fonts` does). And `playwright install-deps` supports Debian and Ubuntu ONLY -
  on Fedora it exits without installing anything, so the chromium set has to be named by hand.


- **The containment a nested engine needs, bisected one flag at a time.** Four additions on top of
  podman's DEFAULT capability set, with SELinux enforcing and the default seccomp profile - and not
  one of the refusals names the flag that fixes it:

      container_engine_t   crun: mount `devpts` to `dev/pts`: Permission denied
      unmask=ALL           crun: mount `tmpfs` to `proc/acpi`: Permission denied
      --cap-add=SYS_ADMIN  crun: sethostname: Operation not permitted
      --device /dev/net/tun  pasta failed: Failed to open() /dev/net/tun

  **`label=type:container_engine_t`, NEVER `label=disable`**, which is what podman's own
  documentation reaches for: `core` is `unconfined_u:unconfined_r:unconfined_t`, so that flag runs
  the container as `unconfined_t` - SELinux containment not weakened but GONE. `container_engine_t`
  is container-selinux's purpose-built type for exactly this and keeps enforcement.

  **`unmask=ALL` is about LOCKED MOUNTS, not about masking.** The outer container's own `/proc`
  masking is inherited by a nested mount namespace and cannot be overmounted from inside it.

  **`SYS_ADMIN` makes `--read-only` hygiene rather than a boundary**, since `mount -o remount,rw /`
  becomes possible. What it reaches is the job's own ephemeral overlay, which the job can already
  write through `$HOME`, `/tmp` and the runner tree - so the loss is smaller than the flag sounds,
  and it is the price of `services:` working at all.

- **A ONE-COMMAND PROBE AND THE REAL WORKLOAD TOOK DIFFERENT CODE PATHS.** An interactive
  `podman run --rm alpine echo ok` inside a lane succeeds with no tap device, which read as proof
  that podman 5 needed none. A DETACHED container - which is every `services:` block - does not:
  `pasta failed: Failed to open() /dev/net/tun`. The cheap probe was not the test.

- **`/dev/net/tun` arrives group-0 only, and the NESTED namespace loses that access.** Group 0
  inside a rootless container IS host group `core`, which the host's udev rule grants - so the
  outer runner can open the node. But a nested user namespace maps its own gid 0 to the runner's
  OUTER gid, so with gid 1000 the nested pasta cannot open a device the outer process reads
  perfectly well. **Primary gid 0** carries it through; it is the uid-arbitrary/gid-0 convention
  OpenShift uses.

  **The chmod that looks like the obvious fix is silently impossible**: the node is owned by an uid
  that is not mapped into the namespace, so container root is not its owner and `CAP_FOWNER` does
  not reach it - `chmod` returns EPERM. Written as `chmod ... || true`, which is how it was written
  first, it fails INVISIBLY and the only symptom is pasta refusing two layers away.

- **A lane's bind mounts mask what the image put underneath them.** An empty `$HOME` hid the base
  image's own engine configuration - `stat /home/runner/.config: no such file or directory`, then a
  socket that never binds - and the tool-cache mount hid the baked Python while the smoke test
  reported `nothing is in /opt/hostedtoolcache/Python` against an image that demonstrably had it.
  Anything a mount covers has to be seeded at start-up from a path it does not.

- **`cp -a` CARRIES THE SELINUX MCS CATEGORIES** of whichever container did the copying, because
  `-a` implies `--preserve=all` and that includes the context. The next container, with a different
  pair, then cannot read what it was given: `ls: cannot open directory ...: Permission denied` on a
  directory plainly present and owned by the right uid. Measured as
  `container_file_t:s0:c676,c800` on the copy against `container_file_t:s0` on the mount around it.
  `cp -rp` inherits the destination's label instead.

- **`core` cannot delete a lane from outside the namespace.** Everything under it belongs to the
  subuid container uid 1000 maps to, so a plain `rm -rf` produces a wall of `Permission denied` and
  leaves a disk budget un-reclaimed while reporting nothing. `podman unshare rm -rf` is the form.

- **`rootless_storage_path` is the key that is read, and `graphroot` alone is not** - and it goes
  under `[storage]`, not `[storage.options]`. In the wrong table podman warns, names the key and
  the file, and then carries on with its default anyway, so the error that FOLLOWS is a permission
  denial about a path nobody chose. Read the first line, not the loudest one.

- **A fixed `--name` on a probe container is a false containment finding.** A container still
  terminating from a previous leg collides with the next and podman exits **125**, which the
  by-IP probe correctly refuses to read as either dropped or refused - and which was reported as
  four separate containment failures for one cause. The probe now prints podman's own message,
  because an arm that says "this proves nothing" and cannot say why sends whoever reads it to
  reproduce the run by hand.

- **`timeout` AS PID 1 RETURNS 125 WITH NOTHING ON STDERR, AND A SHELL WRAPPER DOES NOT FIX IT.**
  GNU `timeout` puts its child in a new process group so it can signal the whole group; as pid 1
  that call fails and it returns 125 - its own "timeout itself failed" code. A container entrypoint
  that `exec "$@"`s makes it pid 1, so every by-IP containment probe in
  `bin/github-runner-smoke.sh` came back 125 and the probe correctly reported, four times, that it
  had proved nothing about the edge. **The cause was inside the probe.**

  **`sh -c 'timeout ...'` WITH A SINGLE COMMAND EXECS IT**, so the wrapper changes nothing and the
  125 survives. A first measurement said otherwise only because it was written
  `timeout 6 true; echo rc=$?` - the second command suppresses the exec optimisation. That accident
  is the entire difference between the two readings, and it sent the fix in the wrong direction
  once. `--foreground` is what actually works: measured in one container under identical flags,
  bare 125, `sh -c` single command 125, `--foreground` 0.
- **A workflow's `image: postgres:16-alpine` is an UNQUALIFIED short name**, because that is what
  Docker resolves. Podman refuses a short name with no search list, and a job log reports that as a
  bad image reference rather than as a missing `registries.conf`. Every `services:` block in every
  repository will be written this way, because that is what GitHub's documentation shows.

- **Cache keys are shared between hosted and self-hosted runners, and the poisoning runs both
  ways.** `upskald`'s keys are all `...-${{ runner.os }}-...` and `runner.os` is `Linux` on both.
  `~/.cache/prek` holds hook environments with ABSOLUTE interpreter paths and `~/.cache/ms-playwright`
  holds browsers built against a specific glibc - so a self-hosted run can break the next HOSTED
  run, and nothing in the workflow can see it happen.

- **Labelling a lane `ubuntu-latest` is the zero-edit trap.** GitHub falls back to a hosted runner
  only when no runner with that label is CONNECTED, so the same workflow silently alternates between
  a hosted Ubuntu image and a two-core container depending on whether a lane happened to be
  registered at that instant - flaky, environment-dependent, and near-impossible to attribute from a
  job log. It would also capture `release-please`, `auto-merge` and `pr-recap`, stalling merges
  behind CI.

## What a phase is given, and the flags that decide it

**Measured 2026-08-25, against the pinned CLI, on the runner image itself.**

- **`--setting-sources` has three values and they do three different things.** `''` loads no skills
  and no `CLAUDE.md` at all; `user` loads `$HOME/.claude/{skills,CLAUDE.md}`; `project` loads the
  BRANCH's, and its hooks with it. The entry above said `''` "drops the project's skills" and left
  it there - `user` is the arm nobody had tried, and it is the one that makes a container's own
  `HOME` a place to put them. Safe here only because that HOME is an ephemeral tmpfs the image
  creates empty, so `user` has nothing of the branch's to find.
- **`--model` unset means the token's default, and the default was NOT the workstation's.** A probe
  read back `claude-sonnet-5` while every interactive session was on Opus. A pin whose absence is
  silent, and the largest single difference in output quality nobody had measured.
- **A mount is not access.** `Read` and `Glob` are confined to the working directory, so a
  read-only mount outside it can be listed by `ls` and not opened by the tools the prompt tells the
  model to use. Four of five `permission_denials` on the first live run were this, and the run
  still answered correctly - by finding a way round, which is what makes it the kind of defect a
  passing test hides. `--add-dir` declares it.
- **rtk's `PreToolUse` hook answers `updatedInput` and no `permissionDecision` at all**, so it
  rewrites and cannot permit. Worth measuring before shipping any third-party hook: one answering
  `allow` bypasses the permission system, which is the half this design calls stronger than a hook
  precisely because it spawns no process.
- **Allowing rtk is allowing everything.** `rtk proxy <cmd>` runs anything, so `Bash(rtk:*)` is
  `Bash(*)`. That costs no capability - `python3 -c` already did - but it empties
  `permission_denials`, which was the only signal saying the model had reached for something new.
  **Silence there is now expected and is not evidence of anything.**
- **A cold `code-review-graph` build is 12 seconds and 38 MB** on 725 files, and `--data-dir` keeps
  it out of the worktree - which matters because `git clean -xdff` in the verification tree would
  delete it on every run.
- **The graph stores ABSOLUTE PATHS, so one data directory per project does not work.** Sharing it
  between worktrees of the same repository - same commits, same files - is refused, naming a file
  from the other tree. It refuses loudly, which is the only reason this cost one run rather than a
  fortnight of a phase navigating a different tree's code. Per worktree, and pay the 38 MB.
- **A phase that hit `--max-budget-usd` exits non-zero exactly like a broken `make install`**, and
  the result event's `subtype` is the only thing that tells them apart. Not reading it meant every
  model failure reached a person as a bare exit code. Measured the expensive way: a plan phase with
  no graph fell back to reading files and spent $2.14 over 32 turns without answering.
- **A planning phase costs more than a fifth of what doing the work costs.** $2.00 was not enough
  twice; the second attempt had a working graph and still ran 41 turns, 1.7M cached tokens and $2.25
  without answering. 27 shell calls against 3 uses of the knowledge graph - on a phase whose whole
  advantage is the graph, with the MCP server connected and all 37 tools offered. **The model
  reaching for grep is the expense**, and it is a prompt problem rather than a plumbing one.

## Windmill will not make a suspend conditional the obvious way

**Measured 2026-08-25 on a scratch flow, both directions, after two wrong answers.**

- **`skip_if` on a module disables that module's `suspend` WHATEVER the predicate evaluates to.**
  Proved with a literal `false`: the module ran, reported `Success`, the suspend never armed and the
  flow completed. A human gate built this way could only ever publish and never ask - the exact
  inverse of a gate, arrived at through the only spelling that reads correct.
- **`skip_if` on the module that WAITS does not prevent the wait**, which is the other half of the
  same misreading. A suspend belongs to the module it precedes, so both ends were tried.
- **A `branchone` DOES contain a suspend, in a sub-job.** The parent reads `InProgress` with
  `branch_chosen`, `windmill.current_module()` returns `None`, and the suspended step lives under a
  different job id - so conduct's discovery, notification and resume paths would all need to learn
  about nesting.
- **`stop_after_if` is what works**, survives the round trip with no drift, and needs no change to
  conduct at all: the flow either stops before the gate or reaches the gate exactly as before.
- **`user_auth_required: true` makes `jobs/flow/resume` fail** with "Approvals for logged in users
  is an enterprise only feature". The UI path works and the owner endpoint does not - so conduct was
  ALREADY unable to answer the human gate, by a second mechanism underneath the `conduct_` prefix
  guard that nobody had found. **REMOVED DELIBERATELY 2026-08-29** so the dashboard could answer the
  card it now shows; see "The card was in the database all along" below for what that cost.

## The round, and four ways a phase reads a tree that is not the one it was sent to

**Everything here was found by writing the loop down rather than by running it**, which is the
cheapest place any of it could have been found - three of the four are silent, and the fourth costs
money on every publish.

- **`prepare_worktree` is destructive and every phase after the first one continues someone's
  work.** It does `checkout --force --detach origin/<ref>`, `reset --hard` and `clean -xdff`, so
  calling it before the reviewing phase DELETES THE COMMITS UNDER REVIEW and calling it before the
  second round's dev phase throws away the work the plan has just triaged. Neither raises: the phase
  runs happily on a clean checkout of `main` and answers "no findings" or "nothing to do", which is
  indistinguishable from a real clean run. `continues` in the descriptor is which phases get
  `continue_worktree` instead.
- **The refusal for an empty tree is a SUBSET of that, not the same list.** `review` and `ship` must
  refuse a tree with nothing on it - a review of a clean checkout of the base reports it clean - and
  `dev` must not, because on the first round it legitimately starts from one. One tuple for both
  questions would have made the first change in the fleet impossible or made every review a lie,
  depending on which way it was written. Two tuples: `continues` and `needs_commits`.
- **The planning phase cannot be in either tuple, because its answer depends on the round.** Round
  one prepares - it is the first step and that is what pins the base for everything after it. Round
  two must not, or it resets away the commits it is reading findings about. It is the only phase
  here whose tree handling is decided at dispatch rather than by the descriptor.
- **A continuing phase must inherit the base pin rather than take one.** `pinned_base` reads the
  MIRROR, which `prepare_worktree` refreshed - so a phase that did not prepare did not refresh, and
  asking again hands it a base newer than the change was written against. Exactly the bug the pin on
  the run row already exists to prevent, one phase later, and it surfaces as
  `merge-base --is-ancestor` refusing a good run.
- **Keying the knowledge-graph build on `needs_task` made the squash phase rebuild 38 MB it never
  opened**, on every publish. `--mcp-config` is the flag that actually makes the server reachable, so
  anything else deciding it is a second list that can disagree - silently, in both directions: a
  pointless 12-second build, or a phase whose prompt tells it to reach for the graph before grep with
  no server behind it.
- **`review` and `ship` had to join `ANSWERS_TO_A_TASK`.** Both answer on the same worktree and both
  run AFTER the dev phase, so both would be the newest answering row and the approval card would show
  a review object - or a squash receipt - labelled as what the phase said it did. The exact failure
  `plan` was added to that tuple for, twice more.

## A stable branch name, and the guarantee the head sha was quietly providing

- **`stop_after_if` fires correctly on a module that FOLLOWS a resumed suspend.** Measured
  2026-08-25 on a scratch flow, both directions: `again` true stopped the flow there with that
  module's result as the flow's and the module below never ran; false carried through to the end.
  `publish_auto` only ever proved it after a plain rawscript, and the `skip_if` trap one section up
  is what "a suspend nearby changes the meaning of the key beside it" looks like when it is real.
- **A branch named for the task is stable, and the head sha in the old name was load-bearing.**
  `agents/<worktree>-<head12>` was immutable by construction, so run N+1 could not move the ref while
  run N's approval was suspended. `agents/fix/1572-file-download-spec` can - a person then approves
  the card for run N and the pull request opens on run N+1's commit, with every check passing and
  nothing anywhere noticing. Two guards replace it: an open publication row for the same task refuses
  a new run at the PLANNING step, before a container costs anything; and every push that could move
  an existing ref is `--force-with-lease`d on the sha conduct itself last put there. A lease naming
  the value it expects to replace is stronger than a name that cannot repeat; what it is not is free
  of bookkeeping, which is why both are there.
- **A squash rewrites history and the gate measured a commit.** The tree does not change, so
  `tree_sha` is what carries the expensive measurement across the rewrite - one `rev-parse` in
  staging instead of a second 15-30 minute verification. A squash that changes the tree is refused,
  and the refusal keeps the VERIFIED commits as what publishes rather than throwing the run away.
- **The round counter must not be a flow argument.** A run form is editable in a browser, so a
  counter carried there is a bound anybody can reset to 1 for ever - and it is the only thing between
  a review that never comes back clean and an unbounded spend. It is a row in conduct's database, and
  the continuation pass measures against that row rather than against what it was handed.
- **Clearing the continuation marker AFTER starting the next round double-dispatches.** A crash
  between Windmill accepting the run and the row being written starts the same round twice - two
  containers, two rounds counted against a limit of two. Cleared first, a failed start restores it,
  so a transient failure retries and only a crash costs a round.
- **The publication pass must run before the continuation pass.** A round going back to planning
  stops a flow that ALREADY opened a publication row when the verification pushed, so that row has to
  be closed - no pull request, nothing to move - before the next round starts, or the new round's
  planning step refuses itself over its own predecessor's row.
- **A tracker outage at the review or the squash would throw away a verified change.** "Reading the
  work refuses the step" is right for planning and dev and wrong after the commits exist and the gate
  has passed on them; those two fall back to the task text conduct recorded on the run row.

## Three ways a new phase reads something that is not there

**All three were found before the phase ran, by reading its own prompt against its own allow
list.** None of them would have failed anything: each produces a confident answer from less
information than it was supposed to have, which is the shape this repository has the most names for.

- **`ALLOW_BASH_READONLY` had no git at all, and the reviewing phase's first instruction is
  `git diff <base>...HEAD`.** The line was drawn at "no git" on an argument about `git checkout` and
  `git stash` moving the tree - true of those verbs, not of git - and it cost nothing while the only
  read-only phase was `plan`, which reads source rather than history. The comment even named
  `git log` and `git diff` as "the one real cost of drawing the line here". Named read-only verbs
  now, two words each, because `Bash(git:*)` is the whole of git and the point is that this is not.
  **The subset test had to learn that these rules are command PREFIXES**: it compared strings, and
  the full list's `Bash(git:*)` is WIDER than `Bash(git log:*)`, so set difference called the
  narrower entry something the full list did not have.
- **rtk rewrites `git diff` and a summarised patch is not a patch.** Every command a model phase
  runs becomes `rtk <command>`, which filters output to save tokens - so a reviewing phase told to
  run `git diff` reads a SUMMARY and reports findings about code it never saw. upskald's own
  `self-review` skill says this in one line; the fleet's prompt did not. `rtk proxy` is the escape
  hatch and it is now in both prompts that need a real diff.
- **A bare `git commit` opens an editor**, and there is no terminal in a phase container. The squash
  phase also holds no `Write` tool, so the message has to reach a file through a shell heredoc.
  Recoverable by retry, and a retry is a turn of a three-dollar phase spent learning something the
  prompt already knew.

## The worktree is reused between changes, and so is everything keyed on it

**The reuse is deliberate and load-bearing** - it holds the `node_modules`, `.venv` and chromium
download that make the gate minutes rather than half an hour - so "the most recent X on this
worktree" means the previous TASK's X until this task has produced its own. Every reader that
existed before the review loop was safe by ordering: the plan phase runs first, and the dev phase
writes its verdict before verify reads one. The two the loop added were not.

- **The planning phase would have been handed the previous task's review to triage** on the first
  round of a new change - findings about code that is no longer in the tree, which it has no way to
  recognise as stale. Bounded by the chain's `opened_at`, which is the only stamp that means "this
  change" rather than "this directory".
- **The verification's push would have leased against the previous task's branch.** Round two
  onwards must lease - a dev phase that amended or rebased does not fast-forward, and a plain push
  is then refused as a non-fast-forward with no way to tell that from somebody else moving the ref -
  but `--force-with-lease` naming `agents/fix/1222-old` while pushing `agents/feat/1266-new` is a
  lease git refuses outright, and the run is lost for it. The report is dropped at the top of round
  one, which is the only moment that can tell a new change from another round.

## The last step of the pipeline is the first one that leaves the host

**Measured 2026-08-25 on the first full run of the round.** Task 1266 planned, changed, gated and
cleared its base-gate comparison - about forty-five minutes and twenty dollars - and then lost the
whole flow to `exit 128` on the push. The identical push succeeded by hand ten minutes later, so
nothing was wrong with the key, the ref, the branch name or the remote.

- **Everything before the push is already paid for by the time git opens a socket**, so a blip there
  discards a pipeline to answer a question nobody asked. Three attempts, five seconds apart.
- **The discriminator for "worth retrying" is the per-ref line, not the exit code and not a
  message.** `--porcelain` prints one line per ref once negotiation has happened, and a REJECTION
  always produces one - a lease that did not hold, a non-fast-forward, a hook refusing. A transport
  failure produces none, because git never got that far. So "no ref line" is exactly "the remote was
  never reached", which is the only failure a retry can fix. Matching on the message would couple
  the decision to somebody else's English and would retry a deterministic no more slowly.
- **ssh ends every transport failure with the same trailer**, so keeping the LAST line of what git
  said kept the one line that says nothing: *"Please make sure you have the correct access rights
  and the repository exists"* reads identically for a revoked key, a wrong repository, a DNS failure
  and a dropped connection. The sentence naming the cause is always the line above it.
- **A handler that raises was answered and never echoed.** The reason went to Windmill and to a
  `dispatch` row, so a person reading `journalctl` saw `poll: failed <job>/<module>` and nothing
  else - on the one path where the orchestrator has already decided the run is over.

## A failed flow is unrecoverable and almost nothing in it is

- **A Windmill `CompletedJob` is terminal.** There is no endpoint that resumes one and none that
  pretends to, so "resume the flow" is not available in any form. What IS available is a new flow
  run in which conduct answers the steps its own tables record as finished - the plan on a run row,
  the commits on a worktree a `continues` phase never resets, the review on another run row.
- **The gate must never be part of that.** It costs no model spend, it is what the pull request
  rests on, and `publish.push` lives INSIDE it - so a run whose push failed has nothing on the
  remote to open a pull request from and has to re-run it regardless. The saving is the three model
  phases; reusing a stored report would buy wall-clock nobody is billed for at the price of the one
  code path whose bug publishes unverified work.
- **`run.result = 'ok'` is not "this step succeeded".** A plan phase that exits 0 and answers
  nothing leaves an `ok` row and is a failure - `_plan_step` says so. Anything deciding what to skip
  has to be RECORDED by the code that made that judgement, never derived from an exit code.
- **A skip that trusts a flag alone publishes whatever is in the tree now.** A worktree is a
  directory on a host a person can reach, so the dev-phase skip compares HEAD against what the round
  recorded and runs the phase again if it moved.
- **The counter counted the wrong thing.** `_plan_step` called `chain_open`, which increments, so a
  resume would have counted as round two and left the change one round short. The counter means
  planning phases actually RUN, and moving the call behind the skip is what makes that true.
- **`not payload.get("exit_code")` also matches a phase that exited 0**, which is why the
  "did conduct break" test is `exit_code is None`. `cycle()` sets the key and leaves it null on a
  raised handler; every handler answering a failure of its own fills it in.
- **A failed flow notified nobody.** `_note_for_a_person` fires only when a HUMAN GATE is next, so a
  run that died at the gate left one journal line on a host nobody watches - and a person who
  dispatched a task and heard nothing cannot tell that from one still running.

## One artefact for two readers, and the flag that unmade a pull request

- **`+` IS A SUCCESSFUL FORCED PUSH and `publish._FLAGS` did not know it.** git documents six
  porcelain flags and the table listed three; `+` is unreachable until something pushes with
  `--force`, so it did not exist until the leased re-push landed and the table was not revisited on
  the day the flag became possible. Measured on avanserv/upskald#252: the squash succeeded, the push
  succeeded, `_status` called it a refusal, and the pull request opened describing a commit its
  branch no longer held - wrong sha, wrong compare link, the pre-squash commit's subject as the
  title, and an error that never happened leading the reasons a person was being asked. The TREE was
  right the whole time, so every check was green. **Name the flags from git's own list, not from the
  ones that happened to occur.**
- **The approval card is not a pull request description.** The card answers "should this be
  published at all", for one person, at one moment, beside evidence, behind a passkey; a pull
  request answers "is this right", for whoever reads it, months later. `pr_body` was `render()` with
  the log paths stripped, so #252 opened with `### Why you are being asked` where its description
  should have been.
- **Withholding a skill does not stop the fleet doing the thing.** `pr` was excluded because its
  step 4 runs `gh pr create`; the fleet wrote a body anyway, just not the project's. Shipping it
  with an override table naming what cannot work is cheaper than a second copy of somebody else's
  convention - and the acceptance criteria needed no parser, because `odoo.prompt_text` already
  renders them as the Given/When/Then bullets the skill asks for.
- **Two model phases looking at one finding do not name it the same way.** Five follow-ups reached
  the tracker and two pairs were one task each, differing by "API" and by "response" - which a
  case-folded title comparison cannot see. Word sets, merged when one contains the other; over-merging
  loses a follow-up nobody wrote down twice, under-merging litters a backlog for ever.

## A backlog is a corpus, and the parent task is in it

- **Nothing ever asked the tracker whether a follow-up already existed.** `_merge_follow_ups`
  deduplicates the two sources of ONE run against each other and stops there, so a task re-run after
  a failure re-files everything it filed the first time, and a follow-up duplicating a task a PERSON
  wrote was never checked at all. Same litter, different door.
- **The rule survives a wider corpus; the LENGTH at which it is trusted does not.** Measured over the
  905 open non-epic tasks in project 17, the bare word-set subset rule collides 9 times and every
  invention is one shape - `Public status page` inside `Include the public API in SLOs and on the
  status page`, `Audit Logs` inside `Retain audit logs at least twelve months`. Short, epic-ish
  titles swallowing real work. At a floor of four distinguishing words **on both sides** it collides
  3 times and all three are genuine duplicates. The dangerous direction is the short EXISTING title
  eating a long candidate, so a floor on the candidate alone would have left the failure in place.
- **A follow-up's own parent task is a false positive, and only a live run showed it.** With 1266
  `Cap the size of a request body` back in Pending, a candidate of that name matched the task that
  asked for it. A follow-up is deferred work FROM its task, the parent is usually the shortest
  phrasing of the subject, and every narrower follow-up is therefore a superset of it.
- **A tracker search that fails must file anyway.** The asymmetry inverts the one `_merge_follow_ups`
  reasons from: a duplicate in Backlog is something a person deletes, a finding dropped because a
  search timed out is gone. The note is what stops the degradation being silent.
- **The cap has to apply to what SURVIVES the dedup.** Applied first, three already-open titles spend
  three of the five slots and a genuine sixth is never reached.

## A binary that answers is not a binary that works

- **`node` is assumed by every JS action and declared by none.** `ubuntu-latest` ships it at
  `/usr/local/bin/node`, so no workflow installs it and no workflow declares it. Without it prek's
  `root-lint` hook fails with `Failed to run hook 'root-lint' ... No such file or directory
  (os error 2)` - naming the HOOK, not the interpreter it could not spawn. Deliberately NOT the
  runner's own `externals/node24`: that is an implementation detail the runner replaces on
  self-update, and putting it on PATH would tie every job to the runner version.
- **`nodejs24` ships `node` alone.** `npm` and `npx` are `nodejs24-npm`, and an action shelling out
  to `npx` fails the same quiet way.
- **Fedora builds node `small-icu`, so `Intl` works and answers with the input.**
  `Intl.DisplayNames(['en'],{type:'region'}).of('NL')` returns `NL` rather than `Netherlands`.
  Nothing throws and nothing warns; a sort by display name simply comes out in a different order,
  which is how upskald's *"orders countries by English display name, not ISO code"* failed ONE test
  of 4,460 and read as flake. The test was right and the image was wrong.
- **The gate has to assert BEHAVIOUR, not the build flag.** Checking
  `process.config.variables.icu_small` would pass on any future base that bundles locale data
  differently. The display name is what the workflow actually depends on, so that is what is
  asserted.
- **A binary list is only as good as its enumeration.** The smoke test asserted twenty-six binaries
  and shipped a lane that could not lint, because `node` was not one of them. Same shape as the
  hand-maintained unit watchlist: a check that cannot see what nobody thought to add.

## Turning a feature off costs nothing when it bills per person

- **GHAS bills per ACTIVE COMMITTER, not per repository**, so disabling it on 17 of 19 repositories
  saved exactly $0. The two that mattered were the two with commits.
- **`security_and_analysis.advanced_security` reports ABSENT, not `disabled`**, on a repository that
  is actively billing - so a check reading the field cannot distinguish "off" from "not reported".
  The `code-scanning/default-setup` **403 is the only reliable negative**.
- **A PATCH containing `advanced_security` is rejected ATOMICALLY.** Including it made GitHub refuse
  the whole body, so `secret_scanning` silently stayed enabled while the call looked like it had
  been sent. Send only the fields that are settable.
- **A minimal code-security configuration defaults every setting it does not name to `disabled`**,
  which would have taken Dependabot alerts and private vulnerability reporting with it. The
  GHAS-gated settings have to be spelled `disabled` and the free ones `not_set`, explicitly.
- **`gh api --jq` prints error bodies to STDOUT.** So "did the call return anything" reads a 403 as
  an answer, and a verification script keyed on output rather than exit code reported every
  still-billing repository as clear. It inverted a check twice in one session.
- **`gh api` returns `visibility` LOWERCASE.** Comparing it against `PRIVATE` made a billable count
  read 0 for every repository, which presented as a clean bill of health at $47/month. Caught only
  by reading the rows the script had printed beside its own conclusion.

## The engine kept its state where the job could reach it, and the ninth reproduction still did not fire

- **`XDG_RUNTIME_DIR` was `/tmp/podman-run`**, so podman's locks, its exit files, its rootless
  network state and the pause process pid file that owns the user namespace every nested layer is
  mounted into all sat on the same 512 MB tmpfs a workflow's own steps write to - and `/tmp` inside
  a lane is 1777, so any step can reach it.
- **`runroot` in `storage.conf` LOSES TO `XDG_RUNTIME_DIR`, silently.** The file said
  `/run/nested-storage` and podman reported `Store.RunRoot: /tmp/podman-run/containers` throughout.
  Identical shape to `graphroot` losing to `rootless_storage_path` one setting up: a value that is
  read, a value that is honoured, and no warning separating them. The fix is to make both name the
  same path, and to have the gate ask the ENGINE rather than read the file back - reading the file
  back would have passed the whole time.
- **`/run` was uncapped at half the HOST's memory.** `--read-only-tmpfs` mounts `/run`, `/tmp` and
  `/var/tmp`; `/tmp` was always sized and `/run` inherited podman's default, measured at **7.8G
  inside a lane whose `MemoryMax` is 3,584M**, because a container is not memory-namespaced. A
  tmpfs is charged to the cgroup that owns it, so that is a route to the hard limit with every
  process behaving - the trap already recorded for Chromium and `$TMPDIR`.
- **An explicit `--tmpfs` REPLACES the read-only-tmpfs mount rather than adjusting it**, so
  `tmpcopyup` is required or the image's own `/run` - console, lock, log, secrets, sudo - vanishes
  behind an empty filesystem. Measured with the flag: all fifteen entries present at 64M.
- **uid 1000 cannot `mkdir` in `/run`.** It arrives 0755 root:root, and `mkdir: cannot create
  directory '/run/probe-dir': Permission denied` with `runner` in group 0 and everything else about
  the container correct. So the runtime directories are created by the entrypoint's root branch
  before it drops, and the unprivileged half ASSERTS rather than creates - under `/tmp` the mkdir
  always succeeded, so a tolerant `|| true` would have become podman silently choosing a fallback
  directory and warning on every invocation for the rest of the job.
- **NINE REPRODUCTIONS OF upskald's `api-checks` FAILURE, AND NONE OF THEM FIRED.** Both service
  images; `run -d` against `create`+`start`; the driver's full flag set; a store reused across six
  recycles; the faithful systemd scope with `--cgroups=split` and the 3,584M cap; 1,662 verified
  `MemoryHigh` breaches of deliberate slice pressure; `/tmp` filled to 90%; and finally the
  user-namespace hypothesis taken apart three ways in ONE run - the pause pid file deleted, the
  pause process killed, and the whole runtime directory wiped, each between `create` and `start`.
  All four started postgres cleanly. **The runtime-directory move is therefore filed as a
  correctness fix and NOT as the cure**, which is the distinction the pinned-base entry above
  exists to keep.
- **So the docker shim stopped being only a witness, and the reversal is stated rather than made
  quietly.** It shipped saying "no retry, no suppression"; that sentence was written while "find the
  cause" was still on the table, and nine reproductions later it is not. A failing `docker start` is
  now attempted up to three times, 2s then 5s apart, every attempt announced in the job log and
  every post-mortem kept.
- **A FAILING `podman start` writes ZERO BYTES to stdout** (rc=125, len=0, measured), which is the
  only reason the retry is safe: `DockerCommandManager.cs` parses container ids off stdout, so a
  retry that could print an id twice would break every `services:` job rather than only the failing
  ones.
- **`docker start -a` returns the exit code OF THE CONTAINER**, so a non-zero result there is an
  ordinary outcome and retrying would run the container a second time and duplicate its output. Any
  `-a`/`--attach`/`-i`/`--interactive` disables the retry, combined short flags included. This was
  nearly missed, and it would have been a real bug rather than a noisy one.
- **The gate is the point, because the retry is the only thing in the image that can turn a red job
  green.** The leg asserts four directions against a container that cannot exist: it still exits
  non-zero, stdout stays empty, the ELAPSED TIME proves the retries actually ran rather than being
  merely intended, and `docker start -a` returns in under a second having not been retried.

## The store remembered the old runroot, and podman believed it over everything

- **libpod records its runroot and tmpdir in `db.sql` at the root of the GRAPH ROOT**, which
  in a lane is a bind mount that outlives every image upgrade. Change `XDG_RUNTIME_DIR` and
  podman does not error on the mismatch: it reads the recorded value and uses it, over the
  environment **and** over `storage.conf`, silently. This is the third member of a family -
  `graphroot` losing to `rootless_storage_path`, `runroot` losing to `XDG_RUNTIME_DIR`, and
  now both of them losing to a database written weeks earlier.
- **The result is TWO ENGINES OVER ONE STORE.** `/run/podman-run/libpod/tmp/` held
  `pause.pid` alone, from the environment; `/tmp/podman-run/libpod/tmp/` held `alive`,
  `events`, `exits` and `persist`, from the database - with `podman info` answering the
  database's path while the process holding the user namespace was registered under the
  environment's. `containers/storage` keeps overlay mount refcounts under the runroot, so
  two engines disagreeing about it can each believe the other mounted a layer.
- **REPRODUCED ON DEMAND, after ten reproductions that fired at nothing.** Three passes over
  one store: seeded with the old path, together and clean; same store with the new path,
  SPLIT; same store, new path, `db.sql` deleted, together and clean again. That is also the
  repair, and it is why only `db.sql` is removed rather than the store - the images below it
  are the whole reason the store is a mount of its own.
- **The test is a string in a file, not a podman invocation.** Asking podman would start the
  very engine whose configuration is in question, and it would answer with the stale value
  it is being asked to detect.
- **A SPLIT IS NOT SUFFICIENT TO BREAK `docker start`.** In the reproduction the split was
  real and the container started anyway. `api-checks` also failed before the split existed.
  So this is a defect that was making every diagnosis unreadable, not the cause of that
  failure - a distinction worth keeping, because a fix that lands next to a symptom is the
  easiest thing in the world to over-claim.
- **The smoke test ALREADY had this assertion and reported `ok` on the broken image.**
  `bin/github-runner-smoke.sh` checks that `RunRoot` sits under `XDG_RUNTIME_DIR` - exactly
  the split - and it cannot fire, because `runner()` builds a FRESH lane and a fresh lane has
  no `db.sql` to be stale. Only a lane that has already run work can show it. So the gate is
  `ci.runtime_dir` in `bin/verify-host.sh`, the one battery here that reads a RUNNING lane,
  and it was **proved to FAIL against the two deployed lanes before it was trusted to pass**.
- **`podman exec` without `--user` is container ROOT and reports `rootless: false`**,
  resolving its runtime directory by a different code path entirely. It answered `/tmp` for a
  lane whose jobs were using `/run` and cost an hour. Every measurement inside a lane has to
  name uid 1000 explicitly.
- **The runner's environment was correct the whole time.** Read from the host out of
  `Runner.Listener`'s own `/proc/<pid>/environ`: `XDG_RUNTIME_DIR=/run/podman-run`. The
  actions runner, `run.sh`, `run-helper.sh`, `.env` and `.path` were all eliminated before
  the store was looked at - the environment was never the carrier.
- **A smoke leg was proving something other than its own sentence.** It ran `docker info` and
  reported "the endpoint DOCKER_HOST points at" - but `docker` is the shim, which execs the
  LOCAL podman, and podman honours `CONTAINER_HOST`, not `DOCKER_HOST`. It measured the local
  engine and asserted nothing about the socket. Both are asked now.
- **`.env` and `.path` in the runner tree rewrite every job step's environment.**
  `Runner.Listener` applies both at start-up, GitHub's tarball ships neither, and
  `$LANE_ROOT/runner` is seeded once and never re-seeded or garbage collected - `gc_disk()`
  clears `home/work`, `tmp` and `storage` and deliberately leaves it. A file written there
  under one image is read by every image after it, for ever.
- **`--log-driver=none` MAKES EVERY DIAGNOSTIC INSIDE A LANE UNREADABLE.** The repair above
  announced itself in six lines of stderr and not one of them reached the journal: podman
  discards the container's streams, so `runner-init`'s socket failure, its writability
  assertion and its store repair are all invisible. The failures at least exit non-zero,
  which the driver reads as a fault; a *successful* repair leaves no trace whatsoever. The
  same test therefore runs host-side in `bin/github-runner.sh` before the container starts,
  where `log` reaches the journal, and the in-container copy is the backstop. Two
  implementations of one rule, taken deliberately over a repair nobody can see.
- **The expected value is read from the IMAGE**, not written as a constant in the driver, so
  the check cannot drift from the `ENV` it is checking against.

## The post-mortem measured the wrong mount namespace, and reported it as a finding

- **Rootless podman mounts inside the PAUSE PROCESS's mount namespace, not the caller's.** That
  is what the pause process exists for: a mount made in a transient namespace would vanish when
  the CLI exited, taking a detached container's rootfs with it. So `grep -c ' overlay '
  /proc/self/mountinfo` and `ls -A <layer>/merged` from a shell see **nothing the nested engine
  has mounted**, however healthy it is.
- **Measured on a HEALTHY, RUNNING postgres in a lane**: `overlay mounts shim-ns=1 pause-ns=2`,
  `merged entries shim-ns=0 pause-ns=18`, `mountpoints.json` 198 bytes. The failing job reported
  `overlay-mounts=1` and twelve empty `merged/` directories - **which is the same reading a
  working container gives.** "The nested podman mounted nothing" was therefore never measured,
  and it was written into `docs/ci.md`, this file and the `CLAUDE.md` index as though it had
  been. Retracted.
- **`/proc/<pid>/root` resolves a path in that process's mount namespace** and needs no
  privilege beyond the same uid. That is the whole fix, and it costs one `cat` of `pause.pid`.
- **Print BOTH numbers, labelled.** The old reading is in the record; a reader has to be able to
  see why it said 1 rather than find a silently different number and distrust both.
- **A SECOND reason the reading proved nothing, independent of the first.** libpod unmounts the
  rootfs in its cleanup when the OCI runtime fails at start, so the post-mortem runs AFTER the
  teardown. An empty `merged/` and a 2-byte `mountpoints.json` are equally what a container that
  mounted, failed and was cleaned up leaves behind. **Post-failure state cannot distinguish
  "never mounted" from "mounted, then unmounted"** - so the block now prints `State.Status` and
  `State.Error` to say which side of cleanup it is standing on.
- **The instrument had no control.** The layer-and-mount block had never once been printed on a
  SUCCEEDING `docker start`, so there was no baseline saying what healthy looks like - in a file
  whose own comment argues that "a failing job's line means nothing without a passing one beside
  it", about a different measurement three lines away.

## A tool that assumes a distribution, and does not check before it fails

**`playwright install --with-deps` supports Debian and Ubuntu and nothing else, and it does not
detect that it cannot work.** On the Fedora lane it printed `BEWARE: your OS is not officially
supported by Playwright; installing dependencies for ubuntu24.04-x64 as a fallback`, went ahead
with the Ubuntu package list anyway, and failed on `apt-get: command not found` with exit 127.
All three e2e shards, on the first run that ever reached the step.

- **The libraries were never missing.** `apps/github-runner/Dockerfile` installs the chromium set
  with dnf and names each package, with the reason written beside them - and that comment
  predicted this exact failure, adding that "the thing that would catch it going stale is an e2e
  job actually running". It was right on both halves.
- **The warning names the wrong problem.** "Your OS is not officially supported" reads as a
  Playwright compatibility statement about the browser. It is a statement about the dependency
  installer alone; the browser runs fine.
- **Gated on `runner.environment`, NOT deleted**, which is a change from what `docs/ci.md`
  advised for a year. Dropping `--with-deps` outright leaves the hosted path depending on
  GitHub's image happening to carry Playwright's library set - the assumption Playwright's own
  documentation says not to make - and hosted is the escape hatch the whole `CI_RUNNER`
  indirection exists for.
- **The next Playwright bump that needs a new library will not fail at that step.** Nothing on
  the lane re-derives the list, so the symptom is Chromium failing to launch on a missing `.so`
  several steps later, naming the library and not the step.

## The lane that healed itself, because the remedy had been a person

**`api-checks` has passed cleanly since both lanes were emptied BY HAND on 2026-08-25** - zero
retries, zero post-mortems, `docker start` first attempt, twice in a row and then again with the
full e2e matrix behind it. That is the first time a `services:` block has worked under the real
runner on this host, and **nothing was repaired**.

- **A one-minute reproduction is what got that far.** `lane-probe.yml` in upskald, a push to one
  branch, carrying `api-checks`' service block verbatim over a body that does nothing. Eleven
  prior hypotheses had each cost a thirty-minute job, which is why cheap-but-unfaithful
  reproductions kept being run instead. Four variants in an afternoon eliminated `ports:` and the
  `rootlessport` child netns, the runner's own container-init path (the identical eleven calls
  issued FROM A STEP behave the same) and the inherited environment (`env -i` behaves the same).
- **The one positive result: on wiped lanes all four variants pass; on lanes carrying ~2.4-2.7 GB
  of state from twenty-odd real jobs, all four fail.**
- **It is not a threshold on size or job count, which was the obvious next guess.** It failed at
  2.4 GB after 21 jobs and passes at 2.5 GB after 39. Something specific accumulates and nothing
  has identified it.
- **So the state is BOUNDED rather than explained, and `bin/github-runner.sh` uses that word.**
  `gc_lane` resets `home/work`, `tmp` and `storage` on three triggers - the disk budget, a 50-job
  window, and the shim asking to be healed. The caches are not in it: `home/.cache` and
  `home/.bun` survive and `actions/cache` lives on GitHub, so a reset costs one re-pull of three
  small images.
- **`$HOME` is the only channel out of an ephemeral lane.** The shim runs in a container whose
  stdout belongs to a job log the driver never reads and whose filesystem is gone seconds later -
  except `$HOME`, which is a bind mount. So an exhausted retry leaves a file, and the driver acts
  on it at the top of the next cycle, which is the only moment it knows no job is running.
- **The manual remedy destroyed the evidence every time, and the automated one must not.** Twelve
  reproductions have failed to recreate the state that was thrown away. A reset with a reason now
  copies `db.sql` and the layer, container and image json first - kilobytes, against the 2.5 GB a
  tar of the store would cost - and a routine window reset captures nothing, because there is no
  anomaly in it and fifty of them would evict the two that matter.
- **`cp -a` would have made that capture unreadable, and the first version used it.** `-a`
  preserves the SOURCE's owner and mode, so the copy lands outside the namespace owned by the
  mapped subuid instead of by `core`. Measured: db.sql is 0644, but `layers.json`,
  `containers.json` and `images.json` are all **0600** - three of the five. The commit that
  introduced the fix named db.sql as the 0600 file, which is wrong; the hazard is real and it is
  on the other three.
- **`mountpoints.json` does not exist on an idle lane**, which is not an error - it is written when
  something is mounted, so its absence from a capture is itself a reading. Every copy is `|| true`
  and none is asserted.
- **Automating the wipe is what makes silence the new risk**, so `ci.lane_store` reports a lane
  that healed itself and names the capture. A window reset is deliberately not reported at all.

## Three defects in one reclaim, and the first one hid the other two

**`gc_disk` had never once fired**, so nothing downstream of its threshold had ever executed. That
is what made it possible for three separate defects to sit in twelve lines.

- **It measured with `du` as `core` and removed with `podman unshare rm`.** Half the function was
  inside the user namespace and half was not, and the half that was not skipped every directory it
  could not traverse and reported the remainder WITHOUT AN ERROR: **1,383 MB against 2,500 MB
  actual** on lane 1, the same shape on lane 2. The 20 GB budget was compared against a number low
  by roughly half, and `ci.lane_disk` reported the same understatement to the dashboard.
- **It cleared `home/work`, WHICH HAS NEVER EXISTED.** The just-in-time configuration sets
  `work_folder:"_work"` and the runner resolves that against its OWN directory, so every checkout,
  every `node_modules` and every uv venv lives at `runner/_work`. `home/` holds `.bun`, `.cache`,
  `.config` and `.local` and nothing else. The removal named a path that was not there, reclaimed
  nothing, and reported nothing - `rm -rf` on a missing path is a success.
- **It recreated `tmp/` and `storage/` with a plain `mkdir` and never chowned them back**, so the
  next lane would have met `mkdir /home/runner/.local: permission denied` - the exact state
  preflight's chown loop exists to repair, and a failure that names neither the cause nor the
  chown.
- **A budget reclaim has to take the caches and a targeted one must not.** Measured on lane 1:
  home 1,789 MB, runner 799 MB of which `_work` is 81, storage 660 MB. The caches are the largest
  thing in a lane by a factor of two, so a reclaim that spared them could not get back under the
  budget - and would then fire on every cycle, re-pulling three images each time, for ever.
- The lesson is the ordering. A check that under-reports does not merely warn late: it hides
  everything gated behind it, and the code downstream stops being reviewed because it never runs.

## A ceiling nothing measures is a ceiling nobody can tell is wrong

**`host/systemd/app-ci.slice` asked in its own comment to be rewritten from `memory.peak` and
`pids.peak` "after the first e2e shard", and named its own failure mode as silence.** The driver
now keeps both off each transient scope, in the marker, as a high-water mark across every job.

- **The scope is `--collect`, so it is gone the instant the container exits.** A read at job end
  finds nothing; the numbers have to be sampled while the job runs. They are kernel high-water
  marks, so the sample rate does not decide the answer - what a 30-second poll can miss is a peak
  reached in the last interval before exit, which is teardown rather than test. That is a floor on
  the true peak and is stated as one.
- **`memory.events` counts within ONE cgroup and the cgroup is new every job**, so folding it into
  a lifetime counter on every poll would add the same job's events once per poll. Per-job, then
  added once at the end.
- **Sampling once per 30-second poll left the marker 551 MB low**, measured mid-shard against an
  independent sampler: driver 2,266 MB, sampler 2,817 MB, **`pids.peak` agreeing exactly at 120**,
  which is what said the gap was staleness rather than a bad reader. 15% of MemoryMax on the one
  number the check exists to grade. It now samples on `nap()`'s two-second tick - the tick that
  already exists so a SIGTERM does not have to outwait a sleep - which narrows the window
  fifteen-fold and still does not close it.
- **Grade on the events, never on the peak.** `memory.peak` includes page cache, and
  `app-agents.slice` records that exact reading being misread once already - 3,566M of apparent
  pressure that was `uv sync` cache being reclaimed as designed. `memory.events max` is the hard
  ceiling actually binding and `oom_kill` is the kernel having chosen a victim.

## The failure came back on the machinery built for it, and one number differed

**It recurred on 2026-08-26 at 12:52 on lane 2**, in a re-run of a pipeline that had just gone
green. The whole chain ran on its first real occurrence: the shim retried, post-mortemed and left
the breadcrumb; the driver read it 21 seconds later, captured the store and reset the lane;
`ci.lane_store` reported it. Nobody had to notice a red job.

- **The driver's capture was nearly worthless, for a reason already on record.** Against a capture
  from a healthy lane 13 minutes earlier: 20 layers each, `incomplete=0` in both, no mount state in
  either, `containers.json` 2 bytes in both, `mountpoints.json` absent from both, `images.json`
  byte-identical. **A failing lane's store metadata is indistinguishable from a working one's** -
  because libpod unmounts on a failed start and the runner then `docker rm --force`s the container,
  so a capture 21 seconds later is POST-CLEANUP by construction. The same limitation that was
  written about the shim's own block, rediscovered in the thing built to get round it.
- **What did say something is the shim's block, WITH A CONTROL BESIDE IT for the first time** - a
  postgres started by hand on a healthy lane thirty seconds later, same nested engine:

  ```
                   merged gid   work gid   overlay mounts (pause ns)   merged entries
  failing start    65535        65535      1                           0
  healthy start    0            0          2                           18
  ```

  and all eleven other layers in that healthy store read gid 0 too.
- **65535 IS NOT THE OVERFLOW GID, which was the first guess and is wrong.** This host reports
  `overflowgid` **65534**, and the nested engine's gid map is `0 1000 1` / `1 100000 65536`, so
  65535 is inside the mapped range - a real gid that something chose. What chooses it is unknown.
  The post-mortem now prints both gids and the baseline, so the next occurrence is unambiguous.
- **Two lanes is not a sample.** Lane 2's store had not been reset and lane 1's had, and lane 1
  worked through the same run. That is consistent with the accumulated-state correlation and is not
  evidence for it.

## Four heals in a day, and three instruments that were pointed at nothing

**2026-08-26 produced four occurrences of the `docker start` failure**, not the one on record:
lane 1 at 12:39, lane 2 at 12:53, lane 2 at 20:46, lane 1 at 20:57. Every one retried,
post-mortemed, breadcrumbed, captured, healed and passed its next job with nobody involved, which
settles "that the bound holds". Investigating them settled nothing about the cause and found three
readings that could never have said anything.

- **THE POST-MORTEM WAS REACHING NOBODY, and had not been since the tee was added.** It goes to a
  file under `$HOME` *and* to stderr, written `tee FILE 2>/dev/null >&2` - and redirections apply
  **left to right**, so tee's stdout was pointed at the `/dev/null` fd 2 had just been pointed at.
  Measured: the two evening failures carry **three post-mortem groups each in their forensic
  capture and ZERO in the job logs GitHub kept.** Nothing failed, nothing was empty, and the
  `--log-level=debug` block - echoed directly rather than tee'd - was there both times, which is
  exactly why nobody noticed the other one was gone. Third defect in that one line. The smoke test
  asserted the FILE and only the file; it now counts what lands on stderr.
- **`mountpoints.json` WAS NEVER ABSENT, IT WAS THE WRONG PATH**, and the comment explaining its
  absence as "not an error - it is written when something is mounted" made a bug look like a
  finding. `containers/storage` keeps it in the **RUNROOT**,
  `$XDG_RUNTIME_DIR/containers/overlay-layers/mountpoints.json`, never in the graph root the
  capture copies from - the runroot holds its `mountpoints.lock` and the graph root holds neither
  file. So four captures recorded a meaningful-looking absence of the one file that would show an
  orphaned mount refcount. **It cannot be fixed by pointing at the runroot either**: that tmpfs
  dies with the lane and the capture is taken from the host a cycle later.
- **THE 65535 GID WAS READ AGAINST THE WRONG NAMESPACE'S MAP.** The record said the nested engine's
  gid map is `0 1000 1` / `1 100000 65536`, so 65535 "is inside the mapped range and a real gid
  that something chose". Those two lines are the **LANE's own** map. The nested engine runs as
  `runner`, uid 1000 with primary gid 0, `/etc/subgid` gives it `runner:1:999` and
  `runner:1001:64535`, so its map - off the pause process, which holds that namespace - is
  `0 0 1` / `1 1 999` / `1000 1001 64535`. **Lane gid 65535 is the CEILING of that map and is what
  nested gid 65534, the nested overflowgid, maps onto.** Printing the lane's overflowgid (65534)
  and ruling overflow out on that basis is one namespace too high. The question is not what chose
  65535; it is which chown targeted a gid the nested map does not contain.
- **Three of the five rows in the failing-vs-healthy table cannot discriminate at all**, because
  the failing side is post-cleanup and the healthy control was read from a RUNNING container.
  `mounts 1 vs 2`, `merged 0 vs 18` and `mountpoints.json 2 vs 198 bytes` are three spellings of
  "one of these has been torn down". Only the two gid rows survive an unmount. **So the shim now
  SAMPLES the start** - one line per ~100ms while `podman start` runs, printed only on failure -
  and the setup must happen BEFORE the fork or a start that fails in 230ms kills the sampler
  before it writes a line, and the backgrounded subshell must clear the EXIT trap or it deletes
  the samples on its way out.
- **The load it was blamed on was absent for two of the four.** The evening pair ran against two
  saturated lanes; the midday pair did not. `store_jobs` at the three clean failures was 4, 12 and
  18 - the 50-job window has never fired ahead of a heal. The 12:39 row is not a data point: its
  driver had restarted one second earlier, so `store_jobs=0` is a counter reset. And a mid-job
  `lane_reset` is ruled out rather than assumed - the journal shows the heal two seconds AFTER
  "job finished" in both evening cases.
- **`chown 1000:1000` writes a gid nothing else in the lane writes.** The runner's primary gid is
  0, so every file it creates is gid 0; measured, `$LANE_ROOT/storage` was `100999:100999` on top
  of a tree of `100999:core`. Now `1000:0`. And preflight's `-R` form ran over a POPULATED store on
  every driver start - the only code here that rewrites gids inside a live nested store.
- **AND THAT CHOWN IS NOT RULED OUT, WHICH WAS FIRST WRITTEN THE OTHER WAY.** "Both drivers held
  their pids across the window" is true of 20:34-21:10 and was read off that window alone. **Both
  drivers restarted at 13:43:43** - after the midday resets, about seven hours before the evening
  failures - so the recursive chown ran over both populated stores and both of those stores later
  failed. Not evidence of cause: dozens of jobs passed on them in between, and the midday pair
  failed BEFORE the restart. It is enough that the dismissal had not been measured, on the one
  asymmetry this bug has ever shown, which is an ownership one.
- **Fedora ships NO pip for a parallel-installed `python3.13`.** `setup-python` resolves 3.13 out
  of the seeded tool cache in ~150ms and hands back an interpreter with no pip, so `python3 -m pip`
  fails on the line after "Successfully set up CPython". There is no `python3.13-pip` package -
  `repoquery --whatprovides "python3.13dist(pip)"` is empty - and `python3-pip` targets Fedora 44's
  default 3.14. `ensurepip --altinstall` is the route, and `--altinstall` is load-bearing: without
  it, 3.14's `pip3` becomes 3.13's.

## A thing that shipped, a thing that could not arrive, and no way to tell them apart

Added 2026-08-27, working `avanserv/upskald`'s five requests in
`docs/runbooks/home-server-lane-requests.md`.

- **`gh` was never in the lane image, and the cost is the CONSUMER rather than the package.**
  Nothing in a workflow declares it - hosted runners ship it, so `gh api` is written as though it
  were `cat` - and its absence FAILS GREEN twice over. upskald's `scripts/ai_review_state.py`
  resolves the incremental review's baseline through `gh run download`, and its `_run` helper
  catches `OSError` and returns `(False, "")`, so a missing `gh` turned every AI review into a FULL
  review against the whole tree and billed them per push with nothing failing and nothing warning.
  Its sibling consumer, the coverage baseline, read the same way and warned-and-passed having
  enforced no threshold at all. Fedora 44 carries `gh` in `updates` at 2.97.0-2.fc44, 39.9 MiB
  installed, `/usr/bin` - so it is one word in the dnf list and the `cli/cli` RPM repository is not
  needed.
- **The two assertions worth making about it are not "is it installed".** It writes `~/.config/gh`
  on first use, on a rootfs `bin/github-runner-smoke.sh` asserts fifteen lines later REJECTS
  writes - which works only because `$HOME` is the lane's bind mount and `runner-init` made
  `$HOME/.config` first, a chain of three things any of which a later change could break without
  touching `gh`. And it resolves `GH_TOKEN` with no login and no config file, which is the whole
  reason no credential has to reach the image. `gh --version` proves neither.
- **THE TOOL-CACHE SEED GUARD KEYED ON EXISTENCE, WHICH IS NOT A VERSION.** `runner-init.sh` read
  `[ ! -d "$RUNNER_TOOL_CACHE/Python" ]`, so a lane was seeded exactly once ever and no later seed
  could reach it. The `ensurepip` work shipped in the image on 2026-08-27 and reached NEITHER
  deployed lane. Measured the same morning: the seed held `pip pip3 python python3`, both lanes
  held `python python3` dated the previous day - with the tool cache present, the `.complete`
  marker in place, `setup-python` resolving 3.13 in 150ms, and every check on this host green.
  upskald wrote the prediction down in their runbook before it happened; nothing here noticed it
  after.
- **The stamp is derived from the tree, not written by hand**, because a hand-bumped `ARG` is a
  second thing to remember at the moment attention is on the first, and this seed has already
  proved what forgetting costs. The cache is CLEARED rather than copied over: an overlay would
  leave a previous Python minor in place and `setup-python` may resolve either, which no job log
  makes visible.
- **`bin/github-runner-smoke.sh` cannot grade the stale case and says so.** `runner()` builds a
  fresh lane, a fresh lane has no stamp, no stamp is a mismatch, and a mismatch always re-seeds -
  so it passes by construction on the one shape that broke, and did. It asserts the MECHANISM; the
  check that can see a deployed lane is `ci.toolcache_seed`. Same division of labour as
  `ci.runtime_dir` and the `db.sql` guard, for the same structural reason.
- **The smoke test chowned `1000:1000` where the driver chowns `1000:0`**, under a comment claiming
  they matched, with the failure message at the writability leg repeating the wrong one. gid is the
  ONLY asymmetry the intermittent `docker start` 125 has ever shown - a failing layer reads
  `merged`/`work` at the nested engine's overflowgid, a healthy one reads 0 - so for as long as
  that line stood, no gid-based hypothesis about that failure could be tested through the smoke
  path at all. The instrument disagreed with the thing it was pointed at.

## Eighteen more reproductions that fired at nothing, and one hypothesis retired

- **The instruments were live and the lanes were loaded, which is the only reason this is a result.**
  The post-mortem's `tee` fix, the ~100 ms in-flight sampler and both gid maps deployed at 08:49 in
  image `7d6611a71464`; both lanes were carrying the state that reproduces - lane 1 at 4,746 MB
  across 33 jobs, lane 2 at 4,706 MB across 40, both far past the 2.4-2.7 GB band where all four
  probe variants failed on 2026-08-25.
- **Eighteen attempts, none fired.** Six serial inside one lane container with the image cached;
  twelve more with a FORCED fresh pull each time and both lanes running concurrently, which is the
  shape the failing job had. Both stores were left byte-intact - `store_jobs` and `lane_disk_mb`
  unchanged, no breadcrumb, no leftover containers or networks.
- **What that does NOT establish**: every one of those attempts ran inside a long-lived lane
  container, and the real workload starts a FRESH container per job over a persistent graph root
  whose runroot is a tmpfs that dies with the container. That difference is still unreproduced.
- **THE 31-32 SECOND PATTERN IS THE FAILURE'S OWN DURATION, NOT A PRECURSOR**, and it is written
  down because it looks exactly like one. Three of the four heals came 31-32s after the preceding
  mint - 20:45:54 to 20:46:26, 20:56:54 to 20:57:26, 12:52:35 to 12:53:06 - which is mint, container
  start, job assigned, shim exhausts its retries, job ends, container exits, driver reads the
  breadcrumb. Successful cycles on the same evening are 32-33s apart too.
- **The load hypothesis is contradicted by the instrument's own numbers.** At the instant of the
  20:46 failure the post-mortem read `pressure(io) some avg10=0.00`, `pressure(mem) some
  avg10=0.00`, `pressure(cpu) some avg10=1.63`, `memory.current` 155 MB, `oom_kill 0`, 66 pids of
  1024 and `/var` 33% used. **The lane was idle at the moment it failed.** The correlation with a
  busy evening is real at the scale of the afternoon and absent from the instant, and two of that
  day's four occurrences happened with the load absent entirely.
- **One datum that does support upskald's store-skew suspicion, weakly.** The pull immediately
  before the failure took 2.4s; a genuine cold pull of the same image on this host, measured twelve
  times today, takes 5.0-5.2s. GitHub strips the carriage-return progress updates, so the job log
  cannot show whether those eleven `Copying blob` lines ended in `done` or `skipped: already
  exists` - the timing is the only evidence either way and it is half.
- **A DRIVER KILLED WITHOUT ITS TERM HANDLER COULD DESTROY A LIVE STORE, AND IT IS RULED OUT FOR
  2026-08-26.** Nothing in `bin/github-runner.sh` holds a lock; the only safety is that `gc_lane`
  runs at the top of the loop. The job runs in a SIBLING transient scope that outlives the driver,
  `marker_read()` does not restore `job_in_flight`, and `store_jobs` persists - so a fresh driver
  can `rm -rf` the graph root out from under a live nested engine, which is precisely the observed
  shape. Measured from the journal: both drivers held pids 1405580 and 1405627 continuously from
  19:20 through 20:58 across both evening failures, and the whole day carries no `Main process
  exited`, no signal and no non-clean stop - every restart was a Stopped/Started pair through the
  trap. The guard is one `podman ps` and closes the class regardless.

## One directory for every lane, and the half of it that must never be swept

- **upskald's coverage ratchet moved off GitHub onto this disk**, so the shape of its loss changed
  more than its location did. `scripts/check_coverage.py` returns PASS on `absent` and FAIL only on
  `unavailable`, and a runner with no store reads `absent` - so a lost baseline is not a red gate,
  it is a gate that silently enforces nothing on every surface at once. That is why
  `bin/backup-server.sh` treats an empty capture of an existing store as fatal.
- **The store is a SIBLING of `lanes/`, not a child, and that is its only real guarantee.**
  `lane_reset` deletes `runner/_work tmp storage` out of `$LANE_ROOT`, so a store a reset could
  reach would lose the ratchet on the first self-heal - of which there were four in one day.
- **It is deliberately NOT under `config/`, even though that is where the backup already reaches.**
  `docs/ci.md` states and `bin/github-runner-smoke.sh` asserts that no path under `config/` is
  mounted into a lane; putting it there turns that into "no `config/` except this one". `state/`
  reaches the backup by the mechanism `bin/backup-server.sh` already uses for the Prometheus
  snapshot and the SQLite dumps - staged in by a step - which also needs no new `restic backup`
  path and no change to `bin/verify-restore.sh`, whose assertions cover both repositories.
- **`CI_ARTIFACT_STORE` is declared in the image's `ENV`, not passed with `-e`.** The driver passes
  NO environment into a lane at all, and the argument for that is about the registration token; the
  value here is a CONTAINER path and therefore a property of the image. Being always set is the
  point rather than an oversight - a mounted-but-broken store then reads `unavailable` and turns
  upskald's pull requests red, which is the direction they asked for.
- **Thirty days on `runs/`, and seven would have failed in the worst possible distribution.** One
  consumer runs when a pull request merges and reads the artifacts of that pull request's LAST CI
  run, which may be weeks old if the branch sat - so a short retention breaks exactly the
  slow-moving pull requests and nothing else.
- **The sweep is a timer rather than part of `gc_lane`, because the store is shared.** Every other
  reclaim in `bin/github-runner.sh` operates on a `$LANE_ROOT` exactly one process owns; two
  drivers sweeping one tree have no lock between them.
- **A backup copy taken with plain `rsync` would report success having copied nothing.** Everything
  under the store belongs to the subuid container uid 1000 maps to, so `core` cannot traverse it -
  the same reason the driver unshares its `du` and its `rm`, and the same failure that once read
  1,383 MB against 2,500 MB actual.

- **A LIVE-BUT-UNSEEDED STORE PRODUCES A PIPELINE EXACTLY AS GREEN AS A SEEDED ONE**, so "CI is
  green" cannot separate them and the difference surfaces only on the day a real regression lands
  and nothing stops it. Raised by upskald on 2026-08-27, and it landed on the check rather than on
  the store.
- **`ci.artifact_store` graded `du -sb state/` and could not tell.** Aggregate bytes: any stray
  file under `state/` makes the count non-zero, so a store with content and no
  `<owner>/<repo>/baselines.json` reported `ok` while a consumer opening its own baseline got
  nothing and PASSED on `absent`. The same shape as the three defects removed earlier that week,
  one layer out - not a gate that cannot check, but a check grading a number nothing depends on.
  It counts `baselines.json` files now, because that is the file a consumer opens.
- **Proved by being made to fail before it was trusted**, the way `ci.runtime_dir` was: a store
  holding `notes.txt` and no baseline reads `warn ... holds NO baselines.json (6 bytes of other
  content under state/)`, and the same store with the baseline copied in reads `pass ... holds 1
  coverage baseline(s)`. An unseeded store is a **warn**, not a note - the quietest level was wrong
  for a condition whose whole character is that nothing else will report it.
- **The migration was verified before anything was deleted.** The orphan `coverage-baseline`
  branch's `baselines.json` re-fetched fresh - not the copy used to seed, which would have made the
  comparison tautological - against the store copy: 447 bytes, sha256 `a990d541fe3d180b`, identical,
  and the same hash read from inside BOTH lanes, which is the property a shared store exists for.
  **No credential was passed into a lane to do it**: the store side was read with `podman unshare`
  on the host, which is the same bytes, because `-e GH_TOKEN=...` would have built the route this
  design refuses to have.

## A fallback build makes another distribution's ABI your problem

upskald's item 3 of five, 2026-08-27: the Firefox and WebKit libraries, so the nightly
`[chromium, firefox, webkit]` matrix can leave `ubuntu-latest`. They expected Firefox to be routine
and WebKit to be the hard one and offered to leave WebKit hosted. Both halves were right.

- **Playwright serves the Ubuntu 24.04 build to every distro it does not recognise.**
  `packages/utils/hostPlatform.ts` ends its Linux branch with an unconditional
  `return 'ubuntu24.04-x64'`, so a Fedora lane downloads `firefox-ubuntu-24.04.zip` and
  `webkit-ubuntu-24.04.zip` and must satisfy **Ubuntu's** sonames. chromium is exempt because
  Playwright ships Google's distro-agnostic build for it, which is why chromium has worked here
  from the first e2e run while the other two were unknown. The same line produces the `BEWARE: your
  OS is not officially supported` warning already on record - which is about the dependency
  installer, and this is the half that actually binds.
- **Five sonames have no Fedora package at any version, and never will.** WebKit hard-links
  `libicuuc.so.74`, `libicui18n.so.74`, `libicudata.so.74` and `libjpeg.so.8`; Fedora 44 ships ICU
  76 and 77, and has shipped libjpeg's 6.2 ABI its whole life. Soname skew, not missing
  functionality - so the Ubuntu libraries are vendored from pinned, sha256-checked `.deb`s.
  **The safety argument is that the linker matches EXACTLY**: measured on the built image,
  `libicuuc.so.77` still resolves to `/lib64` and only `.so.74` resolves into the compat directory.
  Only the four files are copied; the icu deb also ships `libicuio`, `libicutest` and `libicutu`.
- **`ld.so.conf.d`, not `LD_LIBRARY_PATH`.** The obvious spelling is the wrong one:
  `LD_LIBRARY_PATH` outranks a binary's own `DT_RUNPATH` for every process in every job step, while
  `ld.so.conf` is consulted after both and can only satisfy a lookup that was going to fail. It
  also stays out of `/proc/1/environ` and out of what the `docker` shim hands to nested containers.
- **The fifth, `libx264.so`, is refused for a codec the browser has not tried to use.** Nothing
  links it - no file in the bundle has it as a `DT_NEEDED` - and with
  `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` webkit 26.5 launches and renders without it. It is
  in webkit's DLOPEN list, which is literally `['libGLESv2.so.2', 'libx264.so']`, and
  `validateDependenciesLinux` THROWS on launch when one is absent. Fedora ships no x264 at all, ever
  - patents, RPM Fusion only. Vendored rather than skipped, because turning the validator off also
  stops it naming the next library that goes genuinely missing. Measured cost of absence:
  `canPlayType` returns `""` for H.264 and `"probably"` for VP8.
- **`ldconfig` will not invent an unversioned symlink.** Playwright dlopens `libx264.so` exactly;
  Ubuntu ships that name only in `libx264-dev`, the runtime package having `libx264.so.164` alone.
  ldconfig builds links from the ELF's SONAME, so the bare name is made by hand and asserted with
  `test -e` - `ldconfig -p` does not list it and could not grade it.
- **A package name in that table can be a HEURISTIC, not a fact.** `gstreamer1-plugin-libav` was
  installed, ships `libgstlibav.so`, and Playwright still asked for `gstreamer1.0-libav` - because
  the table maps the missing `libx264.so` onto that package name, with a source comment saying
  libav's own library is not linked directly so x264 stands in for it. Chasing the package rather
  than the soname goes in a circle.
- **`ldd` clean is not Playwright-clean, and the gap is dlopen.** After twenty-six dnf names and the
  compat layer, no bundle had a missing soname - and `validateDependenciesLinux` still named
  `libgles2` and `gstreamer1.0-libav`, which nothing `DT_NEEDED`s. **It throws on LAUNCH, not only
  on install**, so webkit does not start without them. The mirror of the same table's
  `libavcodec60` for firefox, which has no `lib2package` entry, is a dlopen for media codecs, and is
  deliberately NOT installed - firefox launches without it and the suite plays no video.
- **A permanent warning is a warning nobody reads.** Even where Playwright only warns, a framed
  "Host system is missing dependencies" box on every e2e job would hide the next library that goes
  genuinely missing inside noise this image had chosen to keep. That, not the feature, is why the
  three dlopen packages are installed.
- **The bundle's own libraries read `not found` to a naive `ldd`.** `libwebkitgtk-6.0.so.4`,
  `libwpe-1.0.so.1`, `libjavascriptcoregtk-6.0.so.1`, `libsoup-3.0.so.0` and `libjxl.so.0.8` are all
  resolved from the bundle's RPATH at run time. Subtract what the bundle ships before believing the
  list, or five of the eight "missing" names are phantoms.
- **Playwright's own table is both over- and under-inclusive.** It omits `graphene` and
  `vulkan-loader`, which webkit does need, and lists thirteen packages this base already satisfies
  transitively. The list that shipped was resolved from `ldd` output mapped against Fedora's
  repodata, not transcribed.
- **There was no browser assertion in `bin/github-runner-smoke.sh` at all** until this change, while
  the Dockerfile comment and this document both predicted, in those words, the failure it would have
  caught. It now LAUNCHES all three and reports Playwright's message verbatim, because the missing
  soname is the whole fix.

## Running a browser as container root is a different code path, again

- **The image has no `USER`**, deliberately: it starts as container root and `runner-init` re-execs
  itself through `setpriv --reuid=1000 --regid=0`. So `runner()` in the smoke test - which goes
  through the entrypoint - is uid 1000, and any probe passing `--entrypoint` is **root**.
- **Chromium hung for five and a half minutes as root** and reported `Target crashed` when
  `/dev/shm` was also left at podman's 64 MB default. Neither reading said anything about the
  image; both were the harness. The third instance of this family, after `podman exec` without
  `--user` answering `rootless: false` and the `/dev/shm` measurement that `--shm-size` could not
  fix.
- **So a browser probe must go through the entrypoint and carry the lane's `--shm-size`**, or it
  measures a container no job will ever run in.

## A lane at 45% of its cores was not waiting on the network

- **The obvious reading of a lane's idle half was wrong, and the remedy that follows from it would
  have bought nothing.** Measured while a job ran, a lane's two pinned cores were **45% busy on
  average, 71% at p90, 76% at the worst two-minute window**, with 0.8% iowait - which reads as "it
  is blocked on I/O or the network, so give it more cores".
- **It is neither. Both long jobs on upskald's critical path are single-threaded.** `make
  coverage-api` runs `pytest` with no `-n` and no xdist dependency, and `e2e/playwright.config.ts`
  is `workers: 1` under CI. One busy worker beside three service containers is exactly 1.0-1.4
  cores. A wider cpuset cannot shorten either, and `app-ci.slice` was widened from `4-7` to `4-9`
  for a third LANE rather than for wider lanes on 2026-08-27.
- **The cheap confirmations were already on the host and pointed the same way**: lifetime
  `nr_throttled` on the slice is **4**, so `CPUWeight=20` and `nice -n 10` have never bitten, and
  lifetime memory PSI is **60s**, so the lanes pinning at `MemoryHigh` is reclaim rather than
  pressure. Nothing about the ceilings was the constraint.
- **`docs/ci.md` argued against widening the cpuset because it would "take two cores from where
  Jellyfin floats". A cpuset is not exclusive** - the same file says so two paragraphs earlier
  about `4-7` - so widening shares 8-9 rather than taking them, and everything unpinned keeps all
  twelve. Cores 8-11 measured 7-10% busy over the same 24 hours.

## Uploading from this host costs 20-40x what downloading does

- **`j178/prek-action@v2` runs an `actions/cache` of its own**, which upskald's guard on its own
  cache step (`runner.environment == 'github-hosted'`) does not cover. Measured in `Post Run
  pre-commit`: **50 MB up at 0.4-0.5 MB/s, 1m53**, over a `~/.cache/prek` the lane already keeps.
  The same cache DOWNLOADS at 5-19 MB/s on a hit.
- **So the rule is asymmetric and worth stating once**: anything a lane sends to GitHub is
  expensive and anything it fetches is not. A guard on a cache step says nothing about an action
  that caches on your behalf, and the tell is a `Post <step>` that takes minutes.
- **Queueing was never where the time went.** Across a full eleven-job run on 2026-08-27 the total
  wait for a lane was **171 seconds** against 29m24s of wall clock; 1,637 of 2,438 step-seconds
  were test execution. A third lane is worth having for e2e SHARD width, not to clear a queue.

## The fleet chooses its own work, and four things that look alike while it does

- **`_plan_step` never read `status: blocked`.** It has been in `policy.PLAN_SCHEMA` and in
  `prompts/plan.md` since the planning phase existed - the prompt calls a false premise "a good
  outcome, not a failure" - and the step checked only the exit code and whether a plan was
  produced. So a blocked plan exited 0, the plan was non-empty, the step returned `ok: true`, and
  the flow carried straight on into a $15 dev phase to implement a task the planning phase had just
  said could not be implemented. **Latent for as long as a person chose the task and was watching**;
  the most likely way a round is wasted the moment conduct chooses. Fixed 2026-08-27.
- **The task cannot be put back, and that turns out to be right.** `odoo.move` refuses any stage
  outside the fleet's three, so conduct has no way to return a task to `Pending` and should not have
  one. A blocked task stays in `Planning`, which `odoo.IN_PROGRESS` already excludes from every
  candidate pool - so it removes itself from intake's reach until a person looks, and the chatter
  note is how they find out why.
- **Between `run_flow` and the flow's first suspend, nothing in the database says a task was
  taken.** `chain_open` does not run until `_plan_step`, a tick later, so the next cycle sees an idle
  fleet and picks a second task. That is **not** two runs: `state.chain_open` supersedes on a
  differing `odoo_task`, so the second pick silently CLOSES the first one's round and shortens a
  change nobody was watching. The `intake` claim is written before the start and restored on failure,
  which is the rule `_continuation` already followed for the round counter.
- **Falling out of the dispatch loop is not `idle`.** The loop `continue`s past a suspended
  `await_human` because that module is unprefixed - it is a person's gate and conduct may not read
  it - so a run waiting on somebody reaches the bottom of the cycle looking exactly like a quiet one.
  Taking a second task there puts two changes on one worktree and `prepare_worktree` deletes the
  first. The idle test asks seven local questions before the tracker is contacted at all.
- **An intake that has stopped looks exactly like an empty backlog.** Both are "no run started",
  both leave every unit active and every container healthy and the journal quiet - a revoked API
  key, a renamed stage or an exception in the pass all present as a fleet with nothing to do, which
  is the one explanation nobody investigates. So `agents.intake` grades the LOOK: conduct stamps
  `intake_last_at` on every look including one that picked nothing, and a stamp that stops advancing
  is the fault. Same shape as the mirror whose fetch stopped, where `FETCH_HEAD`'s mtime dates the
  attempt rather than the change. Holding is `ok` with the reason in the message; the two are told
  apart by the AGE and never by the string.
- **And turning that switch back off made the detector fire on the switch.** The `intake` table
  outlives the flag: a project armed once keeps `intake_last_at` at the moment of its last look for
  ever, so disarming it left a stamp ageing past `agents.intake`'s hour and `AgentCheckWarning` -
  the catch-all over the whole section at 30m - paged the phone every half hour, saying the pass had
  stopped and the fleet would sit idle. Which was true, and was asked for. `serve._intake_keys`
  already promised the right behaviour in its own docstring - *"an absent stamp is 'this fleet does
  not choose its own work', which is what a project with `intake` off should report"* - and never
  implemented it, because absence held by construction while nobody had ever armed one. **A comment
  describing a property the code gets for free is not a test of it**, and the first pause is the
  first moment the two can differ. The keys are dropped with the switch now, which puts a deliberate
  pause on the silent `note` branch, and that branch's message names the switch rather than the
  history because it cannot tell a fleet that never chose from one that was stopped.
- **The milestone ladder is ordered by the M-number in the NAME and by nothing else.** `deadline` is
  unset on every milestone and `is_reached` is false on every milestone, so neither can order it -
  and the id is the one that looks like it would work and does not: `M0b Scaleway estate` has the
  highest id in project 17, so a ladder read off ids works the backlog backwards while every query
  returns exactly what it was asked for. **Priority is not a milestone signal either**: the whole
  `M0` tree sits at priority 0 because nobody re-starred it after grooming. A string sort is the
  third trap - it puts `M10` between `M1` and `M2`.
- **A dependency is clear only when `is_closed` is true.** Absence from the candidate pool is not
  evidence of closure: a blocker sitting in `Review` is absent from that pool and is emphatically
  not done. Anything the blocker read does not account for is treated as OPEN, which is the
  direction that defers rather than the one that starts work on something still waiting.
- **The select worktree is reused between looks, so `last_answer` without a `since` bound returns
  the PREVIOUS look's choice.** A phase that exits 0 and answers nothing is a real shape - the
  planning step guards for exactly it - and without the bound that phase hands conduct last look's
  task, conduct re-checks it against a shortlist it is probably still on, every clause passes, and
  the fleet starts a run that nothing chose today. Caught before it shipped, and only because the
  same trap is already on record one section up: *"the most recent X on this worktree is the
  previous TASK's X until this one overwrites it"*, which is why `state.last_answer` grew the
  argument in the first place. **Proved by reverting the fix**: the pass took a task off a stale
  answer.
- **Nothing bounded the fleet as a whole.** Every other refusal here is about the health of one run.
  `config.REVIEW_CAP` is the first that is not, and what it prevents is not a crash: it is twelve
  open draft pull requests, each cut from a `main` that has moved further since the last, all of
  them conflicting, and a person who has stopped reading them. The fleet moves a task to `Review`
  when its PR opens and never past it, so that number only goes down when a human acts.


### A fleet that is invisible to every reader except its own marker
- **Ephemeral-labelled containers are skipped by BOTH container sources, run `--rm` so nothing is
  left `failed`, and are started `--no-healthcheck` so nothing reads unhealthy.** Three independent
  reasons, and they compose: a wedged CI lane or a stuck phase runner leaves a host on which every
  unit is active, every container is healthy and every other dashboard page is quiet. The marker
  file is the only witness, which makes **absence the finding** rather than the fallback - so
  `laneTone` checks grey BEFORE green, and `?? 0` anywhere near `job_in_flight` or
  `phase_in_flight` mints a healthy idle lane out of no evidence. The collector's own help text
  says it: absent "must not be drawn as idle".
- **A gauge that resets at midnight must be bucketed on the boundary it resets on.** `runs_today`,
  `jobs_today` and `tokens_today` reset at UTC midnight because the host runs UTC; the container
  availability strip buckets into LOCAL days on purpose, and reusing that here would take every
  bar's maximum from the tail of the previous UTC day - two hours of every day's runs on the wrong
  bar in summer, with nothing to say so. `dailyPeaks`/`utcDayStarts` are the UTC half, two
  functions rather than a flag, because a boolean argument is how the wrong one gets picked.
- **conduct counts a failure as `result IS NOT NULL AND result != 'ok'`, and the inverse is a real
  bug rather than a nicety.** A run in flight has a NULL result; the first version of
  `source_fleet`'s SQL counted those as failures and drew every running phase as a failed one. It
  also has to match `state.counts_today` exactly, or the document and
  `home_server_agent_runs_failed_today` put two disagreeing numbers on one page with no way to tell
  which lied.
- **The oldest suspended step's age is in a check's MESSAGE and in no fact.** `verify-host.sh`
  measures it and records only the count, so displaying the sentence is the only way that number
  reaches a screen - keyed on the stable id, displayed and never parsed.
- **`chain.flow_job_id` is the job that STOPPED, not the one running**, so a round mid-flight
  matches no notice. `waiting_on: null` therefore means "in flight" and must not default to
  "conduct" - that would claim the fleet owns a step nobody has looked at. It is also why an
  orphaned notice has to be rendered separately: dropping it would hide an unanswered approval.

### The lane that held its work and stopped saying so
- **The hold loop napped without writing the marker, so a healthy held lane went stale.**
  `bin/github-runner.sh` held every lane above the first while a conduct phase was in flight, and
  the loop that did it was `log` + `nap 60` and nothing else. `nap()` samples the scope every two
  seconds and writes no marker, so the heartbeat moved once per HOLD rather than once per poll:
  measured on 2026-08-28 at **710s on lane 3 and 258s on lane 2**, both units `active/running`,
  `NRestarts=0`, `Result=success`, both registrations online, six jobs each that day. `ci.heartbeat`
  grades at 300s against a 30s poll, and a `conduct_dev` phase runs past thirty minutes - so **every
  phase longer than five minutes warned on two lanes that were working exactly as designed**.
- **It is the same defect as the idle case forty lines below, in the same file**, where the fix was
  already made and the comment already says why: an idle lane is the normal state, it was measured
  at 465s stale on the first live lane, and "a check that fires on the normal case is a check
  somebody learns to ignore." Holding is equally normal - it is what a lane above the first does
  whenever the fleet works. Two places in one loop can sit still; only one of them had been found.
- **Nothing acted on the stale value, which is why it survived.** `bin/reboot-host.sh` requires
  `job_in_flight=1` **and** a fresh heartbeat before it warns that a reboot would kill CI work, and
  a held lane has `job_in_flight=0` - so it was correctly silent rather than wrongly silent. The
  cost was a false warning on the hourly battery and a grey lane on the dashboard, not a lost job.
  The inverse case is the one still worth watching: a lane genuinely mid-job whose marker went stale
  would be invisible to that gate, and only the busy branch's `marker_write 1` prevents it.
- **The hold's cost was justified by a number that had stopped being true, and the number is now
  deleted rather than restated.** The comment read "at a measured 6.9% phase duty cycle this costs
  almost nothing and CI never drops to zero", off a 30-day mean of
  `home_server_agent_phase_in_flight` taken when the fleet was two lanes and the predicate held
  exactly one. Both halves moved underneath it: the third lane joined the held set on 2026-08-27 by
  the predicate saying nothing, and the fleet began chaining rounds with no gap. A spot reading over
  08:18-10:35 on 2026-08-28 put lanes 2 and 3 in the hold for about **49 and 51 of 137 minutes, some
  36-38%**. That is one window on one busy morning and **not** a replacement measurement - which is
  the whole reason no figure is asserted in its place. The behaviour is unchanged and under
  observation; the recorded 2026-08-26 measurements stay where they are as history.

- **The hold was then removed outright, hours later on the same day, so the loop this was fixed in
  no longer exists.** Recorded because the fix above is otherwise unfindable in the file, and
  because the LESSON outlived the code: two places in one loop could sit still, only one had been
  found, and the check that caught neither graded the normal case. The predicate, its 600s
  freshness rule and the now-dead `CONDUCT_STATE` reader all went with it; `HOME_SERVER_CONDUCT_STATE`
  survives in `bin/reboot-when-staged.sh` alone, which is a different gate and was not touched.
- **What that trade actually is, stated as a trade.** The hold was a SCHEDULING guarantee that
  `app-ci.slice` and `app-agents.slice` could not peak together; removing it leaves the cgroup
  ceilings as the only bound, and they sum to **14,592M of a 15,828M host** (9,984M + 4,608M) with
  nothing sequencing them. It is survivable because neither slice has ever approached its ceiling -
  a lane's measured peak is 2,817M of a 3,584M scope limit, the fleet's 30-day median is 957M
  against p90 1,455M, so three lanes and a phase at observed peaks is about **9.9 GB, not 14.6**.
  "The peaks do not coincide" has gone from a thing arranged to an observation being relied upon.
- **The signals that would say it was wrong are named in `host/systemd/app-ci.slice`**: that slice's
  `memory.events` `max` going non-zero, `oom_kill` non-zero anywhere, or host swap growing rather
  than sitting flat. **Throttling at `MemoryHigh` is NOT one of them** - it is the design working,
  and the slice's own 30-day maximum being exactly `MemoryHigh` is the paragraph above it saying so.
  If the hold returns it should return narrower - holding only the lanes above the second - and on
  a measurement rather than on an argument.


## A board that could not show an outcome, and four ways it nearly asserted one it had not measured

**The Agents page shipped with a board that read `chain WHERE closed_at IS NULL`**, so a round
vanished the moment it closed. `published` and `stopped` were states the page could never draw, and
the only question a reader ever actually has - what happened to the thing the fleet was doing
yesterday - had no answer anywhere on the host. Four things had to be got right to answer it, and
three of them are the same mistake in different clothes.

- **THE OUTCOME IS STRUCTURAL, BECAUSE `closed_why` IS PROSE.** conduct closes a round with a
  sentence - "reached the publish path", "the rounds are used up", "the flow failed: ..." - and the
  obvious implementation string-matches it. That is the habit this file names as a defect in six
  other places under a different name ("key on the id, never parse the message"), and it fails the
  first time somebody rewords a message with every test still green. **The publication join says
  the same thing structurally**: whether a round reached the publish path is a row's existence,
  whether it published is a column on that row. `fixtures/smoke.mjs` rewords a `closed_why` and
  asserts the state does not move, which is the only assertion that could have caught the parse.
- **A CLOSED PUBLICATION CARRYING NO PULL REQUEST IS A THIRD OUTCOME.** The flow ended without
  opening one, which is what a declined approval and a seven-day timeout both look like. It is
  neither "still waiting to publish" nor "gave up before the publish path", and collapsing it into
  either neighbour loses the distinction that says whether a person declined something.
- **THE PULL REQUEST WAS BEING THROWN AWAY.** `poll._publication` read `result["url"]` off the
  finished flow, moved the tracker, posted a chatter note - and dropped it. **A sentence in Odoo was
  the only durable record of a pull request this fleet had opened**, so nothing on the host could
  answer which PR a round produced. `publication` now carries `pr_url` and `pr_number`, and both
  arguments are optional precisely so the paragraph above stays expressible. `COALESCE` rather than
  a plain SET, because reconcile closes stale rows with no arguments and `_publication`'s own
  per-row guard leaves a row to be closed again next cycle - either would blank a recorded url.
- **PROGRESS IS PER ATTEMPT AND ONLY THE ATTEMPT COUNTER SAYS SO.** `chain.done` is append-only
  within a round and `chain_restart` clears it wholesale, because a re-plan is the entire point of
  another round. So 2/5 on attempt 2 is work being redone, not work that was lost, and a bar without
  "attempt N of 2" beside it asserts the second thing.

### An ETA is a prediction, and this one says a dash more often than a number
- **conduct records no expectation anywhere.** `flows/ship.py` carries prose in its module summaries
  ("dev 10-25 minutes") and nothing machine-readable, so an estimate is either derived from what
  this host has actually done or it is invented. It is a median of **successful, completed** runs
  per phase over 30 days: a killed phase stopped early and a failed one may have stopped anywhere,
  so including them would predict a shorter round the worse things were going.
- **It is withheld ENTIRELY below five samples** rather than computed from two, and `phase_stats`
  travels with the document so the tooltip can name what the number rests on. On a young fleet the
  dash is the common case and that is correct.
- **A ROUND WAITING ON A PERSON CARRIES NO ETA AT ALL**, and this was caught on screen rather than
  by reasoning. The remaining phases sum to the MACHINE's work - a couple of minutes of `ship` for a
  round sitting on the publish gate - while the real wait is however long somebody takes to look,
  bounded only by the seven-day `HUMAN_TIMEOUT`. The first render drew **"~1m" against a gate that
  had been waiting eleven hours**, which would have been the most confidently wrong number on the
  page.

### `chain` is not a log, and the board that read it drew one row out of eleven
- **`chain.worktree_id` is a PRIMARY KEY, `chain_open` does `INSERT OR REPLACE`, and the worktree is
  REUSED for every change** - every task this fleet has run went through `upskald-ship`. So each
  round overwrites the last one's row and the table holds exactly ONE however much work has
  happened. Measured: 1 row in `chain` against 67 in `run`, eleven rounds over six days. A history
  cannot be read out of it and no amount of ordering or capping changes that.
- **`run` is the only durable record** - AUTOINCREMENT, never deleted - so rounds are grouped out of
  it: a `plan` run starts one, which is conduct's own definition of an attempt. `verify` runs on
  `<worktree>-verify` and must be folded back or every round loses its gate and reads 3/5 for ever.
- **The publication join had to become windowed in the same change.** On `worktree_id` alone it was
  invisible with one row and wrong the instant history appeared: all ten rounds on `upskald-ship`
  would carry the same pull request. A publication belongs to the latest round that had already
  started when it opened. Measured: 2 of 11, and the right two.
- **A task id cannot be parsed out of `run.task`** - that column holds the phase's whole prompt,
  which happens to contain "(task 1251)". `run.odoo_task` exists for that reason, and it fills in
  going forward only: an older round renders a disabled chip and hides its attempt line.
- **The whole class of error is a premise about a table, not a bug in code.** Every fixture was
  written by the same person who held the premise, so the entire suite was green; only counting the
  rows the deployed collector produced from the live database disagreed.

### The two halves deploy separately, and the gap was measured rather than reasoned about
- **A SELECT naming `publication.pr_url` before conduct has migrated raises `no such column`**, which
  `source_fleet` catches and reports as an unreadable database - so the whole board would have read
  "absent, not zero" over a healthy fleet for the length of the deployment window. The columns are
  asked for on `pragma_table_info`, the same discriminator conduct's own `_migrate` uses. Caught by
  running the new collector against a copy of the LIVE database, which is the only thing that could
  have caught it: every synthetic fixture already had the column.
- **The fix exposed a second defect that would never have healed.** A publication row written before
  the columns existed holds NULL whether or not it opened a pull request, so the one round this fleet
  has actually merged read **"not published"** - permanently, with no later run correcting it.
  `pr_state` is `unknown` when the column could not be read at all, and `unknown` outranks the claim:
  a null means "opened none" only when a url would have been visible had there been one.
- **The first version of that fix covered only half of it, and the live host proved it.** Guarding on
  "the column is absent" fixes the deployment window and does nothing for the permanent case: once
  conduct HAS migrated, a row that closed before it still holds NULL. Both publication rows on this
  host predate the columns and one is `#249`, so the fleet's only merged pull request would have read
  "not published" for ever with every test green. `FLEET_PR_RECORDED_FROM` is the cutover - a dated
  constant, deliberately, because the alternative was a lie - and it expires by itself as those rows
  age out of the board's window.

### Hiding a row needs positive evidence, and the leg that supplies it fails open
- **A merged round is hidden and an UNKNOWN one is not.** `pr_state` is `unknown` whenever GitHub
  could not be asked - no token, a timeout, an expired credential - and an unknown round stays on
  the board. A row disappearing because a token lapsed is the same class of error as an empty list
  reading as an idle fleet, which is the failure `fleet.json`'s `sources` exists to prevent. The
  toggle prints its own count whether or not it is on, because **a filter a reader cannot see is a
  filter that lies**.
- **`github` is the one source `sourceNotes` must NOT speak for.** Every other upstream supplies
  rows, so "absent, not zero" is exactly right for it. GitHub supplies one FIELD on rows that are
  already present, so the generic sentence sends a reader looking for missing rounds that are on
  the screen in front of them. Found by reading the rendered page, not the code.
- **It is the FIRST host-side network call `bin/collect-metrics.py` makes.** Every other outbound
  request in that file is `podman exec <container> curl`, and this one cannot be: the token must not
  enter a container, which is the rule `docs/ci.md` already states for the credential that never
  enters a lane. `GITHUB_PR_READ_TOKEN` is a **third** GitHub credential deliberately - the Windmill
  variable is `pull_requests: write` and `GITHUB_RUNNER_PAT` is org-scoped, so widening either would
  give a monitor the ability to act.
- **On the monitor rather than in conduct**, for the reason `docs/agents.md` already gives: a
  reconciler that stops is safe and a monitor that stops is blind. One dead flow job has already
  stopped that fleet for two hours.

### Two panels called "Runs" counted different things
- The board is **rounds** - one task through five phases - and the strip below it is
  `home_server_agent_runs_today`, which counts **phase executions**. `runs_today = 6` could be one
  round or three, so leaving both labelled "Runs" put two numbers on one page that disagree with
  each other and gave a reader no way to tell which. The strip is "Phase runs" now.

### The gate's own formatting closed the round, and the loop for it was unreachable
- **`make check` rewrites the tree it is measuring**, and until 2026-08-28 that was a terminal
  refusal: `after the gate ran, the tree is not clean: web/bun.lock`. Three rounds died on it in one
  morning. Committing what the gate wrote is sound because of the target ORDER - `check-gate:
  version-check format lint deadcode deps type-check unit-test verify-site e2e-test`, so `format`
  and `lint` are prerequisites of everything that reads and every test ran against the mutated tree.
  Measured on the mirror, not assumed.
- **A protected path is still refused**, and that is reachable rather than hypothetical: `format`
  runs over the whole tree and `Makefile` is in it. So is anything past `GATE_DIFF_MAX`, which is
  2 MB because this repository's lockfiles are 1.2 MB rewritten whole - **the first draft said
  512 KB and would have refused the exact case the repair exists for.**
- **`_review_step`'s "the gate failed and the base passes it" could never print.** `judge_base`
  refuses precisely in that case, so a red gate that was the change's fault returned `ok: false` and
  never reached the review at all - the only one that ever got there was one the base already
  failed, where `again` is false by construction. The retry loop existed on paper for as long as it
  has existed. `report["retryable"]` is set off the MEASUREMENT, never off the wording of a reason.
- **A REPAIR IS NOT A ROUND**: a review's findings may invalidate the plan, a red gate cannot, so a
  repair keeps `plan` in `done` and re-runs dev and the gate. `resume: True` is the whole mechanism
  and the only thing `_may_skip` reads. **It must count itself** - `chain_open` counts a round from
  inside the planning phase, which a repair skips - and must put the count back if the flow never
  starts, or a Windmill outage closes a change as "the rounds are used up".
- `MAX_ATTEMPTS` 2 -> 3: two was the whole loop while a refusal ENDED the run, so leaving it would
  have made the fix a cut in what a review may ask for.
- **The branch is pushed at the end of dev now**, behind `verify.inspect`'s cheap refusals, so the
  code is readable during the thirty minutes the gate takes. A refused round therefore leaves a
  branch on GitHub, and conduct never deletes a ref.
- **`run.error` and `run.branch`, because neither `report` nor `chain` is a log** - both keyed on a
  REUSED worktree, both holding one row. Same premise that drew one row on the board where there
  should have been eleven.

### Two regressions the fixtures could not see, and four properties that never existed
- **`opened_at` was never emitted** after the board moved off `chain`, so every row read "opened
  never" and `byUrgency` would throw on two same-rank open rounds. `types.ts` declares it
  non-optional and every fixture supplied it, so nothing failed - only the live document was missing
  the key.
- **`closed_why` was read only while the chain row was OPEN**, and the same branch nulls `closed_at`
  - so the one field whose purpose is saying why something stopped was null on every round that had
  stopped. It belongs to the LATEST round on a worktree, open or closed, because `chain` holds one
  row and that is the round it speaks for.
- **`v-if="attempts !== null"` does not defend against `undefined`**, and the collector and the
  bundle deploy separately - so a document written by an older collector rendered `attempt  of 3`.
  It renders only above one now, because "attempt 1 of 3" is a line on every row saying nothing.
- **`--ink`, `--ink-dim`, `--ink-faint` and `--t-micro` are in no stylesheet.** Every declaration
  naming one was invalid-at-computed-value-time, so the board's sub-lines silently inherited the
  row's font and colour. `.row .cell:nth-child(4)` was the matching hazard in the other direction:
  correct only while nobody adds a cell.

### The dashboard can act, and the shape that made that acceptable was already here
- **The refused thing was an inbound RPC to the host**, in five files and always the same sentence:
  a listener spends real containment to give an internet-facing container an RPC that spawns
  `claude`. The shape that was NOT refused is the one this stack already runs on - a human clicks
  Approve in Windmill, conduct polls, conduct forks `podman run`. A command is a suspended flow step
  on that same path, so nothing new reaches the host and `paths.ts` is unchanged.
- **`rewrite` is a stronger guard than a path allowlist**, and the difference is that there is
  nothing to get past: whatever the client asked for is discarded and one literal substituted.
  Proved with requests, because `caddy validate` cannot see this class of mistake - a GET is 405, a
  traversal reaches the control flow with its path thrown away, a client's own `Authorization` is
  replaced rather than forwarded, and the token appears on no other upstream. **A bare
  `/api/control` does not match `/api/control/*`** and falls through to the bundle.
- **`config.py` is read at import, and a restart reaps a live phase.** reconcile keys a lease on
  conduct's OWN pid with no grace period, so arming intake by restarting would destroy a running
  phase's network, datastores and worktree. The control row is read every cycle instead - the
  descriptor stays the default and keeps its argument, and `serve._intake_keys` asks the same
  question so the marker cannot contradict the pass.
- **Absent is not `off`, three times over**: a missing row means nobody has said, a value that is
  neither defers, and an action conduct does not recognise is REFUSED rather than ignored - a command
  that silently does nothing sends the person away believing the fleet is held.
- **A hold is bounded by something the person setting it does not control.** conduct does not answer
  a held step and `CONDUCT_TIMEOUT` is 24h, so a hold left long enough does not pause a round, it
  fails one. `agents.control_holds` is a `note` while it is young - a deliberate pause must not read
  as a fault, which this repository learned the expensive way - and a `warn` past 20h.
- **A restart cancels before it starts, and that ordering is the only one here that is not
  interchangeable.** Closing the chain leaves the Windmill job suspended and still visible to the
  dispatch loop, so a second flow is two rounds on one worktree and the next `prepare_worktree`
  deletes the first one's commits. `CONTROL_RESTART_MIN_SEC` exists because a double click produces
  exactly that.
- **`paths.ts`'s "conduct is never a `to`" was prose in three files and enforced nowhere** - the
  lint's paths leg `continue`d past every pseudo-node edge before its check ran. It is declared as
  `NEVER_A_DESTINATION` now and asserted, and the assertion was PROVED to fire on a planted edge. A
  first draft tried to read the direction out of the descriptions and failed six correct edges:
  `internet` is "outbound only" because it is where traffic goes and `conduct` is "outbound only"
  because it is what starts the connection - the same two words, opposite ends of an edge.
- **`FLEET_MAX_ATTEMPTS` was still 2 while conduct had moved to 3**, found while adding the control
  block beside it. Nothing failed and no test noticed; the board would have drawn "attempt 3 of 2"
  the first time a change used its third. A second copy of a fact is a thing to check when the first
  one moves, and there are now two of them in that file.

### One SIGTERM, three defects, and five rounds that produced nothing
- **conduct's phase wait read no stop flag**, so a SIGTERM arriving while a phase ran was noticed
  only after the phase finished. `RUNTIME_MAX_SEC` allows a phase 5,400s and
  `home-server-conduct.service` declares no `TimeoutStopSec`, so systemd's default 90s expired,
  systemd escalated to SIGABRT, and conduct was **core-dumped mid-phase** - `code=dumped,
  status=6/ABRT`, with the dump's own stack sitting in that `time.sleep`. The phase died either
  way; what was lost was conduct's account of it. The fix is an interruptible wait, NOT a longer
  timeout - raising it would hang every deploy for up to ninety minutes.
- **A reaped worktree left its round claiming the work still existed.** reconcile removing an
  interrupted tree is correct and deliberate, but the `chain` row survived carrying `done =
  ["plan"]` - and `_failed_flow`'s three guards ask whether conduct broke the run, whether it has
  already resumed once, and whether `done` is non-empty. **None of them asks whether the tree those
  phases wrote to still exists.** So the round resumed 1h41m later, skipped the planning phase on
  the strength of that row, and dev tried to continue a directory that was gone: `EmptyTree`, in
  **zero seconds, twice**, before closing with "the phase before it never ran" - which was false.
- **Closing the round is the fix, not clearing `done`.** `_failed_flow` and the continuation pass
  both iterate `chains_open`, so a closed round is one neither can reach, and it holds even when the
  cancel and the notification fail. `chain_open` is `INSERT OR REPLACE` on a primary key, so the
  next round overwrites `done` anyway - a second mechanism for one fact is how two halves drift.
- **Every outbound call the reconciler makes is wrapped on its own.** `act` runs its lambda inline
  and `serve` wraps the whole sweep in ONE `except` that prints `reconcile failed`, so an unwrapped
  raise would abandon every later step - the orphaned networks and containers included. A Windmill
  outage must cost the cancel and nothing else.
- **An `EmptyTree` cannot tell its two causes apart and must not assert either.** It takes a project
  and a path, not a database. Naming the wrong one sent a real investigation looking for a phase
  that had never been dispatched.
- **The $15.00 dev ceiling was binding on its own distribution.** Four dev phases that day cost
  $4.88, $10.93, $14.63 and $15.11 - one finished with 37 cents of head room and the next crossed
  the line, answered nothing, and cost twenty minutes and the round. A ceiling that fires on the
  upper half of ordinary runs is a coin toss, not a bound on a runaway. Now $25.00.
- **Running out of room is repairable; breaking is not.** An exhausted budget or turn count leaves
  the plan and the commits on the worktree, so dev CONTINUING that tree completes work already paid
  for - the same branch a red gate takes. `error_during_execution` is a broken CLI and deliberately
  not in `quota.RETRYABLE_STOPS`. **Keyed on the result event's SUBTYPE, never on the sentence**:
  `STOP_REASONS`' prose is written for a phone and is free to change. `MAX_ATTEMPTS` still bounds it.
- **The phase log is parsed once for both answers.** They are ~11 MB each, 342 MB across the tree,
  and the caller needs the subtype for the retry decision and the sentence for a person. `stopped`
  and `ran_out` are two out-parameters because `stopped` is handed straight to `finish_run` as the
  run's detail - a subtype appended to it would surface in a person's copy of what happened.
- **A failed round parks its task where intake cannot reach it, by design.** `odoo.move` refuses any
  stage outside the fleet's three, so conduct cannot return a task to Pending and should not be able
  to. Five tasks - 1247, 1251, 1254, 1260, 1271 - sat in Implementation after that day and needed a
  person to move them back.

### The command arrived, and the receipt could not be read
- **Windmill's run endpoint answers `201`, `text/plain; charset=utf-8`, 36 bytes** - a bare job id,
  measured off Caddy's own access log, which records the upstream's headers. `res.ok` is true for a
  201 and the sign-in sniffer knows only `text/html`, so a plain-text body walks past both of
  `http.ts`'s guards and into `JSON.parse`, which throws on a UUID.
- **The comment naming the hazard sat one line above the call that ignored it.** `control.ts` read
  "Windmill answers the run endpoint with a bare job-id string, not an object" and then handed that
  string to `fetchJson`; the return type had been changed to `string` and the parser underneath it
  had not. conduct had already met the same thing and handled it - `windmill.py` falls back to
  `raw.strip()`, with a comment saying why.
- **Proving a route with curl does not prove the client.** Every measurement recorded for this route
  was made from the host, and no fixture reached `src/api/` at all, so the browser's own read of the
  response had never once run. Four assertions over a stubbed `fetch` close it, and they need no
  DOM: `looksLikeSignIn` reads `window` only when `res.redirected`, which a constructed `Response`
  never is, and `reauthenticate` catches its own missing `sessionStorage`.
- **Every other layer said yes** - 201 at the edge, a successful flow, `intake armed for upskald` in
  the journal, a row in `conduct.db`, and a round started on task 1260 four minutes later. The only
  wrong thing in the system was the word on the button, and it was the safest-sounding wrong word:
  `failed` invites a second press of a command that has already been carried out. It got one, 4.2
  seconds later, and `name` being a PRIMARY KEY is the only reason that cost nothing.
- **A chip that never cleared `asked` stopped naming its own action.** Set once and never reset, so
  once the next `fleet.json` flipped its label from `arm` to `disarm` the button read `asked` over a
  command that would now do the opposite. It clears on a label change, which is the moment the fleet
  has been observed doing the thing; a timer would expire while the answer was still unknown.

### The loop was inside a phase, and every signal said it was fine
- **conduct's poll loop is single-threaded and a phase blocks it.** `poll.cycle` takes ONE snapshot
  of suspended jobs and then iterates it, and the dispatch handler blocks in `_await_phase` - a 15s
  `time.sleep` loop that checked exactly one boolean. A disarm posted at 21:26:20 on 2026-08-28 was
  created **eight minutes after that snapshot**, so it was not in the list conduct was holding at
  all. It landed at 22:00:07: **33m 47s**, against a 5400s ceiling.
- **Nothing escaped, and that is the reason this was latency rather than loss.** conduct cannot take
  new work mid-phase - `poll.py:1991` returns before `_intake` is reached, `_intake_idle` refuses on
  `actions`, on `suspended` and on `chains_open`, and `INTAKE_SEC` paces the look anyway.
- **The heartbeat could not have shown it**: `_await_phase` calls `serve.refresh(ok=True)` every 15s
  while the loop is fully blocked, so `last_ok_at` read two seconds old after nineteen minutes of
  not polling. `agents.conduct_fresh` is structurally unable to fire on this, and did not.
- **A control step could also be starved indefinitely**, because it was answered INSIDE the dispatch
  loop and both of that loop's `return actions` cut it short. Which of the two the loop reached
  first depended on the order `jobs/queue/list` happened to return, which conduct does not sort.
  **The argument against that was already in the file, one function above** - `_sweep_notices` was
  hoisted out for exactly it - and control was left behind.
- **60 seconds is `POLL_SEC`, the sleep BETWEEN cycles, not the length of one.** Six places in the
  dashboard promised "within a minute", including the chip's own tooltip, while `docs/agents.md`
  already said "twenty minutes already spent, and rediscovering the same suspended step next cycle".
- **`agents.approvals_pending` says the SQL cannot separate conduct's steps from a person's, and for
  the control flow that is false.** `v2_job.runnable_path` names the flow and `v2_job.args` carries
  the action, so `agents.control_lag` separates them outright - and excludes `restart`, whose wait
  IS deliberate. Measured before the fix at 1976s while `approvals_pending` beside it read PASS,
  "oldest 0h".
- **ruff caught what the tests could not.** The deferred `poll` import went one function above the
  one that uses it, where it read as used; `_answer_control` had never executed in any test, because
  every test that reaches `_await_phase` stubs `run_phase` out. Its own suite exists now, including
  an assertion that the call site is still there - a function that works and is never called is the
  same as no function.
- **A remembered ask must be cleared by derivation, never by a timer.** The chip compares what was
  asked with what it would send NOW: while they match the command has not taken effect, and the
  moment the fleet moves they differ and the memory retires itself. A ceiling is only the backstop
  for a flow that timed out unanswered and so will never move the state at all.
- **`control.json` exists because cadence, not content, was the problem.** `fleet.json` is the
  collector's 5-minute slow tier and the browser polls it every 5 minutes, so the board could be ten
  minutes behind a click that conduct now answers in fifteen seconds. Both documents carry `control`
  and the store treats the fast one as a PRECEDENCE - and only when its own `conduct_db` source
  answered, or a locked database would flip the tile to "as shipped" and claim nobody had ever set
  the switch.


## The card was in the database all along, and the lock that had to go

- **The board was showing the wrong text and had been from the start.** `notice.summary` is the
  PHONE copy - rendered at the verify stage, hard-bounded at 3500 bytes, then cut to 240 characters
  by `_fleet_text` on its way into `fleet.json`. The card a person actually approves is the
  ship-stage rendering, measured at **7,568 bytes**, and it was already in `conduct.db` twice:
  `report.body["card"]` and `dispatch.payload` for `conduct_ship`. **Reading it needed no conduct
  change at all**, which an investigation concluded the opposite of - it reported the card "exists
  only as the `await_human` module result inside Windmill", and the live database contradicted that.
- **The `dispatch` copy is the one to read.** `report` is keyed on `worktree_id` alone and holds one
  row, so the next round on the same worktree overwrites it; `dispatch` is keyed per flow job and
  survives. Same family as `chain` not being a log.
- **`user_auth_required` was spent, not lost.** It was a second lock against conduct answering its
  own gate, and it also blocked the only mechanism by which anything server-side could answer - so
  showing the card without it is half a feature. **The `conduct_` prefix refusal in `poll._resume`
  is now the only lock**, which `ship.py` had already named as the one to rely on. It was proved to
  fail before being trusted: invert it and exactly two tests go red, including the negative control
  that reproduces the original hole.
- **The new route needed the MIRROR of that refusal or it would have been one.** `f/agents/approve`
  reads the target job and answers only `HUMAN_MODULE`; without that clause a browser could forge a
  verification result, which this design did not previously permit. Both guards read one constant in
  `flows/common.py`. `tests/test_approve.py` removes the clause and watches a `conduct_verify` job
  get answered, so the assertion measures the guard rather than an accident of the code path.
- **Two tokens, not one.** Each is scoped to starting exactly one flow, so neither route reaches the
  other's and a leak is bounded by what that flow does - and `control.approve_available` is a
  SEPARATE flag, because inferring the approve chips from the control token would offer a button
  that answers 401 at the moment it is most needed.
- **What was given up is stated:** a signed resume URL that escaped is now sufficient where it
  previously still needed a session, and the approval record still cannot name a person -
  `resume_id: 0`, the same limit the control route already had.
- **A SUSPENDED JOB FROZE THE OLD SUSPEND CONFIG, so the change does not reach the round already
  waiting.** Measured immediately after the redeploy: `f/agents/ship` in git no longer carries
  `user_auth_required`, `serve` had rewritten the deployed flow, and the job suspended at
  `publish_pr` since 22:30 the previous night STILL contained it. A flow definition governs the runs
  that START under it; an in-flight job carries the copy it was created with. So the first round
  after a flow change is the first one the change applies to, and the round in flight has to be
  answered the old way - which for this one means Windmill's own page. The board offering a button
  that would answer "enterprise only feature" is the failure this measurement exists to prevent.

## A transcript that can be served, and the drop that makes the redaction affordable

- **Measured before it was designed**, on 73 logs and 374 MB: the conversation surface of the WHOLE
  history is 450 KB; a gate log is 197,160 lines of which 38 are JSON and none is a conversation;
  and `thinking` blocks are all zero-length, so there was nothing there to decide about. A rendered
  round with full tool inputs is ~400 KB, forty of them ~15 MB.
- **DROP FIRST, REDACT SECOND, and that ordering is the whole economy.** `DOCKER_VOLUME_CACHE`
  appears **3,920 times** in the raw logs and **17 times** in what survives dropping tool results -
  so the strict policy of replacing every `.env` value costs nothing, where over the raw logs it
  would have mangled the output into uselessness.
- **No credential was in any log**, measured across all 73: the only `.env` values present were
  `DOMAIN`, a cache path, a URL, a repo slug and two addresses. So the pass is not repairing a live
  leak; it is what holds the day a phase prints its environment, which is the day nobody is looking.
- **It fails closed.** `load_env()` degrades to `{}` during `render-env.sh`'s write window, and a
  redactor built from an empty environment looks EXACTLY like one that found nothing to redact - so
  an empty env skips the render entirely rather than writing an unredacted transcript.
- **The placeholder names the variable** (`${DOMAIN}`, not `[redacted]`), because every name is
  already public in `.env.sample` and it tells a reader what they are looking at. Longest value
  first, or a short value that is a substring of a longer one corrupts it.
- **`agents.round_detail` measures the output, not the code.** It greps every rendered document for
  every `.env` value and FAILS on a hit, naming the VARIABLE and never the value - `status.json` is
  itself readable by the dashboard, so a check quoting what it found would publish it a second time
  while reporting the first. Proved to fail by planting a real token: it named
  `GITHUB_PR_READ_TOKEN`, and was clean the moment the plant was removed.
- **A log file must not be claimed twice, and the match needs a CEILING.** The first draft had
  neither and both showed a reader SOMEBODY ELSE'S TRANSCRIPT - three dev runs in one round all
  matched the same file, and a run whose own log had aged out of `LOG_RETAIN_SEC` matched the next
  log on that worktree, which belongs to a later round. Confidently wrong is worse than absent.
- **`run.log` is what makes the join possible at all.** The path was in `dispatch.payload`,
  `report.body` and `base_gate.log`, none of them keyed to a run row, and rebuilding the filename
  fails three ways: `start_run` and `phase.start` are MINUTES apart on a cold worktree, the
  verification's row says `verify` while its log says `check`, and a red round writes TWO
  `-verify-check-` logs against ONE run row. `base_gate.log` separates that last pair by identity.
- **`run_ship` took `odoo_task` and never passed it on**, so the last phase of every tracked round
  wrote a row with a null task id while every other phase in the same round had one.
- **The collector now deletes, which nothing in it did before.** A directory contracted as
  "rewritten whole, nothing accumulates" needs a sweep once its filenames come from data rather than
  being fixed - and the `.tmp` files go with it, because `/data/*` is a glob and would serve one
  caught mid-rename.
- **`--print` had to be taught to this source.** Every other source is read-only by nature, so a dry
  run costing nothing was a property rather than a decision; this one writes AND deletes.
- **`phaseClock` read the first globally-running run in the document**, not the row's own, so with
  two rounds in flight every row would have shown one clock. It read correctly only because this
  fleet runs one round at a time - a claim nothing could contradict.

### The comment style this repository is written in is invalid in the file that needed it most
- **An XML comment may not contain two dashes in a row, and BOTH halves of the house style do.**
  The `=====`/`-----` rules that open every file here, and every custom property name that would be
  cited in one - `--brand`, `--bg`, `var(--ok)` - are all `--`. Writing `apps/dashboard/public/favicon.svg`
  in the idiom of its neighbours produced a file no renderer would open.
- **The error names the wrong thing entirely.** librsvg reports `unable to read image data ... error/svg.c/RenderRSVGImage`,
  followed by `no decode delegate for this image format`, which reads as a corrupt file, a missing
  delegate or an unsupported format - three plausible wrong diagnoses, and the actual cause is a
  comment. `python3 -c "import xml.dom.minidom; ..."` says it in one line and is the cheap check.
- The resolution is not to abandon the documentation: the rules are `=` only, and the properties are
  named without their leading pair with one line saying why. **A `git grep` for `--brand` therefore
  does not find the file that hardcodes it**, which is the whole reason `tokens.css` names
  `favicon.svg` explicitly and `favicon.svg` names `tokens.css` back.

### An icon that renders perfectly and ships blurred
- **`magick` rasterises an SVG at its INTRINSIC size and then enlarges it.** `favicon.svg` declares
  32x32, so `magick favicon.svg -resize 512x512` renders 32 pixels and scales them up 16x. It exits
  0, writes a valid PNG of exactly the right dimensions, and the only symptom is that the icon looks
  soft - at a size nobody inspects at 100%. `-density 3072` (96 dpi scaled to 1024) renders at 1024
  first, so every target is a downscale.
- **Two SVG renderers ship in one binary and only one draws this mark.** `magick -list format` shows
  `SVG` bound to RSVG 2.60.0 here; the fallback is MSVG, ImageMagick's own, which does not draw
  `stroke-linecap="round"` faithfully. A host without librsvg produces a different icon from the
  same source, silently.
- The 16-bit sRGB default also tripled every file for an icon that is two flat colours; `-strip
  -depth 8` took the 512 from 39 KB to 15 KB with no visible difference.

### A directory added to an app does not reach its image
- **`apps/dashboard/Dockerfile`'s `COPY` list is exhaustive and enumerates every path**, so adding
  `apps/dashboard/public/` without adding `COPY public/ ./public/` ships an image with no icons in
  it. The build succeeds, `vue-tsc` passes, the container starts, `Notify=healthy` fires, and the
  page is correct in every respect except the one asset it was changed for.
- It is the same shape as the lane's tool-cache seed guard: the local `npm run build` writes the
  files into `dist/` from the working tree and proves nothing about the image. **The check has to be
  made inside the image** - `podman run --rm --entrypoint ls <image> /srv/dist/favicon.svg ...` -
  and the local build passing is not evidence either way.

### A number in one file that only means anything because of a number in another
- **`fitRole`'s 5.9 was the per-character advance of Azeret Mono at 9.5px, hardcoded in
  `src/graph.ts`, and moving the type scale invalidated it silently.** It truncates a network node's
  role to fit a 150px box; at 11px Spline Sans Mono the advance is 6.6, so it kept cutting at the
  OLD character count while each of those characters had grown, and the text ran to within 4px of
  the box. Nothing failed, nothing warned, and the symptom - a label that overflows its box - is the
  exact appearance the function exists to prevent. **The container NAME was never fitted at all**
  and had simply been short enough: `windmill-worker-verify` drew 173px into a 150px box the moment
  `--t-mono-md` went from 11px to 13px.
- Both constants are now named for the token they belong to and both were **measured in the
  browser** rather than derived, because the advance depends on the face as well as the size.
- Same family as the collector metric and fact-key collision: two files that must agree, with
  nothing between them that can say they do not.

### A fixture whose clock moves is a fixture with no stable identity
- **A round's key IS its start time**, so `fixtures/fleet.ts` stamping relative to `Date.now()` on
  every request handed out a different key every second. Every deep link to
  `/agents/rounds/<key>` therefore landed on "this round is not on the board", however fresh the
  link was.
- **Clicking a row always worked**, because the row and the lookup read the same document - so the
  fault could only ever show on a hand-typed URL or a reload, which is the one path a click-through
  review never takes. The anchor is at module load now, the same intent `fixtures/model.ts` records
  for its seeded rng: a dev document that changes under you is one nobody can screenshot twice.

### Three ways a shared class or a shared box was not shared at all
- **`white-space: nowrap` on a chip defeats `table-layout: fixed`.** The recipe's own comment
  promises an over-long cell will clip; it can only do that if something inside the cell can shrink,
  and an inline-flex that refuses to wrap is not that. One long branch name widened the round board
  and gave the whole page a horizontal scrollbar. `ChipLink` wraps its label in a shrinkable span.
- **A page's toolbar text borrowed the class its panel footnotes use.** `CiPage`'s `.note` carries
  `margin-top`, `padding-top` and a `border-top`, so `read only` teleported into the shell header
  with a stray rule above it - correct-looking for a year at 10px, obvious the moment the type grew.
  The two other pages that teleport the same string define `.note` as a plain dim line, so only one
  of the four was wrong and nothing could have told you which.
- **Everything in the shell header was shrinkable, so the wrong half gave way.** 13px type widened
  seven tabs past what 1360 could hold beside the System page's toolbar, and the browser compressed
  the mark and wrapped the OS line rather than the toolbar - a 75px header with a nav tab under it.
  The nav is `flex: none` and the toolbar is the half that clips, because a page's own toolbar is
  the half that may give way.

### The header was the horizontal scrollbar, and touch is where it could not be seen
- **`.left` is `flex: none` at an intrinsic ~583px** - a seven-tab nav of roughly 452px plus the
  113px lockup - so on a 375px screen the document's scroll width was at least **649px before any
  page contributed a pixel**. Every page carried ~275px of bare `--bg` and a scroll axis nobody
  asked for, and the fix was one element rather than seven pages.
- **Touch draws overlay scrollbars, so the overflow was silent on exactly the devices that had
  it.** No affordance, no scrollbar, nothing on screen to say the page continued off the right edge
  until somebody swiped. Which is why `overflow-x: hidden` on `body` was refused: it conceals this
  class of defect rather than removing it, and it breaks `position: sticky` in some engines.
  `fixtures/shoot.mjs` asserts `scrollWidth` against `clientWidth` at three viewports instead.
- **The clip that hid it was also eating the wrong end.** The old header wrapper was
  `justify-content: flex-end` with `overflow: hidden`, and an overflow in a flex-end row accumulates
  on the **start** edge - so the first thing sliced off was the verdict's StatusDot and then the
  front of its sentence. A status pill with no status light is the one rendering that header must
  never produce.
- **The drawer's rung is 900 and it was measured twice.** Seven tabs ~452px, lockup 113, verdict up
  to 229, gutters 66: the header needs **776px** empty. Written at 640 first, and the tablet
  viewport immediately reported 44px of overflow on all nine routes - true all along, invisible
  because the clip above was eating it. A fourth breakpoint at 780 would have existed for one
  element.
- **`#toolbar` had to leave its wrapper to get a row of its own.** Nested, a `flex-basis: 100%`
  sizes the WRAPPER, which put the verdict on a line by itself and left the toolbar indented under
  it - three rows for two things. There is still exactly one `#toolbar`; eight pages teleport into
  it and a second target would be two answers to one question.

### Two folds that got worse as the screen got smaller, and one that never had a floor
- **`SystemPage`'s `.right-column` and `NetworkPage`'s `.side` flip from a column to a ROW** when
  they can no longer sit beside their sibling. Correct at 1200, still in force at 375, where it left
  two panels in ~160px each - one of them holding a 92px fixed track. The rule is not wrong; it has
  no floor.
- `.bottom` folded `1fr 1fr 340px` to `1fr 1fr` and stopped there, permanently two columns.
- **`HomePage` had no breakpoint at all**, and it is the front door - `/` redirects to it. A hard
  300px track for the requests panel beside up to three flexible ones wanted 300 of 347 usable
  pixels, and the poster grid is eight across at every width.

### Three ways a phone lost information rather than losing width
- **A folded cell must sit OUTSIDE any clamped element.** `FindingsPanel`'s `.msg` is a two-line
  `-webkit-line-clamp`, so the check id folded into it spent one of the message's two lines and
  every finding read as a truncated sentence under its own name.
- **`StatePill` was the one chip-shaped element with no `max-width`.** ChipLink and ChipButton both
  cap themselves with a shrinkable label; this one did not, so a long state word could widen a
  fixed-layout table past its container.
- **A column sized by arithmetic ellipsed anyway, and `scrollWidth` agreed it fitted.** `waiting on
  you` needs 111.x px and both integer readings said 111 in a cell offering 111 - the pill is a flex
  item with the default `flex-shrink: 1`, so it had been squeezed to exactly its share and the
  ellipsis fired on the fraction the rounding had thrown away. Guessed twice, then measured.

### A drawer that opened perfectly for a mouse and not at all for a keyboard
- **A function `ref` on a `RouterLink` is handed the COMPONENT INSTANCE, not its element**, so
  `.focus()` on it throws - and it throws inside a watcher, where nothing on the page shows it.
  `shoot.mjs` reports `pageerror`, which is the only reason it was found in the same minute it was
  written. `querySelector` off the panel is the fix.
- `--z-scrim` and `--z-overlay` had been declared in `tokens.css` with the comment "a modal, a
  drawer" and had no consumer at all, so the drawer introduced no new tier.

### `idle` drew the encoding that means "in progress, ratio unknown"
- The Agents header's phase tile rendered a bare `ProgressBar` track and a dash while nothing was
  running. `ProgressBar`'s contract was never wrong - null is a bare track and zero is a
  zero-width fill, deliberately, and that distinction is load-bearing everywhere else - the call
  site was. The bar renders only in flight now, and the line under the reading says WHICH nothing:
  `no phase running` against `no phase has started on this host`.
- The band was also labelled `Fleet` directly under a sub-nav whose other segment is `Fleet`.

### The fixture gave every round a distinct id and the live board gives them all one
- **The task chip fell back to the WORKTREE ID, which names a lane and not a round.** A worktree is
  reused between changes by design, so ten of the eleven live rounds carried the identical grey chip
  `upskald-ship` at the top of the cell - above the summary that was the only line telling them
  apart. A fallback that is the same on every row is not an identifier. The chip is the tracker task
  or nothing now, and the worktree id is the TITLE's last fallback, where it costs no line.
- **The same string was the `v-for` key and the per-row tooltip id.** Vue does not warn about a
  duplicate key and a list that never reorders renders correctly anyway, so nothing caught it; a
  keyed diff over a list that DOES reorder may reuse the wrong node. The round's document name is
  unique because it carries the start time.
- **Every fixture round has a distinct worktree id and one in ten has no task id. The live board is
  the exact mirror: one worktree, ten rounds, one task id.** So no screenshot review and no
  `shoot.mjs` run at any viewport could ever have shown either of these - the fixture models as an
  edge case the thing that is the rule.

### A class on a component is not a class on the element you meant
- `class="fold3"` on a `ChipLink` lands on the component's ROOT, where its own scoped
  `.chip { display: inline-flex }` is one class more specific than a bare `.fold3` - so the fold
  never hid and the wide board printed the branch twice, once in the meta line and once in the
  Outcome column it had not dropped. A wrapper element is the fix.
- **An EMPTY wrapper is still a flex item and still costs a gap**, which is a 12px hole between two
  visible things on the rows where the round has no branch yet. `display: contents` removes it - and
  only inside the rung, or it outranks the `display: none` that has to win above it.

### A column priced at 48% of the table for one word, and the worst width was a laptop
- **The narrowest the task column ever got was at 1000px, not on a phone.** Six columns carry 814px
  of FIXED width, so a 1000px window left the one flexible column **104px** - about thirteen
  characters - and nothing on the ladder between 1180 and 900 caught it. Cost and Outcome now drop
  at 1180 on a `.p4` tier, which is a tier on an existing rung and not a re-rung of `.p3`: the round
  page's five-column table still gives its flexible column 384px at 920 and needed none of it.
- **Dropping columns at 900 was not enough either.** 168 + 282 + 140 of fixed width left an 834px
  tablet 162px, so Time leaves at that rung too - the narrowest column and the one most often empty,
  since the ETA half is withheld below five samples. Phase stays: the progress bar is the round's
  only picture of itself. The phase sub line truncates at 200px, which is the trade.
- **At 640 the state column was 156px of 328 with about 70px of it empty.** That width was measured
  twice and both readings were right ABOUT THE PILL; neither asked whether the COLUMN was worth its
  width once only two were left. It folds into the task cell now, keeping its left edge, its dot,
  its tone and its link, so the scan down for `waiting on you` is unchanged.
- A header row over one column names nothing, and `TASK` had stopped being true of a cell that now
  holds the state as well.

### Packed-left wrapping is a layout until the row runs out
- **The header's three conditions sit on one line from 1360 down to 760 and break 2 + 1 at 640** -
  intake and quota side by side, worktrees alone underneath. Two unequal columns, three labels that
  no longer align, and no column to read down at the width where reading down matters most. The
  label moves to the left of its value below 640.
- The label column is `max-content` through a `subgrid` with a measured 82px literal behind it -
  `WORKTREES` is 73px at `--t-label`. All three rows share the literal, so they align without
  subgrid too; subgrid is what keeps it true if the type scale moves, which is the failure `fitRole`
  already paid for once.

### The gate that reserved two days of headroom for nobody
- **`config.QUOTA_HOLD_AT = "allowed_warning"` is right and its premise is not always true.** The
  fleet stops while there is headroom so that what is left is left for the human's own sessions -
  and on a weekend nobody is working, that reserves two days of fleet time for nobody. Measured
  2026-08-29: `select` recorded the warning at 11:17Z and every model phase after it was held, with
  the seven-day window not clearing until the 31st.
- **There was no way to say so.** `QUOTA_HOLD_AT` is a bare literal, not read from the environment,
  so no `.env` change reaches it; and `conduct intake --force` bypasses only the intake half - the
  dispatch loop's hold takes no `force`, so a hand-forced round stalls at its first model phase.
- **The row is a STAMP and not `on`**, which is safe by `state.control`'s own rule: `control_flag`
  answers None to a value it does not define, so no existing reader can mistake it for a switch. The
  expiry is DERIVED from the reading's own `resets_at`, so an override cannot outlive the window it
  was granted against and there is nothing to remember to undo.
- **`rejected` still holds, and that floor is the whole argument.** Spending the weekly window
  faster can warn the five-hour one too, which the override covers deliberately; past that the API
  refuses, `observe()` records it, and the fleet stops until that window clears by itself.
- **An unparseable value and a passed stamp both read as "the default is in force".** Failing open
  would be a hold nobody could restore by fixing a row - and `quotaHold` was made to fail on a
  planted presence test before it was trusted.

### A check that would have paged the phone about a fleet that was running
- **`agents.quota_headroom`'s warn arm says "the fleet is holding, which is what it is meant to
  do"**, and `AgentCheckWarning` pages on any `agents.*` warn after 30 minutes. Lifting the hold
  without a fourth arm would have alerted, hourly, with a sentence that was false - about a state
  somebody had deliberately asked for.
- The fourth arm is a **note**, which is silent in Prometheus (`== 2` is warn, a note is 1). Holding
  is not a fault and neither is deliberately not holding, which is `agents.intake`'s own posture.
- **`AgentQuotaRejected`'s inference inverts and its expression must not.** "a rejection means
  something other than the fleet spent it" stops holding under an override - so the description
  points at the check rather than deciding it, and no second clause was added: a rule that went
  silent while somebody was spending the window would go silent in the one state they would most
  want to be told about.
- Two sentences in `docs/observability.md` were **already** false and sat in the paragraphs being
  rewritten: "percentages are the currency" eleven lines from the note that the percentage era
  ended, and the marker described as holding "the two quota percentages".

### The counted sentence moved, in the order its own comment demands
- `marker.KEYS` is asserted against a set lifted from the READERS in the other repository, and its
  comment says a key must be added there LAST. Adding `quota_override_until` failed that test until
  `cget quota_override_until` and `AGENT_STAMPS` existed, which is the whole of what it is for.
- The paired count - "five checks and fourteen series" - lives in `conduct/marker.py` and in
  `docs/agents.md`, and "has been wrong in both copies at once already". Fifteen now: one series,
  no new check id, both halves moved together.
- **`bin/collect-metrics.py`'s `_fleet_control` silently drops any control name it does not route**,
  which is why `restart:*` has never reached the board. A `quota:` row would have been invisible to
  the dashboard with every other layer working.
