// =============================================================================
// A synthetic host, for developing against
// -----------------------------------------------------------------------------
// Deterministic, offline, and DELIBERATELY UNHEALTHY. A fixture where
// everything passes exercises exactly the state that needs the least design
// work; the interesting layouts are the actionable strip with something in it,
// a panel that has gone stale, a container in a restart loop, a disk with a
// reallocated sector. So this host has all of those, and they are the same
// failures the real one has actually had.
//
// Nothing here ships: fixtures/ is imported only by vite.config.ts, which drops
// the plugin entirely when VITE_PROM is set, and the production image serves a
// bundle that has never referenced this file.
// =============================================================================

import { NODES } from "../src/topology";
import type { AmAlert, Check, StatusDocument } from "../src/types";

// -----------------------------------------------------------------------------
// A seeded generator, so two reloads look the same and a layout bug does not
// hide behind fresh noise.
// -----------------------------------------------------------------------------
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A smooth-ish waveform with a stable shape per key. */
export function wave(key: string, t: number, base: number, swing: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const phase = (h % 1000) / 1000;
  const slow = Math.sin(t / 1800 + phase * 6.283) * 0.6;
  const fast = Math.sin(t / 240 + phase * 12.566) * 0.25;
  const jitter = (rng(h ^ Math.floor(t / 30))() - 0.5) * 0.3;
  return Math.max(0, base + swing * (slow + fast + jitter));
}

// -----------------------------------------------------------------------------
// The containers, taken from the same topology module the app reads, so a node
// added there shows up here without a second edit.
// -----------------------------------------------------------------------------
const IMAGES: Record<string, string> = {
  caddy: "localhost/home-server/caddy:latest",
  dashboard: "localhost/home-server/dashboard:latest",
  tinyauth: "ghcr.io/steveiliop56/tinyauth:v5",
  "pocket-id": "ghcr.io/pocket-id/pocket-id:v2",
  sonarr: "lscr.io/linuxserver/sonarr:latest",
  radarr: "lscr.io/linuxserver/radarr:latest",
  prowlarr: "lscr.io/linuxserver/prowlarr:develop",
  bazarr: "lscr.io/linuxserver/bazarr:latest",
  unpackerr: "ghcr.io/unpackerr/unpackerr:latest",
  jellyseerr: "docker.io/fallenbagel/jellyseerr:latest",
  flaresolverr: "ghcr.io/flaresolverr/flaresolverr:latest",
  jellyfin: "lscr.io/linuxserver/jellyfin:latest",
  "tdarr-server": "ghcr.io/haveagitgat/tdarr:latest",
  "tdarr-node-01": "ghcr.io/haveagitgat/tdarr_node:latest",
  prometheus: "quay.io/prometheus/prometheus:v3",
  "node-exporter": "quay.io/prometheus/node-exporter:v1",
  alertmanager: "quay.io/prometheus/alertmanager:v0",
  "ntfy-alertmanager": "docker.io/xenrox/ntfy-alertmanager:latest",
  ntfy: "docker.io/binwiederhier/ntfy:v2",
  duckdns: "lscr.io/linuxserver/duckdns:latest",
  gluetun: "docker.io/qmcgaw/gluetun:v3",
  qbittorrent: "lscr.io/linuxserver/qbittorrent:libtorrentv1",
  joal: "docker.io/anthonyraymond/joal:latest",
  torrent: "localhost/podman-pause:5.4.0",
};

/**
 * Memory ceilings, matching the `MemoryHigh=` in `stacks/`.
 *
 * IT SAID THAT BEFORE AND IT WAS NOT TRUE. Measured against every quadlet on
 * 2026-09-08: bazarr was 512 MiB here against 1536M in stacks/, prowlarr 512 MiB
 * against 1G, qbittorrent 1 GiB against 2G, and twelve more took the 256 MiB
 * default while their units declare 64M to 1G explicitly. That was harmless only
 * for as long as the `ratio >= 0.98` arm of memoryTone was dead code; it is a
 * live arm now, so a wrong ceiling makes the fixture exercise fiction.
 *
 * MemoryMax is derived rather than tabulated: it is 1.33-1.5x MemoryHigh on
 * every unit here, and fixtures/prometheus.ts already generated it that way.
 */
const MEM_HIGH: Record<string, number> = {
  jellyfin: 3 * 1024 ** 3,
  "tdarr-server": 2 * 1024 ** 3,
  "tdarr-node-01": 6 * 1024 ** 3,
  prometheus: 512 * 1024 ** 2,
  caddy: 512 * 1024 ** 2,
  sonarr: 1024 ** 3,
  radarr: 1024 ** 3,
  prowlarr: 1024 ** 3,
  bazarr: 1536 * 1024 ** 2,
  qbittorrent: 2 * 1024 ** 3,
  dashboard: 64 * 1024 ** 2,
  jellyseerr: 1024 ** 3,
  tinyauth: 256 * 1024 ** 2,
  "pocket-id": 512 * 1024 ** 2,
  ntfy: 128 * 1024 ** 2,
  "ntfy-alertmanager": 64 * 1024 ** 2,
  "node-exporter": 128 * 1024 ** 2,
  alertmanager: 128 * 1024 ** 2,
  duckdns: 128 * 1024 ** 2,
  unpackerr: 512 * 1024 ** 2,
  gluetun: 256 * 1024 ** 2,
  joal: 512 * 1024 ** 2,
  "windmill-db": 512 * 1024 ** 2,
  "windmill-server": 768 * 1024 ** 2,
  "windmill-worker": 512 * 1024 ** 2,
  "windmill-worker-verify": 512 * 1024 ** 2,
  // MemoryHigh=1G, MemoryMax=2G in stacks/media/flaresolverr.container. Taken
  // from the unit rather than defaulted, because this is the row whose finding
  // IS its memory and a made-up ceiling would make its ratio fiction.
  flaresolverr: 1024 ** 3,
};

