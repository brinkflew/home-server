// =============================================================================
// Every PromQL expression this dashboard issues, in one place
// -----------------------------------------------------------------------------
// Centralised for two reasons, and the second is the one that matters:
//
//   1. A query written inline in a component is invisible to review. The set
//      of things this page asks of Prometheus IS the interface between the
//      dashboard and bin/collect-metrics.py, and an interface belongs in a
//      file somebody can read end to end.
//
//   2. THE DEV FIXTURES ANSWER BY EXACT QUERY STRING. fixtures/server.ts
//      imports this module, so a query that is edited here and not taught to
//      the fixtures fails loudly in `npm run dev` instead of silently
//      rendering an empty panel. A fixture that has quietly stopped covering
//      the real queries is the same shape of problem as a lint that matches
//      nothing.
//
// NAMING: `home_server_*` comes from bin/collect-metrics.py, `node_*` from
// node-exporter or from the collector standing in for a collector that cannot
// run rootless, `container_*` is the cAdvisor-compatible set the collector
// emits from cgroup files. CLAUDE.md's naming contract governs which is which;
// none of it is guessed here.
// =============================================================================

/** rate() needs a window comfortably wider than the 30s scrape. */
const RATE = "5m";

export const SYSTEM = {
  /** Busy fraction of all cores. mode="idle" is the only reliable one. */
  cpuBusy: `1 - avg(rate(node_cpu_seconds_total{mode="idle"}[${RATE}]))`,

  /**
   * The same thing WITHOUT the avg(), so it returns one series per hardware
   * thread - twelve here, because SMT is on deliberately (see CLAUDE.md, "The
   * segmentation"). The aggregate above hides the case this exists to show: a
   * single-threaded job pinning one core reads as 8% busy across twelve, which
   * looks like an idle machine and is not.
   *
   * These series already exist in the TSDB; asking for them per core costs
   * nothing against the cardinality budget, because a query creates no series.
   */
  cpuPerCore: `1 - rate(node_cpu_seconds_total{mode="idle"}[${RATE}])`,

  /**
   * MemAvailable, not MemFree. Free excludes reclaimable page cache, so a
   * healthy Linux host looks permanently out of memory - which is the same
   * misreading CLAUDE.md documents at length for Jellyfin's cgroup.
   */
  memoryUsed: "node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes",
  memoryUsedRatio: "1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes",
  memoryTotal: "node_memory_MemTotal_bytes",

  /**
   * THE FOUR BANDS OF THE MEMORY STACK, AND THEY SUM TO MemTotal BY
   * CONSTRUCTION. That is the only thing that makes pinning the chart's frame
   * to MemTotal honest, and it is why `memoryUsed` above is NOT the bottom
   * band: it is MemAvailable-based, and MemAvailable already contains most of
   * Cached and Buffers, so stacking it under them counts them twice. The stack
   * would then overshoot the ceiling, where projectY clamps each cumulative top
   * on its own - the top band thins away and the overshoot is absorbed silently
   * rather than drawn.
   *
   *   used = MemTotal - MemFree - Buffers - Cached - SReclaimable
   *   used + Buffers + (Cached + SReclaimable) + MemFree == MemTotal, exactly.
   */
  memoryUsedParts:
    "node_memory_MemTotal_bytes - node_memory_MemFree_bytes - node_memory_Buffers_bytes" +
    " - node_memory_Cached_bytes - node_memory_SReclaimable_bytes",
  memoryBuffers: "node_memory_Buffers_bytes",
  memoryCache: "node_memory_Cached_bytes + node_memory_SReclaimable_bytes",
  memoryFree: "node_memory_MemFree_bytes",

  /**
   * SWAP IS NOT RAM AND IS NOT A FIFTH BAND. The stack is pinned to MemTotal;
   * adding four gigabytes of swap to it would draw a machine with twenty. It
   * gets its own bar with its own ceiling instead. Measured on this host on
   * 2026-08-22: 4.0 GB total with 1.2 GB in use, so it is neither absent nor
   * decorative.
   */
  swapTotal: "node_memory_SwapTotal_bytes",
  swapUsed: "node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes",

  load1: "node_load1",

  /** The encoder block, which saturates long before the SM does: CLAUDE.md
   *  records two NVENC sessions pinning it at 100% with the SM at 10%. */
  gpuEncoder: 'home_server_gpu_utilization_ratio{engine="encoder"}',
  gpuSm: 'home_server_gpu_utilization_ratio{engine="sm"}',
  gpuTemp: "home_server_gpu_temperature_celsius",
  gpuPower: "home_server_gpu_power_watts",
  gpuSessions: "home_server_gpu_encoder_sessions",

  /** Physical interfaces only. veth* is already excluded by the collector,
   *  but lo is not and would double every number. */
  netRx: `sum(rate(node_network_receive_bytes_total{device!="lo"}[${RATE}]))`,
  netTx: `sum(rate(node_network_transmit_bytes_total{device!="lo"}[${RATE}]))`,

  /**
   * WHOLE DISKS ONLY. node-exporter's diskstats collector already drops
   * partitions, but NOT device-mapper, and dm-0 is stacked on sda - so a bare
   * sum() counts every byte of the media spindle twice. Measured on this host
   * on 2026-08-22: dm-0 at 782.41187 GB read against sda at 782.41410 GB,
   * which is one workload seen at two layers rather than two workloads.
   */
  diskRead: `sum(rate(node_disk_read_bytes_total{device!~"dm-.*"}[${RATE}]))`,
  diskWritten: `sum(rate(node_disk_written_bytes_total{device!~"dm-.*"}[${RATE}]))`,

  /**
   * CPU pressure: the share of time at least one task was stalled waiting for
   * a runnable CPU. This is the number that was pinned when the host wedged
   * under 470 queued health checks while still answering ICMP - utilisation
   * looked survivable and pressure did not.
   */
  cpuPressure: `rate(node_pressure_cpu_waiting_seconds_total[${RATE}])`,
  ioPressure: `rate(node_pressure_io_stalled_seconds_total[${RATE}])`,

  filesystems: "node_filesystem_size_bytes",
  filesystemAvail: "node_filesystem_avail_bytes",

  disksInfo: "home_server_disk_info",
  diskHealth: "home_server_disk_health_ok",
  diskTemp: "home_server_disk_temperature_celsius",
  diskHours: "home_server_disk_power_on_hours",
  diskWear: "home_server_disk_nvme_wear_ratio",
  diskReallocated: "home_server_disk_reallocated_sectors",
  diskPending: "home_server_disk_pending_sectors",
  diskMediaErrors: "home_server_disk_media_errors_total",

  /** NOT home_server_uptime_seconds, which nothing has ever emitted - it
   *  returned empty for as long as it existed. The page reads uptime from
   *  status.json's facts; this is the one with a time axis. */
  bootTime: "node_boot_time_seconds",
} as const;

