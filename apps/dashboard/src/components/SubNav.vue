<script setup lang="ts">
/**
 * The in-page segmented navigation, for a section that is more than one page.
 *
 * ONE TAB IN THE SHELL, SEVERAL VIEWS BEHIND IT. The Agents page had grown to
 * nine panels answering at least three different questions, and the answer is
 * not a tenth panel - it is that "is the fleet working", "what did this round
 * do" and "what is the machinery costing" are three pages. A second row of
 * tabs in NavBar would have cost every one of the other six pages the height,
 * so the sub-navigation lives in the page body.
 *
 * IT IS THE WINDOW PICKER'S BOX, deliberately. A segmented control is already
 * in this product's vocabulary and it already means "pick one of these"; a
 * second segmented idiom that looked slightly different would be a new thing
 * to learn for no gain. The active pick is the accent for the same reason it
 * is there - it marks a choice a person made.
 *
 * EXACT MATCHING IS NOT WANTED. /agents/rounds/<key> must keep the Rounds
 * segment lit, so this uses `router-link-active` rather than the exact class -
 * a reader who has opened a round has not left the board.
 */
defineProps<{
  items: { to: string; label: string }[];
}>();
</script>

<template>
  <nav class="sub">
    <RouterLink v-for="i in items" :key="i.to" :to="i.to" class="seg">
      {{ i.label }}
    </RouterLink>
  </nav>
</template>

<style scoped>
.sub {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-sm);
  background: var(--field);
  border: 1px solid var(--line);
  align-self: flex-start;
}

.seg {
  padding: 5px 13px;
  border-radius: var(--r-xs);
  font: var(--t-ui);
  color: var(--fg-5);
  transition: background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.seg:hover {
  background: var(--fill);
  color: var(--fg);
}

/* A wash and a WEIGHT STEP, so the selected segment is never colour alone. */
.seg.router-link-active {
  background: var(--accent-tint);
  color: var(--accent);
  font: var(--t-ui-md);
}
</style>
