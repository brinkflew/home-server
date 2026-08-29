// Screenshots every page against the dev fixtures, at THREE viewports, and
// reports every console error, page error, failed request and horizontal
// overflow.
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

// THE THREE RUNGS, MADE EXECUTABLE. 1360x860 is the design's reference viewport
// and was the only one this script ever used, which is exactly why the app had
// no layout below 1100px: nothing ever looked. 834 is a tablet in portrait and
// 390 a phone, and the phone one crosses every rung at once.
const VIEWPORTS = [
  { name: "wide", width: 1360, height: 860 },
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
  "system",
  "services",
  "network",
  "ci",
  "agents",
  "agents/fleet",
  ...(deep ? [deep.replace(/^\//, "")] : []),
];

for (const vp of VIEWPORTS) {
  await page.setViewportSize({ width: vp.width, height: vp.height });

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
}

console.log(`\n--- ${problems.length} problem(s)`);
for (const p of [...new Set(problems)].slice(0, 30)) console.log(`  ${p}`);

await browser.close();
process.exit(problems.length ? 1 : 0);