export const SERVICES = {
  /**
   * The identity join. podman's own PODMAN_SYSTEMD_UNIT label is what maps
   * torrent-infra to torrent-pod.service with no lookup table, and CLAUDE.md
   * is emphatic that a table maintained in a script is the most driftable
   * thing here. Everything else on the page keys on `container`.
   */
  info: "home_server_container_info",
  running: "home_server_container_running",
  /** 0 healthy, 1 starting, 2 unhealthy. ABSENT for duckdns and unpackerr,
   *  which serve no HTTP and define no health check - absent, not zero. */
  health: "home_server_container_health",
  healthDefined: "home_server_container_healthcheck_defined",
  restarts: "home_server_container_restarts_total",
  startTime: "container_start_time_seconds",

  cpu: `rate(container_cpu_usage_seconds_total[${RATE}])`,
  /** Working set, NOT usage_bytes. The latter counts cold page cache and is
   *  the reason Jellyfin looks like it is at its ceiling when it needs 400 MB. */
  memory: "container_memory_working_set_bytes",
  memoryHigh: "home_server_container_memory_high_bytes",
  memoryLimit: "container_spec_memory_limit_bytes",
  /** Real starvation, as opposed to a cgroup doing ordinary file I/O. */
  memoryRefault: `rate(home_server_container_memory_workingset_refault_file_total[${RATE}])`,
  oomKills: 'home_server_container_memory_events_total{event="oom_kill"}',

  identityUnresolved: "home_server_container_identity_unresolved",

  /** The applications, for the service strip. */
  arrIndexers: "home_server_arr_indexers",
  arrQueue: 'home_server_arr_queue_items{state="total"}',
  arrHealth: "home_server_arr_health_issues",
  indexerUp: "home_server_indexer_up",
  jellyfinSessions: "home_server_jellyfin_sessions_total",
  tdarrQueue: "home_server_tdarr_queue_files_total",
  torrentState: "home_server_torrent_connection_state",
  torrentRate: "home_server_torrent_rate_bytes_per_second",
  vpnInfo: "home_server_vpn_info",
} as const;

