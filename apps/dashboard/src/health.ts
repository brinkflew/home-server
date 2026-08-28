// =============================================================================
// home_server_container_health, and the one value that is not a number
// -----------------------------------------------------------------------------
// Lifted out of ServicesPage.vue, unchanged, because the Home page's service
// strip needs the identical mapping and this is the subtlest rule in the whole
// application to get wrong quietly.
//
// THE METRIC IS ABSENT, NOT ZERO, for a container that defines no health check.
// duckdns and unpackerr serve no HTTP and have none, so `health.get(name)`
// returns undefined - and undefined must render GREY, never green. Zero means
// "checked and healthy"; absent means "nobody is checking". A page that treats
// them alike reports two containers as verified healthy on the strength of no
// evidence at all, which is exactly the shape of failure this repository is
// written around, and it is invisible because grey and green both look fine.
//
// It is also what lets one alert rule cover every container without naming any:
// `home_server_container_health == 2` matches nothing for a container that
// emits no series.
// =============================================================================

import type { CheckStatus, Tone } from "@/types";

export interface ContainerHealth {
  tone: Tone;
  /** Prose for the row, and deliberately not parsed anywhere. */
  state: string;
}

/**
 * @param running whether the container is up at all
 * @param health  0 healthy, 1 starting, 2 unhealthy, undefined = no check defined
 */
export function containerTone(running: boolean, health: number | undefined): ContainerHealth {
  if (!running) return { tone: "fail", state: "stopped" };
  if (health === undefined) return { tone: "off", state: "running, unchecked" };
  if (health === 0) return { tone: "ok", state: "healthy" };
  if (health === 1) return { tone: "warn", state: "starting" };
  return { tone: "fail", state: "unhealthy" };
}

/**
 * A check's status as a tone. ONE FUNCTION, because two call sites guessing is
 * how the System page came to draw a `note` amber in the strip at the top and
 * grey in the list below it - the strip bound `:class="c.status"` and only
 * `.fail` had an override, so `note` fell through to the warn treatment and
 * nothing said so.
 *
 * `note` IS GREY, not amber. bin/verify-host.sh emits it for a check that could
 * not run, and the whole argument above containerTone applies unchanged: an
 * unmeasured thing must not borrow the colour of a measured one, in either
 * direction.
 */
export function checkTone(status: CheckStatus): Tone {
  switch (status) {
    case "fail":
      return "fail";
    case "warn":
      return "warn";
    case "pass":
      return "ok";
    default:
      return "off";
  }
}

/**
 * A CI lane's state.
 *
 * GREY IS CHECKED FIRST AND IT OUTRANKS EVERYTHING, which is not the order a
 * reader expects and is the whole reason this is a function rather than a
 * ternary at a call site. A lane is invisible to every other collector source -
 * it carries io.home-server.ephemeral so source_containers and
 * source_container_network skip it, it is `podman run --rm` so no unit fails,
 * and it defines no health check so no container reads unhealthy. docs/ci.md:
 * "a wedged lane leaves no failed unit and no unhealthy container". The marker
 * is the only witness, so a lane with no marker is not an idle lane, it is a
 * lane nothing is reporting on - and the collector's own help text for
 * job_in_flight says in those words that ABSENT "must not be drawn as idle".
 *
 * @param heartbeatAge seconds since the lane's heartbeat, NaN when absent
 * @param inFlight     1, 0, or undefined when the series is absent
 * @param failures     consecutive mint failures, NaN when absent
 */
export function laneTone(
  heartbeatAge: number,
  inFlight: number | undefined,
  failures: number,
): ContainerHealth {
  if (!Number.isFinite(heartbeatAge) || inFlight === undefined) {
    return { tone: "off", state: "never started" };
  }
  // The threshold ci.heartbeat grades on, against a 30s driver poll.
  if (heartbeatAge > 300) return { tone: "fail", state: "heartbeat stale" };
  if (Number.isFinite(failures) && failures > 0) return { tone: "warn", state: "mint failing" };
  if (inFlight === 1) return { tone: "ok", state: "running a job" };
  return { tone: "ok", state: "idle" };
}

/**
 * The agent fleet's quota, which is a STATUS and deliberately not a number.
 *
 * UNKNOWN RANKS WORST, and that is the collector's grading rather than a choice
 * made here: home_server_agent_quota_status is 0 allowed, 1 allowed_warning,
 * 2 rejected, and anything unrecognised is 2. The series is ABSENT until a
 * model phase has run at all, which is grey - a fleet nobody has asked is not a
 * fleet with headroom.
 */
export function quotaTone(status: number | undefined): ContainerHealth {
  if (status === undefined || !Number.isFinite(status)) {
    return { tone: "off", state: "not read yet" };
  }
  if (status <= 0) return { tone: "ok", state: "allowed" };
  if (status === 1) return { tone: "warn", state: "warning" };
  return { tone: "fail", state: "rejected" };
}

/**
 * Whether a marker-backed thing is running, stale, or has never run.
 *
 * The shape conduct's heartbeat and a phase in flight share: a timestamp that
 * may be absent, and a threshold. Absent is grey for the reason laneTone
 * documents at length - "conduct has never run here" is the state every
 * conduct-dependent check reported for months, and it is not a fault.
 */
export function heartbeatTone(age: number, threshold: number): ContainerHealth {
  if (!Number.isFinite(age)) return { tone: "off", state: "never run" };
  if (age > threshold) return { tone: "warn", state: "stale" };
  return { tone: "ok", state: "fresh" };
}
