// Turning a Vue SFC with <script setup lang="go"> into an SFC that the
// ordinary Vue tooling compiles.
//
//   .vue ── @vue/compiler-sfc parse ──> descriptor
//            └─ <script setup lang="go">
//                 ├─ gosfc synth  (Go side, go/scanner) ─> synthetic Go + bindings
//                 └─ goesm emit-ts (overlay)            ─> TypeScript modules + maps
//   .vue with the Go block replaced by a small <script setup> that imports the
//   lowered package and declares one const per Go binding
//            └─ @vitejs/plugin-vue compiles template, styles, HMR as usual
//
// Only the Go block is rewritten. Template, <style>, <style scoped> and any
// plain <script> stay byte-for-byte what the user wrote.
//
// .astro files take Go in two places, lowered the same way (compileAstro):
//
//   ---go frontmatter    ─> a TypeScript frontmatter that imports the lowered
//                           package, runs it once per render and declares one
//                           const per Go binding (runtime/astro.js)
//   <script lang="go">   ─> <script>import "gosfc:astro-script/<n>/<file>.js"</script>,
//                           a module that runs the lowered block in the browser
//                           (compileAstroScript)

import { compileTemplate, parse } from "@vue/compiler-sfc";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import MagicString from "magic-string";
import path from "node:path";
import { GosfcError, lineCol, sfcError, withFrame } from "./errors.js";
import { findGoModule, goTool, run } from "./gomod.js";
import { GoProgram } from "./program.js";

export { GosfcError } from "./errors.js";

// The bridge module the generated script imports (runtime/bridge.js). It is a
// virtual id rather than a package specifier so that Vite's SSR never
// externalizes it: it imports gosfc:convert.js, which only this plugin resolves.
export const RUNTIME_ID = "gosfc:bridge.js";
// The runtime of a Go frontmatter (runtime/astro.js).
export const ASTRO_RUNTIME_ID = "gosfc:astro.js";
// Client scripts of .astro files: gosfc:astro-script/<index>/<absolute path>.js.
// The id names the file and the script, because Astro builds the client in a
// Vite environment of its own, whose plugin instance has not seen the .astro
// file. (It does not end in .astro, which Astro's plugin would claim.)
export const ASTRO_SCRIPT_PREFIX = "gosfc:astro-script/";

