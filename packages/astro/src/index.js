// @gosfc/astro: a thin Astro integration.
//
// It adds @astrojs/vue when the project has it installed and has not added
// it itself, and the @gosfc/vite plugin. Rendering, SSR, SSG, islands,
// client:* directives and HTML generation stay with Astro and @astrojs/vue;
// a component with <script setup lang="go"> is an ordinary Vue component to
// them.
//
// The plugin also compiles the Go of .astro files: a frontmatter that opens
// with ---go becomes a TypeScript frontmatter running the lowered Go once per
// render, and <script lang="go"> becomes an ordinary processed <script> that
// runs the lowered Go in the browser. Astro compiles the rewritten file as
// usual. A project with Go only in .astro files needs neither Vue nor
// @astrojs/vue.

import gosfcVite from "@gosfc/vite";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * @param {{ vue?: false | import("@astrojs/vue").Options }} [options] options
 *   passed to @astrojs/vue when gosfc adds it, or false not to add it
 * @returns {import("astro").AstroIntegration}
 */
export default function gosfc(options = {}) {
  return {
    name: "@gosfc/astro",
    hooks: {
      "astro:config:setup": async ({ config, updateConfig }) => {
        const integrations = [];
        if (options.vue !== false && !config.integrations.some((i) => i.name === "@astrojs/vue")) {
          const vue = await loadVue(config.root);
          if (vue) integrations.push(vue(options.vue));
        }
        updateConfig({ integrations, vite: { plugins: [gosfcVite()] } });
      },
    },
  };
}

/**
 * Imports @astrojs/vue as the project at root resolves it, an optional peer
 * dependency: undefined when it is not installed.
 * @param {URL} root
 */
async function loadVue(root) {
  let file;
  try {
    file = createRequire(new URL("package.json", root)).resolve("@astrojs/vue");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "MODULE_NOT_FOUND") return undefined;
    throw e;
  }
  return (await import(pathToFileURL(file).href)).default;
}
