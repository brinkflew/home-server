import { createRouter, createWebHistory } from "vue-router";

/**
 * Seven nav entries, and the last one is three views.
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
    {
      path: "/system",
      name: "system",
      component: () => import("@/pages/SystemPage.vue"),
    },
    {
      path: "/services",
      name: "services",
      component: () => import("@/pages/ServicesPage.vue"),
    },
    {
      path: "/network",
      name: "network",
      component: () => import("@/pages/NetworkPage.vue"),
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
    // AGENTS IS NESTED, AND IT IS THE ONLY SECTION THAT IS. One page had grown
    // to nine panels answering three different questions - is the fleet
    // working, what did this round do, and what is the machinery costing. The
    // parent carries the sub-navigation and the toolbar note; the children are
    // the three answers. See pages/agents/AgentsLayout.vue.
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
});
