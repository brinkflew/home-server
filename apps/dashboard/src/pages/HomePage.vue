<script setup lang="ts">
/**
 * Home: what is happening in the house right now.
 *
 * THE FRONT DOOR, AND THE LAST PAGE WITH NO HEADLINE. `/` redirects here, so
 * this is what a phone opens onto, and until this pass it opened onto a bespoke
 * `repeat(var(--cards), 1fr) 300px` grid - the bento the band rule replaced -
 * with no reading above it and `--t-mono-xl`, "the one headline reading", used
 * nowhere. Five other pages had each had that pass; this one and /library had
 * had none of it.
 *
 * The lead is "5 things happening", which is watching plus in flight and
 * deliberately not requests. See homeLead in @/media for why the arithmetic is
 * spelled out in the sub-line, and for the two absences the number has to make
 * room for.
 *
 * NO CHART AND THEREFORE NO WindowPicker. Nothing here sits on a time axis, and
 * a picker that changes nothing on screen is a lie about a control.
 *
 * THE SHELL SEARCH FIELD IS STILL DROPPED. The design puts "search or request"
 * in the nav; half of that is a write, which is structurally impossible here,
 * and the other half has nothing to search - the documents carry the working set
 * and the last seven days, not an index of 617 items.
 */
import { computed } from "vue";

import Band from "@/components/Band.vue";
import ChipLink from "@/components/ChipLink.vue";
import NowPlayingCard from "@/components/NowPlayingCard.vue";
import PanelBox from "@/components/PanelBox.vue";
import PosterTile from "@/components/PosterTile.vue";
import ServiceStrip from "@/components/ServiceStrip.vue";
import StaleNote from "@/components/StaleNote.vue";
import StatusDot from "@/components/StatusDot.vue";

import { useHostStore } from "@/stores/host";
import { useMediaStore } from "@/stores/media";
import { jellyfinItem } from "@/links";
import { docState, homeConditions, homeLead, mediaActivity, requestRows } from "@/media";
import * as fmt from "@/format";
import type { Tone } from "@/types";

const media = useMediaStore();
const host = useHostStore();

/** Up to three cards, which is what this host actually runs to. A cap that is
 *  visible is honest, so the difference is said out loud below. */
const MAX_CARDS = 3;

const cards = computed(() => media.sessions.slice(0, MAX_CARDS));
const overflow = computed(() => Math.max(0, media.sessions.length - MAX_CARDS));

/** The newest eight. This row is a glance rather than an inventory - the band's
 *  aside carries the true total. */
const grid = computed(() => media.recent.slice(0, 8));

// ---------------------------------------------------------------------------
// The reading. Every decision is in @/media, which is what lets smoke.mjs reach
// them: a computed in this file is code no test in this repository can call.
// ---------------------------------------------------------------------------
const activity = computed(() =>
  mediaActivity({
    sessions: media.sessions,
    rows: media.rows,
    requestCounts: media.libraryDoc?.request_counts,
    playback: docState(!!media.activityDoc, media.activityStale),
    library: docState(!!media.libraryDoc, media.libraryStale),
  }),
);

const conds = computed(() => homeConditions(activity.value));
const lead = computed(() => homeLead(activity.value, conds.value));
const requests = computed(() => requestRows(media.requests, host.now));

/** A tone on a value, without a fourth colour: fail and warn speak, ok is the
 *  ordinary body colour and off is the dim one. */
function toneClass(tone: Tone): Record<string, boolean> {
  return { bad: tone === "fail", warnish: tone === "warn", dim: tone === "off" };
}
</script>

