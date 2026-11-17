// Go that blocks where a Vue component cannot wait.
//
// A Go function that blocks (on a channel, a mutex, time.Sleep, a
// JavaScript Promise imported with await, or a call to such a function)
// becomes an async function in goesm's output, and returns a Promise to
// JavaScript. Two places of a Vue component cannot take a Promise:
//
//   * the setup: Vue runs setup() synchronously, and the bridge needs the
//     lookup function GosfcSetup returns (runtime/bridge.js), not a Promise
//     of it;
//   * a Go function the template calls while it renders ({{ Total() }},
//     :title="Name()", v-if="Ready()"): the render shows the Promise.
//     (An event handler may block: the bridge reads the bindings again when
//     its Promise settles.)
//
// goesm reports which functions are async only in its output, so the check
// reads the lowered TypeScript of the block's package: GosfcSetup, or the
// closure of a binding the template calls, is async. The error names the
// chain of calls that blocks, from the first await of each function on:
// the await's position in the source map, and the function it awaits,
// looked up in the module (a function of the package) or in the module of
// the import it names (a function of another package), until a call into
// the standard library or a call the module does not show (a method called
// through an interface, a function value).

import { readFileSync } from "node:fs";
import path from "node:path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { parseAst } from "vite";

/**
 * @typedef {import("./goesm.js").GoModuleOutput} GoModuleOutput
 * @typedef {{ file: string, line: number, column: number, text: string }} Step
 */

/**
 * The places of a Vue component's Go block that block where Vue cannot
 * wait: the setup, and the Go functions the template calls while it
 * renders. Empty when there are none.
 * @param {{
 *   importPath: string,            // of the block's package
 *   modules: GoModuleOutput[],     // the program's lowered modules
 *   descriptor: import("@vue/compiler-sfc").SFCDescriptor,
 *   bindings: string[],            // the block's bindings
 * }} opts
 * @returns {{ offset?: number, chain: Step[], call?: string }[]} offset: of the
 *   template call in the .vue file; call: the name of the binding it calls
 */
export function blockingCalls({ importPath, modules, descriptor, bindings }) {
  const own = modules.find((m) => m.importPath === importPath);
  if (!own || !/\basync\b/.test(own.code)) return [];
  const program = new Program(modules);
  const mod = program.module(importPath);
  if (!mod) return [];
  const setup = mod.functions.get("GosfcSetup");
  if (!setup) return [];
  const out = [];
  if (setup.async) out.push({ chain: program.chain(mod, setup) });
  // The closures of the bindings: Name = async (...) => {...} in the setup.
  const closures = new Map();
  walk(setup.body, (n) => {
    if (n.type === "AssignmentExpression" && n.left.type === "Identifier" && isFunction(n.right)) closures.set(n.left.name, n.right);
  });
  const names = new Set(bindings.filter((b) => closures.get(b)?.async));
  if (names.size) {
    for (const { name, offset } of renderCalls(descriptor, names)) {
      out.push({ offset, call: name, chain: program.chain(mod, closures.get(name), closures) });
    }
  }
  return out;
}

/**
 * The calls of the names in the expressions the template evaluates while it
 * renders: interpolations and the values of directives other than v-on.
 * @param {import("@vue/compiler-sfc").SFCDescriptor} descriptor
 * @param {Set<string>} names
 * @returns {{ name: string, offset: number }[]}
 */
function renderCalls(descriptor, names) {
  const t = descriptor.template;
  if (!t?.ast || t.src || (t.lang && t.lang !== "html")) return [];
  const call = new RegExp(`(?<![\\p{L}\\p{N}_$.])(${[...names].map((n) => n.replace(/\$/g, "\\$")).join("|")})\\s*\\(`, "gu");
  const out = [];
  const scan = (exp) => {
    if (!exp || exp.type !== 4 || exp.isStatic) return;
    for (const m of exp.content.matchAll(call)) out.push({ name: m[1], offset: exp.loc.start.offset + m.index });
  };
  const visit = (node) => {
    if (node.type === 5) scan(node.content); // {{ ... }}
    for (const p of node.props ?? []) if (p.type === 7 && p.name !== "on") scan(p.exp);
    for (const c of node.children ?? []) visit(c);
  };
  visit(t.ast);
  return out;
}

/** The lowered modules, parsed as they are needed. */
class Program {
  /** @param {GoModuleOutput[]} modules */
  constructor(modules) {
    this.byPath = new Map(modules.map((m) => [m.importPath, m]));
    /** @type {Map<string, ParsedModule | null>} */
    this.parsed = new Map();
  }