export const AVAILABILITY = {
  /**
   * HOURLY, NOT DAILY, AND THE STEP IS WHY. Averaging server-side is still the
   * point - thirty days of raw 30s samples for twenty containers would be about
   * 1.7 million points for a strip of thirty bars - but a 1d average fetched at
   * a 1d step lands its buckets on UTC midnight, which is not where the bars
   * are: src/uptime.ts buckets into LOCAL days, on purpose. Asking for one point
   * per day therefore handed it exactly one sample per bar, aligned to the wrong
   * midnight. An hourly average at a 1h step is 721 points per series - well
   * inside Prometheus' 11,000-point cap, where a 30s step over 30 days is a 400
   * - and gives every local day twenty-four samples to average.
   */
  containerHourly: "avg_over_time(home_server_container_running[1h])",
} as const;

/**
 * The segments, per container.
 *
 * THERE IS NO FLOW MATRIX AND THERE CANNOT BE ONE. `nsenter -n` into a
 * container namespace fails EPERM as core and the host's
 * /proc/net/nf_conntrack is Permission denied, so per-flow accounting is not
 * available on this host and no amount of collector work will make it so.
 * These are per-container-per-SEGMENT endpoint counters; src/paths.ts carries
 * the shape they hang on.
 *
 * DIRECTION IS THE CONTAINER'S. The collector reads /proc/<pid>/net/dev inside
 * that container's own namespace, so `receive` is what the container received.
 * Reading the host-side veth instead would report every one of these inverted
 * while looking exactly the same.
 */
export const NETWORK = {
  rx: `rate(home_server_container_network_receive_bytes_total[${RATE}])`,
  tx: `rate(home_server_container_network_transmit_bytes_total[${RATE}])`,

  /** Written as an explicit 0 by the collector, so it can be alerted on. A
   *  series that appears only when something is wrong cannot be. */
  unmapped: "home_server_container_network_unmapped_interfaces",
  pairs: "home_server_container_network_pairs",
} as const;

/**
 * The CI lanes.
 *
 * THIS PAGE IS THE ONLY ONE THAT CAN SEE THIS FLEET AT ALL, and that is what
 * shapes every query below. A lane container carries io.home-server.ephemeral,
 * so source_containers and source_container_network skip it; it is
 * `podman run --rm`, so no unit fails; and it defines no health check, so no
 * container ever reads unhealthy. docs/ci.md states the consequence plainly: a
 * wedged lane leaves no failed unit and no unhealthy container. The marker file
 * these series come from is the ONLY witness.
 *
 * So absence is the finding here, not the fallback - see the note on inFlight.
 */