/**
 * MemoryMax, the hard limit, from the `MemoryMax=` in `stacks/`.
 *
 * TABULATED RATHER THAN DERIVED, and that is the point. Both fixture files were
 * computing it as `Math.round(memoryHigh * 1.5)` INDEPENDENTLY - the same
 * duplicated-literal shape that let a `refault > 0` rule ship unchallenged, one
 * field over. It is not 1.5x either: the real ratio runs from 1.28 (jellyseerr,
 * 1G to 1536M) to 1.5, and it is 1.33 on most of the *arrs.
 */
const MEM_MAX: Record<string, number> = {
  jellyfin: 4 * 1024 ** 3,
  "tdarr-server": 3 * 1024 ** 3,
  "tdarr-node-01": 8 * 1024 ** 3,
  prometheus: 768 * 1024 ** 2,
  caddy: 768 * 1024 ** 2,
  sonarr: 1536 * 1024 ** 2,
  radarr: 1536 * 1024 ** 2,
  prowlarr: 1536 * 1024 ** 2,
  bazarr: 2 * 1024 ** 3,
  qbittorrent: 3 * 1024 ** 3,
  dashboard: 128 * 1024 ** 2,
  jellyseerr: 1536 * 1024 ** 2,
  tinyauth: 384 * 1024 ** 2,
  "pocket-id": 768 * 1024 ** 2,
  ntfy: 256 * 1024 ** 2,
  "ntfy-alertmanager": 128 * 1024 ** 2,
  "node-exporter": 192 * 1024 ** 2,
  alertmanager: 256 * 1024 ** 2,
  duckdns: 192 * 1024 ** 2,
  unpackerr: 768 * 1024 ** 2,
  gluetun: 512 * 1024 ** 2,
  joal: 768 * 1024 ** 2,
  "windmill-db": 768 * 1024 ** 2,
  "windmill-server": 1024 ** 3,
  "windmill-worker": 768 * 1024 ** 2,
  "windmill-worker-verify": 768 * 1024 ** 2,
  flaresolverr: 2 * 1024 ** 3,
};

/**
 * container_memory_working_set_bytes, measured on the host on 2026-09-08.
 *
 * IT WAS A FLAT 64 MiB FOR EVERY ROW, and that only looked harmless while
 * MEM_HIGH was wrong in the same direction. Correcting the ceilings against
 * stacks/ put ntfy-alertmanager - 64 MiB of memory against its real 64M
 * watermark - at a ratio of exactly 1.000, which is a shape the host does not
 * have: its actual working set is 6.4 MiB, a tenth of its ceiling. A fixture
 * whose every row sits at its limit cannot exercise a rule about limits.
 *
 * Working set, not memory.current: the cold page cache is exactly what the
 * ratio must not count. Rows patched below override this deliberately.
 */
const MEMORY: Record<string, number> = {
  "windmill-db": 309608448,
  jellyfin: 226381824,
  flaresolverr: 222019584,
  bazarr: 194641920,
  "tdarr-server": 180244480,
  jellyseerr: 173481984,
  sonarr: 151633920,
  radarr: 137179136,
  prowlarr: 110833664,
  "tdarr-node-01": 80842752,
  prometheus: 76226560,
  caddy: 48431104,
  gluetun: 35463168,
  qbittorrent: 35373056,
  joal: 34017280,
  "windmill-server": 32546816,
  alertmanager: 30932992,
  dashboard: 29413376,
  tinyauth: 22089728,
  "node-exporter": 18165760,
  ntfy: 16998400,
  "pocket-id": 16199680,
  "windmill-worker-verify": 15097856,
  "windmill-worker": 13737984,
  unpackerr: 12505088,
  "ntfy-alertmanager": 6742016,
  duckdns: 6070272,
  torrent: 577536,
};

/**
 * rate(...workingset_refault_file_total[5m]) in pages/s, measured on the host on
 * 2026-09-08.
 *
 * NON-ZERO ON HALF THE RACK, WHICH IS THE ENTIRE POINT. This fixture used to
 * hardcode 840 for bazarr and 0 for the other twenty-six, so a rule warning on
 * `refault > 0` could not be contradicted by it - and that is exactly what
 * shipped. On the host, a mean of 9 of 27 containers were selected by that
 * expression at any instant over six hours and 25 of 27 at the peak, every one
 * of them holding cache. tdarr-node-01's rate is one page every four and a half
 * minutes, and it drew "memory starved".
 */
const REFAULT: Record<string, number> = {
  "tdarr-node-01": 0.0037,
  "tdarr-server": 0.022,
  jellyfin: 1.14,
  prowlarr: 1.24,
  radarr: 1.16,
  caddy: 1.95,
  "windmill-db": 1.42,
  alertmanager: 0.31,
  "pocket-id": 0.42,
  tinyauth: 0.44,
  jellyseerr: 0.14,
  dashboard: 0.13,
  "node-exporter": 0.11,
  prometheus: 0.29,
  flaresolverr: 95.4,
};

/**
 * rate(container_pressure_memory_waiting_seconds_total[5m]) - PSI `some`, the
 * share of wall time at least one task in the cgroup was delayed on memory.
 *
 * THESE ARE THE HOST'S THIRTY-DAY MAXIMA, NOT ITS TYPICAL READING, so the
 * fixture sits at the worst this fleet has ever been rather than at its quietest
 * - which is the reading a floor has to survive. Everything not named here is 0.
 */
