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
//   "./x.ts", "../y.ts"   -> resolved relative to the importing virtual id
//                            (the runtime's files import each other this way)
//   gosfc:bridge.js       -> runtime/bridge.js (template bindings)
//   gosfc:astro.js        -> runtime/astro.js (Go frontmatter bindings)
//   gosfc:convert.js      -> runtime/convert.js (binding values and props, used by both)
//   gosfc:astro-script/<n>/<file>.js
//                         -> the n-th <script lang="go"> of an .astro file, compiled
//                            when requested (also in Astro's client build, which has
//                            its own plugin instance)
// The ids end in .ts so that Vite's own TypeScript transform handles them,
// and each load returns goesm's source map (generated TS -> .vue / .go),
// which Vite composes into the final JS -> .vue / .go map.
//
// The Go blocks of an app and the packages its JavaScript imports with go: are
// one goesm program per Go module (program.js), so a package has one module
// and one state for every component. A package's module id is its import
// path (gosfc:goesm/<import path>.ts), with the number of its program for the
// programs after the first in a Vite root that has several Go modules. When a
// compilation changes a module, its module is invalidated: Vite's HMR takes
// a .go edit to the components using the package, and a page whose modules
// a component edit changed besides the component's own package reloads.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASTRO_RUNTIME_ID,
  compileAstro,
  compileAstroScript,
  compileSfc,
  goImports,
  mayHaveGoAstro,
  mayHaveGoSetup,
  parseAstroScriptId,
  placeholderSfc,
  RUNTIME_ID,
  scanGoModule,
} from "./compile.js";
import { findGoModule } from "./gomod.js";
import { GoProgram } from "./program.js";
import { goImportTypes, writeTypes } from "./types.js";

