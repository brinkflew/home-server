// =============================================================================
// Fixture answers, keyed by the exact query string
// -----------------------------------------------------------------------------
// It answers by exact match against src/queries.ts rather than by parsing
// PromQL, which means an unrecognised query is a loud empty result rather than
// a plausible wrong one. `assertCoverage()` below turns that into a startup
// error instead: if a query is added to the catalogue and not taught here, the
// dev server says so on the first request.
// =============================================================================

import { AGENTS, ALL_QUERIES, AVAILABILITY, CI, NETWORK, SERVICES, SYSTEM } from "../src/queries";
import { CONTAINERS, wave } from "./model";
import { NODES } from "../src/topology";

type At = (t: number) => number;

interface SeriesSpec {
  metric: Record<string, string>;
  at: At;
}

const constant = (v: number): At => () => v;
const swing = (key: string, base: number, amplitude: number): At => (t) => wave(key, t, base, amplitude);

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const MEM_TOTAL = 16 * GB;

const FS = [
  { mountpoint: "/boot", device: "/dev/nvme0n1p3", fstype: "ext4", size: 350 * MB, avail: 171 * MB },
  { mountpoint: "/var", device: "/dev/nvme0n1p4", fstype: "xfs", size: 233 * GB, avail: 168 * GB },
  { mountpoint: "/var/mnt/media", device: "/dev/mapper/media-media", fstype: "xfs", size: 36000 * GB, avail: 3200 * GB },
  // SIZED AND UNMEASURED. node_filesystem_avail_bytes does not come back for
  // this one, so `ratio` is NaN - the case fsTone used to answer "ok" to, and
  // therefore drew as a healthy empty mount. `avail: null` is how the table
  // below skips it, rather than answering 0, which would be a different lie.
  { mountpoint: "/var/lib/containers", device: "/dev/nvme0n1p4", fstype: "xfs", size: 233 * GB, avail: null },
];

const DISKS = [
  { device: "sda", model: "ST8000VN004-2M2101", firmware: "SC60", temp: 38, hours: 41207, realloc: 1, pending: 0 },
  { device: "nvme0", model: "Samsung SSD 980 PRO 250GB", firmware: "5B2QGXA7", temp: 44, hours: 12044, realloc: 0, pending: 0 },
  // ENUMERATED AND UNGRADED, which is the state that had never been on screen.
  // smartctl can name a model without returning a health verdict, and
  // home_server_disk_health_ok is then simply absent for that device - see
  // HEALTH_GRADED below.
  { device: "sdb", model: "WDC WD40EFPX-68C6CN0", firmware: "81.00A81", temp: 36, hours: 8912, realloc: 0, pending: 0 },
];

/** The drives SMART actually returned a verdict for. sdb is deliberately not
 *  one of them: absence is a third state and must draw grey, not red. */
const HEALTH_GRADED = ["sda", "nvme0"];

const INDEXERS = [
  "1337x", "Nyaa", "Nyaa Trusted", "TorrentGalaxy", "YTS", "EZTV", "LimeTorrents",
  "TheRARBG", "Torlock", "Anidex", "AnimeTosho", "SubsPlease", "Rutracker",
];
const DOWN_INDEXERS = ["The Pirate Bay", "1337x.st"];

/**
 * A timestamp a fixed age in the past, READ WHEN THE SAMPLE IS ASKED FOR.
 *
 * `() => now - 12` DEFERS NOTHING. `now` is captured once, the table is cached
 * for the life of the process, and the arrow is already holding a number - so
 * the timestamp is frozen and its AGE grows in real time. Eight rows were
 * spelled that way, and every one of them crossed a threshold the pages grade
 * on: the CI rack went "heartbeat stale" on both lanes after five minutes of
 * `npm run dev`, conduct read stale after nine, intake after fifty-six, and the
 * quota window rolled over after seventy-two and turned amber into "cleared".
 * The `() =>` is exactly what made it look correct.
 *
 * Same family as the dayRamp clamp twenty lines below, and for the same reason:
 * the fixture's clock stops and the page's does not.
 *
 * Ages the UI does not grade on - a 41-day boot time, a container's uptime -
 * keep the captured `now` deliberately: a few minutes of drift on a number
 * printed in days is invisible, and the point is which readings can silently
 * change state, not tidiness.
 */
