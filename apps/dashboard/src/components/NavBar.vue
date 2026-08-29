<script setup lang="ts">
/**
 * The shell header: wordmark, the seven pages, and a per-page toolbar.
 *
 * All seven pages are built. The wordmark points at Home rather than System:
 * it is the go-home affordance, and pointing it somewhere `/` does not go would
 * be a contradiction the moment anyone noticed.
 */
import { computed } from "vue";
import { useHostStore } from "@/stores/host";
import { coarse } from "@/format";
import StatusDot from "./StatusDot.vue";

const host = useHostStore();

const routes = [
  { to: "/home", label: "Home" },
  { to: "/library", label: "Library" },
  { to: "/services", label: "Services" },
  { to: "/network", label: "Network" },
  { to: "/system", label: "System" },
  { to: "/ci", label: "CI" },
  { to: "/agents", label: "Agents" },
];

const tone = computed(() => {
  switch (host.verdict) {
    case "pass":
      return "ok" as const;
    case "warn":
      return "warn" as const;
    case "fail":
      return "fail" as const;
    default:
      return "off" as const;
  }
});

/** The counts, or an honest blank. Never "0 failing" when nothing was read. */
const tally = computed(() => {
  if (host.verdict === "unknown" || !host.doc) return "no reading";
  const s = host.doc.summary;
  if (s.fail === 0 && s.warn === 0) return `${s.pass} passing`;
  return [s.fail ? `${s.fail} failing` : "", s.warn ? `${s.warn} degraded` : ""]
    .filter(Boolean)
    .join(" / ");
});

const age = computed(() => {
  const f = host.statusFreshness;
  return f.missing ? "never" : coarse(f.age);
});
</script>

<template>
  <header class="bar">
    <div class="left">
      <RouterLink to="/home" class="mark" aria-label="home server">
        <!-- Design option 1c, "pitch and units": the house reduced to its roof
             pitch over two rack units. Inline SVG rather than an <img> or an
             icon package, which is what ChipLink and PosterTile already do. The
             geometry sits on a 32 unit grid so every edge lands on a whole
             pixel when it halves to 16. -->
        <svg class="glyph" viewBox="0 0 32 32" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M4.6 16.6L16 6L27.4 16.6" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M8.2 22.8H23.8" stroke-width="3.4" stroke-linecap="round" />
          <path d="M8.2 27.7H15.8" stroke-width="3.4" stroke-linecap="round" />
        </svg>
        <span class="word mono">HOMESERVER</span>
      </RouterLink>

      <nav class="nav">
        <RouterLink v-for="r in routes" :key="r.to" :to="r.to" class="tab">
          {{ r.label }}
        </RouterLink>
      </nav>
    </div>

    <div class="right">
      <!-- Pages teleport their own controls here. `defer` so the target is
           mounted before a page that renders early tries to reach it. -->
      <div id="toolbar" class="toolbar" />

      <div class="verdict" :class="tone">
        <StatusDot :tone="tone" :live="tone === 'fail'" :size="5" />
        <span class="mono">{{ tally }}</span>
        <span class="age mono">{{ age }}</span>
      </div>
    </div>
  </header>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 14px var(--pad-page);
  border-bottom: 1px solid var(--line);
}

.left,
.right {
  display: flex;
  align-items: center;
  gap: 18px;
  min-width: 0;
}

/* THE NAV NEVER COMPRESSES AND THE TOOLBAR ALWAYS CAN. The type going from
   12px to 13px widened the tabs, and the System page teleports the most into
   this bar - an OS line, a staged chip and a window picker. With everything
   shrinkable the mark lost its wordmark and the OS line wrapped, which took
   the whole header to 75px and put a tab under it. A page's own toolbar is the
   half that may give way, so it is the half that shrinks. */
.left {
  flex: none;
}

.right {
  gap: 9px;
  flex: 1 1 auto;
  justify-content: flex-end;
  overflow: hidden;
}

.mark {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--fg);
  flex: none;
}

/* 20px against the 11px wordmark at 0.16em is the design's own small lockup.
   The colour is --accent rather than --ok deliberately - a mark in the status
   colour, beside the verdict pill, reads as a second status light. It is one
   consumer of the accent among several now, not a colour of its own. */
.glyph {
  width: 20px;
  height: 20px;
  flex: none;
  color: var(--accent);
}

.word {
  font: 600 11px/1 var(--font-mono);
  letter-spacing: 0.16em;
}

.nav {
  display: flex;
  gap: 3px;
}

.tab {
  padding: 6px 11px;
  border-radius: var(--r-sm);
  font: var(--t-ui);
  color: var(--fg-4);
  transition: background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

/* Hover LIGHTENS AND MOVES NOTHING. No transform, no shadow, no scale: this
   is read from across a room, where a 2px scale is invisible and a reflow is
   not. */
.tab:hover {
  background: var(--fill);
  color: var(--fg);
}

/* The active tab is a choice a person made, so it is the accent - a wash plus
   a WEIGHT STEP, which is what keeps the state from being colour-only. */
.tab.router-link-active {
  background: var(--accent-tint);
  color: var(--accent);
  font: var(--t-ui-md);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  overflow: hidden;
}

.verdict {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px;
  border-radius: var(--r-sm);
  font: var(--t-mono-md);
  border: 1px solid var(--line);
  background: var(--fill);
  color: var(--fg-3);
  flex: none;
}

.verdict.ok {
  background: var(--ok-tint);
  border-color: var(--ok-edge);
  color: var(--ok);
}

.verdict.warn {
  background: var(--warn-tint);
  border-color: var(--warn-edge);
  color: var(--warn);
}

.verdict.fail {
  background: var(--fail-tint);
  border-color: var(--fail-edge);
  color: var(--fail-text);
}

.age {
  color: var(--fg-dim);
  font-weight: 400;
}
</style>
