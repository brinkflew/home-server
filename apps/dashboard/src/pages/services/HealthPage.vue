<script setup lang="ts">
/**
 * /services/health: is anything wrong with the stack, and what do I type?
 *
 * THE PAGE COULD NOT SHOW A SERVICE THAT WAS DOWN, which is what the redesign
 * before this split was for. Every row was built from
 * home_server_container_info, the collector builds that from `podman ps`, and
 * `podman ps` lists RUNNING containers - so a service that stopped did not go
 * red here, it VANISHED, and the rack was at its emptiest exactly when it
 * mattered most. src/services.ts carries the argument and the fix: the rack is
 * enumerated from home_server_unit_state, which source_units reads from the
 * quadlet generator directory for this very reason, and a container is joined
 * onto a unit rather than the other way round.
 *
 * ONE DERIVATION, TWO VIEWS - AND THEY ARE NOW TWO PAGES. "Needs attention" is
 * a FILTER over the same array /services/list draws, never a second reading of
 * the same series, which is how the System page came to draw one finding two
 * ways and disagree with itself about what `note` meant. Splitting the two
 * apart is the pressure that would produce that second reading, so the
 * derivation lives in composables/useServiceRack.ts and both views call it.
 *
 * IT ASKS FOR NO RANGE. `activity: false` drops the 24-bar CPU strip, which is
 * the only range query on this section and is drawn only by the rack - so this
 * view is sixteen instants, and does not depend on the time window at all.
 * That is why the WindowPicker teleports from /services/list and not from here.
 */
import { computed } from "vue";

import Band from "@/components/Band.vue";
import ChipLink from "@/components/ChipLink.vue";
import FindingsPanel from "@/components/FindingsPanel.vue";
import PanelBox from "@/components/PanelBox.vue";
import StatusDot from "@/components/StatusDot.vue";

import { useMetricsStale } from "@/composables/useStaleness";
import { useServiceRack } from "@/composables/useServiceRack";
import { appHome } from "@/links";
import * as svc from "@/services";
import type { Tone } from "@/types";

const metricsStale = useMetricsStale();
const { rows, unresolved } = useServiceRack({ activity: false });

const attention = computed(() => svc.needsAttention(rows.value));
const tally = computed(() => svc.serviceTally(rows.value));
const lead = computed(() => svc.servicesLead(rows.value));
const conds = computed(() => svc.conditionRows(rows.value));

/** A tone on a value, without a fourth colour: fail and warn speak, ok is the
 *  ordinary body colour and off is the dim one. The System views' rule. */
function toneClass(tone: Tone): Record<string, boolean> {
  return { bad: tone === "fail", warnish: tone === "warn", dull: tone === "off" };
}

/** ok DRAWS NO RAIL. A teal edge down every healthy row is a wall of colour
 *  that makes the two rows with a rail harder to find, not easier. */
function rail(tone: Tone): string {
  return tone === "ok" ? "transparent" : `var(--${tone})`;
}

/** The application's own page, where it has one. */
function open(row: svc.ServiceRow): string | null {
  return row.app ? appHome(row.app) : null;
}
</script>

