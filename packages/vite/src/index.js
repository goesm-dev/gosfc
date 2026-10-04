// @gosfc/vite: compiles <script setup lang="go"> in Vue SFCs through goesm.
//
// The plugin runs before @vitejs/plugin-vue (enforce: "pre") and only touches
// .vue files that contain <script setup lang="go">. Everything else, including
// Vue + TypeScript components, reaches @vitejs/plugin-vue unchanged. It does
// not compile templates or styles, bundle, or render: plugin-vue, Vite,
// Rolldown and Vue do.
//
// It also serves the TypeScript tree goesm produced, as virtual modules whose
// ids mirror goesm's output layout below gosfc:goesm/:
//   go:<import path>      -> gosfc:goesm/<import path>.ts        (the glue's import, or an
//                            import from a .js / .ts / .astro module, which compiles
//                            that package in the importing file's Go module)
//   @goesm/runtime        -> gosfc:goesm/@goesm/runtime/index.ts (the bridge's import)
//   "./x.ts", "../y.ts"   -> resolved relative to the importing virtual id
//                            (goesm's modules import each other and the runtime this way)
//   gosfc:bridge.js       -> runtime/bridge.js (template bindings)
// The ids end in .ts so that Vite's own TypeScript transform handles them,
// and each load returns goesm's source map (generated TS -> .vue / .go),
// which Vite composes into the final JS -> .vue / .go map.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compilePackage, compileSfc, mayHaveGoSetup, placeholderSfc, RUNTIME_ID } from "./compile.js";

