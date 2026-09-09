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
/* THE CONTROL ROW IS DECLARED, BECAUSE THIS HEADER HAD NO HEIGHT OF ITS OWN. It
   was 28px of padding plus whatever its tallest child happened to be, so a route
   teleporting a WindowPicker got a 2px taller header than one teleporting a note
   - and the header is not sticky above 900, so the whole page body stepped down
   on navigation. In the 900-1180 band, which nothing had ever sampled, it was
   27px: /home's two freshness readings wrapped to four stacked lines.

   35px is ceil(34.19), the WindowPicker measured - a 1px border and 2px of
   padding around a .pick of 5px/11px over --t-mono-md's 18.19px line. It also
   clears the 34px .menu button below 900 and the 34px a ChipLink becomes under
   (pointer: coarse), where base.css redefines --pad-chip to 7px 10px. Every
   element in here carries an explicit unitless line-height, so none of this
   depends on whether the webfont has loaded.

   --bar-row RATHER THAN --row, which tokens.css already defines as a gradient.
   It has no consumer today, but page content is teleported INTO this subtree, so
   a page reaching for background: var(--row) would silently be handed 35px.

   IT IS A FLOOR AND fixtures/shoot.mjs IS THE CEILING. A `height` would slice an
   over-tall payload in silence, since the toolbar clips in both directions; a
   floor lets one grow the header where the walk can name the route. That
   division is what makes the number honest rather than a claim. */
.bar {
  --bar-row: 35px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 14px var(--pad-page);
  border-bottom: 1px solid var(--line);
}

/* THE NAV NEVER COMPRESSES AND THE TOOLBAR ALWAYS CAN. The type going from
   12px to 13px widened the tabs, and the page that teleports the most into this
   bar is Library - a search field, a chip and a window picker. With everything
   shrinkable the mark lost its wordmark and a teleported line wrapped, which
   took the whole header to 75px and put a tab under it. A page's own toolbar is
   the half that may give way, so it is the half that shrinks.

   THAT FIXED THE WRAP FOR THE NAV AND NOT FOR THE TOOLBAR'S OWN TEXT, which is
   what `white-space: nowrap` below is for. Giving way by wrapping is still
   giving way in the one direction that moves the page.

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

  /* Above 900 the three children share one row and this is the one that is
     always here, so flooring it pins the bar even when the toolbar has removed
     itself - which is the deferred Teleport's first mount, and would be any
     route that teleported nothing. Measured with #toolbar emptied: 64px with
     this floor, 61.14 without it, at 1360 and at 901 alike. */
  min-height: var(--bar-row);
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

/* THIS IS THE ONLY CHILD THAT CAN GIVE WAY, and until 2026-09-09 the way it gave
   was to WRAP. .left and .verdict are both flex: none, so between the 900 rung and
   about 1180 this is crushed to 32-231px and a teleported note broke across
   lines - `asks the fleet` became three of them at 960, /home's two ages four at
   901. overflow: hidden does not prevent that: it clips horizontally and grows
   vertically, which is the one direction that moves the page.

   nowrap IS ON THE CONTAINER RATHER THAN ON EACH PAYLOAD. It inherits, so it
   governs the eleven teleport sites and any written later; putting .truncate on
   the five .note rules would have fixed five call sites and said nothing about
   the sixth. It makes "the toolbar is the half that gives way" mean clip, which
   is what the overflow below already intended.

   The floor is here as well as on .left because below 900 this is a row of its
   own, and .left cannot speak for a row it is not in. */
.toolbar {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  min-height: var(--bar-row);
  white-space: nowrap;
  overflow: hidden;
}

/* The four section layouts teleport nothing but a note. NO ROUTE TELEPORTS
   NOTHING - ten sites in ten files, every one of them unconditional - so this
   never fires today. It is here because an empty flex item still opens a flex
   line once the header wraps, and display: none outranks the floor above it
   while a floor cannot reach a row that is not there at all. The .left floor
   is what holds the wide case if this ever does fire; measured, 64px against
   61.14 without it. */
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
   nothing. There is still exactly ONE #toolbar element - ten sites in ten
   files teleport into it and a second target would be two answers to one
   question.

   AND THE ROW IS FLOORED HERE TOO, because these are two rows rather than one:
   the header is a constant 109px on every route below 900 against 88.4-107.2
   before. Nine of the fourteen routes pay 18px of sticky header on a phone for
   it, which is the price of a constant and 35px is the smallest one available.
   If that is ever judged too much, the lever is this bar's own 14px padding
   below 900 - never the row, which is what a control needs to be. */
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
     Library page sends a search field, a chip and a window picker, which is
     about 400px of controls that used to be clipped to nothing.

     A CLASSIC SCROLLBAR WOULD ADD ITS OWN HEIGHT HERE, on exactly the routes
     whose controls overflow. base.css gives it 9px, and Library is the only
     route that reaches it - measured at 390, 405px of controls in a 362px row,
     against 362 in 362 on the other nine; on touch, and in the headless Chromium the walk
     uses, it is an overlay and costs nothing. Not worth scrollbar-gutter: an
     always-present empty trough under `read only` on thirteen routes is a
     worse trade than 9px on one. */
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