<template>
  <!-- THE HEADLINE IS THE COUNT THAT NEEDS SOMETHING DOING. "26 of 28 healthy"
       reads as a pass mark; the two are the reason to be here. -->
  <Band label="Right now">
    <template #aside>
      <span class="mono">
        <span class="count">{{ tally.total }}</span> services
      </span>
    </template>

    <PanelBox :stale="metricsStale">
      <div class="lead">
        <StatusDot :tone="lead.tone" :live="lead.live" :size="9" />
        <span class="reading mono">{{ lead.text }}</span>
      </div>
      <p class="lead-sub mono">{{ lead.sub }}</p>

      <div class="conds">
        <div v-for="c in conds" :key="c.id" class="cond">
          <span class="label">{{ c.label }}</span>
          <span class="mono cvalue" :class="toneClass(c.tone)">{{ c.value }}</span>
          <span class="mono sub">{{ c.sub }}</span>
        </div>
      </div>
    </PanelBox>
  </Band>

  <!-- SECOND, AND IT IS THE POINT OF THE PAGE. Everything below is evidence;
       this is the list, the sentence and the command. -->
  <Band label="Needs attention">
    <template #aside>
      <span class="mono">
        <span class="count">{{ attention.length }}</span> of
        <span class="count">{{ tally.total }}</span>
      </span>
    </template>

    <PanelBox :stale="metricsStale">
      <table v-if="attention.length" class="tbl">
        <thead>
          <tr>
            <th class="c-rail" />
            <th>Service</th>
            <!-- EVERY REMEDY IS A READ. This dashboard cannot restart anything -
                 the podman socket is SELinux-denied from container_t - and that
                 is not the only reason: a command that changes the host is a
                 decision for the person, not a string a panel prints. -->
            <th class="c-remedy p2">Look here first</th>
            <th class="c-open" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in attention" :key="row.unit || row.name" :style="{ '--rail': rail(row.tone) }">
            <td class="rail">
              <StatusDot :tone="row.tone" :live="row.tone === 'fail'" :size="6" />
            </td>
            <td>
              <div class="sname">{{ row.name }}</div>
              <div class="sstate mono" :class="toneClass(row.tone)">{{ row.state }}</div>
              <!-- NOT CLAMPED. This sentence is the reason the row is here. -->
              <p class="issue">{{ row.issue }}</p>
              <code v-if="row.remedy" class="fold2 cmd mono">{{ row.remedy }}</code>
            </td>
            <td class="c-remedy p2">
              <code v-if="row.remedy" class="cmd mono">{{ row.remedy }}</code>
              <span v-else class="mono dull">nothing to run - wait for it</span>
            </td>
            <td class="c-open">
              <ChipLink
                v-if="row.app"
                label="open"
                :href="open(row)"
                :title="`open ${row.name}'s own interface`"
              />
            </td>
          </tr>
        </tbody>
      </table>

      <!-- A CALM EMPTY STATE THAT STILL COUNTS THE GREY ONES. "All good" would
           fold "nobody is checking three of these" into the same sentence as
           "these passed", which is the one fold this application never makes. -->
      <p v-else class="empty mono">
        nothing needs attention - {{ tally.ok }} healthy, {{ tally.off }} with no health check,
        nothing failing or restarting
      </p>

      <p v-if="unresolved > 0" class="note unresolved mono">
        {{ unresolved }} container(s) could not be mapped to a systemd unit, so
        they are absent from every table here. That is what
        home_server_container_identity_unresolved counts.
      </p>
    </PanelBox>
  </Band>

  <!-- THE BATTERY'S OWN PROSE, over the two sections this page is about.
       `containers` grades the units and the probes; `update` grades the nightly
       image roll that recreates every container on the host, which is the answer
       to "why did this restart last night" and belongs beside the restart. -->
  <FindingsPanel label="What the hourly battery found" :section="['containers', 'update']" />
</template>

<style scoped>
/* The unresolved footnote's base tier. The toolbar note that used to share this
   class went up to ServicesLayout with the Teleport. */
.note {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
}

/* --- the header ----------------------------------------------------------- */

.lead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

/* --t-mono-xl, "the one headline reading". One per view. */
.reading {
  font: var(--t-mono-xl);
  color: var(--fg);
}

.lead-sub {
  margin-top: 7px;
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

/* Three equal columns above 900, packed left below it, and a label-left readout
   below 640 - the recipe /system/health and the round board already use. */
.conds {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--gap) var(--gap-lg);
  margin-top: 15px;
  padding-top: 14px;
  border-top: 1px solid var(--border-divider);
}

.cond {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.label {
  font: var(--t-label);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--fg-5);
}

.cvalue {
  font: var(--t-mono-md);
  color: var(--fg-2);
}

