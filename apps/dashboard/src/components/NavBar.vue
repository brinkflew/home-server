<script setup lang="ts">
/**
 * The shell header: wordmark, the seven pages, and a per-page toolbar.
 *
 * All seven pages are built. The wordmark points at Home rather than System:
 * it is the go-home affordance, and pointing it somewhere `/` does not go would
 * be a contradiction the moment anyone noticed.
 *
 * BELOW 640 THE SEVEN TABS BECOME A DRAWER, and that is not a preference. The
 * nav's intrinsic width is about 452px and `.left` is `flex: none`, so this
 * header alone gave the document a scroll width of at least 649px on a 375px
 * screen - every page, whatever it contained. See NavDrawer.vue.
 */
import { computed, ref } from "vue";
import { useHostStore } from "@/stores/host";
import { coarse } from "@/format";
import StatusDot from "./StatusDot.vue";
import NavDrawer from "./NavDrawer.vue";

const host = useHostStore();
const menu = ref(false);

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
      <!-- Below 640 only. Three bars rather than an icon-font glyph, for the
           reason the mark is inline SVG: this repository has no icon package
           and adding one is a separate decision. -->
      <button
        type="button"
        class="menu"
        aria-label="pages"
        :aria-expanded="menu"
        @click="menu = true"
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M3 5.5H17" stroke-width="1.7" stroke-linecap="round" />
          <path d="M3 10H17" stroke-width="1.7" stroke-linecap="round" />
          <path d="M3 14.5H17" stroke-width="1.7" stroke-linecap="round" />
        </svg>
      </button>

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

    <!-- Pages teleport their own controls here. `defer` so the target is
         mounted before a page that renders early tries to reach it.

         A DIRECT CHILD OF THE BAR, NOT NESTED BESIDE THE VERDICT. It was
         nested, and below 640 that made it impossible to give it a row of its
         own at the page gutter: a `flex-basis: 100%` inside the wrapper sized
         the WRAPPER, which pushed the verdict onto a line by itself and left
         the toolbar indented under it. Three rows for two things. Flat, the
         wrap is `order` and nothing else. -->
    <div id="toolbar" class="toolbar" />

    <div class="verdict" :class="tone">
      <StatusDot :tone="tone" :live="tone === 'fail'" :size="5" />
      <span class="mono tally truncate">{{ tally }}</span>
      <span class="age mono">{{ age }}</span>
    </div>
  </header>

  <NavDrawer :open="menu" :routes="routes" @close="menu = false" />
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 14px var(--pad-page);
  border-bottom: 1px solid var(--line);
}

/* THE NAV NEVER COMPRESSES AND THE TOOLBAR ALWAYS CAN. The type going from
   12px to 13px widened the tabs, and the System page teleports the most into
   this bar - an OS line, a staged chip and a window picker. With everything
   shrinkable the mark lost its wordmark and the OS line wrapped, which took
   the whole header to 75px and put a tab under it. A page's own toolbar is the
   half that may give way, so it is the half that shrinks.

   Below 640 neither of those is true any more: the nav is not here at all.

   The auto margin is what pushes the toolbar and the verdict to the right
   edge, and it does it without `justify-content: space-between` - which with
   three children would have parked the toolbar in the middle of the bar. */
.left {
  display: flex;
  align-items: center;
  gap: 18px;
  min-width: 0;
  flex: none;
  margin-right: auto;
}

.menu {
  display: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  margin-left: -7px;
  border-radius: var(--r-sm);
  color: var(--fg-3);
  flex: none;
}

.menu svg {
  width: 20px;
  height: 20px;
}

.menu:hover {
  background: var(--fill);
  color: var(--fg);
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

/* Four of the eight pages teleport nothing but a note, and two teleport
   nothing at all on some routes. An empty flex item still opens a flex line
   once the header wraps, so it stops occupying one. */
.toolbar:empty {
  display: none;
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
  min-width: 0;
}

/* The dot and the age hold; the sentence between them is the half that gives
   way. Losing "degraded" from the middle of a tally costs a word. Losing the
   dot costs the reading. */
.tally {
  min-width: 0;
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
  flex: none;
}

/* --- the rung, and it is 900 rather than 640 -------------------------------
   MEASURED, NOT CHOSEN. Seven tabs are about 452px, the lockup 113px, the
   verdict pill up to 229px, and the gutters 66px: the header needs 776px
   before a page has teleported anything into it. The nearest rung above that
   is 900, so that is where the tabs become a drawer - a tablet in portrait
   gets the drawer too, and the alternative was a fourth breakpoint at 780
   that exists only for this element.

   IT USED TO BE HIDDEN RATHER THAN FIXED. `overflow: hidden` on the old
   wrapper meant this never reported: between 640 and 900 the header simply
   overflowed and the clip ate the verdict's status light. Flattening the bar
   removed the clip, and the three-viewport walk named 44px on all nine routes
   within a minute.

   The tabs leave, the wordmark leaves, the header sticks, and a page's own
   toolbar gets a scrollable row of its own rather than being clipped to
   nothing. There is still exactly ONE #toolbar element - eight pages teleport
   into it and a second target would be two answers to one question. */
@media (max-width: 900px) {
  .bar {
    flex-wrap: wrap;
    row-gap: 10px;
    position: sticky;
    top: 0;
    z-index: var(--z-sticky);
    background: var(--bg);
  }

  .menu {
    display: flex;
  }

  .nav,
  .word {
    display: none;
  }

  .left {
    gap: 10px;
  }

  /* Row one is the menu, the glyph and the verdict. Row two is whatever the
     page teleported, full width, at the gutter and scrollable in place - the
     System page sends an OS line, a staged chip and a window picker, which is
     about 400px of controls that used to be clipped to nothing. */
  .verdict {
    order: 2;
    flex: 0 1 auto;
  }

  .toolbar {
    order: 3;
    flex: 1 0 100%;
    justify-content: flex-start;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
  }
}
</style>
