// The TypeScript view of Go components, for the Vue language tools: vue-tsc
// and the Vue extensions of editors, which load it as a plugin of
// @vue/language-core named in tsconfig.json (vue-language-plugin.cjs):
//
//   "vueCompilerOptions": { "plugins": ["@gosfc/vite/vue-language-plugin"] }
//
// The language tools generate TypeScript from a <script setup> in
// TypeScript or JavaScript only. For a Go block they generate nothing, so
// the component is not a module to TypeScript, and a TypeScript component
// importing it fails with TS2306. The plugin shows them, in place of the Go
// block, a <script setup lang="ts"> that declares what the component is:
//
//   type __gosfc_In = typeof import("go:example.com/app/src/_gosfc/child_vue") extends { GosfcSetup(props: infer P): any } ? P : unknown;
//   type __gosfc_Prop<K extends string> = __gosfc_In extends { [k in K]?: infer T } ? T : any;
//   defineProps<{ "label"?: __gosfc_Prop<"Label">; "count"?: __gosfc_Prop<"Count"> }>();
//   defineEmits<{ "picked": any[] }>();
//   let props!: any;
//   let Pick!: any;
//
// The props are the fields of the block's Props type, by the names the glue
// declares them by (compile.js), all optional. Their types are those of the
// fields of the setup function's parameter in the declaration file goesm
// writes for the block's package, which the plugins write to the types file
// with those of the go: imports (types.js); until the Go has been compiled
// (or without the types file), they are any. The events are the ones gosfc
// synth finds passed to the function vue.Emitter returns, with any
// arguments. The bindings, which the template reads, are any.
//
// The language tools are synchronous, so the plugin runs gosfc synth
// synchronously, as the Vite plugin does when it compiles the block (it
// never compiles Go). When synth cannot run (no go command, no gosfc tool in
// go.mod), the props are any and the bindings are the names the template
// reads.
//
// None of the view maps to the .vue file: its errors, hovers and formatting
// never land on the Go code. Errors in the template still point at the
// template.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { parse } from "@vue/compiler-sfc";
import { blockImportPath, JS_RESERVED, mayHaveGoSetup, packageName, propFields, templateNames } from "./compile.js";
import { findGoModule } from "./gomod.js";

/** Go module directory -> path of its gosfc tool, or why it cannot run. */
const tools = new Map();
/** .vue file -> the last Go block synth read and its output */
const synthCache = new Map();
/** Go module directories whose synth failure was reported. */
const warned = new Set();

/**
 * The gosfc tool of the Go module at dir (go tool -n, as gomod.js's goTool).
 * @param {string} dir
 * @returns {string}
 */
