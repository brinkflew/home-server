<script setup lang="ts">
/**
 * The 24-bar activity strip in the pod rack. Deliberately not a chart: it has
 * no axis and no scale, and it is not meant to be read as a number - it exists
 * so that a row which has been busy looks different from one that has been
 * idle, at a glance, down a column of sixteen.
 *
 * A missing sample is a gap at the floor rather than a zero-height bar, so an
 * absent series does not look like an idle one.
 *
 * TWO WIDTH MODES, AND THE DEFAULT IS THE NARROW ONE. Fixed 3px bars are what
 * the rack needs: sixteen rows of a fixed-width column, where a strip that
 * stretched would make every row's bars a different width depending on the
 * container name beside it. A daily strip in a full-width panel wants the
 * opposite - fourteen 3px bars in a 600px panel read as a stub of a chart that
 * failed to load. `stretch` is that case, and it is a prop rather than a
 * separate component because everything else about the two is identical.
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** Any scale. Normalised against the largest value present. */
    values: number[];
    tone?: "ok" | "warn" | "fail" | "off";
    height?: number;
    /** Fill the available width instead of using fixed 3px bars. */
    stretch?: boolean;
  }>(),
  { tone: "ok", height: 20, stretch: false },
);

const bars = computed(() => {
  const finite = props.values.filter(Number.isFinite);
  const max = finite.length ? Math.max(...finite) : 0;

  return props.values.map((v) => {
    if (!Number.isFinite(v)) return { h: 0, missing: true };
    if (max <= 0) return { h: 1, missing: false };
    // A floor of 1px so a small-but-nonzero value is still visible.
    return { h: Math.max(1, (v / max) * props.height), missing: false };
  });
});
</script>

<template>
  <div class="strip" :class="{ stretch }" :style="{ height: `${height}px` }">
    <span
      v-for="(b, i) in bars"
      :key="i"
      class="bar"
      :class="{ missing: b.missing }"
      :style="{ height: `${b.h}px`, background: `var(--${tone})` }"
    />
  </div>
</template>

<style scoped>
.strip {
  display: flex;
  align-items: flex-end;
  gap: 2px;
}

.bar {
  width: 3px;
  flex: none;
  border-radius: 1px;
  opacity: 0.85;
}

/* min-width, not width: a strip of 60 bars in a narrow panel must still draw
   all 60 rather than overflowing its own container. */
.stretch .bar {
  width: auto;
  min-width: 2px;
  flex: 1;
}

.missing {
  height: 2px !important;
  background: var(--off) !important;
  opacity: 1;
}
</style>