<template>
  <div class="page">
    <Teleport defer to="#toolbar">
      <!-- Two documents, two ages, because they go stale at different rates and
           a single number would hide which one did. -->
      <span class="mono ages">
        playback
        <span :class="{ bad: !!media.activityStale }">
          {{ fmt.coarse(media.activityFreshness.age) }}
        </span>
        / library
        <span :class="{ bad: !!media.libraryStale }">
          {{ fmt.coarse(media.libraryFreshness.age) }}
        </span>
      </span>
    </Teleport>

    <!-- THE HEADLINE LEADS. --t-mono-xl is "the one headline reading" and this
         page consumed it nowhere until this pass. -->
    <Band label="Right now">
      <PanelBox>
        <div class="lead">
          <StatusDot :tone="lead.tone" :live="lead.live" :size="9" />
          <span class="reading mono">{{ lead.text }}</span>
        </div>

        <!-- NO PROGRESS BAR. There is no denominator for "things happening",
             and a bare track is the encoding this store reserves for "in
             progress, ratio unknown" - the defect three call sites have paid
             for already. -->
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

    <!-- Equal columns, from Band, rather than the hand-rolled grid that gave the
         requests panel a hard 300px track beside up to three flexible ones. -->
    <Band label="Playing" :cols="Math.max(1, cards.length)">
      <template #aside>
        <!-- A CAP THAT IS VISIBLE IS HONEST. Three cards is a layout limit, not
             a statement about how many people are watching. -->
        <span v-if="overflow" class="mono"
          >+ {{ overflow }} more session{{ overflow === 1 ? "" : "s" }} not shown</span
        >
      </template>

      <template v-if="cards.length">
        <PanelBox v-for="s in cards" :key="s.id" :stale="media.activityStale">
          <NowPlayingCard :session="s" :doc-at="media.activityDoc?.generated_at ?? ''" />
        </PanelBox>
      </template>

      <!-- FRESH-AND-EMPTY AND STALE-AND-EMPTY ARE DIFFERENT CLAIMS, the same way
           they are in the Library table. "Nothing playing" is an assertion, and
           at eight minutes old it is one we are not entitled to make. -->
      <PanelBox v-else :stale="media.activityStale">
        <p v-if="media.activityStale" class="empty mono">
          no session as of {{ fmt.coarse(media.activityFreshness.age) }} ago
          <span class="asked">which is not the same as nobody watching</span>
        </p>
        <p v-else class="empty mono">
          nothing playing
          <span class="asked">asked {{ fmt.coarse(media.activityFreshness.age) }} ago</span>
        </p>
      </PanelBox>
    </Band>

    <!-- ITS OWN BAND, AND A TABLE. It was a list of records in a 300px sidebar
         track, which is both halves of what the band rule and the .tbl recipe
         exist to stop: a panel narrower than its siblings for a reason invisible
         to a reader, holding records drawn as cards. -->
    <Band label="Requests">
      <template #aside>
        <!-- NOT `N pending`, which the condition one band up already says. The
             count is authoritative over ALL requests and the list is the newest
             handful, so the relationship between the two is what this has to
             carry - it is also what makes an empty list with a non-zero total
             read as ordinary rather than contradictory. -->
        <span class="mono">
          newest <span class="count">{{ requests.length }}</span> of {{ activity.requestTotal }}
        </span>
      </template>

      <PanelBox :stale="media.libraryStale">
        <table v-if="requests.length" class="tbl">
          <thead>
            <tr>
              <th class="c-title">title</th>
              <th class="c-status p3">status</th>
              <th class="c-asked r p2">asked</th>
              <th class="c-act r">action</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in requests" :key="r.id">
              <td class="c-title">
                <div class="title-cell">
                  <PosterTile
                    :path="r.poster"
                    :tag="r.posterTag"
                    :width="26"
                    :height="38"
                    :title="r.title"
                    :kind="r.kind"
                  />
                  <div class="tstack">
                    <span class="ttitle truncate" :title="r.title">{{ r.title }}</span>
                    <!-- What the dropped columns handed over. Nothing is lost,
                         it relocates. -->
                    <span class="tmeta mono">
                      <span>{{ r.kind }}</span>
                      <span class="fold3">{{ r.status }}</span>
                      <span class="fold2">asked {{ r.asked }}</span>
                    </span>
                  </div>
                </div>
              </td>
              <td class="c-status p3 mono cell">{{ r.status }}</td>
              <td class="c-asked r p2 mono cell">{{ r.asked }}</td>
              <td class="c-act r">
                <ChipLink
                  label="open"
                  :href="r.href"
                  title="open the request queue in Jellyseerr"
                  tone="ok"
                />
              </td>
            </tr>
          </tbody>
        </table>

        <!-- The count in the aside is authoritative over ALL requests; the list
             is the newest handful. So an empty list with a non-zero count is
             possible rather than contradictory, and saying "no requests" there
             would flatly disagree with the number beside it. -->
        <p v-else class="empty mono">
          {{ activity.requestTotal ? `none of the newest ${activity.requestTotal} shown` : "no requests" }}
          <span class="asked">asked {{ fmt.coarse(media.libraryFreshness.age) }} ago</span>
        </p>
      </PanelBox>
    </Band>

    <Band label="Recently added">
      <template #aside>
        <span class="mono">{{ media.recentTotal }} in the last 7 days</span>
      </template>

      <PanelBox :stale="media.libraryStale" padding="0">
        <StaleNote :reason="media.libraryStale" />

        <div v-if="grid.length" class="grid">
          <a
            v-for="item in grid"
            :key="item.id"
            class="cell-link"
            :href="item.item_id ? jellyfinItem(item.item_id) ?? undefined : undefined"
            target="_blank"
            rel="noopener noreferrer"
          >
            <PosterTile
              :path="item.poster"
              :tag="item.poster_tag"
              :width="150"
              :title="item.title"
              :kind="item.kind"
            />
            <span class="ctitle truncate" :title="item.title">{{ item.title }}</span>
            <span class="cmeta mono">{{ item.sub ?? "" }}</span>
          </a>
        </div>

        <p v-else class="empty mono">
          nothing added in the last 7 days
          <span class="asked">asked {{ fmt.coarse(media.libraryFreshness.age) }} ago</span>
        </p>
      </PanelBox>
    </Band>

    <!-- Any upstream that did not answer says so, rather than reading as zero -->
    <p v-for="note in media.sourceNotes" :key="note" class="source-note mono">{{ note }}</p>

    <!-- `The media stack`, NOT `Services`. A band may not repeat its own tab,
         and repeating a DIFFERENT section's tab is worse - a band labelled
         Services on the front page reads as a link to the Services page. -->
    <ServiceStrip />

    <p class="footnote mono">
      every action here opens the owning application in a new tab; this dashboard writes nothing
    </p>
  </div>
