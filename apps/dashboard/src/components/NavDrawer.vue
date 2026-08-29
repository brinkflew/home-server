<script setup lang="ts">
/**
 * The seven pages, as a drawer, below the 900px rung.
 *
 * THE NAV IS THE WHOLE HORIZONTAL SCROLLBAR AND THIS IS WHY THIS EXISTS. In
 * NavBar `.left` is `flex: none` and its intrinsic width is about 583px - a
 * seven-tab nav of roughly 452px plus the 113px lockup - so on a 375px screen
 * the document's scroll width was at least 649px BEFORE any page contributed a
 * pixel. Every page had a scroll axis nobody asked for and 275px of bare
 * background beside it, and on touch the scrollbar is an overlay, so nothing
 * said so.
 *
 * IT IS THE FIRST FLOATER HERE THAT IS NOT THE TOOLTIP, and the tokens for it
 * were already waiting: `--z-scrim` and `--z-overlay` are declared in
 * tokens.css with the comment "a modal, a drawer" and had no consumer. So this
 * introduces no new tier and no new elevation idiom - a floater gets one
 * shadow and a hairline, which is the rule the whole system already states.
 *
 * TELEPORTED TO body, for the reason Tooltip gives: position: fixed inside a
 * clipping ancestor is clipped, and the header it is opened from is exactly
 * such an ancestor - `.right` and `.toolbar` both carry `overflow: hidden`.
 *
 * FOUR WAYS TO CLOSE IT, and the fourth is the one that is easy to forget: a
 * rotation to landscape crosses the rung, the tabs come back in the header,
 * and a drawer left open over them would be two navigations on screen at once.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";

const props = defineProps<{
  open: boolean;
  routes: { to: string; label: string }[];
}>();

const emit = defineEmits<{ close: [] }>();

const route = useRoute();
const panel = ref<HTMLElement | null>(null);
let returnTo: HTMLElement | null = null;

/**
 * Focus moves in on open and BACK ON CLOSE. Without the second half a keyboard
 * user is returned to the top of the document every time they dismiss the
 * drawer, which is worse than not moving focus at all.
 */
watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      returnTo = document.activeElement as HTMLElement | null;
      await nextTick();
      // QUERIED, NOT REF'D. A function ref on a RouterLink is handed the
      // COMPONENT INSTANCE rather than its element, so calling .focus() on it
      // throws - and it throws inside a watcher, where nothing on the page
      // shows it. The drawer still opened, which is exactly the shape of
      // defect this repository keeps finding: it worked, loudly, for anyone
      // using a mouse and not at all for anyone using a keyboard.
      const entry = panel.value?.querySelector<HTMLElement>(".entry");
      (entry ?? panel.value)?.focus();
    } else if (returnTo) {
      returnTo.focus();
      returnTo = null;
    }
  },
);

// A drawer that survived a route change would be a menu offering the page you
// are already looking at.
watch(() => route.fullPath, () => emit("close"));

function onKey(e: KeyboardEvent): void {
  if (!props.open) return;
  if (e.key === "Escape") {
    emit("close");
    return;
  }
  // A modal keeps the tab ring inside itself. Six links and a close button is
  // a small enough loop to wrap by hand rather than reach for a library.
  if (e.key !== "Tab") return;
  const items = panel.value?.querySelectorAll<HTMLElement>("a, button");
  if (!items || items.length === 0) return;
  const edge = e.shiftKey ? items[0] : items[items.length - 1];
  if (document.activeElement === edge) {
    e.preventDefault();
    (e.shiftKey ? items[items.length - 1] : items[0]).focus();
  }
}

// The rung, restated. A resize past it puts the seven tabs back in the header.
function onResize(): void {
  if (props.open && window.innerWidth > 900) emit("close");
}

onMounted(() => {
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", onResize);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="scrim" @click="emit('close')" />

    <nav
      v-if="open"
      ref="panel"
      class="drawer"
      tabindex="-1"
      aria-label="pages"
      aria-modal="true"
      role="dialog"
    >
      <div class="head">
        <span class="label">Pages</span>
        <button type="button" class="shut mono" @click="emit('close')">close</button>
      </div>

      <RouterLink v-for="r in routes" :key="r.to" :to="r.to" class="entry">
        {{ r.label }}
      </RouterLink>
    </nav>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-scrim);
  background: oklch(0 0 0 / 0.55);
}

/* A floater: one shadow, one hairline, and it goes UP the surface scale. The
   width is capped so the page behind it stays visible - a drawer that covers
   everything is a page, and this is a menu. */
.drawer {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: var(--z-overlay);
  width: min(272px, 82vw);
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px;
  background: var(--surface-high);
  border-right: 1px solid var(--border-float);
  box-shadow: var(--shadow-overlay);
  animation: slide-in var(--dur-base) var(--ease-standard);
}

@keyframes slide-in {
  from {
    transform: translateX(-100%);
  }
}

/* The slide is emphasis and carries no information, so losing it costs
   nothing - but a drawer that arrives with no transition at all must still
   arrive in place rather than from off screen. */
@media (prefers-reduced-motion: reduce) {
  .drawer {
    animation: none;
  }
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 2px 10px 12px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border-divider);
}

.shut {
  font: var(--t-mono-sm);
  color: var(--fg-5);
  padding: var(--pad-chip);
  border-radius: var(--r-xs);
}

.shut:hover {
  color: var(--accent);
  background: var(--fill);
}

.entry {
  padding: var(--pad-control);
  border-radius: var(--r-sm);
  font: var(--t-ui);
  color: var(--fg-3);
  transition: background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.entry:hover {
  background: var(--fill);
  color: var(--fg);
}

/* THE SAME TWO SIGNALS AS THE DESKTOP TAB: an accent wash and a weight step.
   The weight is what keeps the state from being colour-only, and using the
   header's own encoding means the drawer teaches nothing new. */
.entry.router-link-active {
  background: var(--accent-tint);
  color: var(--accent);
  font: var(--t-ui-md);
}
</style>