/** Quick test used before parsing: does the file contain a Go setup block? */
export function mayHaveGoSetup(code) {
  return /<script\b[^>]*\blang\s*=\s*["']?go\b/.test(code);
}

// ---go at the start of an .astro file opens a Go frontmatter.
const GO_FENCE = /^\s*(---go)[ \t]*(?:\r?\n|$)/;

/** Quick test: does an .astro file have a Go frontmatter or a Go script? */
export function mayHaveGoAstro(code) {
  return GO_FENCE.test(code) || mayHaveGoSetup(code);
}

/**
 * @typedef {import("./goesm.js").GoModuleOutput} GoModuleOutput
 * @typedef {import("./goesm.js").RuntimeFile} RuntimeFile
 * @typedef {import("./program.js").GoBlock} GoBlock
 * @typedef {import("./program.js").Lowered} Lowered
 * @typedef {(block: GoBlock) => Promise<Lowered>} Lower lowers a block with the rest of its program
 * @typedef {{
 *   code: string,
 *   map: any,
 *   modules: GoModuleOutput[],
 *   runtime: RuntimeFile[],
 *   goFiles: string[],
 * }} CompileResult
 */

/**
 * Compiles one .vue file. Returns null when it has no <script setup lang="go">.
 * @param {string} code
 * @param {string} filename absolute path of the .vue file
 * @param {{ root: string, lower?: Lower }} opts lower: how the block is lowered with the
 *   rest of the app (by default, as a program of its own)
 * @returns {Promise<CompileResult | null>}
 */
export async function compileSfc(code, filename, opts) {
  const { descriptor, errors } = parse(code, { filename, sourceMap: false });
  const block = descriptor.scriptSetup;
  if (!block || block.lang !== "go") {
    if (descriptor.script?.lang === "go") {
      throw sfcError(filename, code, descriptor.script.loc.start.offset, '<script lang="go"> is not supported; use <script setup lang="go">', opts.root);
    }
    return null;
  }
  if (errors.length) return null; // let @vitejs/plugin-vue report SFC syntax errors
  if (descriptor.script?.lang === "go") {
    throw sfcError(filename, code, descriptor.script.loc.start.offset, '<script lang="go"> is not supported; use <script setup lang="go">', opts.root);
  }

  const tagOffset = code.lastIndexOf("<script", block.loc.start.offset);
  const vb = vueBlock(code, filename, descriptor, opts.root);
  const { importPath, synth, res, goFiles } = await compileGoBlock({ ...vb, lower: opts.lower });

  const s = new MagicString(code);
  // <script setup lang="go"> -> <script setup lang="ts">. Vue requires <script>
  // and <script setup> to share a language, so follow a plain <script> if any.
  const tagEnd = code.indexOf(">", tagOffset);
  const tag = code.slice(tagOffset, tagEnd);
  const langAttr = /\slang\s*=\s*(["']?)go\1/.exec(tag);
  const otherLang = descriptor.script?.lang;
  const lang = descriptor.script ? (otherLang ? ` lang="${otherLang}"` : "") : ' lang="ts"';
  s.overwrite(tagOffset + langAttr.index, tagOffset + langAttr.index + langAttr[0].length, lang);

  // The hash of the lowered Go makes the script change whenever the Go code
  // does, even if the bindings stay the same; that is what tells
  // @vitejs/plugin-vue's HMR to reload the component rather than re-render
  // it. (plugin-vue compares script ASTs, so it has to be code, not a comment.)
  // A change to another package reaches the component through Vite's HMR
  // of that package's module.
  const hash = createHash("sha256");
  for (const m of res.modules) if (m.importPath === importPath) hash.update(m.code);
  const version = JSON.stringify(hash.digest("hex").slice(0, 16));
  const glue = synth.props
    ? [
        "",
        `import { GosfcSetup as __gosfc_setup, GosfcProps as __gosfc_props } from ${JSON.stringify("go:" + importPath)};`,
        `import { useGo as __gosfc_useGo } from ${JSON.stringify(RUNTIME_ID)};`,
        // The Props fields are declared as Vue props, so that the other
        // attributes (class, style, listeners) fall through to the root element.
        `const __gosfc_in = defineProps(${JSON.stringify(propNames(synth))});`,
        `const __gosfc = __gosfc_useGo(__gosfc_setup, ${version}, __gosfc_props${defaultsArg(synth) || ", undefined"}, __gosfc_in);`,
      ]
    : [
        "",
        `import { GosfcSetup as __gosfc_setup } from ${JSON.stringify("go:" + importPath)};`,
        `import { useGo as __gosfc_useGo } from ${JSON.stringify(RUNTIME_ID)};`,
        `const __gosfc = __gosfc_useGo(__gosfc_setup, ${version});`,
      ];
  const bindings = (synth.bindings ?? []).filter((b) => !vb.used || vb.used.includes(b.name));
  glue.push(...bindings.map((b) => `const ${b.name} = __gosfc.binding(${JSON.stringify(b.name)});`));
  // Keep the line count so positions after the block do not move.
  const lines = block.content.split("\n").length;
  while (glue.length < lines) glue.push("");
  s.overwrite(block.loc.start.offset, block.loc.end.offset, glue.join("\n"));

  return {
    code: s.toString(),
    map: s.generateMap({ source: filename, includeContent: true, hires: true }),
    modules: res.modules,
    runtime: res.runtime,
    goFiles,
  };
}

/**
 * Returns the id to import the package of a block by (the plugin's virtual
 * module of the package).
 * @typedef {(importPath: string) => string} Register
 */

/**
 * Compiles the Go of one .astro file. A ---go frontmatter becomes a
 * TypeScript frontmatter that runs the lowered block once per render (awaiting
 * it if it blocks) and declares one const per Go binding; its line count stays
 * the same, so template positions do not move. Each <script lang="go"> becomes
 * a <script> importing gosfc:astro-script/<n>/<file>.js, which
 * compileAstroScript compiles when it is requested. Returns null when the file
 * has no Go.
 * @param {string} code
 * @param {string} filename absolute path of the .astro file
 * @param {{ root: string, register?: Register, lower?: Lower }} opts
 * @returns {Promise<CompileResult | null>}
 */
export async function compileAstro(code, filename, opts) {
  const s = new MagicString(code);
  const fm = goFrontmatter(code, filename, opts.root);
  /** @type {CompileResult & { blocks: string[] }} */
  const out = { code, map: null, modules: [], runtime: [], goFiles: [], blocks: [] };
  if (fm) {
    const { importPath, synth, res, goFiles } = await compileGoBlock({ ...frontmatterBlock(code, filename, fm, opts.root), lower: opts.lower });
    const jsImports = synth.jsImports ?? [];
    const bindings = synth.bindings ?? [];
    // A binding becomes a const next to the imports and Astro's own globals.
    const taken = new Map(jsImports.filter((i) => i.name !== "_").map((i) => [i.name, `the name of the import of ${JSON.stringify(i.path)}`]));
    taken.set("Astro", "Astro's global");
    const errs = bindings
      .filter((bd) => taken.has(bd.name))
      .map((bd) => {
        return withFrame({ file: filename, line: bd.line, column: bd.column, message: `${bd.name} is also ${taken.get(bd.name)}; rename one of them` }, code);
      });
    if (errs.length) throw new GosfcError(errs, opts.root);

    const id = opts.register ? opts.register(importPath) : "go:" + importPath;
    const stmts = jsImports.map((i) => (i.name === "_" ? `import ${JSON.stringify(i.path)};` : `import ${i.name} from ${JSON.stringify(i.path)};`));
    stmts.push(
      synth.props
        ? `import { GosfcSetup as __gosfc_setup, GosfcProps as __gosfc_props } from ${JSON.stringify(id)};`
        : `import { GosfcSetup as __gosfc_setup } from ${JSON.stringify(id)};`,
      `import { runGo as __gosfc_run } from ${JSON.stringify(ASTRO_RUNTIME_ID)};`,
      `const __gosfc = await __gosfc_run(__gosfc_setup, ${synth.props ? "__gosfc_props" : "null"}, Astro.props${defaultsArg(synth)});`,
      ...bindings.map((bd) => `const ${bd.name} = __gosfc(${JSON.stringify(bd.name)});`),
    );
    s.overwrite(fm.fence, fm.fence + "---go".length, "---");
    // Keep the line count: the content ends with the newline before the
    // closing ---, so it has lines - 1 lines of text to fill.
    const room = fm.content.split("\n").length - 1;
    if (room === 0) {
      s.appendLeft(fm.contentOffset, stmts.join(" ") + "\n");
    } else {
      const lines = stmts.slice(0, room - 1);
      lines.push(stmts.slice(room - 1).join(" "));
      while (lines.length < room) lines.push("");
      s.overwrite(fm.contentOffset, fm.contentOffset + fm.content.length, lines.join("\n") + "\n");
    }
    out.modules = res.modules;
    out.runtime = res.runtime;
    out.goFiles = goFiles;
  }

  const scripts = goScripts(code, fm ? fm.end : frontmatterEnd(code));
  // The file's blocks, so that the program leaves out the ones removed.
  const mod = findGoModule(path.dirname(filename));
  if (mod) {
    if (fm) out.blocks.push(blockImportPath(mod, filename, frontmatterBlock(code, filename, fm, opts.root).pkgName));
    scripts.forEach((sc, i) => out.blocks.push(blockImportPath(mod, filename, scriptBlock(code, filename, sc, i, opts.root).pkgName)));
  }
  scripts.forEach((sc, i) => {
    if (sc.otherAttrs) {
      throw sfcError(filename, code, sc.start, `<script lang="go"> takes no other attributes (found ${sc.otherAttrs})`, opts.root);
    }
    const lines = code.slice(sc.contentStart, sc.contentEnd).split("\n").length;
    s.overwrite(sc.start, sc.end, `<script>import ${JSON.stringify(astroScriptId(filename, i))};${"\n".repeat(lines - 1)}</script>`);
  });

  if (!fm && !scripts.length) return null;
  out.code = s.toString();
  out.map = s.generateMap({ source: filename, includeContent: true, hires: true });
  return out;
}

/**
 * Compiles the index-th <script lang="go"> of an .astro file into a module
 * that runs the block (bindings are not used).
 * @param {string} filename
 * @param {number} index
 * @param {{ root: string, register?: Register, lower?: Lower, code?: string }} opts
 * @returns {Promise<{ code: string, modules: GoModuleOutput[], runtime: RuntimeFile[], goFiles: string[], blocks: string[] }>}
 */
export async function compileAstroScript(filename, index, opts) {
  const code = opts.code ?? readFileSync(filename, "utf8");
  const fm = goFrontmatter(code, filename, opts.root);
  const sc = goScripts(code, fm ? fm.end : frontmatterEnd(code))[index];
  if (!sc) throw new Error(`gosfc: ${filename} has no <script lang="go"> number ${index + 1}`);
  const { importPath, res, goFiles } = await compileGoBlock({ ...scriptBlock(code, filename, sc, index, opts.root), lower: opts.lower });
  const id = opts.register ? opts.register(importPath) : "go:" + importPath;
  return {
    code: `import { GosfcSetup } from ${JSON.stringify(id)};\nGosfcSetup();\n`,
    modules: res.modules,
    runtime: res.runtime,
    goFiles,
    blocks: [importPath],
  };
}

/** The Go block of a .vue file, for compileGoBlock. */
function vueBlock(code, filename, descriptor, root) {
  const block = descriptor.scriptSetup;
  return {
    code,
    filename,
    contentOffset: block.loc.start.offset,
    content: block.content,
    tagOffset: code.lastIndexOf("<script", block.loc.start.offset),
    pkgName: packageName(filename),
    root,
    used: templateNames(descriptor, filename),
  };
}

/**
 * Returns the names the template and the style's v-bind() may reference,
 * a superset of the bindings they read, or null when they cannot be told
 * (no template, or one in another language or with errors): the free
 * identifiers of the compiled template, the components and directives it
 * resolves by name, and the static ref="..." names.
 * @param {import("@vue/compiler-sfc").SFCDescriptor} descriptor
 * @param {string} filename
 * @returns {string[] | null}
 */
function templateNames(descriptor, filename) {
  const t = descriptor.template;
  if (!t || (t.lang && t.lang !== "html")) return null;
  const r = compileTemplate({ source: t.content, filename, id: "gosfc", compilerOptions: { prefixIdentifiers: true } });
  if (r.errors.length) return null;
  const names = new Set();
  // Go identifiers are Unicode letters, digits and _.
  const ident = /[\p{L}_$][\p{L}\p{N}_$]*/gu;
  for (const m of r.code.matchAll(/_ctx\.([\p{L}_$][\p{L}\p{N}_$]*)/gu)) names.add(m[1]);
  const camel = (n) => n.replace(/-(\w)/g, (_, c) => c.toUpperCase());
  const cap = (n) => n.charAt(0).toUpperCase() + n.slice(1);
  for (const m of r.code.matchAll(/_resolve(Component|Directive)\("([^"]+)"/g)) {
    const n = camel(m[2]);
    if (m[1] === "Directive") names.add("v" + cap(n));
    else for (const c of [n, n.split(".")[0]]) names.add(c).add(cap(c)); // <Form.Input> reads Form
  }
  const walk = (node) => {
    for (const p of node.props ?? []) if (p.type === 6 && p.name === "ref" && p.value) names.add(p.value.content);
    for (const c of node.children ?? []) walk(c);
  };
  if (t.ast) walk(t.ast);
  for (const v of descriptor.cssVars) for (const m of v.matchAll(ident)) names.add(m[0]);
  return [...names].sort();
}

/** The Go frontmatter of an .astro file, for compileGoBlock. */
function frontmatterBlock(code, filename, fm, root) {
  return {
    code,
    filename,
    content: fm.content,
    contentOffset: fm.contentOffset,
    tagOffset: fm.fence,
    pkgName: packageName(filename),
    root,
    block: "the Go frontmatter",
    jsImports: true,
  };
}

/** The index-th <script lang="go"> of an .astro file, for compileGoBlock. */
function scriptBlock(code, filename, sc, index, root) {
  return {
    code,
    filename,
    content: code.slice(sc.contentStart, sc.contentEnd),
    contentOffset: sc.contentStart,
    tagOffset: sc.start,
    pkgName: `${packageName(filename)}_script${index}`,
    root,
    block: '<script lang="go">',
    bindings: false,
  };
}

/** The virtual id of the index-th <script lang="go"> of an .astro file. */
export function astroScriptId(filename, index) {
  return `${ASTRO_SCRIPT_PREFIX}${index}/${filename.replace(/^\//, "")}.js`;
}

/** @returns {{ file: string, index: number } | null} */
export function parseAstroScriptId(id) {
  const m = /^gosfc:astro-script\/(\d+)\/(.+)\.js$/.exec(id);
  if (!m) return null;
  return { file: /^[A-Za-z]:/.test(m[2]) ? m[2] : "/" + m[2], index: Number(m[1]) };
}

/**
 * The ---go frontmatter of an .astro file: offsets of the fence, of the Go
 * content and of the end of the closing ---.
 */
function goFrontmatter(code, filename, root) {
  const m = GO_FENCE.exec(code);
  if (!m) return null;
  const fence = m.index + m[0].indexOf("---go");
  const contentOffset = m.index + m[0].length;
  const close = /^---/gm;
  close.lastIndex = contentOffset;
  const c = close.exec(code);
  if (!c) throw sfcError(filename, code, fence, "the Go frontmatter is not closed: end it with a line ---", root);
  return { fence, contentOffset, content: code.slice(contentOffset, c.index), end: c.index + 3 };
}

/** End of an ordinary frontmatter, or 0. */
function frontmatterEnd(code) {
  const m = /^\s*---/.exec(code);
  if (!m) return 0;
  const close = /^---/gm;
  close.lastIndex = m.index + m[0].length;
  const c = close.exec(code);
  return c ? c.index + 3 : 0;
}

/** The <script lang="go"> elements after offset from, outside HTML comments. */
function goScripts(code, from) {
  const comments = [...code.matchAll(/<!--[\s\S]*?-->/g)].map((m) => [m.index, m.index + m[0].length]);
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/g;
  re.lastIndex = from;
  const langRE = /\slang\s*=\s*(["']?)go\1(?![\w-])/;
  const out = [];
  for (let m; (m = re.exec(code)); ) {
    if (comments.some(([a, b]) => m.index > a && m.index < b)) continue;
    if (!langRE.test(m[1])) continue;
    const contentStart = m.index + "<script".length + m[1].length + 1;
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      contentStart,
      contentEnd: contentStart + m[2].length,
      otherAttrs: m[1].replace(langRE, "").trim(),
    });
  }
  return out;
}

/**
 * @typedef {{ go: string, bindings: {name: string, kind: string, line: number, column: number}[], diagnostics: {line: number, column: number, message: string}[], props: boolean, propDefaults?: Record<string, string>, jsImports: {name: string, path: string}[] }} SynthOutput
 */

/**
 * A Go block of a .vue or .astro file.
 * @typedef {{
 *   code: string,           // the whole file
 *   filename: string,       // its absolute path
 *   content: string,        // the Go block
 *   contentOffset: number,  // offset of content in code
 *   tagOffset: number,      // offset of the tag or fence that opens the block
 *   pkgName: string,
 *   root: string,
 *   block?: string,         // how the block is written, for messages
 *   jsImports?: boolean,    // imports of JavaScript modules are allowed
 *   bindings?: boolean,     // false: the bindings are not used (a client script)
 *   used?: string[] | null, // the names the template may reference (null: any)
 * }} BlockInput
 */

/** The import path of the synthetic package of a block of filename. */
function blockImportPath(mod, filename, pkgName) {
  const relDir = path.relative(mod.dir, path.dirname(filename)).split(path.sep).join("/");
  return [mod.modulePath, relDir, "_gosfc", pkgName].filter(Boolean).join("/");
}

/**
 * Makes a Go block a Go package (gosfc synth), for goesm to compile with the
 * rest of the program.
 * @param {BlockInput} b
 * @returns {Promise<GoBlock & { synth: SynthOutput, mod: import("./gomod.js").GoModule }>}
 */
export async function synthBlock(b) {
  const { code, filename, content, contentOffset, tagOffset, pkgName } = b;
  const blockName = b.block ?? '<script setup lang="go">';
  const mod = findGoModule(path.dirname(filename));
  if (!mod) {
    throw sfcError(filename, code, contentOffset, `no go.mod found for this file; ${blockName} imports Go packages of a Go module`, b.root);
  }

  // The synthetic package lives in a directory that exists only in the
  // overlay, below the component, so the Go visibility rules (internal/)
  // apply as if the component were Go code in its own directory.
  const synthDir = path.join(path.dirname(filename), "_gosfc", pkgName);
  const importPath = blockImportPath(mod, filename, pkgName);

  const tagPos = lineCol(code, tagOffset);
  const start = lineCol(code, contentOffset);
  const gosfcBin = await goTool(mod.dir, "gosfc");

  const synthRes = await run(gosfcBin, ["synth"], {
    cwd: mod.dir,
    input: JSON.stringify({
      file: filename,
      package: pkgName,
      source: content,
      line: start.line,
      column: start.column,
      tagLine: tagPos.line,
      tagColumn: tagPos.column,
      block: blockName,
      jsImports: !!b.jsImports,
      used: b.used ?? null,
    }),
  });
  if (synthRes.code !== 0) throw new Error(`gosfc synth failed:\n${synthRes.stderr}`);
  /** @type {SynthOutput} */
  const synth = JSON.parse(synthRes.stdout);

  /** @type {import("./errors.js").SfcError[]} */
  const errs = (synth.diagnostics ?? []).map((d) => withFrame({ file: filename, line: d.line, column: d.column, message: d.message }, code));
  for (const bd of b.bindings === false ? [] : synth.bindings ?? []) {
    if (JS_RESERVED.has(bd.name)) {
      errs.push(withFrame({ file: filename, line: bd.line, column: bd.column, message: `${bd.name} is a reserved word in JavaScript and cannot be used by the template; rename it` }, code));
    }
  }
  if (errs.length) throw new GosfcError(errs, b.root);

  const relLines = [start.line, start.line + content.split("\n").length - 1];
  return {
    importPath,
    pattern: "./" + path.relative(mod.dir, synthDir).split(path.sep).join("/"),
    synthDir,
    go: synth.go,
    filename,
    code,
    lines: relLines,
    tagPos,
    root: b.root,
    synth,
    mod,
  };
}

/**
 * Lowers one Go block of a .vue or .astro file with the rest of its program
 * (b.lower), or as a program of its own.
 * @param {BlockInput & { lower?: Lower }} b
 * @returns {Promise<{ importPath: string, synth: SynthOutput, res: Lowered, goFiles: string[] }>}
 */
async function compileGoBlock(b) {
  const block = await synthBlock(b);
  const res = await (b.lower ?? ((bl) => new GoProgram(bl.mod).lowerBlock(bl)))(block);
  return { importPath: block.importPath, synth: block.synth, res, goFiles: res.goFiles };
}

// The import paths a module imports with go: specifiers, in static and
// dynamic imports and re-exports (from "go:..." and import("go:...")).
// Comments and the contents of other strings are skipped as whole tokens,
// so text that only mentions such an import imports nothing.
const GO_IMPORT_TOKENS =
  /<!--[\s\S]*?-->|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b(?:from|import)\s*\(?\s*(["'])go:([^"'\s]+)\1|"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`/g;

/**
 * @param {string} code
 * @returns {string[]}
 */
export function goImports(code) {
  const out = [];
  for (const m of code.matchAll(GO_IMPORT_TOKENS)) if (m[2]) out.push(m[2]);
  return out;
}

/**
 * The Go blocks of the .vue and .astro files under root that belong to the
 * Go module mod, made Go packages, and the packages JavaScript modules there
 * import with go: (with the file importing each). A file that fails is skipped: it reports its error when
 * it is compiled. Directories Vite does not serve from are skipped: hidden
 * ones, node_modules, build output (outDirs, and caches marked with
 * CACHEDIR.TAG, such as Cargo's target).
 * @param {string} root
 * @param {import("./gomod.js").GoModule} mod
 * @param {string[]} outDirs
 * @returns {Promise<{ blocks: GoBlock[], imports: [string, string][] }>}
 */
export async function scanGoModule(root, mod, outDirs) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === "CACHEDIR.TAG")) return;
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && e.name !== "node_modules" && !outDirs.includes(p)) walk(p);
      } else if (/\.(?:vue|astro|[cm]?[jt]sx?)$/.test(e.name)) {
        files.push(p);
      }
    }
  };
  walk(root);

  const inputs = [];
  /** @type {[string, string][]} */
  const imports = [];
  for (const file of files) {
    if (findGoModule(path.dirname(file))?.dir !== mod.dir) continue;
    let code;
    try {
      code = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    try {
      if (file.endsWith(".vue")) {
        if (!mayHaveGoSetup(code)) continue;
        const { descriptor, errors } = parse(code, { filename: file, sourceMap: false });
        if (!errors.length && descriptor.scriptSetup?.lang === "go") inputs.push(vueBlock(code, file, descriptor, root));
        continue;
      }
      if (file.endsWith(".astro") && mayHaveGoAstro(code)) {
        const fm = goFrontmatter(code, file, root);
        if (fm) inputs.push(frontmatterBlock(code, file, fm, root));
        goScripts(code, fm ? fm.end : frontmatterEnd(code)).forEach((sc, i) => inputs.push(scriptBlock(code, file, sc, i, root)));
      }
    } catch {
      continue;
    }
    for (const i of goImports(code)) imports.push([i, file]);
  }

  const blocks = [];
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const b = inputs[next++];
      try {
        blocks.push(await synthBlock(b));
      } catch {
        // reported when the file is compiled
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { blocks, imports };
}

/**
 * An SFC whose Go block failed to compile, as shown to @vitejs/plugin-vue's
 * HMR: the Go block becomes an empty script whose content still changes with
 * the Go source, so the component is requested again and the compile error is
 * reported from the transform with its .vue position.
 * @param {string} code
 * @param {string} filename
 */
export function placeholderSfc(code, filename) {
  const block = parse(code, { filename, sourceMap: false }).descriptor.scriptSetup;
  if (!block || block.lang !== "go") return code;
  const tagOffset = code.lastIndexOf("<script", block.loc.start.offset);
  const tag = code.slice(tagOffset, block.loc.start.offset).replace(/\slang\s*=\s*(["']?)go\1/, ' lang="ts"');
  const comment = "\n/* gosfc: Go compile error: " + JSON.stringify(block.content).replace(/\*\//g, "* /") + " */\n";
  return code.slice(0, tagOffset) + tag + comment + code.slice(block.loc.end.offset);
}

/** Summary.vue -> summary_vue */
function packageName(filename) {
  let n = path.basename(filename).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!/^[a-z_]/.test(n)) n = "_" + n;
  return n;
}

// defaultsArg is the argument passing the `default:"..."` tags of the Props
// fields to the runtime, or nothing when there are none.
function defaultsArg(synth) {
  return synth.propDefaults && Object.keys(synth.propDefaults).length ? `, ${JSON.stringify(synth.propDefaults)}` : "";
}

// propNames are the names Vue declares the Props fields as props by: the key
// of the props object (json tag name or field name) with its leading capitals
// lowered and camelized as Vue normalizes a declared name ("display-name" is
// displayName), as readProps (runtime/convert.js) reads them. Vue matches the
// kebab-case attributes to them too.
function propNames(synth) {
  const names = (synth.propKeys ?? []).map((k) =>
    k.replace(/^[A-Z]+(?=[A-Z][a-z]|$)|^[A-Z]/, (s) => s.toLowerCase()).replace(/-(\w)/g, (_, c) => c.toUpperCase()),
  );
  return [...new Set(names)].filter((n) => n !== "key" && n !== "ref");
}

// Identifiers that are valid in Go but cannot name a JavaScript binding.
const JS_RESERVED = new Set([
  "arguments", "await", "class", "catch", "debugger", "delete", "do", "enum", "eval", "export",
  "extends", "finally", "implements", "in", "instanceof", "interface", "let", "new", "null",
  "package", "private", "protected", "public", "static", "super", "this", "throw", "true", "false",
  "try", "typeof", "void", "while", "with", "yield", "undefined",
]);