const PREFIX = "gosfc:";
const TREE_PREFIX = PREFIX + "goesm/";
const GO_PREFIX = TREE_PREFIX;
const RT_PREFIX = TREE_PREFIX + "@goesm/runtime/";
const BRIDGE_ID = RUNTIME_ID;
const GO_IMPORT = /["']go:/;
// Specifiers of static and dynamic imports and re-exports: from "go:..." and import("go:...").
const GO_IMPORTS = /\b(?:from|import)\s*\(?\s*(["'])go:([^"'\s]+)\1/g;
const BRIDGE_FILE = fileURLToPath(new URL("../runtime/bridge.js", import.meta.url));

/**
 * @returns {import("vite").Plugin}
 */
export default function gosfc() {
  /** @type {import("vite").ResolvedConfig} */
  let config;
  /** @type {import("vite").ViteDevServer | undefined} */
  let server;
  /** virtual id -> generated module */
  const modules = new Map();
  /** environment name -> (virtual id -> code it last loaded) */
  const loaded = new Map();
  /** .go file -> .vue files (and JS modules importing go:) whose Go code depends on it */
  const goDependents = new Map();

  /** .vue file -> last successful compilation, keyed by its source */
  const compiled = new Map();

  const setModule = (id, code, map) => modules.set(id, { code, map });
  const addGoDependent = (goFile, id) => {
    if (!goDependents.has(goFile)) goDependents.set(goFile, new Set());
    goDependents.get(goFile).add(id);
  };

  // A compilation is reused while the .vue source and the .go files it was
  // built from are unchanged.
  const goStamp = (files) => files.map((f) => (existsSync(f) ? statSync(f).mtimeMs : 0)).join(",");
  async function compile(code, id) {
    const c = compiled.get(id);
    if (c && c.code === code && (!c.result || c.stamp === goStamp(c.result.goFiles))) return c.result;
    const result = await compileSfc(code, id, { root: config.root });
    compiled.set(id, { code, result, stamp: result ? goStamp(result.goFiles) : "" });
    return result;
  }

  /** import path + "\0" + importer -> stamp of the .go files it was compiled from */
  const jsCompiled = new Map();
  async function compileImport(importPath, importer, ctx) {
    const key = importPath + "\0" + importer;
    const c = jsCompiled.get(key);
    if (c && c.stamp === goStamp(c.goFiles)) return;
    const result = await compilePackage(importPath, importer);
    jsCompiled.set(key, { goFiles: result.goFiles, stamp: goStamp(result.goFiles) });
    for (const m of result.modules) setModule(GO_PREFIX + m.importPath + ".ts", m.code, m.map);
    for (const f of result.runtime) setModule(RT_PREFIX + f.file, f.code, null);
    for (const f of result.goFiles) {
      addGoDependent(f, importer);
      ctx.addWatchFile?.(f);
    }
    invalidateChanged(ctx, result.modules);
  }

  // Dev: if the Go side changed since this environment last loaded it,
  // invalidate the generated modules so that the re-imported component
  // gets fresh ones (Vite adds ?t= to their URLs). This is Vite's HMR;
  // gosfc adds no runtime of its own.
  function invalidateChanged(ctx, goModules) {
    if (!server || !ctx.environment) return;
    const seen = loaded.get(ctx.environment.name);
    const ids = goModules.map((m) => GO_PREFIX + m.importPath + ".ts");
    if (seen && ids.some((i) => seen.has(i) && seen.get(i) !== modules.get(i).code)) {
      const graph = ctx.environment.moduleGraph;
      const now = Date.now();
      for (const i of ids) {
        const mod = graph.getModuleById(i);
        if (mod) graph.invalidateModule(mod, new Set(), now, true);
      }
    }
  }

  return {
    name: "gosfc",
    enforce: "pre",

    // Vite's dependency scanner reads <script> blocks of .vue files as
    // JavaScript. A Go block only needs `vue` at run time (through the
    // bridge), so the scanner is shown that instead of Go source.
    config() {
      return {
        // Generated modules are virtual and must never be externalized.
        ssr: { noExternal: ["@goesm/runtime"] },
        optimizeDeps: {
          include: ["vue"],
          rolldownOptions: {
            plugins: [
              {
                name: "gosfc:scan",
                load: {
                  filter: { id: /\.vue$/ },
                  handler(id) {
                    const code = readFileSync(id, "utf8");
                    return mayHaveGoSetup(code) ? 'import "vue";\nexport default {};\n' : null;
                  },
                },
              },
            ],
          },
        },
      };
    },

    configResolved(c) {
      config = c;
    },

    configureServer(s) {
      server = s;
    },

    async resolveId(source, importer) {
      if (source === BRIDGE_ID) return BRIDGE_ID;
      if (source.startsWith("go:")) {
        const importPath = source.slice(3);
        const id = GO_PREFIX + importPath + ".ts";
        // The glue of a .vue file imports the package its transform just
        // compiled. Any other module (.js, .ts, .astro) gets the package
        // compiled here, in the Go module of the importing file.
        const file = importer?.split("?")[0];
        if (file && !file.startsWith(PREFIX) && !file.startsWith("\0") && !file.endsWith(".vue")) {
          await compileImport(importPath, file, this);
        }
        if (!modules.has(id)) {
          this.error(`gosfc: Go package ${importPath} was not compiled; import it from <script setup lang="go"> or from a module inside a Go module`);
        }
        return id;
      }
      if (source === "@goesm/runtime") return RT_PREFIX + "index.ts";
      if (importer?.startsWith(TREE_PREFIX) && (source.startsWith("./") || source.startsWith("../"))) {
        const rel = path.posix.join(path.posix.dirname(importer.slice(TREE_PREFIX.length)), source);
        return TREE_PREFIX + (rel.endsWith(".ts") ? rel : rel + ".ts");
      }
      return null;
    },

    load(id) {
      if (id === BRIDGE_ID) return readFileSync(BRIDGE_FILE, "utf8");
      if (!id.startsWith(PREFIX)) return null;
      const m = modules.get(id);
      if (!m) return null;
      const env = this.environment?.name ?? "default";
      if (!loaded.has(env)) loaded.set(env, new Map());
      loaded.get(env).set(id, m.code);
      return { code: m.code, map: m.map };
    },

    async transform(code, id) {
      const file = id.split("?")[0];
      if (!file.endsWith(".vue") && !id.startsWith(PREFIX) && !id.startsWith("\0") && GO_IMPORT.test(code)) {
        // A JS / TS / Astro module importing Go packages: compile them now,
        // so that the .go files they come from are watched on behalf of this
        // module (an edit then reloads it).
        for (const m of code.matchAll(GO_IMPORTS)) await compileImport(m[2], file, this);
        return null;
      }
      if (!id.endsWith(".vue") || id.includes("?") || id.includes("\0")) return null;
      if (!mayHaveGoSetup(code)) return null;
      let result;
      try {
        result = await compile(code, id);
      } catch (e) {
        if (e && e.name === "GosfcError") {
          this.error({ message: e.message, id: e.id, loc: e.loc, frame: e.frame, plugin: "gosfc" });
        }
        throw e;
      }
      if (!result) return null;

      for (const m of result.modules) setModule(GO_PREFIX + m.importPath + ".ts", m.code, m.map);
      for (const f of result.runtime) setModule(RT_PREFIX + f.file, f.code, null);
      for (const f of result.goFiles) {
        addGoDependent(f, id);
        // Rebuild (vite build --watch) and invalidate (dev) on .go changes.
        this.addWatchFile(f);
      }
      invalidateChanged(this, result.modules);
      return { code: result.code, map: result.map };
    },

    // HMR stays @vitejs/plugin-vue's. It re-reads a changed .vue file through
    // ctx.read() and compares the old and new descriptors to decide between
    // re-rendering and reloading the component. gosfc runs before it and makes
    // read() return the compiled SFC, so plugin-vue compares Vue code (a
    // template-only edit re-renders, a Go edit reloads) instead of failing on
    // Go source.
    //
    // A change to a .go file of a package used by a component re-runs the
    // components that depend on it, which plugin-vue then reloads.
    async handleHotUpdate(ctx) {
      if (ctx.file.endsWith(".vue")) {
        const read = ctx.read;
        ctx.read = async () => {
          const raw = await read();
          if (!mayHaveGoSetup(raw)) return raw;
          try {
            return (await compile(raw, ctx.file))?.code ?? raw;
          } catch {
            // The error is reported when the component is requested again.
            return placeholderSfc(raw, ctx.file);
          }
        };
        return;
      }
      if (!ctx.file.endsWith(".go")) return;
      const vues = goDependents.get(ctx.file);
      if (!vues) return;
      const mods = [];
      for (const v of vues) {
        compiled.delete(v);
        for (const mod of server.moduleGraph.getModulesByFile(v) ?? []) {
          if (mod.id && !mod.id.includes("?")) {
            server.moduleGraph.invalidateModule(mod, new Set(), ctx.timestamp, true);
            mods.push(mod);
          }
        }
      }
      return mods.length ? [...ctx.modules, ...mods] : undefined;
    },
  };
}

export { compileSfc } from "./compile.js";
