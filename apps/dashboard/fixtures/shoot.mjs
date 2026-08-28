// Screenshots the four pages against the dev fixtures, at the design's viewport,
// and reports every console error, page error and failed request.
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
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });

const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console: ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

for (const route of ["home", "library", "system", "services", "network", "ci", "agents"]) {
  await page.goto(`http://localhost:5173/${route}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${route}.png` });
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  console.log(`\n=== /${route}  (${text.length} chars of text)`);
  console.log(text.slice(0, 700));

  // THE ONE ASSERTION IN THIS FILE, and it is here because nowhere else can
  // make it. `smoke.mjs` drives `src/control.ts` in node and never mounts a
  // component, so "does a pressable control appear on the page" is a question
  // the only logic test this repository has cannot answer.
  //
  // IT ASSERTS THE ELEMENT, NOT THE TEXT. ChipButton renders an inert <span>
  // rather than a <button> when it is disabled - the correct rendering for an
  // unset token, and one indistinguishable at a glance from a control that has
  // quietly stopped being offered. The fixture host has a token, so on these
  // fixtures it must be a real button.
  //
  // THE SIGNAL IS THE NAMED LINE, NOT THE EXIT CODE. This script already exits
  // non-zero on the fixture host by construction - the deliberately missing
  // poster is one expected 404 and it counts as a problem - so a reader has to
  // look at what was reported rather than at whether anything was.
  //
  // AND IT WOULD NOT HAVE CAUGHT WHY THIS TILE EXISTS. A control buried six
  // panels down renders exactly like a prominent one; what this catches is the
  // control vanishing or degrading, never it being hard to find.
  if (route === "agents") {
    const tile = page.locator(".tile").filter({ has: page.getByText("intake", { exact: true }) });
    const chip = tile.locator("button.chip");
    const found = await chip.count();
    if (found !== 1) {
      problems.push(`agents: the intake tile offers ${found} pressable chips, want 1`);
    } else if (!(await chip.first().isEnabled())) {
      problems.push("agents: the intake chip is not pressable");
    } else {
      const label = (await chip.first().innerText()).trim();
      if (label !== "arm" && label !== "disarm") {
        problems.push(`agents: the intake chip reads ${JSON.stringify(label)}`);
      }
    }
  }
}

console.log(`\n--- ${problems.length} problem(s)`);
for (const p of [...new Set(problems)].slice(0, 15)) console.log(`  ${p}`);

await browser.close();
process.exit(problems.length ? 1 : 0);
