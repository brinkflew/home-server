<script setup lang="ts">
/**
 * Library: what the pipeline still owes, and every file it knows about.
 *
 * THE LAST HAND-ROLLED RACK. base.css names four - Services, CI, Library and
 * the System timeline - and says none of them could shed a column without being
 * rebuilt as a `.tbl`, which was the follow-up each of them carried. Three had
 * had it; this one still panned behind a 900px min-width inside its own 520px
 * scroller, which is a phone reading a table sideways through a letterbox.
 *
 * It is also the page that used NONE of the four primitives: no Band, no
 * PanelBox, no `.tbl`, no headline, and not one media query in 285 lines of
 * scoped CSS.
 *
 * THE MOST IMPORTANT THING ON THIS PAGE IS STILL ITS EMPTY STATE, and that is
 * not a remark about polish. An almost-empty table is the NORMAL, HEALTHY
 * rendering: `library/queued/` holding no video files means
 * bin/promote-transcoded.py is doing its job, and Tdarr's file table draining to
 * zero is documented design rather than a fault. So there are three empty states
 * and they say three different things - "nothing is in flight", "you filtered
 * everything out" and "nobody has asked in eight minutes" are different facts,
 * and collapsing them is the same failure as rendering `mode.routes: false` as
 * "every route passed".
 *
 * SORTED ATTENTION-FIRST. See sortRows in @/media for the argument.
 *
 * Every decision below is in @/media. A computed in this file is code
 * fixtures/smoke.mjs cannot call, and this page had ten of them.
 */
import { computed, onUnmounted, ref, watch } from "vue";

import Band from "@/components/Band.vue";
import ChipLink from "@/components/ChipLink.vue";
import FindingsPanel from "@/components/FindingsPanel.vue";
import MetricChart from "@/components/MetricChart.vue";
import PanelBox from "@/components/PanelBox.vue";
import PosterTile from "@/components/PosterTile.vue";
import ProgressBar from "@/components/ProgressBar.vue";
import StatePill from "@/components/StatePill.vue";
import StatusDot from "@/components/StatusDot.vue";
import WindowPicker from "@/components/WindowPicker.vue";

import { useCrosshair } from "@/composables/useCrosshair";
import { usePoll } from "@/composables/usePoll";
import { useMetricsStale } from "@/composables/useStaleness";
import { useTimeWindow } from "@/composables/useTimeWindow";
import { instantBy, range } from "@/api/prometheus";
import { toPoints, type ChartSeries } from "@/charts";
import { MEDIA, SYSTEM } from "@/queries";
import { useHostStore } from "@/stores/host";
import { RENDER_CAP, useMediaStore } from "@/stores/media";
import {
  STATE_LABEL,
  STATE_TONE,
  VIEW_HINT,
  actionFor,
  chipCounts,
  docState,
  emptiness,
  filterRows,
  libraryConditions,
  libraryLead,
  mediaActivity,
  mediaDisk,
  stateClass,
  type View,
} from "@/media";
import { tdarr } from "@/links";
import * as fmt from "@/format";
import type { Tone } from "@/types";

const media = useMediaStore();
const host = useHostStore();
const metricsStale = useMetricsStale();
const cross = useCrosshair();
const { window: win } = useTimeWindow();

// ---------------------------------------------------------------------------
// The filter, which is the only state this page owns
// ---------------------------------------------------------------------------
const view = ref<View>("all");
const filter = ref("");

const chips = computed(() => chipCounts(media.rows));
const visible = computed(() => filterRows(media.rows, view.value, filter.value));
const shown = computed(() => visible.value.slice(0, RENDER_CAP));
const empty = computed(() => emptiness(visible.value.length, media.rows.length, media.activityStale));

// ---------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------
const disk = usePoll(async (signal) => {
  const [size, avail] = await Promise.all([
    instantBy(SYSTEM.filesystems, "mountpoint", signal),
    instantBy(SYSTEM.filesystemAvail, "mountpoint", signal),
  ]);
  return mediaDisk(size, avail);
}, 60_000);