const ago = (seconds: number) => () => Math.floor(Date.now() / 1000) - seconds;
const ahead = (seconds: number) => () => Math.floor(Date.now() / 1000) + seconds;

function bySeries(): Record<string, SeriesSpec[]> {
  const now = Math.floor(Date.now() / 1000);
  const table: Record<string, SeriesSpec[]> = {};

  // --- host ----------------------------------------------------------------
  table[SYSTEM.cpuBusy] = [{ metric: {}, at: swing("cpu", 0.24, 0.16) }];
  table[SYSTEM.memoryUsed] = [{ metric: {}, at: (t) => wave("memratio", t, 0.61, 0.06) * MEM_TOTAL }];
  table[SYSTEM.memoryTotal] = [{ metric: { __name__: "node_memory_MemTotal_bytes" }, at: constant(MEM_TOTAL) }];
  table[SYSTEM.load1] = [{ metric: { __name__: "node_load1" }, at: swing("load", 2.4, 1.6) }];

  // TWELVE HARDWARE THREADS, and they are deliberately NOT the same wave: one
  // core pinned while the other eleven idle is the exact case the aggregate
  // hides, so core 3 runs hot here and the chart has something to show.
  table[SYSTEM.cpuPerCore] = Array.from({ length: 12 }, (_, i) => ({
    metric: { cpu: String(i), mode: "idle" },
    at: i === 3 ? swing("cpu3", 0.86, 0.1) : swing(`cpu${i}`, 0.18, 0.14),
  }));

  // THE FOUR BANDS ARE DERIVED FROM ONE WAVE AND CLOSED BY SUBTRACTION. Four
  // independent swing()s would not sum to MEM_TOTAL, and the stack would
  // under-fill its pinned frame in dev - a chart that looks broken while
  // nothing is, which is the one fixture failure that trains you to ignore it.
  const memUsed = (t: number) => wave("memratio", t, 0.27, 0.05) * MEM_TOTAL;
  const memBuf = (t: number) => wave("membuf", t, 0.012, 0.003) * MEM_TOTAL;
  // A DELIBERATE HOLE, four hours back: the same discipline as the six missing
  // uptime days. It is what puts the stack's compounding gap rule on screen,
  // where "cache is unknown here" must break every band above it rather than
  // drawing three quarters of a column and calling it a total.
  const memCache = (t: number) =>
    Math.round((now - t) / 1800) === 8 ? Number.NaN : wave("memcache", t, 0.55, 0.08) * MEM_TOTAL;
  const memFree = (t: number) => MEM_TOTAL - memUsed(t) - memBuf(t) - memCache(t);

  table[SYSTEM.memoryUsedParts] = [{ metric: {}, at: memUsed }];
  table[SYSTEM.memoryBuffers] = [{ metric: {}, at: memBuf }];
  table[SYSTEM.memoryCache] = [{ metric: {}, at: memCache }];
  // Inherits the NaN through the arithmetic, which is right: with cache
  // unknown, free is unknown too.
  table[SYSTEM.memoryFree] = [{ metric: {}, at: memFree }];

  table[SYSTEM.swapTotal] = [{ metric: {}, at: constant(4 * GB) }];
  table[SYSTEM.swapUsed] = [{ metric: {}, at: swing("swap", 1.2 * GB, 0.4 * GB) }];

  // TWO CARDS, because the host has two and they are not interchangeable. GPU 0's
  // video engines are dead hardware - every NVENC session on it fails - so both
  // consumers are pinned to gpu=1 and card 0 encodes nothing, for ever. A
  // single-card fixture is what let the page ship reading `[0]` off each of these
  // and reporting the idle card's permanent 0% as the encoder utilisation.
  const gpu0 = { gpu: "0", uuid: "GPU-9f1c0b2e" };
  const gpu1 = { gpu: "1", uuid: "GPU-4b7d15a3" };

  table[SYSTEM.gpuEncoder] = [
    { metric: { ...gpu0, engine: "encoder" }, at: constant(0) },
    { metric: { ...gpu1, engine: "encoder" }, at: swing("enc", 0.86, 0.14) },
  ];
  table[SYSTEM.gpuSm] = [
    { metric: { ...gpu0, engine: "sm" }, at: constant(0) },
    { metric: { ...gpu1, engine: "sm" }, at: swing("sm", 0.12, 0.08) },
  ];
  table[SYSTEM.gpuTemp] = [
    { metric: { __name__: "home_server_gpu_temperature_celsius", ...gpu0 }, at: swing("gputemp0", 34, 3) },
    { metric: { __name__: "home_server_gpu_temperature_celsius", ...gpu1 }, at: swing("gputemp", 62, 6) },
  ];
  table[SYSTEM.gpuPower] = [
    { metric: { __name__: "home_server_gpu_power_watts", ...gpu0 }, at: swing("gpupwr0", 22, 4) },
    { metric: { __name__: "home_server_gpu_power_watts", ...gpu1 }, at: swing("gpupwr", 112, 28) },
  ];
  table[SYSTEM.gpuSessions] = [
    { metric: { __name__: "home_server_gpu_encoder_sessions", ...gpu0 }, at: constant(0) },
    { metric: { __name__: "home_server_gpu_encoder_sessions", ...gpu1 }, at: constant(2) },
  ];

  table[SYSTEM.netRx] = [{ metric: {}, at: swing("rx", 6.2e6, 5.5e6) }];
  table[SYSTEM.netTx] = [{ metric: {}, at: swing("tx", 2.1e6, 1.9e6) }];
  table[SYSTEM.diskRead] = [{ metric: {}, at: swing("dr", 18e6, 16e6) }];
  table[SYSTEM.diskWritten] = [{ metric: {}, at: swing("dw", 9e6, 8e6) }];

  table[SYSTEM.cpuPressure] = [{ metric: {}, at: swing("psicpu", 0.04, 0.035) }];
  table[SYSTEM.ioPressure] = [{ metric: {}, at: swing("psiio", 0.09, 0.08) }];

  table[SYSTEM.filesystems] = FS.map((f) => ({
    metric: { __name__: "node_filesystem_size_bytes", device: f.device, fstype: f.fstype, mountpoint: f.mountpoint },
    at: constant(f.size),
  }));
  table[SYSTEM.filesystemAvail] = FS.filter((f) => f.avail !== null).map((f) => ({
    metric: { __name__: "node_filesystem_avail_bytes", device: f.device, fstype: f.fstype, mountpoint: f.mountpoint },
    at: constant(f.avail),
  }));

  table[SYSTEM.disksInfo] = DISKS.map((d) => ({
    metric: { __name__: "home_server_disk_info", device: d.device, model: d.model, firmware: d.firmware },
    at: constant(1),
  }));
  table[SYSTEM.diskHealth] = DISKS.filter((d) => HEALTH_GRADED.includes(d.device)).map((d) => ({
    metric: { device: d.device },
    at: constant(1),
  }));
  table[SYSTEM.diskTemp] = DISKS.map((d) => ({ metric: { device: d.device }, at: swing(`t${d.device}`, d.temp, 3) }));
  table[SYSTEM.diskHours] = DISKS.map((d) => ({ metric: { device: d.device }, at: constant(d.hours) }));
  table[SYSTEM.diskWear] = [{ metric: { device: "nvme0" }, at: constant(0.04) }];
  table[SYSTEM.diskReallocated] = DISKS.map((d) => ({ metric: { device: d.device }, at: constant(d.realloc) }));
  table[SYSTEM.diskPending] = DISKS.map((d) => ({ metric: { device: d.device }, at: constant(d.pending) }));
  table[SYSTEM.diskMediaErrors] = [{ metric: { device: "nvme0" }, at: constant(0) }];

  // --- containers ----------------------------------------------------------
  table[SERVICES.info] = CONTAINERS.map((c) => ({
    metric: { __name__: "home_server_container_info", container: c.name, unit: c.unit, image: c.image, pod: c.pod },
    at: constant(1),
  }));
  table[SERVICES.running] = CONTAINERS.map((c) => ({
    metric: { container: c.name },
    at: constant(c.running ? 1 : 0),
  }));
  table[SERVICES.health] = CONTAINERS.filter((c) => c.health !== undefined).map((c) => ({
    metric: { container: c.name },
    at: constant(c.health as number),
  }));
  table[SERVICES.healthDefined] = CONTAINERS.map((c) => ({
    metric: { container: c.name },
    at: constant(c.health === undefined ? 0 : 1),
  }));
  table[SERVICES.restarts] = CONTAINERS.map((c) => ({ metric: { container: c.name }, at: constant(c.restarts) }));
  table[SERVICES.startTime] = CONTAINERS.map((c) => ({
    metric: { container: c.name },
    at: constant(now - c.startedAgo),
  }));
  table[SERVICES.cpu] = CONTAINERS.map((c) => ({
    metric: { container: c.name },
    at: swing(`cpu${c.name}`, c.cpu, c.cpu * 0.55),
  }));
  table[SERVICES.memory] = CONTAINERS.map((c) => ({
    metric: { container: c.name },
    at: swing(`mem${c.name}`, c.memory, c.memory * 0.05),
  }));
  table[SERVICES.memoryHigh] = CONTAINERS.map((c) => ({ metric: { container: c.name }, at: constant(c.memoryHigh) }));
  table[SERVICES.memoryLimit] = CONTAINERS.map((c) => ({
    metric: { container: c.name },
    at: constant(Math.round(c.memoryHigh * 1.5)),
  }));
  table[SERVICES.memoryRefault] = CONTAINERS.map((c) => ({
    metric: { container: c.name },
    at: constant(c.name === "bazarr" ? 840 : 0),
  }));
  table[SERVICES.oomKills] = [{ metric: { container: "bazarr", event: "oom_kill" }, at: constant(4) }];
  table[SERVICES.identityUnresolved] = [{ metric: {}, at: constant(0) }];

  // --- applications --------------------------------------------------------
  table[SERVICES.arrIndexers] = [
    { metric: { service: "sonarr" }, at: constant(11) },
    { metric: { service: "radarr" }, at: constant(13) },
    { metric: { service: "prowlarr" }, at: constant(15) },
  ];
  table[SERVICES.arrQueue] = [
    { metric: { service: "sonarr", state: "total" }, at: constant(3) },
    { metric: { service: "radarr", state: "total" }, at: constant(1) },
  ];
  table[SERVICES.arrHealth] = [
    { metric: { service: "sonarr", severity: "warning" }, at: constant(1) },
    { metric: { service: "radarr", severity: "warning" }, at: constant(0) },
    { metric: { service: "prowlarr", severity: "error" }, at: constant(2) },
  ];
  table[SERVICES.indexerUp] = [
    ...INDEXERS.map((indexer) => ({ metric: { indexer }, at: constant(1) })),
    ...DOWN_INDEXERS.map((indexer) => ({ metric: { indexer }, at: constant(0) })),
  ];
  table[SERVICES.jellyfinSessions] = [{ metric: {}, at: constant(2) }];
  table[SERVICES.tdarrQueue] = [{ metric: {}, at: constant(1) }];
  table[SERVICES.torrentState] = [{ metric: {}, at: constant(0) }];
  table[SERVICES.torrentRate] = [
    { metric: { direction: "download" }, at: swing("dl", 4.4e6, 3.8e6) },
    { metric: { direction: "upload" }, at: swing("ul", 1.2e6, 1.1e6) },
  ];
  table[SERVICES.vpnInfo] = [
    {
      metric: { __name__: "home_server_vpn_info", country: "Netherlands", city: "Amsterdam", organization: "Proton AG" },
      at: constant(1),
    },
  ];

  // --- availability --------------------------------------------------------
  // bazarr has had a bad fortnight; everything else is flat. The oldest six
  // days are absent entirely, so the strip shows grey rather than inventing
  // history the store does not have.
  table[AVAILABILITY.containerHourly] = CONTAINERS.map((c) => ({
    metric: { container: c.name },
    at: (t) => {
      const daysAgo = Math.round((now - t) / 86400);
      if (daysAgo > 23) return Number.NaN;
      if (c.name === "bazarr") return daysAgo < 3 ? 0.62 : daysAgo < 9 ? 0.981 : 1;
      if (c.name === "flaresolverr" && daysAgo === 11) return 0.94;
      return 1;
    },
  }));

  // --- the store's own pulse query ----------------------------------------
  table['{__name__=~"up|home_server_collector_last_success_timestamp_seconds"}'] = [
    { metric: { __name__: "up", job: "prometheus", instance: "127.0.0.1:9090" }, at: constant(1) },
    { metric: { __name__: "up", job: "node", instance: "node-exporter:9100" }, at: constant(1) },
    {
      metric: { __name__: "home_server_collector_last_success_timestamp_seconds" },
      at: (t) => t - 12,
    },
  ];


  // --- the segments, per container ----------------------------------------
  // Derived from NODES so a topology change cannot leave the fixtures behind,
  // the same reason model.ts builds CONTAINERS from it. Pod members declare
  // networks: [] and are absent here for the reason the collector dedupes on
  // the namespace inode: the four of them read one set of counters, charged
  // once to the infra container.
  //
  // ASYMMETRIC ON PURPOSE. jellyfin streams out, the torrent pod pulls in,
  // dashboard is nearly nothing. A fixture where rx and tx matched would let a
  // page that had swapped them look perfectly correct.
  const NET_RATE: Record<string, [number, number]> = {
    "jellyfin/net-media": [0.4e6, 24e6],
    "caddy/net-media": [24e6, 0.5e6],
    "torrent-infra/net-download": [0.9e6, 3.1e6],
    "torrent-infra/tunnel": [4.4e6, 1.2e6],
    "caddy/net-dashboard": [2e3, 41e3],
    "dashboard/net-dashboard": [41e3, 2e3],
    "prowlarr/net-solver": [12e3, 1.1e6],
    "flaresolverr/net-solver": [1.1e6, 12e3],
  };
  const netPairs = NODES.flatMap((n) =>
    n.networks.map((network) => ({ container: n.name, network })),
  ).concat([{ container: "torrent-infra", network: "tunnel" }]);

  // bazarr on net-arr is deliberately ABSENT, so the "not measured" grey is on
  // screen in dev - the same discipline as the six missing uptime days.
  const measured = netPairs.filter((p) => !(p.container === "bazarr" && p.network === "net-arr"));

  const rateFor = (c: string, n: string): [number, number] =>
    NET_RATE[`${c}/${n}`] ?? [18e3, 9e3];

  table[NETWORK.rx] = measured.map((p) => ({
    metric: { container: p.container, network: p.network },
    at: swing(`nrx${p.container}${p.network}`, rateFor(p.container, p.network)[0],
              rateFor(p.container, p.network)[0] * 0.5),
  }));
  table[NETWORK.tx] = measured.map((p) => ({
    metric: { container: p.container, network: p.network },
    at: swing(`ntx${p.container}${p.network}`, rateFor(p.container, p.network)[1],
              rateFor(p.container, p.network)[1] * 0.5),
  }));
  table[NETWORK.pairs] = [{ metric: {}, at: constant(measured.length) }];
  table[NETWORK.unmapped] = [{ metric: {}, at: constant(0) }];

  // --- CI lanes -------------------------------------------------------------
  //
  // THREE LANES IN THREE DIFFERENT STATES, and the third is the one that earns
  // its place. Lane 1 is busy, lane 2 is idle and healing, and LANE 3 HAS NEVER
  // STARTED - which in a fixture means it appears in NO map at all, not as a
  // zero. That is the state the whole page is built to render as grey, and a
  // fixture where every lane reports would exercise the layout that needs the
  // least care and hide the rule that needs the most.
  const LANES = ["1", "2"];
  const laneAt = (v: Record<string, number>) =>
    LANES.map((lane) => ({ metric: { lane }, at: constant(v[lane]) }));

  table[CI.markerPresent] = [{ metric: {}, at: constant(1) }];
  table[CI.heartbeat] = LANES.map((lane) => ({ metric: { lane }, at: ago(12) }));
  table[CI.lastJob] = LANES.map((lane) => ({
    metric: { lane },
    at: ago(lane === "1" ? 900 : 5400),
  }));

  // Present for lane 1 only: the driver clears it at teardown, so an idle lane
  // legitimately has no series here.
  table[CI.jobStarted] = [{ metric: { lane: "1" }, at: ago(640) }];
  table[CI.inFlight] = laneAt({ "1": 1, "2": 0 });

  table[CI.jobsToday] = laneAt({ "1": 7, "2": 4 });
  table[CI.jobsTotal] = [
    { metric: { lane: "1" }, at: (t) => 1204 + Math.floor((t - now) / 900) },
    { metric: { lane: "2" }, at: (t) => 988 + Math.floor((t - now) / 1400) },
  ];
  table[CI.lastJobSeconds] = laneAt({ "1": 512, "2": 1764 });

  // Lane 2 is failing to mint, which is the amber state.
  table[CI.failures] = laneAt({ "1": 0, "2": 3 });

  // THE SAWTOOTH IS THE POINT. Lane 2 resets partway through the window, so the
  // chart has a vertical drop in it and the caveat about it has something to
  // point at.
  const RESET_AT = now - 9000;
  table[CI.laneDisk] = [
    { metric: { lane: "1" }, at: (t) => (14200 + ((t / 60) % 900)) * MB },
    { metric: { lane: "2" }, at: (t) => (t < RESET_AT ? 19900 : 3100 + ((t - RESET_AT) / 90)) * MB },
  ];

  table[CI.laneMemPeak] = laneAt({ "1": 2790 * MB, "2": 2410 * MB });
  table[CI.lanePidsPeak] = laneAt({ "1": 604, "2": 511 });
  // Non-zero on lane 1: this, not the peak, is what justifies a ceiling change.
  table[CI.laneMemMaxEvents] = laneAt({ "1": 2, "2": 0 });
  table[CI.laneOomKills] = laneAt({ "1": 0, "2": 0 });

  table[CI.storeJobs] = laneAt({ "1": 39, "2": 6 });
  table[CI.storeResets] = laneAt({ "1": 4, "2": 9 });

  table[CI.jobsPerHour] = [
    { metric: { lane: "1" }, at: swing("cijobs1", 3.4, 2.2) },
    { metric: { lane: "2" }, at: swing("cijobs2", 2.1, 1.8) },
  ];
  table[CI.resetsPerDay] = laneAt({ "1": 1, "2": 3 });

  table[CI.slicePresent] = [{ metric: {}, at: constant(1) }];
  table[CI.sliceMemory] = [{ metric: {}, at: swing("cislice", 5100 * MB, 1900 * MB) }];
  table[CI.sliceMemoryPeak] = [{ metric: {}, at: constant(8990 * MB) }];
  table[CI.sliceMemoryHigh] = [{ metric: {}, at: constant(8448 * MB) }];
  table[CI.sliceMemoryMax] = [{ metric: {}, at: constant(9984 * MB) }];
  table[CI.slicePids] = [{ metric: {}, at: swing("cipids", 240, 120) }];
  table[CI.slicePidsMax] = [{ metric: {}, at: constant(1024) }];
  table[CI.sliceOom] = [{ metric: {}, at: constant(0) }];

  table[CI.lanesActive] = [{ metric: {}, at: constant(2) }];
  table[CI.lanesFailed] = [{ metric: {}, at: constant(1) }];
  table[CI.imageAgeDays] = [{ metric: {}, at: constant(19) }];
  table[CI.versionCheckAgeDays] = [{ metric: {}, at: constant(3) }];
  table[CI.toolcacheStale] = [{ metric: {}, at: constant(1) }];
  // ZERO ON PURPOSE. An empty baseline store is a green pipeline enforcing
  // nothing, and it must be on screen in dev or the panel that shouts about it
  // is never looked at.
  table[CI.artifactBaselines] = [{ metric: {}, at: constant(0) }];
  table[CI.artifactStateBytes] = [{ metric: {}, at: constant(12 * MB) }];
  table[CI.artifactRunsBytes] = [{ metric: {}, at: constant(3400 * MB) }];
  table[CI.sliceUnlimited] = [{ metric: {}, at: constant(0) }];
  // Three net-ci-* networks against two reporting lanes, which is correct: lane
  // 3 has a network and has never written a marker.
  table[CI.networks] = [{ metric: {}, at: constant(3) }];
  table[CI.strays] = [{ metric: {}, at: constant(0) }];

  // --- the agent fleet ------------------------------------------------------
  table[AGENTS.markerPresent] = [{ metric: {}, at: constant(1) }];
  table[AGENTS.heartbeat] = [{ metric: {}, at: ago(41) }];
  table[AGENTS.lastOk] = [{ metric: {}, at: ago(41) }];
  table[AGENTS.phaseInFlight] = [{ metric: {}, at: constant(1) }];
  table[AGENTS.phaseStarted] = [{ metric: {}, at: ago(1870) }];

  // REJECTED, which is the loud state and the one AgentQuotaRejected fires on.
  table[AGENTS.quotaStatus] = [{ metric: {}, at: constant(2) }];
  table[AGENTS.quotaResets] = [{ metric: {}, at: ahead(4300) }];
  table[AGENTS.quotaRead] = [{ metric: {}, at: ago(300) }];
  table[AGENTS.intakeLast] = [{ metric: {}, at: ago(260) }];

  table[AGENTS.tokensWeek] = [{ metric: {}, at: constant(11_900_000) }];
  // tokensToday, runsToday and runsFailedToday are the resetting gauges, and
  // they are given their shape at the foot of this function - the fleet page
  // draws all three over a time axis, so a constant would be three flat lines.

  // THE TWO WORKTREE COUNTS DISAGREE, deliberately: three leases against four
  // directories is an orphan, which is exactly what agents.worktree_orphans
  // grades and what the tile prints both numbers to show.
  table[AGENTS.worktreesLeased] = [{ metric: {}, at: constant(3) }];
  table[AGENTS.worktreesOnDisk] = [{ metric: {}, at: constant(4) }];

  table[AGENTS.roundsOpen] = [{ metric: {}, at: constant(3) }];
  table[AGENTS.publicationsPending] = [{ metric: {}, at: constant(1) }];
  table[AGENTS.noticesOpen] = [{ metric: {}, at: constant(2) }];

  table[AGENTS.slicePresent] = [{ metric: {}, at: constant(1) }];
  table[AGENTS.sliceMemory] = [{ metric: {}, at: swing("agslice", 1180 * MB, 620 * MB) }];
  table[AGENTS.sliceMemoryPeak] = [{ metric: {}, at: constant(2960 * MB) }];
  table[AGENTS.sliceMemoryHigh] = [{ metric: {}, at: constant(3840 * MB) }];
  table[AGENTS.sliceMemoryMax] = [{ metric: {}, at: constant(4608 * MB) }];
  table[AGENTS.slicePids] = [{ metric: {}, at: swing("agpids", 88, 40) }];
  table[AGENTS.slicePidsMax] = [{ metric: {}, at: constant(1024) }];
  table[AGENTS.sliceOom] = [{ metric: {}, at: constant(0) }];

  table[AGENTS.approvalsPending] = [{ metric: {}, at: constant(2) }];
  table[AGENTS.runnersLeaked] = [{ metric: {}, at: constant(0) }];
  table[AGENTS.windmillDbBytes] = [{ metric: {}, at: constant(1290 * MB) }];
  table[AGENTS.workerLanes] = [{ metric: {}, at: constant(2) }];
  table[AGENTS.mirrorAge] = [{ metric: {}, at: constant(2400) }];
  table[AGENTS.checkoutDirty] = [{ metric: {}, at: constant(0) }];
  table[AGENTS.publishConfigured] = [{ metric: {}, at: constant(1) }];
  table[AGENTS.conductAge] = [{ metric: {}, at: constant(41) }];

  // The three resetting gauges, which the fleet page draws as lines over the
  // window picker. Each one climbs through a UTC day and drops back to nothing
  // at midnight, so a 7d window shows seven teeth and a 6h one shows a rise -
  // the sawtooth IS the metric, and nothing on the page reduces it.
  //
  // Four days back is deliberately ABSENT so a hole is on screen at 7d. A hole
  // and a flat zero are the two readings this page must never draw the same.
  const DAY = 86400;

  // A DIFFERENT PEAK EVERY DAY, and that is not decoration. The first version
  // ramped every day to the same ceiling, so a fortnight of them was a wall of
  // identical teeth - which reads as a chart that failed to render rather than
  // as a fleet with quiet days and busy ones, and would hide a real bug behind
  // a plausible-looking shape.
  //
  // COSINE RATHER THAN SINE, so today's factor is 1 rather than 0.35: the
  // headline reads this same series at `now` through an instant query, and a
  // quiet fixture day made "1 phase run today" the shot on every screenshot.
  //
  // Deterministic rather than random, for the reason images.ts gives about
  // poster hues: a reload that reshuffles the data makes a visual review
  // impossible.
  const dayFactor = (daysAgo: number) => 0.35 + 0.65 * Math.abs(Math.cos(daysAgo * 1.7));

  const dayRamp = (peak: number, gapDaysAgo: number): At => (t) => {
    // CLAMPED AT ZERO, and this is the same clamp src/uptime.ts documents for
    // the same reason. `now` is frozen when this table is built and cached,
    // while the page keeps asking for a range ending LATER than that - so every
    // sample past it read daysAgo = -1, took a different day's factor and drew
    // the counter falling off a cliff at the right-hand edge of every window.
    //
    // Invisible until 2026-09-07, because the only consumer was a fourteen-bar
    // strip reduced with max: a low tail inside today's bucket lost to the
    // day's peak and the bar was right anyway. Drawn as a line it is a fleet
    // whose run counter dropped from 7 to 3 for no reason.
    const daysAgo = Math.max(0, Math.floor((now - t) / DAY));
    if (daysAgo === gapDaysAgo) return Number.NaN;
    const intoDay = ((t % DAY) + DAY) % DAY;
    return Math.round(peak * dayFactor(daysAgo) * (0.2 + 0.8 * (intoDay / DAY)));
  };

  // ONE GAP DAY ACROSS ALL THREE. Two lanes disagreeing about which day the
  // store has no sample for would read as a data problem rather than as one.
  // And failed <= runs at every instant by construction, because both ramps
  // share the day factor and the fraction of the day.
  table[AGENTS.runsToday] = [{ metric: {}, at: dayRamp(9, 4) }];
  table[AGENTS.runsFailedToday] = [{ metric: {}, at: dayRamp(2, 4) }];
  table[AGENTS.tokensToday] = [{ metric: {}, at: dayRamp(2_600_000, 4) }];

  return table;
}

