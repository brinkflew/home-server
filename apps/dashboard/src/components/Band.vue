<script setup lang="ts">
/**
 * A band: a labelled group of panels, either full width or N EQUAL COLUMNS.
 *
 * THAT IS THE WHOLE LAYOUT RULE, and it replaced a bento. The System page used
 * a 12-column grid running 7/5 then 4/4/4 over a bottom row of three unequal
 * panels, one of which held two stacked panels of its own - every panel a
 * different width for reasons that were true of its content and invisible to a
 * reader, so the page had no organisation to learn. Equal columns are legible
 * at a glance; a bespoke span is only legible once you have read the panel.
 *
 * IF A PANEL NEEDS MORE WIDTH THAN ITS SIBLINGS, GIVE IT ITS OWN BAND. A band
 * that wants a grid AND a full-width panel under it is two bands, not a
 * special case here.
 *
 * TWO RHYTHMS, and they are what make a page read as bands rather than as one
 * long stack: --gap between panels inside a band, --gap-lg between bands. The
 * page owns the second one; this owns the first.
 */
withDefaults(
  defineProps<{
    label?: string;
    /** 1 stacks; 2 or more is that many equal columns. */
    cols?: number;
  }>(),
  { label: "", cols: 1 },
);
</script>

<template>
  <section class="band">
    <div v-if="label || $slots.aside" class="head">
      <span class="label">{{ label }}</span>
      <span class="aside"><slot name="aside" /></span>
    </div>
    <div class="body" :style="{ '--cols': cols }">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.band {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
  min-width: 0;
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gap-lg);
}

.aside {
  font: var(--t-ui-sm);
  color: var(--fg-5);
}

/* minmax(0, 1fr) rather than 1fr: a grid track's default minimum is
   min-content, so one long unbroken value in a panel widens its column and
   the "equal" stops being true. */
.body {
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  gap: var(--gap);
  align-items: start;
  min-width: 0;
}

/* The reference viewport is 1360 wide. Below that a three-up band is three
   narrow columns rather than three panels, so it folds rather than squeezes. */
@media (max-width: 1180px) {
  .body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