export const CI = {
  /** 1 when at least one lane has written its marker. 0 on a host where no
   *  lane is enabled, which every ci check reports as a NOTE. */
  markerPresent: "home_server_ci_marker_present",

  /** Timestamps, not ages: the consumer subtracts from time(), so a stopped
   *  driver shows as staleness rather than freezing at its last value. */
  heartbeat: "home_server_ci_heartbeat_timestamp_seconds",
  lastJob: "home_server_ci_last_job_timestamp_seconds",
  /** ABSENT WHILE A LANE IS IDLE, by design - the driver clears it at teardown.
   *  That is what lets an in-flight job's age be computed without separately
   *  asking whether one is running. */
  jobStarted: "home_server_ci_job_started_timestamp_seconds",

  /**
   * 1 while this lane is running a job.
   *
   * ABSENT WHEN THE LANE HAS NEVER STARTED, which is not 0 and MUST NOT BE
   * DRAWN AS IDLE - the collector's own help text says so in those words.
   * `?? 0` here is the bug: it would report a lane nobody has ever run as a
   * healthy idle one, on a page that is the only place it could be seen.
   */
  inFlight: "home_server_ci_job_in_flight",

  /** A GAUGE that resets at midnight by design. rate() over it is a lie; use
   *  jobsTotal, which is the counter. */
  jobsToday: "home_server_ci_jobs_today",
  jobsTotal: "home_server_ci_jobs_total",
  lastJobSeconds: "home_server_ci_last_job_seconds",

  /** Failed attempts to mint a runner identity since the last success. A
   *  permanent rejection stops the lane instead, which shows as a failed unit. */
  failures: "home_server_ci_consecutive_failures",

  /** A SAWTOOTH HERE IS THE DESIGN WORKING: the driver clears the regenerable
   *  parts of a lane when it passes its budget. */
  laneDisk: "home_server_ci_lane_disk_bytes",

  /**
   * Converted in PromQL rather than in the page, because it is the one metric
   * in the family not already in base units - and a chart mixing megabytes with
   * the slice's bytes is a wrong number under a right axis.
   */
  laneMemPeak: "home_server_ci_lane_memory_peak_megabytes * 1048576",
  lanePidsPeak: "home_server_ci_lane_pids_peak",

  /** THIS, NOT THE PEAK, is the reading that justifies raising a ceiling: the
   *  peak includes page cache, so a lane at its ceiling after a dependency
   *  install is reclaim working rather than pressure. */
  laneMemMaxEvents: "home_server_ci_lane_memory_max_events_total",
  laneOomKills: "home_server_ci_lane_oom_kills_total",

  /** Jobs the nested image store has served since it was last reset, against
   *  GITHUB_RUNNER_STORE_MAX_JOBS. */
  storeJobs: "home_server_ci_store_jobs",
  storeResets: "home_server_ci_store_resets_total",

  /** Counters, so increase() is meaningful where a rate over the daily gauges
   *  would not be. */
  jobsPerHour: "increase(home_server_ci_jobs_total[1h])",
  resetsPerDay: "increase(home_server_ci_store_resets_total[24h])",

  /** The slice. Every gauge below is ABSENT both when the slice is empty and
   *  when a control is unlimited, which is what slicePresent tells apart. */
  slicePresent: "home_server_ci_slice_present",
  sliceMemory: "home_server_ci_slice_memory_bytes",
  sliceMemoryPeak: "home_server_ci_slice_memory_peak_bytes",
  sliceMemoryHigh: "home_server_ci_slice_memory_high_bytes",
  sliceMemoryMax: "home_server_ci_slice_memory_max_bytes",
  slicePids: "home_server_ci_slice_pids",
  slicePidsMax: "home_server_ci_slice_pids_max",
  sliceOom: "home_server_ci_slice_oom_total",

  /**
   * MIND THE PREFIX. Everything above is home_server_ci_*, minted by the
   * collector from the lane markers. Everything below is
   * home_server_github_runner_*, minted by source_status from
   * bin/verify-host.sh's facts - a different writer on a different cadence.
   * bin/lint-repo.sh leg 9 asserts the two families stay disjoint, because a
   * collision rejects the WHOLE scrape rather than producing one wrong number.
   */
  lanesActive: "home_server_github_runner_lanes_active",
  lanesFailed: "home_server_github_runner_lanes_failed",
  imageAgeDays: "home_server_github_runner_image_age_d",
  versionCheckAgeDays: "home_server_github_runner_version_check_age_d",
  toolcacheStale: "home_server_github_runner_toolcache_stale",
  /** ZERO IS THE INTERESTING NUMBER. upskald's coverage gate PASSES on an
   *  absent baseline and fails only on an unavailable one, so an empty store is
   *  a green pipeline enforcing nothing at all. */
  artifactBaselines: "home_server_github_runner_artifact_baselines",
  artifactStateBytes: "home_server_github_runner_artifact_state_bytes",
  artifactRunsBytes: "home_server_github_runner_artifact_runs_bytes",
  sliceUnlimited: "home_server_github_runner_slice_unlimited",
  strays: "home_server_github_runner_strays",
} as const;

/**
 * The agent fleet.
 *
 * EVERY SERIES HERE IS A SCALAR AND NONE OF THEM CAN SAY WHAT IT IS DOING.
 * `runs_today = 3` names no task, no round and no pull request waiting on a
 * person - a title and a job id are the label family the collector refuses to
 * mint. That half of the page comes from fleet.json; this half is the numbers
 * with a time axis.
 *
 * NOTE THE TWO FAMILIES, one letter apart. home_server_agent_* is the collector
 * reading conduct's marker; home_server_agents_* is source_status mirroring
 * bin/verify-host.sh's facts. They are different writers on different cadences,
 * and where both measure the same thing - worktrees - they legitimately
 * disagree. See worktreesLeased.
 */