const STALL_SOME: Record<string, number> = {
  qbittorrent: 0.01225,
  bazarr: 0.01031,
  flaresolverr: 0.00229,
  jellyfin: 0.00153,
  "tdarr-node-01": 0.00071,
};

export interface FixtureContainer {
  name: string;
  unit: string;
  image: string;
  pod: string;
  /** 0 healthy, 1 starting, 2 unhealthy. undefined = no health check defined. */
  health?: number;
  running: boolean;
  restarts: number;
  cpu: number;
  memory: number;
  memoryHigh: number;
  startedAgo: number;
  /** cgroup OOM kills since this container was created. The one memory event
   *  that is unambiguous - see memoryTone() in src/services.ts. */
  oomKills: number;
  /** MemoryMax. See MEM_MAX - it is NOT MemoryHigh times a constant. */
  memoryLimit: number;
  /** rate(...workingset_refault_file_total[5m]), pages/s. See REFAULT. */
  refault: number;
  /** PSI `some` and `full` as fractions of wall time. NaN here means the SERIES
   *  IS ABSENT rather than zero - fixtures/prometheus.ts drops any sample that
   *  formats to NaN, the way a rate is simply missing for a container younger
   *  than its own window. */
  stallSome: number;
  stallFull: number;
}

/**
 * THE ONE SERVICE THAT IS DOWN, AND IT IS DOWN BY BEING ABSENT.
 *
 * `podman ps` lists RUNNING containers, so a service that has stopped has no
 * home_server_container_info row at all - its unit is the only witness. No
 * fixture had ever carried that state, which is the whole reason ServicesPage
 * could not draw it: the rack was built from the containers, so a stopped
 * service did not go red, it disappeared. See UNITS below, where
 * duckdns.service is inactive.
 */
const STOPPED = "duckdns";

export const CONTAINERS: FixtureContainer[] = NODES.filter((n) => n.name !== STOPPED).map((n) => {
  const pod = n.pod ?? (n.name === "torrent" ? "torrent" : "");
  // unpackerr serves no HTTP and defines no health check, and neither does the
  // pod's infra container. The metric is ABSENT for them rather than zero,
  // which is what lets a rule cover every container without naming any - see
  // CLAUDE.md.
  const noHealth = n.name === "unpackerr" || n.name === "torrent";

  return {
    name: n.name,
    // ONE UNIT PER CONTAINER, WHICH IS WHAT THE HOST ACTUALLY REPORTS. This
    // said `torrent-pod.service` for all three pod members, and it is their own
    // .container quadlet that PODMAN_SYSTEMD_UNIT names - measured on the live
    // host: gluetun.service, qbittorrent.service, joal.service. Only the infra
    // container carries the pod's unit. A fixture where four containers share
    // one unit is a shape production does not have, and it hid the join
    // ServicesPage now makes.
    unit: n.name === "torrent" ? "torrent-pod.service" : `${n.name}.service`,
    image: IMAGES[n.name] ?? "docker.io/library/unknown:latest",
    pod,
    health: noHealth ? undefined : 0,
    running: true,
    restarts: 0,
    cpu: 0.01,
    memory: MEMORY[n.name] ?? 64 * 1024 ** 2,
    memoryHigh: MEM_HIGH[n.name] ?? 256 * 1024 ** 2,
    memoryLimit: MEM_MAX[n.name] ?? 384 * 1024 ** 2,
    startedAgo: 41 * 86400 + 6 * 3600,
    oomKills: 0,
    refault: REFAULT[n.name] ?? 0,
    stallSome: STALL_SOME[n.name] ?? 0,
    stallFull: 0,
  };
});

// --- the two live problems, so the actionable layer has something in it ------
function patch(name: string, changes: Partial<FixtureContainer>): void {
  const c = CONTAINERS.find((x) => x.name === name);
  if (c) Object.assign(c, changes);
}

// `restarts` STAYS 0 HERE, AND THAT IS THE POINT. podman's per-container count
// is reset whenever a quadlet recreates the container, which is every restart -
// so it reads 0 throughout the exact event it looks like it would catch. The
// nine restarts this row is meant to carry are on bazarr.service in UNITS,
// where systemd's NRestarts survives them.
patch("bazarr", { health: 2, restarts: 0, startedAgo: 96, memory: 508 * 1024 ** 2 });
// A REAL, BENIGN AMBER. Jellyseerr genuinely takes about forty seconds to pass
// its health check after a restart, so `health: 1` here is a state the host
// actually reaches rather than an invented one - and nothing else in this fixture
// exercises the "starting" branch that ServicesPage and the Home strip both have.
// With bazarr already unhealthy and unpackerr defining no check at all, the strip
// then renders all four tones at once, which is the point of a fixture.
//
// AND THE ROW WITH NO PRESSURE READING AT ALL, which is honest rather than
// contrived: it is forty seconds old, and a rate needs two samples in its five
// minute window. So it reaches memoryTone with a MemoryHigh gauge and no
// arbiter, and the answer has to be `off` - unmeasured, not verified fine.
// Under the old rule an absent refault made `thrashing` false and returned
// `ok`: health asserted from nothing, which is the family docs/known-state.md
// files as "Absence read as health in one function and as a failure in the
// next". NaN is an ABSENT SERIES in fixtures/prometheus.ts, not a zero.
patch("jellyseerr", {
  health: 1,
  startedAgo: 40,
  memory: 180 * 1024 ** 2,
  refault: Number.NaN,
  stallSome: Number.NaN,
  stallFull: Number.NaN,
});
// THE ROW THE OLD RULE DREW RED, AND THE ONE CLAUDE.md SPENDS A SECTION SAYING
// IS FINE. 2.99G of a 3G watermark is a ratio of 0.997, so `ratio >= 0.98 &&
// refault > 0` made this container a FAILURE - the very one every memory
// argument on this page is built from. anon 0.385G, pgsteal tracking pgscan to
// five digits, and the rest cold streaming page cache the kernel reclaims for
// nothing. Its worst memory stall in thirty days is 0.153% of wall time.
patch("jellyfin", { cpu: 3.9, memory: 2.99 * 1024 ** 3, startedAgo: 15 * 3600 + 38 * 60 });
patch("tdarr-node-01", { cpu: 1.6, memory: 1.4 * 1024 ** 3 });
patch("prowlarr", { cpu: 0.06, memory: 220 * 1024 ** 2 });
patch("prometheus", { cpu: 0.11, memory: 402 * 1024 ** 2 });
patch("qbittorrent", { cpu: 0.22, memory: 610 * 1024 ** 2 });
patch("caddy", { cpu: 0.03, memory: 88 * 1024 ** 2 });
patch("dashboard", { cpu: 0.002, memory: 14 * 1024 ** 2 });

