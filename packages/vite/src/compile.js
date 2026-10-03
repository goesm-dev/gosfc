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

import { generateCodeFrame, parse } from "@vue/compiler-sfc";
import { createHash } from "node:crypto";
import MagicString from "magic-string";
import path from "node:path";
import { emitTS } from "./goesm.js";
import { findGoModule, goTool, run } from "./gomod.js";

// The bridge module the generated script imports (runtime/bridge.js). It is a
// virtual id rather than a package specifier so that Vite's SSR never
// externalizes it: it imports @goesm/runtime, which only this plugin resolves.
export const RUNTIME_ID = "gosfc:bridge.js";

/** Quick test used before parsing: does the file contain a Go setup block? */
export function mayHaveGoSetup(code) {
  return /<script\b[^>]*\blang\s*=\s*["']?go\b/.test(code);
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

  const mod = findGoModule(path.dirname(filename));
  if (!mod) {
    throw sfcError(filename, code, block.loc.start.offset, "no go.mod found for this component; <script setup lang=\"go\"> imports Go packages of a Go module", opts.root);
  }

  // The synthetic package lives in a directory that exists only in the
  // overlay, below the component, so the Go visibility rules (internal/)
  // apply as if the component were Go code in its own directory.
  const pkgName = packageName(filename);
  const relDir = path.relative(mod.dir, path.dirname(filename)).split(path.sep).join("/");
  const synthDir = path.join(path.dirname(filename), "_gosfc", pkgName);
  const importPath = [mod.modulePath, relDir, "_gosfc", pkgName].filter(Boolean).join("/");

  const tagOffset = code.lastIndexOf("<script", block.loc.start.offset);
  const tagPos = lineCol(code, tagOffset);
  const [gosfcBin, goesmBin] = await Promise.all([goTool(mod.dir, "gosfc"), goTool(mod.dir, "goesm")]);

  const synthRes = await run(gosfcBin, ["synth"], {
    cwd: mod.dir,
    input: JSON.stringify({
      file: filename,
      package: pkgName,
      source: block.content,
      line: block.loc.start.line,
      column: block.loc.start.column,
      tagLine: tagPos.line,
      tagColumn: tagPos.column,
    }),
  });
  if (synthRes.code !== 0) throw new Error(`gosfc synth failed:\n${synthRes.stderr}`);
  /** @type {{ go: string, bindings: {name: string, kind: string}[], diagnostics: {line: number, column: number, message: string}[] }} */
  const synth = JSON.parse(synthRes.stdout);

  /** @type {SfcError[]} */
  const errs = (synth.diagnostics ?? []).map((d) => withFrame({ file: filename, line: d.line, column: d.column, message: d.message }, code));
  for (const b of synth.bindings ?? []) {
    if (JS_RESERVED.has(b.name)) {
      const at = lineCol(code, block.loc.start.offset + Math.max(0, block.content.search(new RegExp(`\\b${b.name}\\b`))));
      errs.push(withFrame({ file: filename, ...at, message: `${b.name} is a reserved word in JavaScript and cannot be used by the template; rename it` }, code));
    }
  }
  if (errs.length) throw new GosfcError(errs, opts.root);

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
      opts.root,
    );
  }

  // Go source files the lowered modules came from (for watching).
  const goFiles = new Set();
  for (const m of res.modules) for (const s of m.map.sources ?? []) if (s.endsWith(".go")) goFiles.add(s);

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
  const glue = [
    "",
    `import { GosfcSetup as __gosfc_setup } from ${JSON.stringify("go:" + importPath)};`,
    `import { useGo as __gosfc_useGo } from ${JSON.stringify(RUNTIME_ID)};`,
    `const __gosfc = __gosfc_useGo(__gosfc_setup, ${JSON.stringify(hash.digest("hex").slice(0, 16))});`,
    ...synth.bindings.map((b) => `const ${b.name} = __gosfc.binding(${JSON.stringify(b.name)});`),
  ];
  // Keep the line count so positions after the block do not move.
  const lines = block.content.split("\n").length;
  while (glue.length < lines) glue.push("");
  s.overwrite(block.loc.start.offset, block.loc.end.offset, glue.join("\n"));

  return {
    code: s.toString(),
    map: s.generateMap({ source: filename, includeContent: true, hires: true }),
    modules: res.modules,
    runtime: res.runtime,
    goFiles: [...goFiles],
  };
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