</template>

<style scoped>
/* Two rhythms, not one: --gap between panels inside a band, --gap-lg between
   bands. Band owns the first; the page owns this. */
.page {
  padding: 16px var(--pad-page) var(--pad-page);
  display: flex;
  flex-direction: column;
  gap: var(--gap-lg);
  min-width: 0;
}

.ages {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.ages .bad {
  color: var(--warn);
}

/* --- the header ----------------------------------------------------------- */

.lead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

/* --t-mono-xl, which tokens.css describes as "the one headline reading". One
   per view is the whole point of it. */
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
   below 640 - the round board's recipe, on all eight pages that carry it. */
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

/* Three states and no fourth colour: fail and warn speak for themselves, ok is
   the ordinary body colour, and off is the dim one - never green. */
.bad {
  color: var(--fail-text);
}

.warnish {
  color: var(--warn);
}

.dim {
  color: var(--fg-5);
}

/* --- the requests table --------------------------------------------------- */

/* Measured in the browser, and the widths are carried on the CELLS as well as
   the headers: with the thead hidden at 640 the width source moves to the first
   body row, and a th-only width is inert exactly where it is needed most. */
.c-status {
  width: 116px;
}

.c-asked {
  width: 92px;
}

.c-act {
  width: 76px;
}

.cell {
  font: var(--t-mono-sm);
  color: var(--fg-2);
}

.title-cell {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
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
  color: var(--fg-2);
}

/* Packed left on one wrapping line, and the items carry NO SEPARATOR: each is
   self-labelling - `movie`, `approved`, `asked 2h ago` - and a separator that
   has to hide together with its own neighbour is how a stray `-` ends up
   between two chips on a phone. base.css hides each fold and reveals it at its
   own rung; nothing here overrides that, because a scoped rule of equal
   specificity winning on source order is not a mechanism to rely on. */
.tmeta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

/* --- recently added ------------------------------------------------------- */

.grid {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 9px;
  padding: var(--pad-panel);
}

.cell-link {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

/* PosterTile is sized in px, so it is stretched to the column here rather than
   the grid being sized to it - eight fixed-width posters would not fit 1360. */
.cell-link :deep(.tile) {
  width: 100% !important;
  height: auto !important;
  aspect-ratio: 2 / 3;
  transition: border-color 0.12s ease-out;
}

.cell-link:hover :deep(.tile) {
  border-color: var(--ok-edge);
}

.ctitle {
  font: var(--t-ui-sm);
  font-size: 11px;
  font-weight: 500;
  color: var(--fg-2);
}

.cmeta {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

/* --- shared --------------------------------------------------------------- */

.empty {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 2px;
  font: var(--t-mono-sm);
  color: var(--fg-dim);
}

.grid + .empty,
.stale + .empty {
  padding: var(--pad-panel);
}

.asked {
  font: var(--t-mono-xs);
  color: var(--fg-dim);
}

.source-note {
  font: var(--t-mono-sm);
  color: var(--warn);
}

.footnote {
  font: var(--t-mono-xs);
  color: var(--fg-dim);
}

/* --- the rungs ------------------------------------------------------------
   The posters step 8 -> 6 -> 4 -> 3 rather than going `auto-fill`. auto-fill
   sized from an 88px minimum gives FOURTEEN columns at 1360, which is not the
   design and is not what anybody wants on a desktop; the count is a decision
   per rung and it is written down as one.

   1180 is new. It is the rung Band itself folds on, so a three-up band above an
   eight-across grid used to change shape while the grid did not. */
@media (max-width: 1180px) {
  .grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}

@media (max-width: 900px) {
  .conds {
    display: flex;
    flex-wrap: wrap;
  }

  .grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

/* The conditions, on a phone: the label moves left of its value, three rows, one
   condition each, labels in a column of their own. The 92px fallback is the
   width of REQUESTS at --t-label, measured, and is what the browser uses where
   subgrid is unavailable. */
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

  .grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