  /** @param {string} importPath @returns {ParsedModule | null} */
  module(importPath) {
    if (!this.parsed.has(importPath)) {
      const m = this.byPath.get(importPath);
      let p = null;
      if (m) {
        try {
          p = new ParsedModule(m);
        } catch {
          // Output this file cannot read: the chain ends here.
        }
      }
      this.parsed.set(importPath, p);
    }
    return this.parsed.get(importPath) ?? null;
  }

  /**
   * The calls that make the async function fn of mod block, from its first
   * await on.
   * @param {ParsedModule} mod
   * @param {any} fn
   * @param {Map<string, any>} [locals] closures fn may call by name
   * @returns {Step[]}
   */
  chain(mod, fn, locals = new Map()) {
    const steps = [];
    const seen = new Set();
    for (let depth = 0; fn && depth < 32 && !seen.has(fn); depth++) {
      seen.add(fn);
      const a = firstAwait(fn.body);
      if (!a) break;
      const step = mod.step(a.start);
      if (step) steps.push(step);
      const next = this.callee(mod, unparen(a.argument), locals);
      if (!next) break;
      ({ mod, fn } = next);
      locals = new Map();
    }
    return steps;
  }

  /** The async function a call awaits, when the module shows it. */
  callee(mod, call, locals) {
    if (call?.type !== "CallExpression") return null;
    const c = unparen(call.callee);
    if (c.type === "Identifier") {
      const local = locals.get(c.name);
      if (local?.async) return { mod, fn: local };
      const f = mod.functions.get(c.name);
      return f?.async ? { mod, fn: f } : null;
    }
    if (c.type === "MemberExpression" && !c.computed && c.object.type === "Identifier" && c.property.type === "Identifier") {
      const target = mod.namespaces.get(c.object.name);
      // A call into the standard library ends the chain at the call.
      if (!target || !target.split("/")[0].includes(".")) return null;
      const m = this.module(target);
      const f = m?.functions.get(c.property.name);
      return f?.async ? { mod: m, fn: f } : null;
    }
    return null;
  }
}

class ParsedModule {
  /** @param {GoModuleOutput} m */
  constructor(m) {
    this.m = m;
    const ast = parseAst(m.code, { lang: "ts" });
    /** @type {Map<string, any>} top-level functions by name */
    this.functions = new Map();
    /** @type {Map<string, string>} import namespace -> import path */
    this.namespaces = new Map();
    for (const s of ast.body) {
      if (s.type === "FunctionDeclaration" && s.id) this.functions.set(s.id.name, s);
      if (s.type === "ImportDeclaration") {
        for (const sp of s.specifiers) {
          if (sp.type !== "ImportNamespaceSpecifier") continue;
          const target = path.posix.join(path.posix.dirname(m.importPath), s.source.value).replace(/\.ts$/, "");
          this.namespaces.set(sp.local.name, target);
        }
      }
    }
    this.lineStarts = [0];
    for (let i = m.code.indexOf("\n"); i >= 0; i = m.code.indexOf("\n", i + 1)) this.lineStarts.push(i + 1);
  }

  /** The Go position of the generated offset, and its line of Go. @returns {Step | null} */
  step(offset) {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    this.map ??= new TraceMap(this.m.map);
    const p = originalPositionFor(this.map, { line: lo + 1, column: offset - this.lineStarts[lo] });
    if (!p.source || !p.line) return null;
    return { file: p.source, line: p.line, column: (p.column ?? 0) + 1, text: sourceLine(this.map, p.source, p.line) };
  }
}

/** The line of a source of a map, trimmed (empty when it cannot be read). */
function sourceLine(map, source, line) {
  let text;
  const i = map.resolvedSources.indexOf(source);
  text = i >= 0 ? map.sourcesContent?.[i] : null;
  if (text == null) {
    try {
      text = readFileSync(source, "utf8");
    } catch {
      return "";
    }
  }
  return (text.split("\n")[line - 1] ?? "").trim();
}

const isFunction = (n) => n?.type === "ArrowFunctionExpression" || n?.type === "FunctionExpression";
const unparen = (n) => (n?.type === "ParenthesizedExpression" ? unparen(n.expression) : n);

/** The first await of a function body, in source order, outside nested functions. */
function firstAwait(body) {
  let first = null;
  walk(body, (n) => {
    if (n.type === "AwaitExpression" && (!first || n.start < first.start)) first = n;
  });
  return first;
}

/** Calls f on the nodes of an AST, not entering nested functions. */
function walk(node, f) {
  if (!node || typeof node.type !== "string") return;
  f(node);
  for (const k of Object.keys(node)) {
    if (k === "type" || k === "start" || k === "end") continue;
    const v = node[k];
    for (const c of Array.isArray(v) ? v : [v]) {
      if (c && typeof c.type === "string" && !isFunction(c) && c.type !== "FunctionDeclaration") walk(c, f);
    }
  }
}