const activity = computed(() =>
  mediaActivity({
    sessions: media.sessions,
    rows: media.rows,
    requestCounts: media.libraryDoc?.request_counts,
    playback: docState(!!media.activityDoc, media.activityStale),
    library: docState(!!media.libraryDoc, media.libraryStale),
  }),
);

const conds = computed(() => libraryConditions(activity.value, media.totals, disk.data.value));
const lead = computed(() => libraryLead(activity.value, conds.value));

function toneClass(tone: Tone): Record<string, boolean> {
  return { bad: tone === "fail", warnish: tone === "warn", dim: tone === "off" };
}

function rail(tone: Tone): string {
  return tone === "ok" || tone === "off" ? "transparent" : `var(--${tone})`;
}

// ---------------------------------------------------------------------------
// The history, which nothing had ever asked Prometheus for. See MEDIA in
// queries.ts: seven families collected since the collector existed, kept for
// four hundred days, and read by no page in this application.
// ---------------------------------------------------------------------------
function byLabel(rows: { metric: Record<string, string>; values: [number, string][] }[], key: string): ChartSeries[] {
  return rows
    .slice()
    .sort((a, b) => (a.metric[key] ?? "").localeCompare(b.metric[key] ?? ""))
    .map((s) => ({ points: toPoints(s.values), label: s.metric[key] ?? "?" }));
}

const charts = usePoll(async (signal) => {
  const options = { window: win.value.seconds, step: win.value.step, signal };
  const [bytes, subs, queued, inFlight, movies, episodes] = await Promise.all([
    range(MEDIA.libraryBytes, options),
    range(MEDIA.subtitlesWanted, options),
    range(MEDIA.pipelineQueued, options),
    range(MEDIA.pipelineItems, options),
    range(MEDIA.moviesMissing, options),
    range(MEDIA.episodesMissing, options),
  ]);

  return {
    bytes: byLabel(bytes, "library"),
    subtitles: byLabel(subs, "kind"),
    // The queue and what is in it, on one axis: a queued count with nothing
    // seeding beside it cannot say whether the pipeline is draining or stopped.
    pipeline: [
      ...(queued[0] ? [{ points: toPoints(queued[0].values), label: "queued" }] : []),
      ...byLabel(inFlight, "state"),
    ],
    missing: [
      ...(movies[0] ? [{ points: toPoints(movies[0].values), label: "films" }] : []),
      ...(episodes[0] ? [{ points: toPoints(episodes[0].values), label: "episodes" }] : []),
    ],
  };
}, 30_000);

// The window is read inside the loader, so a change to it would otherwise not
// show until the next 30s tick - which reads as a dead button.
watch(win, () => {
  void charts.refresh();
});

const c = computed(() => charts.data.value);
const from = computed(() => host.now - win.value.seconds);

/** Derived from the picker, which is the only place the span can be stated
 *  without being able to drift. */
const windowLabel = computed(() => `last ${win.value.label}`);

/** pointerleave is the only other thing that clears the shared cursor, and a
 *  keyboard user leaving by the nav never fires it - so the readouts would
 *  strand on an instant nobody is pointing at. */
onUnmounted(() => cross.clear());
</script>