// THE MEMORY ARM, ON ITS OWN AND ON THE RIGHT CONTAINER. flaresolverr is
// headless Chrome and it is the one that fills its cgroup here - CLAUDE.md has
// it at 1,925 MB in 969 unlinked fds, and the live host reports 29,187 `high`
// events against it. Being AT MemoryHigh is not news and must never draw amber;
// an OOM KILL is, so this row is the only one whose finding is its memory, with
// its liveness perfectly healthy. Nothing else exercises that path.
patch("flaresolverr", { memory: 1004 * 1024 ** 2, oomKills: 2 });

// THE STARVED ROW, AND NEITHER AN OOM KILL NOR AN UNHEALTHY PROBE SAYS SO.
// stacks/infra/windmill-db.container mounts /dev/shm under a 512M MemoryHigh,
// and docs/known-state.md's "A filesystem that counts against the memory
// ceiling" is what that costs: tmpfs pages are charged to the cgroup and, with
// no swap, cannot be reclaimed - so memory.current pins at the watermark and the
// kernel throttles the allocator instead of freeing anything. In the recorded
// incident `memory.events max` and `oom_kill` BOTH stayed 0, no unit failed, no
// container went unhealthy, no check fired and no alert reached the phone.
//
// PSI IS THE ONLY WITNESS THAT SHAPE HAS, and a tmpfs-pinned cgroup refaults NO
// file pages at all - there is no file cache left to evict - so the rule this
// replaces could not have seen it however high its floor was set. This row's
// liveness is perfect on purpose, so memory is the only finding on it.
patch("windmill-db", {
  memory: 505 * 1024 ** 2, // ratio 0.986 against the unit's own 512M
  refault: 3.2,
  stallSome: 0.41,
  stallFull: 0.19, // >= STALL_FAIL, with no OOM kill anywhere
});

// AMBER AT A RATIO OF 0.375 WITH A REFAULT RATE OF EXACTLY ZERO, which is the
// combination the old rule was structurally incapable of drawing. A cgroup being
// reclaimed for ANON pressure faults no file pages back in and sits nowhere near
// its watermark; nothing but PSI can see it. Without this row the warn arm would
// render in dev exactly as often as it did before - never.
patch("sonarr", { memory: 384 * 1024 ** 2, refault: 0, stallSome: 0.071, stallFull: 0.004 });

// A CONTAINER THAT RESTARTED WITHOUT ITS UNIT RESTARTING, which is podman's own
// doing and the one thing podman's counter can say that systemd's cannot. It is
// 0 on every other row here, exactly as it is on the live host.
patch("joal", { restarts: 2 });

// -----------------------------------------------------------------------------
// The units, which are the half podman cannot see
// -----------------------------------------------------------------------------
// ENUMERATED FROM THE CONTAINERS PLUS THE ONE THAT HAS NONE, which is the
// inversion of what the collector does and the right way round for a fixture:
// source_units reads the quadlet generator directory, so a unit exists whether
// or not anything is running under it. That asymmetry is the whole point -
// duckdns.service is here and duckdns is not.
//
// THE ONESHOTS ARE ABSENT BECAUSE THE QUERY EXCLUDES THEM. There are fourteen
// `.network` and `.build` units on the host and all fourteen rest INACTIVE when
// everything is well, so SERVICES.unitState carries a `kind=~"container|pod"`
// selector. These fixtures answer by exact query string and cannot evaluate a
// selector, so the table has to hold what Prometheus would have returned - and
// putting the oneshots in it would draw fourteen healthy networks as fourteen
// dead services in dev and nowhere else.

export interface FixtureUnit {
  unit: string;
  kind: "container" | "pod";
  /** 0 active, 1 activating, 2 failed, 3 deactivating, 4 inactive, 5 reloading. */
  state: number;
  /** systemd's NRestarts. The counter that survives a restart loop. */
  restarts: number;
}

export const UNITS: FixtureUnit[] = [
  ...CONTAINERS.map((c) => ({
    unit: c.unit,
    kind: (c.unit.endsWith("-pod.service") ? "pod" : "container") as FixtureUnit["kind"],
    state: 0,
    restarts: 0,
  })),
  // THE STOPPED SERVICE. Inactive, not failed - which is the distinction that
  // cost 35 minutes of Caddy being down while three checks looked straight at
  // it. A dependency that failed to start leaves its dependant inactive, and
  // `systemctl --user list-units --failed` does not list it.
  { unit: `${STOPPED}.service`, kind: "container", state: 4, restarts: 0 },
];

function unitPatch(unit: string, changes: Partial<FixtureUnit>): void {
  const u = UNITS.find((x) => x.unit === unit);
  if (u) Object.assign(u, changes);
}