function gosfcTool(dir) {
  let t = tools.get(dir);
  if (t === undefined) {
    try {
      t = execFileSync("go", ["tool", "-n", "gosfc"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
        .trim()
        .split("\n")
        .pop()
        .trim();
    } catch (e) {
      t = new Error(`\`go tool gosfc\` is not available in ${dir}: ${String(/** @type {any} */ (e).stderr || /** @type {Error} */ (e).message).trim()}`);
    }
    tools.set(dir, t);
  }
  if (t instanceof Error) throw t;
  return t;
}

/** 1-based line and column of offset in code. */
function lineCol(code, offset) {
  const before = code.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}

/**
 * What gosfc synth reads of the Go block of a .vue file (its bindings, the
 * keys of its Props and its events), and the import path of its package.
 * Null when synth cannot run.
 * @param {string} code
 * @param {string} filename
 * @param {import("@vue/compiler-sfc").SFCScriptBlock} block
 * @returns {{ importPath: string, synth: { bindings?: { name: string }[], props?: boolean, propKeys?: string[], emits?: string[] } } | null}
 */
function readBlock(code, filename, block) {
  const mod = findGoModule(path.dirname(filename));
  if (!mod) return null;
  const pkgName = packageName(filename);
  const importPath = blockImportPath(mod, filename, pkgName);
  const c = synthCache.get(filename);
  if (c && c.source === block.content && c.importPath === importPath) return c.result;
  let result = null;
  try {
    const start = lineCol(code, block.loc.start.offset);
    const tag = lineCol(code, code.lastIndexOf("<script", block.loc.start.offset));
    const out = execFileSync(gosfcTool(mod.dir), ["synth"], {
      cwd: mod.dir,
      encoding: "utf8",
      maxBuffer: 256 << 20,
      input: JSON.stringify({
        file: filename,
        package: pkgName,
        source: block.content,
        line: start.line,
        column: start.column,
        tagLine: tag.line,
        tagColumn: tag.column,
        used: null,
      }),
    });
    result = { importPath, synth: JSON.parse(out) };
  } catch (e) {
    if (!warned.has(mod.dir)) {
      warned.add(mod.dir);
      console.warn(`gosfc: the Go components of ${mod.dir} are typed as any: ${/** @type {Error} */ (e).message}`);
    }
  }
  synthCache.set(filename, { source: block.content, importPath, result });
  return result;
}

const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/**
 * The TypeScript that stands for the Go block of a .vue file (see the top
 * of this file).
 * @param {string} code
 * @param {string} filename
 * @param {import("@vue/compiler-sfc").SFCDescriptor} descriptor
 * @returns {string}
 */
export function goView(code, filename, descriptor) {
  const q = JSON.stringify;
  const lines = ["// The types of the Go block, from gosfc (@gosfc/vite/vue-language-plugin)."];
  const read = readBlock(code, filename, descriptor.scriptSetup);
  /** @type {string[]} */
  let bindings;
  if (read) {
    const { importPath, synth } = read;
    if (synth.props) {
      lines.push(
        `type __gosfc_In = typeof import(${q("go:" + importPath)}) extends { GosfcSetup(props: infer P): any } ? P : unknown;`,
        "type __gosfc_Prop<K extends string> = __gosfc_In extends { [k in K]?: infer T } ? T : any;",
        `defineProps<{ ${propFields(synth)
          .map(([key, name]) => `${q(name)}?: __gosfc_Prop<${q(key)}>`)
          .join("; ")} }>();`,
      );
    }
    if (synth.emits?.length) lines.push(`defineEmits<{ ${synth.emits.map((e) => `${q(e)}: any[]`).join("; ")} }>();`);
    bindings = (synth.bindings ?? []).map((b) => b.name);
  } else {
    lines.push("defineProps<Record<string, any>>();");
    bindings = templateNames(descriptor, filename) ?? [];
  }
  for (const name of new Set(bindings)) if (IDENT.test(name) && !JS_RESERVED.has(name)) lines.push(`let ${name}!: any;`);
  return "\n" + lines.join("\n") + "\n";
}

/**
 * The plugin of @vue/language-core (vue-language-plugin.cjs). It is two:
 * the first parses a .vue file with a Go block before the language tools
 * do, and replaces the block with its view (goView); the second, after the
 * language tools generated their TypeScript, unmaps the code generated from
 * the view.
 * @returns {object[]}
 */
export function vueLanguagePlugin() {
  return [
    {
      version: 2.2,
      name: "gosfc",
      order: -1,
      /**
       * @param {string} fileName
       * @param {string} languageId
       * @param {string} content
       */
      parseSFC2(fileName, languageId, content) {
        if (languageId !== "vue" || !mayHaveGoSetup(content)) return undefined;
        try {
          const r = parse(content, { filename: fileName, sourceMap: false, ignoreEmpty: false });
          const block = r.descriptor.scriptSetup;
          // A file with SFC errors is the language tools' to report.
          if (r.errors.length || block?.lang !== "go") return undefined;
          // The block keeps its attributes (lang="go"), which tell the second
          // plugin which files have a view.
          const scriptSetup = { ...block, lang: "ts", content: goView(content, fileName, r.descriptor) };
          return { ...r, descriptor: { ...r.descriptor, scriptSetup } };
        } catch (e) {
          console.warn(`gosfc: ${fileName}: ${/** @type {Error} */ (e).message}`);
          return undefined;
        }
      },
    },
    {
      version: 2.2,
      name: "gosfc (view)",
      order: 1,
      /**
       * @param {string} _fileName
       * @param {any} ir
       * @param {{ content: (string | [string, string | undefined, number, object])[] }} code
       */
      resolveEmbeddedCode(_fileName, ir, code) {
        const setup = ir.scriptSetup;
        if (setup?.attrs?.lang !== "go") return;
        code.content = code.content.map((s) => (typeof s !== "string" && s[1] === setup.name ? s[0] : s));
      },
    },
  ];
}