<template>
  <div class="page">
    <Teleport defer to="#toolbar">
      <input v-model="filter" class="mono search" type="search" placeholder="filter by title or path" />
      <ChipLink label="scan" :href="tdarr()" title="open Tdarr, which owns the transcode queue" />
      <WindowPicker />
    </Teleport>

    <!-- THE HEADLINE LEADS, and it replaced six equal stat blocks about six
         unrelated things with no primary among them - the exact complaint that
         produced every other header in this application. Three of the six are
         the sub-line now, two are conditions and one is the band's aside. -->
    <Band label="Right now">
      <template #aside>
        <span class="mono">
          <span class="count">{{ media.recentTotal }}</span> added in the last 7 days
        </span>
      </template>

      <PanelBox>
        <div class="lead">
          <StatusDot :tone="lead.tone" :live="lead.live" :size="9" />
          <span class="reading mono">{{ lead.text }}</span>
        </div>

        <!-- NO PROGRESS BAR. "In flight" has no denominator - the pipeline is
             not working towards a total - and a bare track is what this store
             reserves for "in progress, ratio unknown". -->
        <p class="lead-sub mono">{{ lead.sub }}</p>

        <div class="conds">
          <div v-for="cd in conds" :key="cd.id" class="cond">
            <span class="label">{{ cd.label }}</span>
            <span class="mono cvalue" :class="toneClass(cd.tone)">{{ cd.value }}</span>
            <span class="mono sub">{{ cd.sub }}</span>
          </div>
        </div>
      </PanelBox>
    </Band>

    <!-- `Files`, NOT `Library`: a band may not repeat its own tab. -->
    <Band label="Files">
      <template #aside>
        <span class="mono">
          showing {{ shown.length }} of {{ media.rows.length }}, sorted by attention then activity
        </span>
      </template>

      <PanelBox :stale="media.activityStale">
        <!-- THE CONTROL, WHICH READS SECOND. The chips are the one thing on this
             page somebody can change, and the reading order every other page
             settled on is the reading, the control, the history, the evidence. -->
        <div class="chips">
          <button
            v-for="ch in chips"
            :key="ch.id"
            class="chip mono"
            :class="{ on: view === ch.id, warn: ch.tone === 'warn' && ch.n > 0 }"
            @click="view = ch.id"
          >
            {{ ch.label }} <span class="n">{{ ch.n }}</span>
          </button>
        </div>

        <table v-if="shown.length" class="tbl">
          <thead>
            <tr>
              <th class="c-title">title</th>
              <th class="c-state p2">state</th>
              <th class="c-prog p3">progress</th>
              <th class="c-detail p4">detail</th>
              <th class="c-size r p3">size</th>
              <th class="c-rate r p2">rate</th>
              <th class="c-act r">action</th>
            </tr>
          </thead>

          <tbody>
            <tr v-for="row in shown" :key="row.id" :style="{ '--rail': rail(STATE_TONE[row.state]) }">
              <!-- THE CELL LEADS WITH THE TITLE, and everything the dropped
                   columns carried arrives under it. Nothing is lost, it
                   relocates - which is the whole of the column-priority rule. -->
              <td class="c-title rail">
                <div class="title-cell">
                  <PosterTile
                    :path="row.poster"
                    :tag="row.poster_tag"
                    :width="22"
                    :height="32"
                    :title="row.title"
                    :kind="row.kind"
                  />
                  <div class="tstack">
                    <!-- The state, once its own column has gone. It keeps its
                         left edge and its tone; the rail is on the ROW, so
                         whichever cell is first draws it. -->
                    <div class="fold2 tstate">
                      <StatePill :label="STATE_LABEL[row.state]" :tone="STATE_TONE[row.state]" size="sm" />
                    </div>

                    <span class="ttitle truncate" :title="row.title">{{ row.title }}</span>

                    <span class="tmeta mono">
                      <span v-if="row.sub">{{ row.sub }}</span>
                      <span v-if="row.note" class="fold4">{{ row.note }}</span>
                      <span v-if="row.progress !== null" class="fold3">
                        {{ fmt.percent(row.progress, 0) }}
                      </span>
                      <span v-if="row.size !== null" class="fold3">{{ fmt.bytes(row.size) }}</span>
                      <span v-if="row.rate_bps !== null && row.rate_bps > 0" class="fold2">
                        {{ fmt.rate(row.rate_bps) }}
                      </span>
                      <span v-else-if="row.rate_note" class="fold2">{{ row.rate_note }}</span>
                    </span>
                  </div>
                </div>
              </td>

              <td class="c-state p2">
                <StatePill :label="STATE_LABEL[row.state]" :tone="STATE_TONE[row.state]" />
              </td>

              <td class="c-prog p3">
                <!-- NO BAR WITHOUT A RATIO. `ratio: null` draws a bare track,
                     which this store reserves for "in progress, ratio unknown"
                     - so a stalled file with no progress reported drew the one
                     encoding that means it is moving. Three call sites have
                     made this mistake and the contract was right every time;
                     the dash alone is the honest rendering. -->
                <div class="progress-cell">
                  <ProgressBar
                    v-if="row.progress !== null"
                    :ratio="row.progress"
                    :tone="STATE_TONE[row.state]"
                    :live="stateClass(row.state) === 'live'"
                  />
                  <span class="mono pct">
                    {{ row.progress === null ? fmt.NO_DATA : fmt.percent(row.progress, 0) }}
                  </span>
                </div>
              </td>

              <td class="c-detail p4">
                <!-- A clamp goes on an inner div: `display: -webkit-box` on a
                     td replaces `display: table-cell`. -->
                <div class="detail">
                  <div class="note" :title="row.note ?? ''">{{ row.note ?? "" }}</div>
                  <span class="src mono truncate">
                    {{ [row.source, row.quality].filter(Boolean).join(" / ") }}
                  </span>
                </div>
              </td>

              <td class="c-size r p3 mono cell">
                {{ row.size === null ? fmt.NO_DATA : fmt.bytes(row.size) }}
              </td>

              <td class="c-rate r p2 mono cell">
                <!-- A rate of 0 is a fact for a seeding torrent with no peers, so
                     the note is the fallback only when there is genuinely no
                     rate. -->
                <span v-if="row.rate_bps !== null && row.rate_bps > 0">{{ fmt.rate(row.rate_bps) }}</span>
                <span v-else-if="row.rate_note">{{ row.rate_note }}</span>
                <span v-else>{{ fmt.NO_DATA }}</span>
              </td>

              <td class="c-act r">
                <ChipLink
                  :label="actionFor(row).label"
                  :href="actionFor(row).href"
                  :title="actionFor(row).title"
                />
              </td>
            </tr>
          </tbody>
        </table>

        <!-- THREE EMPTY STATES, THREE SENTENCES -->
        <p v-else-if="empty === 'fresh'" class="empty mono">
          nothing in flight. the queue drains to zero by design.
          <span class="asked">asked {{ fmt.coarse(media.activityFreshness.age) }} ago</span>
        </p>

        <p v-else-if="empty === 'stale'" class="empty mono">
          no rows as of {{ fmt.coarse(media.activityFreshness.age) }} ago
          <span class="asked">which is not the same as nothing being in flight</span>
        </p>

        <p v-else-if="empty === 'filtered'" class="empty mono">
          no row matches <span class="needle">{{ filter || VIEW_HINT }}</span>
          <button class="clear mono" @click="filter = ''; view = 'all'">clear filter</button>
        </p>

        <p v-if="visible.length > shown.length" class="capped mono">
          {{ visible.length - shown.length }} beyond the render cap of {{ RENDER_CAP }}
        </p>

        <!-- Any upstream that did not answer says so, rather than reading as
             zero - this is what `sources` is for. -->
        <p v-for="note in media.sourceNotes" :key="note" class="source-note mono">{{ note }}</p>
      </PanelBox>
    </Band>

    <Band label="Over time" :cols="2" stretch>
      <template #aside><span class="mono">{{ windowLabel }}</span></template>

      <PanelBox label="Library on disk" :stale="metricsStale">
        <template #aside><span class="mono">transcoded only</span></template>
        <!-- NOT STACKED, WHICH MetricChart'S OWN DOCBLOCK DECIDES: a stack is
             "only honest with a `yMax` naming the total the bands add up to",
             and there is no such total here - two libraries sharing a disk is
             an accumulation, not a partition of a known whole. Drawn stacked
             and unpinned it filled the frame to an unlabelled top edge at
             778 GB with the highest tick reading 512 GB, which is the welded
             ceiling this document already records for the memory chart. Two
             lines lose nothing: each library's own growth is the reading. -->
        <MetricChart
          :series="c?.bytes ?? []"
          :from="from"
          :to="host.now"
          :grid="3"
          y-axis
          x-axis
          legend
          :tick-base="1024"
          :format="fmt.bytes"
        />
        <p class="cnote">
          `queued/` is excluded: it is a staging area that drains to zero by design, so counting it
          would draw the pipeline working as if the library had grown. Both lines together are
          smaller than the media disk reading above and should be - the disk also holds what is
          downloading and what is still seeding.
        </p>
      </PanelBox>

      <PanelBox label="The pipeline" :stale="metricsStale">
        <template #aside><span class="mono">files</span></template>
        <MetricChart
          :series="c?.pipeline ?? []"
          :from="from"
          :to="host.now"
          :grid="3"
          y-axis
          x-axis
          legend
          :format="(v: number) => fmt.number(v)"
        />
        <p class="cnote">
          A queue that is not draining and a queue nothing is being added to are the same flat line
          until the seeding count is beside it.
        </p>
      </PanelBox>

      <PanelBox label="Subtitle backlog" :stale="metricsStale">
        <template #aside><span class="mono">bazarr</span></template>
        <MetricChart
          :series="c?.subtitles ?? []"
          :from="from"
          :to="host.now"
          :grid="3"
          y-axis
          x-axis
          legend
          :format="(v: number) => fmt.number(v)"
        />
        <p class="cnote">
          Items wanting at least one subtitle, which is the number the condition above prints. A
          backlog rather than a queue, which is why nothing on this page grades it amber - what is
          worth watching is the slope, not the number.
        </p>
      </PanelBox>

      <PanelBox label="Missing" :stale="metricsStale">
        <template #aside><span class="mono">films and episodes</span></template>
        <MetricChart
          :series="c?.missing ?? []"
          :from="from"
          :to="host.now"
          :grid="3"
          y-axis
          x-axis
          legend
          :format="(v: number) => fmt.number(v)"
        />
        <p class="cnote">
          Most of what is missing is not released yet - `isAvailable` reads true for a 2027 film - so
          this is a backlog of intent and not of work. bin/search-missing.py acts on the part of it
          that is searchable.
        </p>
      </PanelBox>
    </Band>

    <!-- THE EVIDENCE IS LAST, which is the reading order the other five settled
         on. The battery's media-side checks are three sections and six checks;
         this is the only page that asks for them, so they are unfiltered by
         status here and this is the one place they live. -->
    <FindingsPanel
      label="What the battery found"
      :section="['search', 'seeding', 'torrent']"
    />

    <p class="footnote mono">
      every action here opens the owning application in a new tab; this dashboard writes nothing
    </p>
  </div>
