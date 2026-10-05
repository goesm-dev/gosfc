// @gosfc/astro: a thin Astro integration.
//
// It adds @astrojs/vue (unless the project already has it) and the
// @gosfc/vite plugin. Rendering, SSR, SSG, islands, client:* directives and
// HTML generation stay with Astro and @astrojs/vue; a component with
// <script setup lang="go"> is an ordinary Vue component to them.
//
// The plugin also compiles the Go of .astro files: a frontmatter that opens
// with ---go becomes a TypeScript frontmatter running the lowered Go once per
// render, and <script lang="go"> becomes an ordinary processed <script> that
// runs the lowered Go in the browser. Astro compiles the rewritten file as
// usual.

import vue from "@astrojs/vue";
import gosfcVite from "@gosfc/vite";

/**
 * @param {{ vue?: import("@astrojs/vue").Options }} [options] options passed to
 *   @astrojs/vue when gosfc adds it
 * @returns {import("astro").AstroIntegration}
 */
export default function gosfc(options = {}) {
  return {
    name: "@gosfc/astro",
    hooks: {
      "astro:config:setup": ({ config, updateConfig }) => {
        const hasVue = config.integrations.some((i) => i.name === "@astrojs/vue");
        updateConfig({
          integrations: hasVue ? [] : [vue(options.vue)],
          vite: { plugins: [gosfcVite()] },
        });
      },
    },
  };
}
