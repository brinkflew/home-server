import { createRouter, createWebHistory } from "vue-router";

/**
 * Seven nav entries, and four of them are several views each.
 *
 * `/` lands on Home now. It used to land on System, because Home was the stub and
 * sending someone to a page that says "not built" would have been a strange front
 * door. Home is the first entry in the nav and the page that answers "is anything
 * happening"; System is one click away, and the verdict chip in the nav is visible
 * from every page anyway.
 *
 * History mode, not hash: the container's Caddyfile does try_files {path}
 * /index.html, so a deep link and a reload both resolve.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/home" },
    // SYSTEM IS NESTED, FOR THE REASON AGENTS IS. SystemPage.vue reached 1,553
    // lines - longer than the AgentsPage that was split a week earlier - and
    // answered three questions at once, so somebody opening it because their
    // phone had buzzed scrolled past four bands of machinery to reach the alert
    // that sent them. The parent carries the sub-navigation and the toolbar
    // note; the children are the three answers. See pages/system/SystemLayout.vue.
    //
    // THE NAME STAYS ON THE DEFAULT CHILD, and the parent has none: a record
    // that only redirects is not a destination, and anything resolving
    // { name: "system" } must keep landing somewhere real.
    {
      path: "/system",
      component: () => import("@/pages/system/SystemLayout.vue"),
      children: [
        { path: "", redirect: "/system/health" },
        {
          path: "health",
          name: "system",
          component: () => import("@/pages/system/HealthPage.vue"),
        },
        {
          path: "load",
          name: "system-load",
          component: () => import("@/pages/system/LoadPage.vue"),
        },
        {
          path: "storage",
          name: "system-storage",
          component: () => import("@/pages/system/StoragePage.vue"),
        },
      ],
    },
    // SERVICES IS NESTED, AND IT WAS THE RACK THAT FORCED IT. ServicesPage.vue
    // was 957 lines, and the band in the middle - nineteen units by eight
    // columns, each row carrying a 24-bar CPU strip, a three-line memory cell
    // and a restart caption - was taller than the other three put together. So
    // the sentence that says what to type and the panel that says what the
    // battery found sat above and below an inventory nobody opens this page to
    // read. See pages/services/ServicesLayout.vue.
    {
      path: "/services",
      component: () => import("@/pages/services/ServicesLayout.vue"),
      children: [
        { path: "", redirect: "/services/health" },
        {
          path: "health",
          name: "services",
          component: () => import("@/pages/services/HealthPage.vue"),
        },
        {
          path: "list",
          name: "services-list",
          component: () => import("@/pages/services/ListPage.vue"),
        },
        {
          path: "apps",
          name: "services-apps",
          component: () => import("@/pages/services/ApplicationsPage.vue"),
        },
      ],
    },
    // NETWORK IS NESTED BECAUSE THE DRAWING WAS THE PAGE. NetworkGraph is the
    // tallest thing this application draws, and it was band four of five on a
    // page whose first question is "is the segmentation intact" - so the two
    // tables carrying the readings sat below it at every width. It is a view of
    // its own now, and clicking a node navigates to /network/overview with
    // ?focus= and #segments rather than filtering anything in place. See
    // pages/network/NetworkLayout.vue.
    {
      path: "/network",
      component: () => import("@/pages/network/NetworkLayout.vue"),
      children: [
        { path: "", redirect: "/network/overview" },
        {
          path: "overview",
          name: "network",
          component: () => import("@/pages/network/OverviewPage.vue"),
        },
        {
          path: "map",
          name: "network-map",
          component: () => import("@/pages/network/MapPage.vue"),
        },
      ],
    },
    {
      path: "/home",
      name: "home",
      component: () => import("@/pages/HomePage.vue"),
    },
    {
      path: "/library",
      name: "library",
      component: () => import("@/pages/LibraryPage.vue"),
    },
    // The two ephemeral fleets. They are last in the nav and separate from each
    // other because they answer different questions off different data planes -
    // CI is three lane markers, Agents is a document - and because a lane and a
    // phase runner are invisible to every other page here.
    {
      path: "/ci",
      name: "ci",
      component: () => import("@/pages/CiPage.vue"),
    },
    // AGENTS IS NESTED, AND IT WAS THE FIRST SECTION THAT WAS. One page had
    // grown to nine panels answering three different questions - is the fleet
    // working, what did this round do, and what is the machinery costing. The
    // parent carries the sub-navigation and the toolbar note; the children are
    // the three answers. See pages/agents/AgentsLayout.vue. /system followed it
    // on 2026-09-07, /services and /network on 2026-09-08, all for the same
    // reason - so four of the seven tabs are sections now, and a flat page is
    // the exception rather than the rule.
    //
    // A ROUND'S KEY IS THE COLLECTOR'S OWN FILENAME KEY, built by roundKey() in
    // src/api/round.ts from the worktree id and the round's start. It is
    // deliberately NOT carried in fleet.json: the two would then be a pair that
    // can disagree, and the pair that disagreed last time cost a blank board.
    {
      path: "/agents",
      component: () => import("@/pages/agents/AgentsLayout.vue"),
      children: [
        { path: "", redirect: "/agents/rounds" },
        {
          path: "rounds",
          name: "agents",
          component: () => import("@/pages/agents/RoundsPage.vue"),
        },
        {
          path: "rounds/:key",
          name: "agents-round",
          component: () => import("@/pages/agents/RoundPage.vue"),
        },
        {
          path: "fleet",
          name: "agents-fleet",
          component: () => import("@/pages/agents/FleetPage.vue"),
        },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/home" },
  ],

  /**
   * A HASH SCROLLS, AND NOTHING ELSE CHANGES. /network/map hands its click to
   * /network/overview as ?focus= plus #segments, and without this vue-router
   * would land the reader at the top of a page whose filtered table is two
   * bands down. Returning undefined for every hash-less navigation is what
   * keeps that from being a behaviour change everywhere else: the default is
   * "leave the scroll position alone", and the six pages that had it keep it.
   */
  scrollBehavior(to) {
    return to.hash ? { el: to.hash } : undefined;
  },
});
