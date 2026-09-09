// Screenshots every page against the dev fixtures, at FOUR viewports, and
// reports every console error, page error, failed request, horizontal overflow
// and any route whose shell header is a different height from the others'.
//
// PLAYWRIGHT IS DELIBERATELY NOT A DEPENDENCY. `npm run build` is the only test
// this repository has, and adding a browser download to it for a script nobody
// runs in CI would be a poor trade. So this asks for it explicitly rather than
// being quietly unrunnable - the same reason lint-repo.sh SKIPs loudly without
// shellcheck instead of reporting that it passed.
//
//   npm i --no-save --no-package-lock playwright
//   npx playwright install chromium
//   npm run dev &
//   node fixtures/shoot.mjs [outDir]
//
// The fixture host is deliberately unhealthy, so ONE 404 is expected: the
// missing-poster path that exists to put the fallback tile on screen.
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "fixtures/shoot.mjs needs playwright, which is not a dependency of this app.\n" +
      "  npm i --no-save --no-package-lock playwright && npx playwright install chromium",
  );
  process.exit(2);
}

const out = process.argv[2] ?? "/tmp";
const browser = await chromium.launch();

// THE THREE RUNGS, MADE EXECUTABLE - AND THE BAND BETWEEN TWO OF THEM. 1360x860
// is the design's reference viewport and was the only one this script ever used,
// which is exactly why the app had no layout below 1100px: nothing ever looked.
// 834 is a tablet in portrait and 390 a phone, and the phone one crosses every
// rung at once.
//
// 901 IS NOT A RUNG, IT IS THE BAND THREE RUNGS LEAVE UNSAMPLED. Three rungs make
// four bands and this walk covered three of them, so 900-1180 was never looked at
// - the one band where the shell header is squeezed but has not yet wrapped, and
// the toolbar is the only child that can give way. The header measured 61px, 65px,
// 83px and 90px on four routes here - and THE TOOLBAR IS 0px WIDE at 901, so the
// payload is clipped to nothing while its wrapped lines still push the height.
// /home grew 29px for two freshness readings that were not on screen at all. One
// pixel above the rung is the worst case of it, so that is where the sample goes.
const VIEWPORTS = [
  { name: "wide", width: 1360, height: 860 },
  { name: "rung", width: 901, height: 900 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "phone", width: 390, height: 844 },
];

const page = await browser.newPage({ viewport: VIEWPORTS[0] });

const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console: ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

// A round's key is minted from the fixture clock at module load, so it cannot
// be hardcoded. Read it off the board rather than guessing - which also proves
// the row is a link, which is the whole navigation model of that table.
await page.goto("http://localhost:5173/agents/rounds", { waitUntil: "networkidle" });
const deep = await page.locator("a.state").first().getAttribute("href");
if (!deep) problems.push("agents: no round on the board carries a link to its own page");