let cache: Record<string, SeriesSpec[]> | null = null;

function table(): Record<string, SeriesSpec[]> {
  if (!cache) cache = bySeries();
  return cache;
}

/** Names every catalogued query the fixtures do not answer. */
export function uncovered(): string[] {
  const known = table();
  // ALL_QUERIES, not a second hand-written list of the groups. This function
  // re-enumerated SYSTEM/SERVICES/AVAILABILITY by hand, so a NEW group in
  // queries.ts was covered by nothing and said nothing about it - a coverage
  // check that silently stops covering things is the exact shape of the
  // problem it exists to catch.
  return ALL_QUERIES.filter((q) => !(q in known));
}

function format(v: number): string {
  return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : "NaN";
}

export function instant(query: string, at: number): unknown {
  const specs = table()[query] ?? [];
  return {
    status: "success",
    data: {
      resultType: "vector",
      result: specs
        .map((s) => ({ metric: s.metric, value: [at, format(s.at(at))] }))
        .filter((s) => s.value[1] !== "NaN"),
    },
  };
}

export function range(query: string, start: number, end: number, step: number): unknown {
  const specs = table()[query] ?? [];
  const result = specs.map((s) => {
    const values: [number, string][] = [];
    for (let t = start; t <= end; t += step) {
      const v = s.at(t);
      // A hole in the fixture is an ABSENT sample, exactly as Prometheus
      // returns it - not a NaN string. That is what exercises the gap
      // handling in charts.ts rather than papering over it.
      if (Number.isFinite(v)) values.push([t, format(v)]);
    }
    return { metric: s.metric, values };
  });

  return { status: "success", data: { resultType: "matrix", result: result.filter((r) => r.values.length) } };
}