</template>

<style scoped>
.page {
  padding: 16px var(--pad-page) var(--pad-page);
  display: flex;
  flex-direction: column;
  gap: var(--gap-lg);
  min-width: 0;
}

.search {
  width: 210px;
  padding: 4px 8px;
  font: var(--t-mono-sm);
  color: var(--fg);
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
}

.search::placeholder {
  color: var(--fg-dim);
}

/* --- the header ----------------------------------------------------------- */

.lead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.reading {
  font: var(--t-mono-xl);
  color: var(--fg);
}

.lead-sub {
  margin-top: 7px;
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

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
  display: flex;
  align-items: center;
  gap: 7px;
  font: var(--t-mono-md);
  color: var(--fg-2);
}

.sub {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.bad {
  color: var(--fail-text);
}

.warnish {
  color: var(--warn);
}

.dim {
  color: var(--fg-5);
}

/* --- the filter chips ----------------------------------------------------- */

/* IT WRAPS, AND IT HAS TO. Five chips is 450px of segmented control and a
   390px screen gives the panel 328 - so a non-wrapping row put 91px of
   horizontal scroll on the whole document, which is silent on touch because
   the scrollbar is an overlay there. `.hscroll` would have been the wrong
   answer: base.css reserves panning for a grid that genuinely cannot shed a
   column, and a filter nobody can see is a filter that lies. */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 2px;
  margin-bottom: 13px;
  max-width: 100%;
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
}