const routes = [
  "home",
  "library",
  // EVERY VIEW OF EVERY SECTION, not every section. The bare path only proves
  // the redirect; the children it redirects past are where every table, every
  // chart and every drawing in this application now lives. Four of the seven
  // tabs are sections as of 2026-09-08, so this list is twice the nav.
  "system",
  "system/load",
  "system/storage",
  "services",
  "services/list",
  "services/apps",
  "network",
  "network/map",
  "ci",
  "agents",
  "agents/fleet",
  ...(deep ? [deep.replace(/^\//, "")] : []),
];

for (const vp of VIEWPORTS) {
  await page.setViewportSize({ width: vp.width, height: vp.height });

  // Per viewport, because the four bands legitimately differ from each other.
  // What is asserted is that the routes agree WITHIN one.
  const barHeights = new Map();

  for (const route of routes) {
    await page.goto(`http://localhost:5173/${route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const slug = route.replace(/\//g, "-");
    await page.screenshot({ path: `${out}/${slug}.${vp.name}.png`, fullPage: vp.name !== "wide" });

    // THE ASSERTION THAT CATCHES EVERY FIXED-WIDTH REGRESSION IN THE APP, and
    // the one the codebase most needed: the shell header alone used to force a
    // 649px document on a 375px screen, on every page, whatever it contained.
    //
    // IT IS CHECKED RATHER THAN SUPPRESSED. `overflow-x: hidden` on body would
    // have hidden this instead of fixing it - and hidden it worst on touch,
    // where the scrollbar is an overlay and a page running off the right edge
    // is already silent. Absence is the finding.
    const spill = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (spill > 1) {
      problems.push(`/${route} @${vp.width}: ${spill}px of horizontal overflow`);
    }

    // THE HEADER IS ONE HEIGHT OR THE WHOLE PAGE MOVES WHEN YOU NAVIGATE. It had
    // no height of its own - 28px of padding plus whatever its tallest child
    // happened to be - so the five routes that teleport a WindowPicker were 2px
    // taller than the eight that do not, and above 900 the header is not sticky,
    // so the entire body stepped down. In the band this walk never sampled it was
    // 27px rather than 2.
    //
    // NO NUMBER LIVES HERE. The row height is declared once, in NavBar.vue's own
    // scoped CSS; this asserts only that every route agrees with every other, so
    // changing that row deliberately is one edit and this follows it rather than
    // fighting it. The floor is in the CSS and the ceiling is here.
    //
    // `header.bar`, NOT `header`: PanelBox renders a <header class="head"> for
    // every panel on the page, so the bare tag is whichever one is first in
    // document order. And getBoundingClientRect rather than offsetHeight, which
    // rounds to an integer - CiPage.vue records the previous instance of this
    // defect as "a pixel taller than every other page", and an integer would
    // have hidden it.
    const bar = await page.evaluate(() => {
      const el = document.querySelector("header.bar");
      return el ? el.getBoundingClientRect().height : null;
    });
    // Thirteen nulls agree with each other, which is the trap the .cond selector
    // above already records: a stale selector reports nothing and passes.
    if (bar === null) problems.push(`/${route} @${vp.width}: no shell header on the page`);
    else barHeights.set(`/${route}`, Math.round(bar * 100) / 100);

    if (vp.name === "wide") {
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
      console.log(`\n=== /${route}  (${text.length} chars of text)`);
      console.log(text.slice(0, 700));
    }

    // THE INTAKE CONTROL, and it must be a real button.
    //
    // `smoke.mjs` drives `src/control.ts` in node and never mounts a component,
    // so "does a pressable control appear on the page" is a question the only
    // logic test this repository has cannot answer.
    //
    // IT ASSERTS THE ELEMENT, NOT THE TEXT. ChipButton renders an inert <span>
    // rather than a <button> when it is disabled - the correct rendering for an
    // unset token, and one indistinguishable at a glance from a control that
    // has quietly stopped being offered. The fixture host has a token, so on
    // these fixtures it must be a real button.
    //
    // THE SIGNAL IS THE NAMED LINE, NOT THE EXIT CODE. This script already
    // exits non-zero on the fixture host by construction - the deliberately
    // missing poster is one expected 404 and it counts as a problem - so a
    // reader has to look at what was reported rather than at whether anything
    // was.
    //
    // AND IT WOULD NOT HAVE CAUGHT WHY THIS CONTROL SITS WHERE IT DOES. One
    // buried six panels down renders exactly like a prominent one; what this
    // catches is the control vanishing or degrading, never it being hard to
    // find. The selector is `.cond` because the fleet header stopped being five
    // equal tiles - it was `.tile`, and a stale selector here reports nothing
    // and passes.
    if (route === "agents") {
      const cond = page.locator(".cond").filter({ has: page.getByText("intake", { exact: true }) });
      const chip = cond.locator("button.chip");
      const found = await chip.count();
      if (found !== 1) {
        problems.push(`agents @${vp.width}: the intake control offers ${found} chips, want 1`);
      } else if (!(await chip.first().isEnabled())) {
        problems.push(`agents @${vp.width}: the intake chip is not pressable`);
      } else {
        const label = (await chip.first().innerText()).trim();
        if (label !== "arm" && label !== "disarm") {
          problems.push(`agents @${vp.width}: the intake chip reads ${JSON.stringify(label)}`);
        }
      }

      // Below 900 the seven tabs are not in the header at all, so the only way
      // to reach another page is the drawer. A menu that opens onto nothing is
      // the app with no navigation whatsoever - and it is asserted at BOTH
      // viewports under the rung, because the tablet one is where the header
      // was overflowing by 44px with nothing on screen to say so.
      if (vp.name === "phone" || vp.name === "tablet") {
        await page.locator("header .menu").click();
        // Past the slide, or the capture is a drawer halfway on screen.
        await page.waitForTimeout(400);
        const entries = await page.locator(".drawer .entry").count();
        if (entries !== 7) {
          problems.push(`drawer @${vp.width}: ${entries} entries, want 7`);
        }
        await page.screenshot({ path: `${out}/drawer.${vp.name}.png` });
        await page.keyboard.press("Escape");
      }
    }
  }

  // GROUPED, SO THE LINE NAMES THE ROUTES RATHER THAN A NUMBER. The majority
  // height is the baseline and every other group is listed by route, which is
  // the difference between "the header varies" and "these five pages teleport
  // something taller than the nav".
  //
  // NO TOLERANCE. Every route is measured in one browser at one viewport, so any
  // device rounding applies equally to all of them; 2dp is only to normalise
  // float noise, and it is well under Blink's 1/64px layout unit. A tolerance
  // here would license exactly the sub-pixel coincidence this fix rejected.
  const byHeight = new Map();
  for (const [route, h] of barHeights) {
    const k = h.toFixed(2);
    if (!byHeight.has(k)) byHeight.set(k, []);
    byHeight.get(k).push(route);
  }
  if (byHeight.size > 1) {
    const [common, ...odd] = [...byHeight].sort((a, b) => b[1].length - a[1].length);
    problems.push(
      `header @${vp.width}: ${common[0]}px on ${common[1].length} routes, but ` +
        odd.map(([h, rs]) => `${h}px on ${rs.join(" ")}`).join("; "),
    );
  }
}

console.log(`\n--- ${problems.length} problem(s)`);
for (const p of [...new Set(problems)].slice(0, 30)) console.log(`  ${p}`);

await browser.close();
process.exit(problems.length ? 1 : 0);