const PREFIX = "gosfc:";
const TREE_PREFIX = PREFIX + "goesm/";
const GO_PREFIX = TREE_PREFIX;
const RT_PREFIX = TREE_PREFIX + "@goesm/runtime/";
const BRIDGE_ID = RUNTIME_ID;
const GO_IMPORT = /["']go:/;
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
 * @param {{ dts?: string | false | (() => string | undefined) }} [options]
 *   dts: where to write the types of go: imports (types.js), relative to
 *   Vite's root; gosfc.d.ts unless set, false for nowhere
 * @returns {import("vite").Plugin}
 */
export default function gosfc(options = {}) {
  /** @type {import("vite").ResolvedConfig} */
  let config;
  /** @type {import("vite").ViteDevServer | undefined} */
  let server;
  /** virtual id -> generated module */
  const modules = new Map();
  /** Go module directory -> the program of its Go */
  const programs = new Map();
  /** program -> import path -> virtual id of the package's module */
  const programIds = new Map();
  /** .go file -> .vue / .astro files, JS modules importing go: and ids of
   * client scripts of .astro files whose Go code depends on it */
  const goDependents = new Map();

  /** .vue file -> last successful compilation, keyed by its source */
  const compiled = new Map();

  const setModule = (id, code, map) => modules.set(id, { code, map });

  /**
   * The program of the Go module of file, which starts as the Go of the app
   * the scan finds. Null when the file is in no Go module.
   * @returns {GoProgram | null}
   */
  function programFor(file) {
    const mod = findGoModule(path.dirname(file));
    if (!mod) return null;
    let p = programs.get(mod.dir);
    if (!p) {
      const outDirs = [path.resolve(config.root, config.build.outDir)];
      p = new GoProgram(mod, () => scanGoModule(config.root, mod, outDirs));
      programs.set(mod.dir, p);
      programIds.set(p, new Map());
    }
    return p;
  }
  const idOf = (program, importPath) => programIds.get(program)?.get(importPath);

  // Adds the modules of a program's last compilation under their ids (see
  // the top of this file) and returns the ids of the modules that changed.
  function publish(program) {
    const o = program.outcome;
    /** @type {Set<string>} */
    const changed = new Set();
    if (!o || o.error) return changed;
    const n = [...programs.values()].indexOf(program);
    const suffix = n > 0 ? "." + n : "";
    const ids = programIds.get(program);
    for (const m of o.modules) ids.set(m.importPath, GO_PREFIX + m.importPath + suffix + ".ts");
    for (const m of o.modules) {
      const code = m.code.replace(REL_IMPORTS, (all, lead, spec) => {
        const target = path.posix.join(path.posix.dirname(m.importPath), spec).replace(/\.ts$/, "");
        return lead + JSON.stringify(ids.get(target) ?? TREE_PREFIX + target + ".ts");
      });
      const id = ids.get(m.importPath);
      if (modules.get(id)?.code !== code) changed.add(id);
      setModule(id, code, m.map);
    }
    for (const f of o.runtime) setModule(RT_PREFIX + f.file, f.code, null);
    writeGoTypes();
    if (server) {
      const t = Date.now();
      for (const id of changed) for (const mod of graphModules(id)) mod.graph.invalidateModule(mod.node, new Set(), t, true);
    }
    return changed;
  }

  // Writes the types of the go: imports of every program (types.js), once
  // there are any.
  function writeGoTypes() {
    const d = options.dts === undefined ? "gosfc.d.ts" : typeof options.dts === "function" ? options.dts() : options.dts;
    if (!d) return;
    const content = goImportTypes(programs.values());
    if (content) writeTypes(path.resolve(config.root, d), content);
  }

  /** The nodes of a module id in the module graphs of the dev server's environments. */
  function graphModules(id) {
    const out = [];
    for (const env of Object.values(server?.environments ?? {})) {
      const node = env.moduleGraph?.getModuleById(id);
      if (node) out.push({ graph: env.moduleGraph, node });
    }
    return out;
  }

  /**
   * Lowers a Go block with the rest of its program (compile.js's lower). A
   * compilation that changes modules the page already runs, other than the
   * block's own, reloads the page: those modules hold the state of the old
   * program.
   */
  async function lower(block) {
    const p = programFor(block.filename);
    try {
      return await p.lowerBlock(block);
    } finally {
      const own = idOf(p, block.importPath);
      const changed = [...publish(p)].filter((id) => id !== own);
      if (server && changed.some((id) => graphModules(id).length)) server.ws.send({ type: "full-reload" });
    }
  }
  /**
   * Leaves the blocks file no longer has out of its program (forget), or
   * the go: imports of a JavaScript module that no longer imports them
   * (imports), and compiles the program again without them, as a .go edit
   * does: what left no longer makes shared functions async or keeps methods.
   */
  async function forget(file, keep = new Set(), imports = false) {
    const mod = findGoModule(path.dirname(file));
    const p = mod && programs.get(mod.dir);
    if (!p || !(imports ? p.forgetImports(file, keep) : p.forget(file, keep))) return;
    p.invalidate();
    await p.compile().catch(() => {});
    const changed = publish(p);
    if (server && [...changed].some((id) => graphModules(id).length)) server.ws.send({ type: "full-reload" });
  }
  // The go: imports of the modules an .astro file becomes: its component,
  // and its client scripts (file?astro&type=script&index=<n>&lang.ts).
  const astroImports = new Map();
  async function astroModuleImports(ctx, file, id, code, imports) {
    // In the browser the component is a stub: its server module says what
    // it imports and which scripts it renders.
    if (id === file && ctx.environment?.config?.consumer === "client") return;
    let mods = astroImports.get(file);
    if (!mods) astroImports.set(file, (mods = new Map()));
    mods.set(id, imports);
    if (id === file) {
      // The scripts the component no longer renders.
      for (const sub of mods.keys()) if (sub !== file && !code.includes(sub.slice(file.length))) mods.delete(sub);
    }
    await forget(file, new Set([...mods.values()].flat()), true);
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
    const blocks = new Set();
    const result = await compileSfc(code, id, { root: config.root, lower: (b) => (blocks.add(b.importPath), lower(b)) });
    compiled.set(id, { code, result, stamp: result ? goStamp(result.goFiles) : "" });
    await forget(id, blocks);
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
  // A compilation of an .astro file is reused while the file and its .go
  // files are unchanged and its blocks are still in the program (a block
  // removed and then restored as it was has to be lowered again).
  async function cached(key, file, code, fn) {
    const c = astroCompiled.get(key);
    const live = (r) => (r.blocks ?? []).every((b) => programFor(file)?.blocks.has(b));
    if (c && c.code === code && (!c.result || (c.stamp === goStamp(c.result.goFiles) && live(c.result)))) return c.result;
    const result = await fn();
    astroCompiled.set(key, { code, result, stamp: result ? goStamp(result.goFiles) : "" });
    return result;
  }
  // register for compileAstro: the id of a block's package in the program of
  // the .astro file.
  const register = (file) => (importPath) => idOf(programFor(file), importPath);
  async function compileAstroFile(code, id) {
    const result = await cached(id, id, code, () => compileAstro(code, id, { root: config.root, register: register(id), lower }));
    // The blocks removed from the file leave the program.
    await forget(id, new Set(result?.blocks ?? []));
    return result;
  }

  /** Reports a GosfcError at its .vue / .astro position. */
  function fail(ctx, e) {
    if (e && e.name === "GosfcError") {
      ctx.error({ message: e.message, id: e.id, loc: e.loc, frame: e.frame, plugin: "gosfc" });
    }
    throw e;
  }

  /** import path + "\0" + importer -> stamp of the .go files it was compiled from */
  const jsCompiled = new Map();
  // Compiles a Go package imported from JavaScript or TypeScript (`import {
  // F } from "go:<import path>"` in a .js, .ts or .astro module) rather than
  // from a Go block, in the program of the importing file's Go module.
  async function compileImport(importPath, importer, ctx) {
    const key = importPath + "\0" + importer;
    const c = jsCompiled.get(key);
    const p = programFor(importer);
    // Reused while the program still counts the import (a module that
    // dropped it and imports it again registers it again).
    if (c && c.stamp === goStamp(c.goFiles) && p?.importers.get(importPath)?.has(path.resolve(importer))) return;
    if (!p) throw new Error(`gosfc: no go.mod found for ${importer}, which imports go:${importPath}`);
    let result;
    try {
      result = await p.lowerImport(importPath, importer);
    } finally {
      publish(p);
    }
    jsCompiled.set(key, { goFiles: result.goFiles, stamp: goStamp(result.goFiles) });
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
        const p = file && programFor(file);
        const id = p && idOf(p, importPath);
        if (!id) {
          this.error(`gosfc: Go package ${importPath} was not compiled; import it from <script setup lang="go"> or from a module inside a Go module`);
        }
        return id;
      }
      // goesm's imports between packages, rewritten by publish.
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
          result = await cached(id, script.file, code, () => compileAstroScript(script.file, script.index, { root: config.root, code, register: register(script.file), lower }));
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
        if (!mayHaveGoAstro(code)) {
          await forget(id);
          return null;
        }
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
      if (!file.endsWith(".vue") && !id.startsWith(PREFIX) && !id.startsWith("\0")) {
        // A JS / TS / Astro module importing Go packages: compile them now,
        // so that the .go files they come from are watched on behalf of this
        // module (an edit then reloads it). The packages a module no longer
        // imports leave the program.
        const imports = GO_IMPORT.test(code) ? goImports(code) : [];
        for (const i of imports) await compileImport(i, file, this);
        if (file.endsWith(".astro")) await astroModuleImports(this, file, id, code, imports);
        else if (id === file) await forget(file, new Set(imports), true);
        if (imports.length) return null;
      }
      if (!id.endsWith(".vue") || id.includes("?") || id.includes("\0")) return null;
      if (!mayHaveGoSetup(code)) {
        // A component whose Go block was removed.
        compiled.delete(id);
        await forget(id);
        return null;
      }
      let result;
      try {
        result = await compile(code, id);
      } catch (e) {
        fail(this, e);
      }
      if (!result) return null;

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
    // A change to a .go file compiles the program again; the modules that
    // changed go through Vite's HMR to the components importing them, which
    // plugin-vue reloads.
    //
    // Astro's HMR compares the old and new source of an .astro file (to update
    // styles only when only styles changed); it is shown the rewritten source
    // too. A .go edit invalidates the .astro files and client scripts using
    // the package.
    // A deleted file's Go blocks and go: imports leave the program.
    async watchChange(id, change) {
      if (change.event !== "delete") return;
      compiled.delete(id);
      astroCompiled.delete(id);
      astroImports.delete(id);
      await forget(id);
      await forget(id, new Set(), true);
    },

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
      const mods = [];
      // The programs reading the file compile again; their changed modules
      // are invalidated (publish) and updated through Vite's HMR.
      // A new file joins a package whose files the program reads.
      const dir = path.dirname(ctx.file);
      for (const p of programs.values()) {
        if (p.outcome && !p.outcome.error && !p.goFiles.some((f) => f === ctx.file || path.dirname(f) === dir)) continue;
        p.invalidate();
        await p.compile().catch(() => {});
        for (const id of publish(p)) {
          const mod = server.moduleGraph.getModuleById(id);
          if (mod) mods.push(mod);
        }
      }
      for (const v of goDependents.get(ctx.file) ?? []) {
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
export { PLACEHOLDER as GO_TYPES_PLACEHOLDER, scanGoImportTypes, writeTypes } from "./types.js";