.chip {
  padding: 4px 10px;
  font: var(--t-mono-xs);
  color: var(--fg-5);
  border-radius: var(--r-xs);
  white-space: nowrap;
}

.chip:hover {
  color: var(--fg-2);
}

.chip.on {
  background: var(--surface-high);
  color: var(--fg);
}

.chip .n {
  color: var(--fg-dim);
}

.chip.warn .n {
  color: var(--warn);
}

/* --- the table ------------------------------------------------------------
   Seven columns on the .p4/.p3/.p2 ladder, which is what replaced a 900px
   min-width and a pan. Every width was measured in the browser and carried on
   the CELL as well as the header: with the thead hidden at 640 the width source
   moves to the first body row, so a th-only width is inert at exactly the rung
   it matters most. */
/* 128, NOT 118. Measured in the browser with the column widened out of the way:
   the widest of the nine pills is `no subtitles` at 102px, and the cell carries
   24px of padding. At 118 the cell offered 94 and `downloading` wanted 95, so
   it ellipsed on a single pixel - a pill is a flex item with the default
   flex-shrink, which is the trap the round board's state column already paid
   for. The two spare pixels are deliberate for the same reason. */
.c-state {
  width: 128px;
}

.c-prog {
  width: 128px;
}

.c-size {
  width: 92px;
}

