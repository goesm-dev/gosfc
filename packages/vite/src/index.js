// @gosfc/vite: compiles <script setup lang="go"> in Vue SFCs, and the Go
// frontmatter (---go) and <script lang="go"> of .astro files, through goesm.
//
// The plugin runs before @vitejs/plugin-vue (enforce: "pre") and only touches
// .vue files that contain <script setup lang="go">. Everything else, including
// Vue + TypeScript components, reaches @vitejs/plugin-vue unchanged. It does
// not compile templates or styles, bundle, or render: plugin-vue, Vite,
// Rolldown and Vue do.
//
// .astro files with Go are rewritten when they are loaded rather than in
// transform, because Astro's own plugin compiles them in its transform, which
// may run first. Astro reads the source of an .astro file through the plugin
// container's load as well (for its sub-requests), so it always sees the
// rewritten file: TypeScript frontmatter and plain <script> elements.
//
// It also serves the TypeScript tree goesm produced, as virtual modules whose
// ids follow goesm's output layout below gosfc:goesm/:
//   go:<import path>      -> gosfc:goesm/<import path>.<hash>.ts (the glue's import, or an
//                            import from a .js / .ts / .astro module, which compiles
//                            that package in the importing file's Go module)
//   @goesm/runtime        -> gosfc:goesm/@goesm/runtime/index.ts  (the bridge's import)
//   "./x.ts", "../y.ts"   -> resolved relative to the importing virtual id
//                            (the runtime's files import each other this way)
//   gosfc:bridge.js       -> runtime/bridge.js (template bindings)
//   gosfc:astro.js        -> runtime/astro.js (Go frontmatter bindings)
//   gosfc:convert.js      -> runtime/convert.js (Go <-> JS values, used by both)
//   gosfc:astro-script/<n>/<file>.js
//                         -> the n-th <script lang="go"> of an .astro file, compiled
//                            when requested (also in Astro's client build, which has
//                            its own plugin instance)
// The ids end in .ts so that Vite's own TypeScript transform handles them,
// and each load returns goesm's source map (generated TS -> .vue / .go),
// which Vite composes into the final JS -> .vue / .go map.
//
// Each component (and each JS module importing go:) is its own goesm program,
// and the code goesm emits for a package depends on the whole program: a
// function value is async in one program and not in another, for example. So
// a package's module id carries a hash of its code and of the ids of the
// packages it imports, which goesm's relative imports are rewritten to.
// Programs that agree on a package share its module (and the bundler's chunk
// for it); programs that do not each get their own. The runtime is the same
// in every program and keeps plain ids.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASTRO_RUNTIME_ID,
  compileAstro,
  compileAstroScript,
  compilePackage,
  compileSfc,
  mayHaveGoAstro,
  mayHaveGoSetup,
  parseAstroScriptId,
  placeholderSfc,
  RUNTIME_ID,
} from "./compile.js";

