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

import { generateCodeFrame, parse } from "@vue/compiler-sfc";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import MagicString from "magic-string";
import path from "node:path";
import { emitTS } from "./goesm.js";
import { findGoModule, goTool, readOnlyGoDirs, run } from "./gomod.js";

// The bridge module the generated script imports (runtime/bridge.js). It is a
// virtual id rather than a package specifier so that Vite's SSR never
// externalizes it: it imports @goesm/runtime, which only this plugin resolves.
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
 * @typedef {{ message: string, file: string, line: number, column: number, frame?: string }} SfcError
 * @typedef {{
 *   code: string,
 *   map: any,
 *   modules: GoModuleOutput[],
 *   runtime: RuntimeFile[],
 *   goFiles: string[],
 * }} CompileResult
 */

export class GosfcError extends Error {
  /** @param {SfcError[]} errors @param {string} root */
  constructor(errors, root) {
    super(errors.map((e) => `${displayPath(e.file, root)}:${e.line}:${e.column}: ${e.message}`).join("\n"));
    this.name = "GosfcError";
    this.errors = errors;
    const first = errors[0];
    // Shape understood by Vite's error overlay and by Astro.
    this.id = first.file;
    this.loc = { file: first.file, line: first.line, column: first.column };
    this.frame = first.frame;
  }
}

/**
 * Compiles one .vue file. Returns null when it has no <script setup lang="go">.
 * @param {string} code
 * @param {string} filename absolute path of the .vue file
 * @param {{ root: string }} opts
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
  const { importPath, synth, res, goFiles } = await compileGoBlock({
    code,
    filename,
    contentOffset: block.loc.start.offset,
    content: block.content,
    tagOffset,
    pkgName: packageName(filename),
    root: opts.root,
  });

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
  const hash = createHash("sha256");
  for (const m of res.modules) hash.update(m.importPath).update("\0").update(m.code);
  const version = JSON.stringify(hash.digest("hex").slice(0, 16));
  const glue = synth.props
    ? [
        "",
        `import { GosfcSetup as __gosfc_setup, GosfcProps as __gosfc_props } from ${JSON.stringify("go:" + importPath)};`,
        `import { useGo as __gosfc_useGo } from ${JSON.stringify(RUNTIME_ID)};`,
        // Props arrive as attributes; they must not also land on the root element.
        "defineOptions({ inheritAttrs: false });",
        `const __gosfc = __gosfc_useGo(__gosfc_setup, ${version}, __gosfc_props);`,
      ]
    : [
        "",
        `import { GosfcSetup as __gosfc_setup } from ${JSON.stringify("go:" + importPath)};`,
        `import { useGo as __gosfc_useGo } from ${JSON.stringify(RUNTIME_ID)};`,
        `const __gosfc = __gosfc_useGo(__gosfc_setup, ${version});`,
      ];
  glue.push(...(synth.bindings ?? []).map((b) => `const ${b.name} = __gosfc.binding(${JSON.stringify(b.name)});`));
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
 * Adds a lowered program (to the plugin's virtual modules) and returns the id
 * to import the package of the block by.
 * @typedef {(res: { modules: GoModuleOutput[], runtime: RuntimeFile[] }, importPath: string) => string} Register
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
 * @param {{ root: string, register?: Register }} opts
 * @returns {Promise<CompileResult | null>}
 */