.c-rate {
  width: 112px;
}

.c-act {
  width: 104px;
}

.cell {
  font: var(--t-mono-sm);
  color: var(--fg-2);
}

.title-cell {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  align-items: center;
  gap: 9px;
}

.tstack {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ttitle {
  font: var(--t-ui-sm);
  color: var(--fg);
}

/* The folded facts, packed left on one wrapping line. Each item is
   self-labelling - `41%`, `1.4 GB`, `14.9 MB/s` - so they carry no separator;
   a separator that has to hide with its own neighbour is how a stray dash gets
   onto a phone. */
.tmeta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.progress-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pct {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* Two lines, then ellipsis - FindingsPanel's clamp, which is the only other
   place here that has to fit prose into a table cell. */
.note {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  font: var(--t-ui-sm);
  font-size: 11px;
  color: var(--fg-4);
}

.src {
  font: var(--t-mono-xs);
  color: var(--fg-dim);
}

.c-rate span {
  color: var(--fg-2);
}

/* --- empty, and what did not fit ------------------------------------------ */

.empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  padding: 22px 2px 6px;
  font: var(--t-mono-sm);
  color: var(--fg-dim);
}

.asked {
  font: var(--t-mono-xs);
  color: var(--fg-dim);
}

.needle {
  color: var(--fg-4);
}

.clear {
  padding: 3px 8px;
  font: var(--t-mono-xs);
  color: var(--fg-4);
  background: var(--surface-chip);
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
}

.clear:hover {
  color: var(--fg);
  border-color: var(--line-strong);
}

/* A CAP THAT IS VISIBLE IS HONEST, and it is a note under the table rather than
   a footer beside an unrelated fact. */
.capped {
  margin-top: 10px;
  font: var(--t-mono-xs);
  color: var(--fg-dim);
}

.source-note {
  margin-top: 8px;
  font: var(--t-mono-sm);
  color: var(--warn);
}

/* The chart panels' prose. A DIFFERENT CLASS FROM THE DETAIL CELL'S CLAMP,
   which is also called a note: two unrelated things sharing one name in one
   file is how a page footnote's border turned up in the shell header. */
.cnote {
  margin-top: 9px;
  font: var(--t-ui-sm);
  color: var(--fg-5);
}

.footnote {
  font: var(--t-mono-xs);
  color: var(--fg-dim);
}

/* --- the rungs ------------------------------------------------------------ */

@media (max-width: 900px) {
  .conds {
    display: flex;
    flex-wrap: wrap;
  }
}

@media (max-width: 640px) {
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

  /* A HEADER ROW OVER TWO COLUMNS NAMES LITTLE, and the one over the title has
     stopped being true - the state pill folded into it. */
  .tbl thead {
    display: none;
  }

  .tstate {
    margin-bottom: 5px;
  }

  /* TWO LINES, NOT ONE, and the action column pays for part of it. With five
     columns gone the title cell had 169px - about twenty-two characters of a
     release name, which is not enough to tell two episodes of one series
     apart. The round board reached the same answer for the same reason. */
  .ttitle {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    white-space: normal;
    overflow: hidden;
  }

  .c-act {
    width: 84px;
  }
}
</style>
