import { createApp } from "vue";
import { createPinia } from "pinia";

// Vendored, not fetched. The design document links Google Fonts; a page behind
// single sign-on that reaches out to a third party on every load is exactly
// what apps/jellyfin/custom.css was rewritten to stop doing.
//
// SPLINE SANS AND SPLINE SANS MONO, NOT GEIST AND AZERET. The design system
// substituted them and gave both a practical and a design reason: it could not
// read node_modules, and the mono is the sans's metric sibling, so a label and
// its value sit on the same x-height. Every size and leading in tokens.css was
// chosen against these metrics.
//
// VARIABLE FACES, so one file per face carries 300-700 rather than three
// static weights each - four woff2 in total, latin and latin-ext. `wght.css`
// rather than `index.css` because the mono ships an italic axis this design
// never sets, and index.css would pull both.
//
// THE FAMILY NAME CARRIES "Variable" AND THAT IS NOT COSMETIC: @font-face here
// declares `Spline Sans Variable`, so a --font-ui naming plain "Spline Sans"
// matches nothing and falls through to system-ui with no error anywhere.
import "@fontsource-variable/spline-sans/wght.css";
import "@fontsource-variable/spline-sans-mono/wght.css";

import "@/styles/tokens.css";
import "@/styles/base.css";

import App from "@/App.vue";
import { router } from "@/router";

createApp(App).use(createPinia()).use(router).mount("#app");