export async function compileAstro(code, filename, opts) {
  const s = new MagicString(code);
  const fm = goFrontmatter(code, filename, opts.root);
  /** @type {CompileResult} */
  const out = { code, map: null, modules: [], runtime: [], goFiles: [] };
  if (fm) {
    const { importPath, synth, res, goFiles } = await compileGoBlock({
      code,
      filename,
      content: fm.content,
      contentOffset: fm.contentOffset,
      tagOffset: fm.fence,
      pkgName: packageName(filename),
      root: opts.root,
      block: "the Go frontmatter",
      jsImports: true,
    });
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

    const id = opts.register ? opts.register(res, importPath) : "go:" + importPath;
    const stmts = jsImports.map((i) => (i.name === "_" ? `import ${JSON.stringify(i.path)};` : `import ${i.name} from ${JSON.stringify(i.path)};`));
    stmts.push(
      synth.props
        ? `import { GosfcSetup as __gosfc_setup, GosfcProps as __gosfc_props } from ${JSON.stringify(id)};`
        : `import { GosfcSetup as __gosfc_setup } from ${JSON.stringify(id)};`,
      `import { runGo as __gosfc_run } from ${JSON.stringify(ASTRO_RUNTIME_ID)};`,
      `const __gosfc = await __gosfc_run(__gosfc_setup, ${synth.props ? "__gosfc_props" : "null"}, Astro.props);`,
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
 * @param {{ root: string, register?: Register, code?: string }} opts
 * @returns {Promise<{ code: string, modules: GoModuleOutput[], runtime: RuntimeFile[], goFiles: string[] }>}
 */
export async function compileAstroScript(filename, index, opts) {
  const code = opts.code ?? readFileSync(filename, "utf8");
  const fm = goFrontmatter(code, filename, opts.root);
  const sc = goScripts(code, fm ? fm.end : frontmatterEnd(code))[index];
  if (!sc) throw new Error(`gosfc: ${filename} has no <script lang="go"> number ${index + 1}`);
  const { importPath, res, goFiles } = await compileGoBlock({
    code,
    filename,
    content: code.slice(sc.contentStart, sc.contentEnd),
    contentOffset: sc.contentStart,
    tagOffset: sc.start,
    pkgName: `${packageName(filename)}_script${index}`,
    root: opts.root,
    block: '<script lang="go">',
    bindings: false,
  });
  const id = opts.register ? opts.register(res, importPath) : "go:" + importPath;
  return {
    code: `import { GosfcSetup } from ${JSON.stringify(id)};\nGosfcSetup();\n`,
    modules: res.modules,
    runtime: res.runtime,
    goFiles,
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
 * @typedef {{ go: string, bindings: {name: string, kind: string, line: number, column: number}[], diagnostics: {line: number, column: number, message: string}[], props: boolean, jsImports: {name: string, path: string}[] }} SynthOutput
 */

/**
 * Lowers one Go block of a .vue or .astro file: gosfc synth makes it a Go
 * package, which goesm compiles with the rest of the program.
 * @param {{
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
 * }} b
 * @returns {Promise<{ importPath: string, synth: SynthOutput, res: { modules: GoModuleOutput[], runtime: RuntimeFile[] }, goFiles: string[] }>}
 */
async function compileGoBlock(b) {
  const { code, filename, content, contentOffset, tagOffset, pkgName } = b;
  const blockName = b.block ?? '<script setup lang="go">';
  const mod = findGoModule(path.dirname(filename));
  if (!mod) {
    throw sfcError(filename, code, contentOffset, `no go.mod found for this file; ${blockName} imports Go packages of a Go module`, b.root);
  }

  // The synthetic package lives in a directory that exists only in the
  // overlay, below the component, so the Go visibility rules (internal/)
  // apply as if the component were Go code in its own directory.
  const relDir = path.relative(mod.dir, path.dirname(filename)).split(path.sep).join("/");
  const synthDir = path.join(path.dirname(filename), "_gosfc", pkgName);
  const importPath = [mod.modulePath, relDir, "_gosfc", pkgName].filter(Boolean).join("/");

  const tagPos = lineCol(code, tagOffset);
  const start = lineCol(code, contentOffset);
  const [gosfcBin, goesmBin] = await Promise.all([goTool(mod.dir, "gosfc"), goTool(mod.dir, "goesm")]);

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
    }),
  });
  if (synthRes.code !== 0) throw new Error(`gosfc synth failed:\n${synthRes.stderr}`);
  /** @type {SynthOutput} */
  const synth = JSON.parse(synthRes.stdout);

  /** @type {SfcError[]} */
  const errs = (synth.diagnostics ?? []).map((d) => withFrame({ file: filename, line: d.line, column: d.column, message: d.message }, code));
  for (const bd of b.bindings === false ? [] : synth.bindings ?? []) {
    if (JS_RESERVED.has(bd.name)) {
      errs.push(withFrame({ file: filename, line: bd.line, column: bd.column, message: `${bd.name} is a reserved word in JavaScript and cannot be used by the template; rename it` }, code));
    }
  }
  if (errs.length) throw new GosfcError(errs, b.root);

  const res = await emitTS({
    goesm: goesmBin,
    moduleDir: mod.dir,
    overlay: { [path.join(synthDir, "setup.go")]: synth.go },
    pattern: "./" + path.relative(mod.dir, synthDir).split(path.sep).join("/"),
  });
  if (!res.ok) {
    throw new GosfcError(
      res.diagnostics.map((d) => {
        const file = d.file && !d.file.startsWith(synthDir) ? d.file : filename;
        const pos = d.file && d.line ? { line: d.line, column: d.column ?? 1 } : tagPos;
        const message = d.layer ? `${d.message} [${d.layer}]` : d.message;
        return file === filename ? withFrame({ file, ...pos, message }, code) : { file, ...pos, message };
      }),
      b.root,
    );
  }

  return { importPath, synth, res, goFiles: await watchedGoFiles(res.modules, mod.dir) };
}

/**
 * Compiles a Go package imported from JavaScript or TypeScript (`import { F }
 * from "go:<import path>"` in a .js, .ts or .astro module) rather than from a
 * Go block. The package is resolved in the Go module of the importing file,
 * exactly as an import in a .go file of that module would be.
 * @param {string} importPath
 * @param {string} importer absolute path of the importing file
 * @returns {Promise<{ modules: GoModuleOutput[], runtime: RuntimeFile[], goFiles: string[] }>}
 */
export async function compilePackage(importPath, importer) {
  const mod = findGoModule(path.dirname(importer));
  if (!mod) throw new Error(`gosfc: no go.mod found for ${importer}, which imports go:${importPath}`);
  const goesmBin = await goTool(mod.dir, "goesm");
  const res = await emitTS({ goesm: goesmBin, moduleDir: mod.dir, overlay: {}, pattern: importPath });
  if (!res.ok) {
    const lines = res.diagnostics.map((d) => {
      const at = d.file ? `${d.file}${d.line ? `:${d.line}:${d.column ?? 1}` : ""}: ` : "";
      return at + d.message + (d.layer ? ` [${d.layer}]` : "");
    });
    throw new Error(`gosfc: compiling go:${importPath} (imported by ${importer}) failed:\n${lines.join("\n")}`);
  }
  return { modules: res.modules, runtime: res.runtime, goFiles: await watchedGoFiles(res.modules, mod.dir) };
}

/**
 * The Go source files the lowered modules came from, to watch: files of the
 * user's packages, not of GOROOT or the module cache, nor goesm's own
 * replacements of standard packages (named goesm/natives/...).
 * @param {GoModuleOutput[]} modules
 * @param {string} moduleDir
 */
async function watchedGoFiles(modules, moduleDir) {
  const readOnly = await readOnlyGoDirs(moduleDir);
  const files = new Set();
  for (const m of modules) {
    for (const s of m.map.sources ?? []) {
      if (s.endsWith(".go") && path.isAbsolute(s) && !readOnly.some((d) => s.startsWith(d + path.sep))) files.add(s);
    }
  }
  return [...files];
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

function lineCol(code, offset) {
  const before = code.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}

function offsetOf(code, line, column) {
  let off = 0;
  for (let l = 1; l < line; l++) off = code.indexOf("\n", off) + 1;
  return off + column - 1;
}

/** @param {SfcError} e @param {string} code */
function withFrame(e, code) {
  const off = offsetOf(code, e.line, e.column);
  return { ...e, frame: generateCodeFrame(code, off, off + 1) };
}

function sfcError(file, code, offset, message, root) {
  return new GosfcError([withFrame({ file, ...lineCol(code, offset), message }, code)], root);
}

function displayPath(file, root) {
  const rel = path.relative(root, file);
  return rel.startsWith("..") ? file : rel.split(path.sep).join("/");
}

// Identifiers that are valid in Go but cannot name a JavaScript binding.
const JS_RESERVED = new Set([
  "arguments", "await", "class", "catch", "debugger", "delete", "do", "enum", "eval", "export",
  "extends", "finally", "implements", "in", "instanceof", "interface", "let", "new", "null",
  "package", "private", "protected", "public", "static", "super", "this", "throw", "true", "false",
  "try", "typeof", "void", "while", "with", "yield", "undefined",
]);