const PREFIX = "gosfc:";
const TREE_PREFIX = PREFIX + "goesm/";
const GO_PREFIX = TREE_PREFIX;
const RT_PREFIX = TREE_PREFIX + "@goesm/runtime/";
const BRIDGE_ID = RUNTIME_ID;
const GO_IMPORT = /["']go:/;
// Specifiers of static and dynamic imports and re-exports: from "go:..." and import("go:...").
const GO_IMPORTS = /\b(?:from|import)\s*\(?\s*(["'])go:([^"'\s]+)\1/g;
// Relative specifiers in goesm's modules: import / export ... from "./x.ts", import("../y.ts").
const REL_IMPORTS = /(\b(?:from|import)\s*\(?\s*)"(\.\.?\/[^"]+)"/g;
const CONVERT_ID = PREFIX + "convert.js";
/** virtual id -> runtime file of gosfc */
const RUNTIME_FILES = new Map(
  [
    [BRIDGE_ID, "bridge.js"],
    [ASTRO_RUNTIME_ID, "astro.js"],
    [CONVERT_ID, "convert.js"],
  ].map(([id, f]) => [id, fileURLToPath(new URL("../runtime/" + f, import.meta.url))]),
);
const GO_KEYWORDS = new Set(["break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var"]);

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
  /** import path + "\0" + importing file -> virtual id of the package's module in that file's program */
  const entries = new Map();
  /** .go file -> .vue / .astro files, JS modules importing go: and ids of
   * client scripts of .astro files whose Go code depends on it */
  const goDependents = new Map();

  /** .vue file -> last successful compilation, keyed by its source */
  const compiled = new Map();

  const setModule = (id, code, map) => modules.set(id, { code, map });

  // Adds the modules of one goesm program, compiled for importer, under
  // content-addressed ids (see the top of this file).
  function addProgram(result, importer) {
    const byPath = new Map(result.modules.map((m) => [m.importPath, m]));
    /** import path -> virtual id */
    const ids = new Map();
    const idOf = (importPath, seen = new Set()) => {
      if (ids.has(importPath)) return ids.get(importPath);
      if (seen.has(importPath)) throw new Error(`gosfc: import cycle through ${importPath}`);
      seen.add(importPath);
      const m = byPath.get(importPath);
      const code = m.code.replace(REL_IMPORTS, (all, lead, spec) => {
        const target = path.posix.join(path.posix.dirname(importPath), spec).replace(/\.ts$/, "");
        const id = byPath.has(target) ? idOf(target, seen) : TREE_PREFIX + target + ".ts";
        return lead + JSON.stringify(id);
      });
      const hash = createHash("sha256").update(code).digest("hex").slice(0, 12);
      const id = GO_PREFIX + importPath + "." + hash + ".ts";
      setModule(id, code, m.map);
      ids.set(importPath, id);
      return id;
    };
    for (const m of result.modules) entries.set(m.importPath + "\0" + importer, idOf(m.importPath));
    for (const f of result.runtime) setModule(RT_PREFIX + f.file, f.code, null);
  }
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

  // The same for .astro files and their client scripts (keyed by virtual id).
  const astroCompiled = new Map();
  /**
   * @template T
   * @param {string} key
   * @param {string} code
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function cached(key, code, fn) {
    const c = astroCompiled.get(key);
    if (c && c.code === code && (!c.result || c.stamp === goStamp(c.result.goFiles))) return c.result;
    const result = await fn();
    astroCompiled.set(key, { code, result, stamp: result ? goStamp(result.goFiles) : "" });
    return result;
  }
  // register for compileAstro: the importing module is the .astro file (or
  // the client script's virtual id).
  const register = (importer) => (res, importPath) => {
    addProgram(res, importer);
    return entries.get(importPath + "\0" + importer);
  };
  const compileAstroFile = (code, id) => cached(id, code, () => compileAstro(code, id, { root: config.root, register: register(id) }));

  /** Reports a GosfcError at its .vue / .astro position. */
  function fail(ctx, e) {
    if (e && e.name === "GosfcError") {
      ctx.error({ message: e.message, id: e.id, loc: e.loc, frame: e.frame, plugin: "gosfc" });
    }
    throw e;
  }

  /** import path + "\0" + importer -> stamp of the .go files it was compiled from */
  const jsCompiled = new Map();
  async function compileImport(importPath, importer, ctx) {
    const key = importPath + "\0" + importer;
    const c = jsCompiled.get(key);
    if (c && c.stamp === goStamp(c.goFiles)) return;
    const result = await compilePackage(importPath, importer);
    jsCompiled.set(key, { goFiles: result.goFiles, stamp: goStamp(result.goFiles) });
    addProgram(result, importer);
    for (const f of result.goFiles) {
      addGoDependent(f, importer);
      ctx.addWatchFile?.(f);
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
                  filter: { id: /\.(?:vue|astro)$/ },
                  handler(id) {
                    const code = readFileSync(id, "utf8");
                    if (id.endsWith(".astro")) return mayHaveGoAstro(code) ? scanAstro(code) : null;
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
      if (RUNTIME_FILES.has(source)) return source;
      if (parseAstroScriptId(source)) return source;
      if (source.startsWith("go:")) {
        const importPath = source.slice(3);
        // The glue of a .vue file imports the package its transform just
        // compiled. Any other module (.js, .ts, .astro) gets the package
        // compiled here, in the Go module of the importing file.
        const file = importer?.split("?")[0];
        if (file && !file.startsWith(PREFIX) && !file.startsWith("\0") && !file.endsWith(".vue")) {
          await compileImport(importPath, file, this);
        }
        const id = entries.get(importPath + "\0" + file);
        if (!id) {
          this.error(`gosfc: Go package ${importPath} was not compiled; import it from <script setup lang="go"> or from a module inside a Go module`);
        }
        return id;
      }
      if (source === "@goesm/runtime") return RT_PREFIX + "index.ts";
      // goesm's imports between packages, rewritten by addProgram.
      if (source.startsWith(TREE_PREFIX) && modules.has(source)) return source;
      // A file a //goesm:import directive imports (goesm.js made it absolute).
      if (importer?.startsWith(TREE_PREFIX) && path.isAbsolute(source)) return source;
      if (importer?.startsWith(TREE_PREFIX) && (source.startsWith("./") || source.startsWith("../"))) {
        const rel = path.posix.join(path.posix.dirname(importer.slice(TREE_PREFIX.length)), source);
        return TREE_PREFIX + (rel.endsWith(".ts") ? rel : rel + ".ts");
      }
      return null;
    },

    async load(id) {
      if (RUNTIME_FILES.has(id)) return readFileSync(RUNTIME_FILES.get(id), "utf8");
      const script = parseAstroScriptId(id);
      if (script) {
        let code;
        try {
          code = readFileSync(script.file, "utf8");
        } catch {
          return null;
        }
        let result;
        try {
          result = await cached(id, code, () => compileAstroScript(script.file, script.index, { root: config.root, code, register: register(id) }));
        } catch (e) {
          fail(this, e);
        }
        this.addWatchFile(script.file);
        for (const f of result.goFiles) {
          addGoDependent(f, id);
          this.addWatchFile(f);
        }
        return { code: result.code, map: null };
      }
      if (id.endsWith(".astro") && !id.includes("?") && !id.startsWith("\0")) {
        // Astro replaces .astro modules with a stub in the browser; their Go
        // runs on the server only.
        if (this.environment?.config?.consumer === "client") return null;
        let code;
        try {
          code = readFileSync(id, "utf8");
        } catch {
          return null;
        }
        if (!mayHaveGoAstro(code)) return null;
        let result;
        try {
          result = await compileAstroFile(code, id);
        } catch (e) {
          fail(this, e);
        }
        if (!result) return null;
        for (const f of result.goFiles) {
          addGoDependent(f, id);
          this.addWatchFile(f);
        }
        return { code: result.code, map: result.map };
      }
      if (!id.startsWith(PREFIX)) return null;
      const m = modules.get(id);
      if (!m) return null;
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
        fail(this, e);
      }
      if (!result) return null;

      addProgram(result, id);
      for (const f of result.goFiles) {
        addGoDependent(f, id);
        // Rebuild (vite build --watch) and invalidate (dev) on .go changes.
        this.addWatchFile(f);
      }
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
    //
    // Astro's HMR compares the old and new source of an .astro file (to update
    // styles only when only styles changed); it is shown the rewritten source
    // too. A .go edit invalidates the .astro files and client scripts using
    // the package.
    async handleHotUpdate(ctx) {
      if (ctx.file.endsWith(".astro")) {
        const read = ctx.read;
        ctx.read = async () => {
          const raw = await read();
          if (!mayHaveGoAstro(raw)) return raw;
          try {
            return (await compileAstroFile(raw, ctx.file))?.code ?? raw;
          } catch {
            return raw; // the error is reported when the file is loaded again
          }
        };
        return;
      }
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
        astroCompiled.delete(v);
        const byId = server.moduleGraph.getModuleById(v);
        for (const mod of [...(server.moduleGraph.getModulesByFile(v) ?? []), ...(byId ? [byId] : [])]) {
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

/**
 * What Vite's dependency scanner is shown of an .astro file with Go: the
 * JavaScript imports of its Go frontmatter and the imports of its other
 * <script> elements (the scanner would read a Go script as TypeScript).
 */
function scanAstro(code) {
  const specs = new Set();
  const fm = /^\s*---go[ \t]*\r?\n([\s\S]*?)^---/m.exec(code);
  if (fm) {
    for (const m of fm[1].matchAll(/(?:^|[\s(;])([A-Za-z_]\w*)\s+"([^"\\]+)"/g)) {
      const p = m[2];
      if (!GO_KEYWORDS.has(m[1]) && (/^(?:\.{0,2}\/|@)/.test(p) || p.includes(":"))) specs.add(p);
    }
  }
  for (const m of code.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/g)) {
    if (/\slang\s*=\s*(["']?)go\1(?![\w-])/.test(m[1])) continue;
    const src = /\ssrc\s*=\s*["']([^"']+)["']/.exec(m[1]);
    if (src) specs.add(src[1]);
    for (const i of m[2].matchAll(/\b(?:from|import)\s*\(?\s*(["'])([^"']+)\1/g)) specs.add(i[2]);
  }
  return [...specs].map((p) => `import ${JSON.stringify(p)};\n`).join("") + "export default {};\n";
}

export { compileAstro, compileSfc } from "./compile.js";