export const AGENTS = {
  markerPresent: "home_server_agent_marker_present",

  heartbeat: "home_server_agent_heartbeat_timestamp_seconds",
  /** Advances only on a CLEAN cycle, where heartbeat advances on any. */
  lastOk: "home_server_agent_last_ok_timestamp_seconds",

  /** 1 while a phase runner executes. ABSENT is "no phase has ever run", not
   *  idle - the same rule as CI.inFlight and for the same reason. */
  phaseInFlight: "home_server_agent_phase_in_flight",
  phaseStarted: "home_server_agent_phase_started_timestamp_seconds",

  /**
   * 0 allowed, 1 allowed_warning, 2 rejected - graded in
   * home_server_check_status's idiom, and UNKNOWN RANKS WORST.
   *
   * ABSENT until a model phase has run. This is the pacing currency and
   * deliberately not a percentage: docs/observability.md records that the
   * account-wide numbers are unreachable from a headless host at all, so this
   * is the API's own rate-limit status taken from the phase's own model call.
   */
  quotaStatus: "home_server_agent_quota_status",
  quotaResets: "home_server_agent_quota_resets_timestamp_seconds",
  quotaRead: "home_server_agent_quota_read_timestamp_seconds",

  intakeLast: "home_server_agent_intake_last_timestamp_seconds",

  /** Gauges that reset at midnight UTC. See the daily strips below. */
  tokensToday: "home_server_agent_tokens_today",
  tokensWeek: "home_server_agent_tokens_week",
  runsToday: "home_server_agent_runs_today",
  runsFailedToday: "home_server_agent_runs_failed_today",

  /** LEASES IN conduct's DATABASE. worktreesOnDisk below counts DIRECTORIES,
   *  and the two disagreeing is exactly what agents.worktree_orphans grades -
   *  so the page shows both, and showing one would hide the finding. */
  worktreesLeased: "home_server_agent_worktrees",

  /** From source_fleet. Counts are retained; the names in fleet.json are not. */
  roundsOpen: "home_server_agent_rounds_open",
  publicationsPending: "home_server_agent_publications_pending",
  noticesOpen: "home_server_agent_notices_open",

  slicePresent: "home_server_agent_slice_present",
  sliceMemory: "home_server_agent_slice_memory_bytes",
  sliceMemoryPeak: "home_server_agent_slice_memory_peak_bytes",
  sliceMemoryHigh: "home_server_agent_slice_memory_high_bytes",
  sliceMemoryMax: "home_server_agent_slice_memory_max_bytes",
  slicePids: "home_server_agent_slice_pids",
  slicePidsMax: "home_server_agent_slice_pids_max",
  sliceOom: "home_server_agent_slice_oom_total",

  /** The plural family - see the note above this object. */
  worktreesOnDisk: "home_server_agents_worktrees",
  /** COUNTS conduct's OWN SUSPENDED STEPS TOO, and the SQL behind it cannot
   *  separate them: both are `suspend > 0`. An upper bound, and the page says so. */
  approvalsPending: "home_server_agents_approvals_pending",
  /** WATCHES TWO FLEETS: conduct-* and ci-* both carry the ephemeral label. */
  runnersLeaked: "home_server_agents_runners_leaked",
  windmillDbBytes: "home_server_agents_windmill_db_bytes",
  workerLanes: "home_server_agents_worker_lanes",
  mirrorAge: "home_server_agents_mirror_age_seconds",
  checkoutDirty: "home_server_agents_checkout_dirty",
  /** Proves a file and a row EXIST, not that the token is unexpired - the check
   *  is named for what it can prove and the panel must be too. */
  publishConfigured: "home_server_agents_publish_configured",
  conductAge: "home_server_agents_conduct_age_seconds",

  /**
   * THE DAILY STRIPS, AND THEY BUCKET ON UTC.
   *
   * These are gauges that reset at midnight, so the day's peak IS the day's
   * total and max_over_time is the right reducer. The reset is at UTC midnight
   * because the host runs UTC - CLAUDE.md records that the household does not -
   * so a strip bucketed into LOCAL days, which is what src/uptime.ts produces
   * for the container availability bars, would straddle every reset and report
   * the previous day's peak. The page buckets these itself and labels the strip
   * UTC.
   *
   * Fetched at a 1h step: 721 points per series over 30 days, well inside
   * Prometheus' 11,000-point cap, and 24 samples for every bucket.
   */
  runsHourly: "max_over_time(home_server_agent_runs_today[1h])",
  runsFailedHourly: "max_over_time(home_server_agent_runs_failed_today[1h])",
  tokensHourly: "max_over_time(home_server_agent_tokens_today[1h])",
} as const;

/** Flattened, so the fixtures can assert they cover every one of them. */
export const ALL_QUERIES: string[] = [
  ...Object.values(SYSTEM),
  ...Object.values(SERVICES),
  ...Object.values(AVAILABILITY),
  ...Object.values(NETWORK),
  ...Object.values(CI),
  ...Object.values(AGENTS),
];