.sub {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

/* --- the table ------------------------------------------------------------ */

.c-rail {
  width: 30px;
}

/* The remedy is a command line and must not wrap mid-flag. The longest one here
   is `systemctl --user show windmill-worker-verify.service -p MemoryHigh -p
   MemoryMax`, which does not fit any column - so it wraps on whitespace and the
   column is sized for the common `journalctl` case. */
.c-remedy {
  width: 380px;
}

.c-open {
  width: 84px;
}

.sname {
  font: var(--t-ui-md);
  color: var(--fg);
}

.sstate {
  margin-top: 2px;
  font: var(--t-mono-xs);
}

/* NOT CLAMPED. The sentence is the reason the row is there, and FindingsPanel's
   two-line clamp is for a column 232px wide beside an id; this one has the
   width of the table. */
.issue {
  margin-top: 6px;
  font: var(--t-ui-sm);
  color: var(--fg-3);
}

/* A command, not a label: it is meant to be selected and pasted into an ssh
   session, so it takes a surface of its own and wraps on whitespace rather than
   truncating - half a command line is worse than none. */
.cmd {
  display: inline-block;
  padding: 5px 8px;
  border-radius: var(--r-xs);
  background: var(--fill);
  color: var(--fg-2);
  font: var(--t-mono-xs);
  overflow-wrap: anywhere;
}

/* TWO CLASSES, TWO SPECIFICITIES, AND base.css LOSES WITHOUT THIS. Its
   `.fold2 { display: none }` and this file's `.cmd { display: inline-block }`
   are both one class, so the later one - the scoped rule - wins and the folded
   copy rendered at every width. The command was on screen twice, side by side,
   in the panel whose whole job is to say what to type. */
.cmd.fold2 {
  display: none;
}

@media (max-width: 640px) {
  .cmd.fold2 {
    display: inline-block;
    margin-top: 7px;
  }
}

.empty {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
  padding: 6px 4px;
}

.unresolved {
  margin-top: 12px;
  padding-top: 11px;
  border-top: 1px solid var(--border-divider);
  color: var(--warn);
}

/* --- the tone classes, LAST ---------------------------------------------
   AND LAST IS NOT TIDINESS. Every one of these is a single class, and so is
   `.cvalue` - equal specificity, so the later rule in the file wins. Written
   above the tables on the page this came from, `.num` beat `.warnish` and a
   unit with nine restarts printed its nine in the ordinary body colour, beside
   a red rail. The rail was right and the value was not, on the one view whose
   job is to make a fault easy to find.

   `.dull`, NOT `.dim`: base.css owns a global `.dim` that means STALE -
   "opacity 0.42, and desaturating as well as dimming is load-bearing" - so a
   scoped `.dim { color: var(--fg-5) }` does not replace it, it ADDS to it. An
   unmeasured thing must not borrow the appearance of an unrefreshed one, in
   either direction. */
.bad {
  color: var(--fail-text);
}

.warnish {
  color: var(--warn);
}

.dull {
  color: var(--fg-5);
}

/* --- the tablet ----------------------------------------------------------- */

@media (max-width: 900px) {
  .conds {
    display: flex;
    flex-wrap: wrap;
  }
}

/* --- the phone ------------------------------------------------------------ */

@media (max-width: 640px) {
  /* THE RAIL NEEDS ITS WIDTH BACK ON THE CELL ONCE THE HEADER IS GONE. Under
     table-layout: fixed the column widths come from the first row, and
     display: none on the thead makes that the first BODY row - which carries no
     widths, so the surviving columns split evenly. */
  .tbl td.rail {
    width: 30px;
  }

  .tbl thead {
    display: none;
  }

  /* The open chip is the only fixed column left once the remedy has folded into
     the row, and it needs its width back by hand for the same reason. */
  .tbl td.c-open {
    width: 74px;
  }

  /* The label moves left of its value: three rows, one condition each, labels in
     a column of their own. The 92px fallback is the width of RESTARTS at
     --t-label, measured, and is what a browser without subgrid uses. */
  .conds {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: var(--gap);
    row-gap: 14px;
  }

  .cond {
    grid-template-columns: 92px 1fr;
    grid-template-columns: subgrid;
    display: grid;
    grid-column: 1 / -1;
    align-items: center;
    column-gap: var(--gap);
    row-gap: 4px;
  }

  .cond .label {
    grid-area: 1 / 1;
  }

  .cond .cvalue {
    grid-area: 1 / 2;
  }

  .cond .sub {
    grid-area: 2 / 2;
  }
}
</style>