// The nine restarts behind bazarr's unhealthy container, on the counter that can
// hold them.
unitPatch("bazarr.service", { restarts: 9 });

// A UNIT LOOPING WITH A HEALTHY CONTAINER UNDER IT, which is the state that had
// no witness anywhere in this application: Restart=always at RestartSec=5 can
// never reach systemd's give-up limit, so the unit stays `active`, podman's
// counter stays 0, and the container passes its probe between restarts. This
// number climbing is the only end state the host has.
unitPatch("ntfy-alertmanager.service", { restarts: 3 });

// -----------------------------------------------------------------------------
// status.json
// -----------------------------------------------------------------------------
const CHECKS: Check[] = [
  { section: "net", id: "net.lan_address", status: "pass", message: "192.168.0.100 on enp3s0" },
  { section: "deploy", id: "deploy.booted", status: "pass", message: "ucore stable-nvidia-lts, 2 deployments" },
  { section: "deploy", id: "deploy.image_tag", status: "pass", message: "stable-nvidia-lts" },
  { section: "deploy", id: "deploy.image_signed", status: "pass", message: "ostree-image-signed, cosign scope matches" },
  { section: "deploy", id: "deploy.pinned", status: "pass", message: "nothing pinned" },
  { section: "deploy", id: "deploy.update_policy", status: "pass", message: "AutomaticUpdatePolicy=stage" },
  { section: "deploy", id: "deploy.update_timer", status: "pass", message: "rpm-ostreed-automatic.timer armed" },
  { section: "deploy", id: "deploy.boot_free", status: "pass", message: "171 MB free of 350 MB" },
  { section: "deploy", id: "deploy.update_run", status: "pass", message: "last ran 9h ago" },
  { section: "storage", id: "storage.media_mount", status: "warn", message: "/mnt/media 91% used, 3.2 TB free of 36 TB" },
  // A `note`, which bin/verify-host.sh emits for a check that COULD NOT RUN.
  // It is here because the two findings surfaces used to disagree about exactly
  // this status - amber in the strip at the top, grey in the list below it -
  // and neither fixture nor lint could see it, because no fixture had one.
  {
    section: "storage",
    id: "storage.smart_selftest",
    status: "note",
    message: "smartctl reports no self-test log for dm-0; not measured rather than passing",
  },
  // THE ONE CHECK /system/storage's COMMITMENT FOOTNOTE READS. Its tone comes
  // from the battery rather than from a ratio recomputed in the page, so with
  // no capacity check in the document the dot was grey at every value - which
  // is the correct ABSENCE state and therefore left the toned path undrawn.
  // Ids and wording are the live battery's, off bin/verify-host.sh.
  { section: "capacity", id: "capacity.census", status: "pass", message: "the /var census ran 1h ago" },
  {
    section: "capacity",
    id: "capacity.var_breakdown",
    status: "pass",
    message: "/var holds 66560MB, of which 4947MB (7%) is unaccounted",
  },
  {
    section: "capacity",
    id: "capacity.var_commitment",
    status: "pass",
    message: "if every capped consumer reached its ceiling /var would hold 190874MB of 238592MB (80%)",
  },
  // --- the media pipeline, which /library is the only reader of ------------
  // ADDED 2026-09-09, WITH THAT PAGE'S EVIDENCE BAND. No fixture had ever
  // carried a check from any of these three sections, so a FindingsPanel asking
  // for them rendered "absent from the battery's last run" - which is the
  // panel being honest about a fixture that could not exercise it. Wording and
  // ids are the live battery's, read off status.json rather than written to
  // suit the page: a fixture derived from its consumer cannot contradict it.
  { section: "search", id: "search.timer_enabled", status: "pass", message: "home-server-search.timer enabled" },
  { section: "search", id: "search.run_age", status: "pass", message: "the last sweep was 22h ago" },
  // THE ONE FINDING THIS PAGE EXISTS TO SURFACE, and it is amber deliberately.
  // A stalled download is silent, blocks every alternative release with
  // "already meets cutoff", and nothing on the host clears it - ten episodes sat
  // at "no connections" for 225-243 hours before bin/clear-stalled.py existed.
  // A fixture where this always passes is one where the evidence band is an
  // empty panel nobody would notice had stopped working.
  {
    section: "search",
    id: "search.stalled_queue",
    status: "warn",
    message: "2 stalled download(s), the oldest 42m at no peers - each one blocks every alternative release",
  },
  { section: "seeding", id: "seeding.timer_enabled", status: "pass", message: "home-server-seeding.timer enabled" },
  { section: "seeding", id: "seeding.run_age", status: "pass", message: "the policy was applied 0h ago" },
  {
    section: "torrent",
    id: "torrent.disk_io_type",
    status: "pass",
    message: "libtorrent 2.0.14.0 with DiskIOType=Posix - no memory-mapped torrent data",
  },
  { section: "gpu_cdi", id: "gpu.count", status: "pass", message: "1 GPU visible" },
  { section: "gpu_cdi", id: "cdi.spec_count", status: "pass", message: "exactly one spec at /run/cdi/nvidia.yaml" },
  { section: "gpu_cdi", id: "cdi.driver_match", status: "pass", message: "spec names 580.173.02, which is running" },
  { section: "gpu_cdi", id: "cdi.refresh_watcher", status: "pass", message: "nvidia-cdi-refresh.path active" },
  { section: "host", id: "host.container_use_devices", status: "pass", message: "on" },
  { section: "host", id: "host.failed_units", status: "pass", message: "no failed system units" },
  { section: "host", id: "host.firewalld", status: "pass", message: "FedoraServer, stack ports open" },
  { section: "host", id: "host.io_delegated", status: "pass", message: "cpu io memory pids delegated to user@1000" },
  { section: "host", id: "host.linger", status: "pass", message: "enabled for core" },
  { section: "greenboot", id: "greenboot.installed", status: "pass", message: "greenboot layered" },
  { section: "greenboot", id: "greenboot.armed", status: "pass", message: "boot counter armed via /boot/grub2/custom.cfg" },
  { section: "greenboot", id: "greenboot.verdict", status: "pass", message: "last boot green" },
  { section: "reboot", id: "reboot.timer_enabled", status: "pass", message: "home-server-reboot.timer armed" },
  { section: "reboot", id: "reboot.last_applied", status: "pass", message: "applied 6d ago" },
  { section: "update", id: "update.podman_timer", status: "pass", message: "podman-auto-update.timer armed" },
  { section: "update", id: "update.caddy_build_timer", status: "pass", message: "home-server-caddy-build.timer armed" },
  { section: "update", id: "update.dashboard_build_timer", status: "pass", message: "home-server-dashboard-build.timer armed" },
  { section: "update", id: "update.policy_count", status: "pass", message: "18 units carry an AutoUpdate policy" },
  { section: "update", id: "update.podman_run", status: "pass", message: "last ran 9h ago" },
  { section: "backup", id: "backup.timer_enabled", status: "pass", message: "home-server-backup.timer armed" },
  { section: "backup", id: "backup.run", status: "pass", message: "last ran 6h ago" },
  { section: "backup", id: "backup.local_age", status: "pass", message: "6h old, fails at 48h" },
  { section: "backup", id: "backup.offsite_age", status: "pass", message: "6h old, fails at 72h" },
  { section: "backup", id: "backup.offsite_prune_age", status: "warn", message: "33 days since the last off-site prune, warns at 30" },
  { section: "backup", id: "backup.offsite_delete_denial", status: "pass", message: "refused with 403 six hours ago" },
  { section: "backup", id: "backup.tsdb_snapshot_age", status: "pass", message: "6h old" },
  { section: "checkout", id: "checkout.clean", status: "pass", message: "working tree clean" },
  { section: "checkout", id: "checkout.matches_origin", status: "pass", message: "at origin/main" },
  // PASS, AND THAT IS THE FINDING. duckdns is down and this check is right to
  // say nothing: a dependency failure leaves a unit INACTIVE rather than failed,
  // so `list-units --failed` is empty while a service is missing. It is the
  // reason containers.units_active exists as a separate check, and the reason
  // /services enumerates the units rather than the containers.
  { section: "containers", id: "containers.failed_units", status: "pass", message: "no failed user units" },
  {
    section: "containers",
    id: "containers.units_active",
    status: "fail",
    message: "duckdns.service is inactive - nothing failed, and the container it should have started does not exist",
  },
  {
    section: "containers",
    id: "containers.healthy",
    status: "fail",
    // Kept consistent with the CONTAINERS patches above: bazarr unhealthy and
    // jellyseerr still starting. Three sources disagreeing about the same host is
    // exactly the confusion a fixture is supposed to avoid.
    message: "bazarr unhealthy, jellyseerr starting; 23 of 27 healthy, 2 define no check",
  },
  {
    section: "containers",
    id: "containers.probe_binaries",
    status: "pass",
    message: "all 25 health probes can run the binary they invoke",
  },
  { section: "containers", id: "containers.gpu_jellyfin", status: "pass", message: "nvidia device present" },
  { section: "containers", id: "containers.gpu_tdarr_node_01", status: "pass", message: "nvidia device present" },
  { section: "logs", id: "logs.persistent", status: "pass", message: "Storage=persistent" },
  { section: "logs", id: "logs.disk_usage", status: "pass", message: "1.2 GB of a 16 GB cap" },
  { section: "logs", id: "logs.retention", status: "pass", message: "90 days" },
  { section: "logs", id: "logs.dropin_loaded", status: "pass", message: "10-home-server.conf parsed by PID 1" },
  { section: "logs", id: "logs.dropin_values", status: "pass", message: "MaxRetentionSec and SystemMaxUse both in force" },
  { section: "logs", id: "logs.suppressed_24h", status: "pass", message: "nothing rate-limited in 24h" },
  { section: "logs", id: "logs.healthcheck_events", status: "pass", message: "0 health_status events in the last hour" },
  { section: "logs", id: "logs.config_log_size", status: "pass", message: "11 MB across 69 files" },
  { section: "metrics", id: "metrics.timer_enabled", status: "pass", message: "home-server-metrics.timer armed" },
  { section: "metrics", id: "metrics.collector_fresh", status: "pass", message: "last collected 12s ago" },
  { section: "metrics", id: "metrics.prometheus_up", status: "pass", message: "answering on net-metrics" },
  { section: "metrics", id: "metrics.targets_down", status: "pass", message: "2 of 2 targets up" },
  { section: "metrics", id: "metrics.alert_rules", status: "pass", message: "17 rules in 5 groups" },
  { section: "metrics", id: "metrics.alertmanager_up", status: "pass", message: "discovered and answering" },
  { section: "metrics", id: "metrics.alert_delivery", status: "pass", message: "no notification errors in 10m" },
  { section: "metrics", id: "metrics.series_count", status: "pass", message: "2896 series of a 4000 budget" },
  { section: "metrics", id: "metrics.tsdb_size", status: "pass", message: "1.9 GB of a 16 GB cap" },
  { section: "verify", id: "verify.timer_enabled", status: "pass", message: "home-server-verify.timer armed" },

  // --- the two fleets -------------------------------------------------------
  //
  // BOTH SECTIONS ARE WARN OR NOTE AND NEVER FAIL, by their own charter:
  // bin/reboot-host.sh refuses to act on a host this battery calls unhealthy,
  // and nothing a CI lane or an agent fleet does wrong is fixed by a reboot. A
  // fixture that put a `fail` here would be exercising a state the real battery
  // cannot produce.
  //
  // THE PASSES ARE NOT PADDING. /ci and /agents render their whole section
  // rather than only what is failing, because two CI facts
  // (github_runner_runtime_split, github_runner_root_label) are strings that
  // mint no series - the check's status is the only route to them. So the
  // passing rows are what those panels are for, and a fixture with only
  // failures would leave that layout unseen.
  { section: "ci", id: "ci.lanes_alive", status: "warn", message: "lane 3 is enabled and not active: exit 5, the credential was refused" },
  { section: "ci", id: "ci.heartbeat", status: "pass", message: "stalest lane heartbeat 12s old" },
  { section: "ci", id: "ci.job_stuck", status: "pass", message: "lane 1 has been running a job for 11m, well inside RuntimeMaxSec" },
  { section: "ci", id: "ci.lane_disk", status: "pass", message: "worst lane 14.3 GB of a 20 GB budget" },
  { section: "ci", id: "ci.lane_headroom", status: "warn", message: "lane 1 refused 2 allocations at MemoryMax; peaks are 2.7 GB and 604 pids" },
  { section: "ci", id: "ci.lane_store", status: "warn", message: "lane 2 healed itself 4h ago after a docker start failure; 6 jobs into the window, 9 resets in total" },
  { section: "ci", id: "ci.runtime_dir", status: "pass", message: "both live lanes agree with the engine: XDG_RUNTIME_DIR is /run and alive lives there" },
  { section: "ci", id: "ci.slice_limits", status: "pass", message: "app-ci.slice: MemoryMax 9984M, MemoryHigh 8448M, TasksMax 1024, AllowedCPUs 4-9" },
  { section: "ci", id: "ci.runner_isolation", status: "pass", message: "3 net-ci-* networks, all isolate=true, no lane on a stack segment" },
  { section: "ci", id: "ci.fleet_root_label", status: "pass", message: "container_file_t" },
  { section: "ci", id: "ci.runner_version", status: "pass", message: "2.331.0 on both lanes, stamp 3d old" },
  { section: "ci", id: "ci.image_fresh", status: "warn", message: "the runner image is 19d old, and the weekly build should have replaced it" },
  { section: "ci", id: "ci.toolcache_seed", status: "warn", message: "lane 2's tool cache is a seed behind the image" },
  { section: "ci", id: "ci.artifact_store", status: "warn", message: "no baselines.json anywhere under state/ - upskald's coverage gate PASSES on absent, so it is enforcing nothing" },

  { section: "agents", id: "agents.slice_limits", status: "pass", message: "app-agents.slice: MemoryMax 4608M, TasksMax 1024, AllowedCPUs 2-3" },
  { section: "agents", id: "agents.worker_lanes", status: "pass", message: "2 tag sets answering: default and verify" },
  { section: "agents", id: "agents.fleet_root_label", status: "pass", message: "container_file_t" },
  { section: "agents", id: "agents.memory_age", status: "pass", message: "the memory root was touched 6h ago" },
  { section: "agents", id: "agents.rounds_open", status: "warn", message: "task 1572's round has been open 11h, past the 6h mark" },
  { section: "agents", id: "agents.tracker_configured", status: "pass", message: "all three Odoo variables are set" },
  { section: "agents", id: "agents.runner_isolation", status: "pass", message: "net-conduct-* all isolate=true, no ephemeral container on a stack segment" },
  { section: "agents", id: "agents.conduct_fresh", status: "pass", message: "conduct last completed a clean cycle 59s ago" },
  { section: "agents", id: "agents.quota_headroom", status: "warn", message: "the API rejected the last call; the window clears in 1h and the fleet is held until it does" },
  { section: "agents", id: "agents.intake", status: "pass", message: "the intake looked 4m ago and picked nothing: three rounds already open, which is REVIEW_CAP" },
  { section: "agents", id: "agents.model_credential", status: "pass", message: "the podman secret is newer than the last .env render" },
  { section: "agents", id: "agents.phase_stuck", status: "pass", message: "a phase has been running 31m, inside RuntimeMaxSec" },
  { section: "agents", id: "agents.runners_leaked", status: "pass", message: "no ephemeral container past the 2h ceiling, across either fleet" },
  { section: "agents", id: "agents.worktree_orphans", status: "warn", message: "4 worktrees on disk against 3 leases - one is an orphan the reconciler has not reaped" },
  { section: "agents", id: "agents.approvals_pending", status: "warn", message: "2 suspended step(s), the oldest for 38h - conduct claims its own within one 60s poll, so at this age it is a human gate nobody saw" },
  { section: "agents", id: "agents.windmill_db_size", status: "pass", message: "1.3 GB of a 2 GB cap" },
  { section: "agents", id: "agents.checkout_drift", status: "pass", message: "/var/agents is clean" },
  { section: "agents", id: "agents.mirror_fresh", status: "pass", message: "the oldest mirror fetched 40m ago" },
  { section: "agents", id: "agents.publish_configured", status: "note", message: "a push key and a workspace token both exist - this cannot prove the token is unexpired" },
];

