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
//
// The Go that runs in the browser is a program of its own (see @gosfc/vite):
// the Go frontmatter of .astro files, and the go: imports of their
// TypeScript frontmatter, of endpoints, middleware and actions, are the
// server's only.
//
// The types of the Go packages TypeScript imports with go: go to a file
// Astro references from .astro/types.d.ts (injectTypes), which the plugin
// rewrites when it compiles; astro sync (and so astro check) compiles the
// Go to write it.

import gosfcVite, { GO_TYPES_PLACEHOLDER, goPrerender, scanGoImportTypes, writeTypes } from "@gosfc/vite";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const TYPES_FILE = "go-imports.d.ts";

/**
 * @typedef {{
 *   vue?: false | import("@astrojs/vue").Options,
 *   routes?: Record<string, string | { package: string, prerender?: boolean }>,
 *   middleware?: string | string[],
 * }} GosfcAstroOptions
 *   vue: options passed to @astrojs/vue when gosfc adds it, or false not to add it;
 *   routes: endpoints written in Go, by route pattern ("/api/[id].json"): the
 *     import path of a Go package that exports GET, POST, ... (and whether
 *     the route is prerendered);
 *   middleware: Go packages that export OnRequest, run before the
 *     middleware of src/middleware.
 */

/**
 * @param {GosfcAstroOptions} [options]
 * @returns {import("astro").AstroIntegration}
 */
export default function gosfc(options = {}) {
  /** @type {string | undefined} the file of the types of go: imports */
  let typesFile;
  let command = "";
  /** @type {string | undefined} the project's root directory */
  let root;
  return {
    name: "@gosfc/astro",
    hooks: {
      "astro:config:setup": async ({ config, command: c, updateConfig, injectRoute, addMiddleware, createCodegenDir }) => {
        command = c;
        root = fileURLToPath(config.root);
        // Endpoints and middleware in Go: Astro imports a module, generated
        // in the integration's directory of .astro/, that re-exports the
        // functions of the Go package (Astro reads a route's file, so it is
        // a file rather than a virtual module).
        const routes = Object.entries(options.routes ?? {});
        const middleware = [options.middleware ?? []].flat();
        if (routes.length || middleware.length) {
          const dir = fileURLToPath(createCodegenDir());
          for (const [pattern, r] of routes) {
            const { package: pkg, prerender } = typeof r === "string" ? { package: r, prerender: undefined } : r;
            const spec = JSON.stringify("go:" + pkg);
            // The methods (GET, POST, ...) keep their names; GetStaticPaths
            // is getStaticPaths.
            const entrypoint = entryFile(dir, "routes", pkg, `import * as go from ${spec};\nexport * from ${spec};\nexport const getStaticPaths = Reflect.get(go, "GetStaticPaths");\n`);
            injectRoute({ pattern, entrypoint, ...(prerender === undefined ? {} : { prerender }) });
          }
          for (const pkg of middleware) {
            const entrypoint = entryFile(dir, "middleware", pkg, `export { OnRequest as onRequest } from ${JSON.stringify("go:" + pkg)};\n`);
            addMiddleware({ entrypoint, order: "pre" });
          }
        }
        const integrations = [];
        if (options.vue !== false && !config.integrations.some((i) => i.name === "@astrojs/vue")) {
          const vue = await loadVue(config.root);
          if (vue) integrations.push(vue(options.vue));
        }
        const src = config.srcDir && fileURLToPath(config.srcDir);
        updateConfig({ integrations, vite: { plugins: [gosfcVite({ dts: () => typesFile, serverOnly: (file) => !!src && serverOnly(src, file) })] } });
      },
      // Astro reads a page's prerender option from its source, as
      // `export const prerender = ...`; a Go frontmatter declares it as
      // `const Prerender = ...`.
      "astro:route:setup": ({ route }) => {
        if (!root || !route.component.endsWith(".astro")) return;
        let code;
        try {
          code = readFileSync(path.resolve(root, route.component), "utf8");
        } catch {
          return;
        }
        const prerender = goPrerender(code);
        if (prerender !== undefined) route.prerender = prerender;
      },
      "astro:config:done": async ({ config, injectTypes, logger }) => {
        // Astro references the file, which gosfc writes itself (an empty
        // content leaves it as it is): the plugin rewrites it after it
        // compiles.
        typesFile = fileURLToPath(injectTypes({ filename: TYPES_FILE, content: "" }));
        if (command === "sync") {
          try {
            const content = await scanGoImportTypes(fileURLToPath(config.root), [fileURLToPath(config.outDir)]);
            if (content) writeTypes(typesFile, content);
          } catch (e) {
            logger.warn(`the types of go: imports were not updated: ${/** @type {Error} */ (e).message}`);
          }
        }
        if (!existsSync(typesFile)) writeTypes(typesFile, GO_TYPES_PLACEHOLDER);
      },
    },
  };
}

/**
 * Writes the module of a route or middleware written as the Go package pkg
 * to dir/kind/<pkg>.js, unless it holds content, and returns its path.
 * @param {string} dir
 * @param {string} kind
 * @param {string} pkg
 * @param {string} content
 */
function entryFile(dir, kind, pkg, content) {
  const file = path.join(dir, kind, ...pkg.split("/")) + ".js";
  writeTypes(file, content);
  return file;
}

/**
 * Whether a JavaScript or TypeScript file under the source directory src
 * runs on the server only: an endpoint (src/pages), the middleware
 * (src/middleware.ts or src/middleware/) or an action (src/actions).
 * @param {string} src
 * @param {string} file
 */
export function serverOnly(src, file) {
  const rel = path.relative(src, file).split(path.sep).join("/");
  if (rel.startsWith("../") || !/\.[cm]?[jt]sx?$/.test(rel)) return false;
  return /^(?:pages|actions|middleware)\//.test(rel) || /^middleware\.[cm]?[jt]s$/.test(rel);
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
