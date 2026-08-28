<script setup lang="ts">
/**
 * The findings, in ONE place and ONE visual language.
 *
 * There were two of these, and they disagreed. A strip of tinted cards at the
 * top of the System page carried an amber wash, an uncoloured title and a grey
 * id, capped at three; a panel below the metrics carried a grey dot, no tint
 * and all of them. Both read host.problems. So which findings existed depended
 * on which half of the page you looked at, and a `note` rendered amber in one
 * and grey in the other - the strip bound `:class="c.status"` and only `.fail`
 * had an override, so `note` fell through to the warn treatment.
 *
 * ONE SURFACE, AND IT IS AT THE TOP, because a finding is the reason to open
 * this page at all. The severity language is a dot and a left rule rather than
 * a full tint: an amber wash reads well on three cards and becomes a wall at
 * twenty. A `fail` keeps its tint - a failure should still be loud - and that
 * is the whole of the difference.
 *
 * SCOPED TO A SECTION, AND SHOWING PASSES, FOR THE TWO FLEET PAGES. That is
 * still one surface rather than the two that disagreed: same tone function, same
 * layout, same rule about `note`. What changes is the question. The System page
 * asks "what is wrong with this host", so it shows what is not passing across
 * every section. /ci and /agents ask "what does the battery know about this
 * fleet", and for them a passing check is content: two of the CI facts
 * (github_runner_runtime_split, github_runner_root_label) are STRINGS with no
 * metric at all, so the check's status is the only route to them anywhere in
 * this application. Hiding it while it passes would mean the only way to learn
 * the runtime split is fine is for it to stop being fine.
 */
import { computed } from "vue";

import PanelBox from "./PanelBox.vue";
import StatusDot from "./StatusDot.vue";
import { useBatteryStale } from "@/composables/useStaleness";
import { useHostStore } from "@/stores/host";
import { checkTone } from "@/health";
import { STATUS_RANK } from "@/types";

const props = withDefaults(
  defineProps<{
    label?: string;
    /** Restrict to one status.json section id, e.g. "ci". Unset means all. */
    section?: string | null;
    /** Include passing checks. Only sensible with `section` - the whole battery
     *  is 105 checks and a wall of green is how a reader learns to skip it. */
    all?: boolean;
  }>(),
  { label: "Findings", section: null, all: false },
);

const host = useHostStore();
const batteryStale = useBatteryStale();

/**
 * Worst-first, and for a section that ordering has to be REDONE rather than
 * inherited: host.problems is already sorted, but host.doc.checks is in the
 * battery's emission order, so the `all` branch would otherwise list a fail
 * below four passes purely because of where it sits in a shell script.
 */
const problems = computed(() => {
  if (!props.section) return host.problems;

  if (!props.all) return host.problems.filter((c) => c.section === props.section);

  const checks = (host.doc?.checks ?? []).filter((c) => c.section === props.section);
  return [...checks].sort(
    (a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || a.id.localeCompare(b.id),
  );
});

/** "14 checks, 2 not passing" for a section; the whole battery otherwise. */
const tally = computed(() => {
  if (!host.doc) return null;
  if (!props.section) {
    return `${host.doc.summary.total} checks, ${host.problems.length} not passing`;
  }
  const all = host.doc.checks.filter((c) => c.section === props.section);
  const bad = all.filter((c) => c.status !== "pass").length;
  return `${all.length} checks, ${bad} not passing`;
});
</script>

<template>
  <PanelBox :label="label" :stale="batteryStale">
    <template #aside>
      <span v-if="tally">{{ tally }}</span>
      <span v-else-if="host.statusNeverRun">the check battery has never run here</span>
    </template>

    <ul v-if="problems.length" class="findings">
      <li v-for="c in problems" :key="c.id" class="finding" :class="c.status">
        <StatusDot :tone="checkTone(c.status)" :live="c.status === 'fail'" :size="6" />
        <div class="body">
          <p class="msg" :title="c.message">{{ c.message }}</p>
          <p class="fid mono">{{ c.id }}</p>
        </div>
      </li>
    </ul>
    <p v-else-if="section && !tally" class="empty mono">
      this section is absent from the battery's last run - not passing, unmeasured
    </p>
    <p v-else class="empty mono">every check passed</p>

    <p v-if="!section && host.doc && !host.doc.mode.routes" class="note mono">
      The public route battery was not walked in this run. Those checks are absent, not passing.
    </p>
  </PanelBox>
</template>

<style scoped>
/* Columns rather than one tall list: this panel now holds every finding, and
   twenty rows down the top of the page would push the charts off the screen. */
.findings {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 5px 10px;
  max-height: 240px;
  overflow-y: auto;
}

.finding {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--r-xs);
  /* The severity, as a rule rather than a wash. --off for a `note`, which is
     the unlit LED: a check that could not run must not borrow the colour of
     one that ran and complained. */
  border-left: 2px solid var(--off);
  background: var(--fill);
  min-width: 0;
}

.finding > :deep(.dot) {
  margin-top: 4px;
}

.finding.warn {
  border-left-color: var(--warn);
}

.finding.fail {
  border-left-color: var(--fail);
  background: var(--fail-tint);
}

.body {
  min-width: 0;
}

/* Two lines, not one. A finding's message is the half worth reading, and the
   strip used to cut most of them mid-sentence to keep a single baseline. */
.msg {
  font: var(--t-ui-md);
  color: var(--fg-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.fid {
  font: var(--t-mono-sm);
  color: var(--fg-5);
  margin-top: 2px;
}

.empty {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
  padding: 6px 4px;
}

.note {
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid var(--line);
  font: var(--t-mono-xs);
  color: var(--fg-5);
}
</style>