const SECTION_TITLES: Record<string, string> = {
  net: "Network",
  deploy: "Deployment",
  storage: "Storage",
  gpu_cdi: "GPU / CDI",
  host: "Host prerequisites",
  greenboot: "Boot health",
  reboot: "Reboot window",
  update: "Container updates",
  backup: "Backups",
  checkout: "Checkout",
  containers: "Containers",
  logs: "Logs",
  metrics: "Metrics",
  verify: "Self",
  ci: "Continuous integration",
  agents: "Agents",
};

function iso(offsetSeconds: number): string {
  return new Date(Date.now() - offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function statusDocument(): StatusDocument {
  const counts = { pass: 0, fail: 0, warn: 0, note: 0 };
  for (const c of CHECKS) counts[c.status] += 1;

  const sections = [...new Set(CHECKS.map((c) => c.section))].map((id) => {
    const own = CHECKS.filter((c) => c.section === id);
    return {
      id,
      title: SECTION_TITLES[id] ?? id,
      pass: own.filter((c) => c.status === "pass").length,
      fail: own.filter((c) => c.status === "fail").length,
      warn: own.filter((c) => c.status === "warn").length,
      note: own.filter((c) => c.status === "note").length,
    };
  });

  return {
    schema: 1,
    // Deliberately a few minutes old, not "now": the battery is hourly and a
    // fixture that is always current hides the freshness affordance entirely.
    generated_at: iso(23 * 60),
    host: "avanserv",
    // The route battery did NOT run, which is the normal case - the hourly
    // timer passes --quiet, not --routes. The UI must say "not measured".
    mode: { routes: false },
    summary: {
      status: counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass",
      ...counts,
      total: CHECKS.length,
    },
    sections,
    checks: CHECKS,
    facts: {
      github_runner_runtime_split: "0",
      github_runner_root_label: "container_file_t",
      booted_version: "44.20260810.3.0",
      // `next_version`, NOT `staged_version`. This fixture emitted the old key
      // for as long as it existed, because it was written from the page rather
      // than from bin/verify-host.sh - so the staged chip rendered in every
      // screenshot ever taken and on no real host at all. A FIXTURE DERIVED
      // FROM ITS CONSUMER CANNOT CONTRADICT THE CONSUMER, which is why nothing
      // here could see it. smoke.mjs asserts the keys against the battery now.
      next_version: "44.20260814.3.0",
      next_finalized: null,
      deployments: 2,
      pinned: 0,
      boot_free_mb: 171,
      gpu_count: 1,
      driver_version: "580.173.02",
      red_boot_at: null,
      greenboot_result: "green",
      backup_local_at: iso(6 * 3600),
      backup_offsite_at: iso(6 * 3600),
      backup_offsite_pruned_at: iso(33 * 86400),
      backup_offsite_policy_ok_at: iso(6 * 3600),
      backup_tsdb_snapshot_at: iso(6 * 3600),
      checkout_clean: true,
      containers_running: CONTAINERS.length,
      journal_mb: 1204,
      journal_cap_mb: 16384,
      journal_retention_days: 90,
      journal_suppressed_24h: 0,
      healthcheck_events_15m: 0,
      config_log_mb: 11,
      metrics_last_ok_at: iso(12),
      metrics_collect_age_s: 12,
      metrics_targets_total: 2,
      metrics_targets_down: 0,
      metrics_alert_rules: 17,
      metrics_notify_errors: 0,
      metrics_series: 2896,
      metrics_tsdb_mb: 1946,
      verify_last_run_at: iso(23 * 60),
      verify_last_ok_at: iso(23 * 60),
      verify_fail_count: counts.fail,
      verify_warn_count: counts.warn,
      uptime_s: 41 * 86400 + 6 * 3600,
    },
  };
}

// -----------------------------------------------------------------------------
// Alertmanager
// -----------------------------------------------------------------------------
export function alerts(): AmAlert[] {
  const active = (labels: Record<string, string>, annotations: Record<string, string>, ago: number): AmAlert => ({
    labels,
    annotations,
    startsAt: iso(ago),
    endsAt: "0001-01-01T00:00:00Z",
    updatedAt: iso(30),
    status: { state: "active", silencedBy: [], inhibitedBy: [] },
    fingerprint: Object.values(labels).join("-"),
  });

  return [
    active(
      { alertname: "ContainerUnhealthy", severity: "critical", container: "bazarr" },
      {
        summary: "bazarr is unhealthy",
        description: "home_server_container_health has been 2 for 4 minutes. Last exit was 137.",
      },
      264,
    ),
    active(
      { alertname: "ContainerRestartLoop", severity: "warning", container: "bazarr" },
      { summary: "bazarr restarted 4 times in the last hour", description: "increase(...restarts_total[1h]) > 5" },
      240,
    ),
    active(
      { alertname: "FilesystemFillingUp", severity: "warning", mountpoint: "/var/mnt/media" },
      {
        summary: "/var/mnt/media is 91% full",
        description: "3.2 TB available of 36 TB. At the current rate it fills in about 11 days.",
      },
      52 * 3600,
    ),
    active(
      { alertname: "BackupOffsitePruneStale", severity: "warning", instance: "node-exporter:9100" },
      {
        summary: "the off-site repository has not been pruned for 33 days",
        description: "Retention runs from the workstation: bin/backup-offsite.sh. It grows until it does.",
      },
      3 * 86400,
    ),
    // THE DEAD MAN'S SWITCH, AND IT MUST NOT RENDER AS A PROBLEM. `expr:
    // vector(1)`, so it is always firing and firing is the healthy state. It is
    // here precisely so the fixture exercises the filter that hides it: a
    // fixture without it would let the heartbeat come back as a permanent amber
    // row and say nothing.
    active(
      { alertname: "Watchdog", severity: "heartbeat" },
      {
        summary: "Alerting is alive",
        description: "Sent once a day through the whole chain. If this stops arriving, the chain is broken.",
      },
      19 * 3600,
    ),
  ];
}
