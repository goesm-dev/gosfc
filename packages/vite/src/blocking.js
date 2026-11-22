// Go that blocks where a Vue component cannot wait.
//
// A Go function that blocks (on a channel, a mutex, time.Sleep, a
// JavaScript Promise imported with await, or a call to such a function)
// becomes an async function in goesm's output, and returns a Promise to
// JavaScript. Three places of a Vue component cannot take a Promise:
//
//   * the setup: Vue runs setup() synchronously, and the bridge needs the
//     lookup function GosfcSetup returns (runtime/bridge.js), not a Promise
//     of it;
//   * a Go function the template calls while it renders ({{ Total() }},
//     :title="Name()", v-if="Ready()"): the render shows the Promise.
//     (An event handler may block: the bridge reads the bindings again when
//     its Promise settles.)
//   * the getter of a vue.Computed: Vue computes a computed when it is read
//     and returns its value at once, and follows the Refs the getter reads
//     only until it returns. With a getter that blocks, Get would return
//     the value of the previous computation (the zero value at first, and
//     in a server render), and the Refs read after the getter waited would
//     not be followed at all.
//
// The check reads the lowered TypeScript of the block's package: GosfcSetup,
// or the closure of a binding the template calls, is async. For the
// Computeds, it reads the block's package and the Go packages it imports,
// directly or not: a function passed to vue.NewComputed is async, or calls
// an async function (a method value). The error names
// the chain of calls that blocks. goesm after v0.0.1-beta.9 explains it
// (goesm emit-ts -blocking): the chain goes down to the operation that
// waits, through the standard library and the calls of interface methods
// and function values, naming a method or function that blocks among those
// such a call may reach. With an older goesm, the chain is read from the
// output, from the first await of each function on: the await's position in
// the source map, and the function it awaits, looked up in the module (a
// function of the package) or in the module of the import it names (a
// function of another package), until a call into the standard library or
// a call the module does not show (a method called through an interface, a
// function value).

import { readFileSync } from "node:fs";
import path from "node:path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { parseAst } from "vite";

/**
 * @typedef {import("./goesm.js").GoModuleOutput} GoModuleOutput
 * @typedef {{ file: string, line: number, column: number, text: string, what?: string }} Step
 *   text: the line of Go; what: goesm's explanation of the step, when it
 *   names a callee the line does not show
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
 * @returns {{ offset?: number, chain: Step[], call?: string, computed?: Step }[]} offset: of the
 *   template call in the .vue file; call: the name of the binding it calls;
 *   computed: the call of vue.NewComputed whose getter blocks
 */
export function blockingCalls({ importPath, modules, descriptor, bindings }) {
  const own = modules.find((m) => m.importPath === importPath);
  if (!own) return [];
  const program = new Program(modules);
  const out = /\basync\b/.test(own.code) ? setupCalls(program, own, descriptor, bindings) : [];
  out.push(...blockingComputeds(program, importPath));
  return out;
}

/**
 * The async setup and the async closures the template calls while it
 * renders, of the block's module own.
 * @param {Program} program
 * @param {GoModuleOutput} own
 * @param {import("@vue/compiler-sfc").SFCDescriptor} descriptor
 * @param {string[]} bindings
 */
function setupCalls(program, own, descriptor, bindings) {
  const mod = program.module(own.importPath);
  if (!mod) return [];
  const setup = mod.functions.get("GosfcSetup");
  if (!setup) return [];
  const why = program.why(own.importPath);
  const out = [];
  if (setup.async) out.push({ chain: why?.named("GosfcSetup") ?? program.chain(mod, setup) });
  // The closures of the bindings: Name = async (...) => {...} in the setup.
  const closures = new Map();
  walk(setup.body, (n) => {
    if (n.type === "AssignmentExpression" && n.left.type === "Identifier" && isFunction(n.right)) closures.set(n.left.name, n.right);
  });
  const names = new Set(bindings.filter((b) => closures.get(b)?.async));
  if (names.size) {
    for (const { name, offset } of renderCalls(descriptor, names)) {
      const closure = closures.get(name);
      const at = why && mod.step(closure.start);
      out.push({ offset, call: name, chain: (at && why.literal(at)) ?? program.chain(mod, closure, closures) });
    }
  }
  return out;
}

// The import path of the package vue.NewComputed belongs to.
const vuePackage = "github.com/goesm-dev/gosfc/vue";

/**
 * The calls of vue.NewComputed whose getter blocks, in the block's package
 * and in the Go packages of the module (not the standard library) it
 * imports, directly or not.
 * @param {Program} program
 * @param {string} importPath of the block's package
 * @returns {{ computed: Step, chain: Step[] }[]}
 */
function blockingComputeds(program, importPath) {
  const out = [];
  const seen = new Set([importPath]);
  const queue = [importPath];
  while (queue.length) {
    const p = queue.shift();
    const m = program.byPath.get(p);
    if (!m) continue;
    const imports = importsOf(m);
    for (const target of imports) {
      if (seen.has(target) || target === vuePackage || !target.split("/")[0].includes(".")) continue;
      seen.add(target);
      queue.push(target);
    }
    // A getter that blocks is async in this module or is a function of a
    // module it imports (vue.NewComputed(pkg.Read)).
    if (!/\.NewComputed\b/.test(m.code)) continue;
    if (!hasAsync(m) && !imports.some((t) => t !== vuePackage && hasAsync(program.byPath.get(t)))) continue;
    const mod = program.module(p);
    const vue = mod && [...mod.namespaces].find(([, target]) => target === vuePackage)?.[0];
    if (!vue) continue;
    for (const top of mod.body) {
      const locals = localFunctions(top);
      walkAll(top, (n) => {
        if (n.type !== "CallExpression" || !isMember(unparen(n.callee), vue, "NewComputed")) return;
        const getter = program.asyncTarget(mod, n.arguments.at(-1), locals);
        if (!getter) return;
        const computed = mod.step(n.start);
        if (!computed) return;
        out.push({ computed, chain: program.whyOf(getter.mod, getter.fn) ?? program.chain(getter.mod, getter.fn, getter.mod === mod ? locals : new Map()) });
      });
    }
  }
  return out;
}

/** Whether the module m has async functions. @param {GoModuleOutput | undefined} m */
function hasAsync(m) {
  return /\basync\b/.test(m?.code ?? "");
}

/** The import paths of the modules m imports. @param {GoModuleOutput} m */
function importsOf(m) {
  const out = [];
  for (const [, spec] of m.code.matchAll(/^import\s+(?:[^"';]*?\s+from\s+)?"([^"]+)\.ts";?$/gm)) {
    if (spec.startsWith(".")) out.push(path.posix.join(path.posix.dirname(m.importPath), spec));
  }
  return out;
}

/** Whether n is the member expression object.name. */
function isMember(n, object, name) {
  return n?.type === "MemberExpression" && !n.computed && n.object.type === "Identifier" && n.object.name === object && n.property.type === "Identifier" && n.property.name === name;
}

/**
 * The functions a statement assigns to names (the closures of a setup, and
 * of any other function: Name = (...) => {...}, let name = ...).
 * @returns {Map<string, any>}
 */
function localFunctions(stmt) {
  const out = new Map();
  walkAll(stmt, (n) => {
    if (n.type === "AssignmentExpression" && n.left.type === "Identifier" && isFunction(unparen(n.right))) out.set(n.left.name, unparen(n.right));
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && isFunction(unparen(n.init))) out.set(n.id.name, unparen(n.init));
  });
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

/** goesm's explanations of the functions of a package that block. */
class Why {
  /** @param {import("./goesm.js").BlockingFunc[]} funcs */
  constructor(funcs) {
    this.funcs = funcs;
    /** @type {Map<string, string[] | null>} */
    this.files = new Map();
  }

  /** The chain of the package's function name. @returns {Step[] | null} */
  named(name) {
    const f = this.funcs.find((f) => f.name === name || f.name.endsWith("." + name));
    return f ? this.steps(f) : null;
  }

  /**
   * The chain of the function literal at a position: the one on its line
   * nearest to it (the source map places a closure at or next to its func).
   * @param {Step} at
   * @returns {Step[] | null}
   */
  literal(at) {
    let best = null;
    for (const f of this.funcs) {
      if (f.name !== "" || f.file !== at.file || f.line !== at.line) continue;
      if (!best || Math.abs(f.column - at.column) < Math.abs(best.column - at.column)) best = f;
    }
    return best ? this.steps(best) : null;
  }

  /** @param {import("./goesm.js").BlockingFunc} f @returns {Step[]} */
  steps(f) {
    return f.steps.map((s) => {
      const step = { file: s.file, line: s.line, column: s.column, text: this.line(s.file, s.line) };
      // A callee the line does not show (a method or a function a call of
      // an interface method or a function value may reach, what a function
      // variable or a parameter holds), or a line that cannot be read.
      if (!step.text || /, which may be |that holds /.test(s.what)) step.what = s.what;
      return step;
    });
  }

  /** A line of a file, trimmed (empty when it cannot be read). */
  line(file, line) {
    if (!this.files.has(file)) {
      let lines = null;
      try {
        lines = readFileSync(file, "utf8").split("\n");
      } catch {
        // A file goesm names relative to its own tree (its patches of the
        // standard library): the step has no line.
      }
      this.files.set(file, lines);
    }
    return (this.files.get(file)?.[line - 1] ?? "").trim();
  }
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
   * goesm's explanations of the functions of a package that block, when it
   * wrote them (for the packages a program is built from).
   * @param {string} importPath
   * @returns {Why | null}
   */
  why(importPath) {
    this.whys ??= new Map();
    if (!this.whys.has(importPath)) {
      const funcs = this.byPath.get(importPath)?.blocking;
      this.whys.set(importPath, funcs ? new Why(funcs) : null);
    }
    return this.whys.get(importPath);
  }

  /**
   * goesm's explanation of the async function fn of mod: a declared
   * function by its name, a function literal by its position.
   * @param {ParsedModule} mod
   * @param {any} fn
   * @returns {Step[] | null}
   */
  whyOf(mod, fn) {
    const why = this.why(mod.m.importPath);
    if (!why) return null;
    if (fn.type === "FunctionDeclaration") return why.named(fn.id.name);
    const at = mod.step(fn.start);
    return at && why.literal(at);
  }

  /**
   * The async function that calling the function value n of mod runs:
   * n itself when it is async, a function a wrapper of n returns the result
   * of (a method value: (...a) => T$M(recv, ...a)), or the declared function
   * or closure it names. Null when the module does not show one.
   * @param {ParsedModule} mod
   * @param {any} n
   * @param {Map<string, any>} locals closures n may name
   * @returns {{ mod: ParsedModule, fn: any } | null}
   */
  asyncTarget(mod, n, locals, depth = 0) {
    n = unparen(n);
    if (!n || depth > 8) return null;
    if (isFunction(n)) {
      if (n.async) return { mod, fn: n };
      // A wrapper that returns what it calls returns its Promise.
      const body = unparen(n.body);
      return body?.type === "CallExpression" ? this.asyncTarget(mod, body.callee, locals, depth + 1) : null;
    }
    if (n.type === "CallExpression") {
      // A function that returns a function: ((r) => (...a) => T$M(r, ...a))(x).
      const f = unparen(n.callee);
      return isFunction(f) && f.body.type !== "BlockStatement" ? this.asyncTarget(mod, f.body, locals, depth + 1) : null;
    }
    if (n.type === "Identifier") {
      const local = locals.get(n.name);
      if (local) return this.asyncTarget(mod, local, new Map(), depth + 1);
      const f = mod.functions.get(n.name);
      return f?.async ? { mod, fn: f } : null;
    }
    if (n.type === "MemberExpression" && !n.computed && n.object.type === "Identifier" && n.property.type === "Identifier") {
      const target = mod.namespaces.get(n.object.name);
      const m = target && this.module(target);
      const f = m?.functions.get(n.property.name);
      return f?.async ? { mod: m, fn: f } : null;
    }
    return null;
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
    /** @type {any[]} the top-level statements */
    this.body = ast.body;
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
// An expression without its parentheses and TypeScript's casts ((f as any)).
const unparen = (n) =>
  n?.type === "ParenthesizedExpression" || n?.type === "TSAsExpression" || n?.type === "TSNonNullExpression" || n?.type === "TSSatisfiesExpression" || n?.type === "TSTypeAssertion"
    ? unparen(n.expression)
    : n;

/** The first await of a function body, in source order, outside nested functions. */
function firstAwait(body) {
  let first = null;
  walk(body, (n) => {
    if (n.type === "AwaitExpression" && (!first || n.start < first.start)) first = n;
  });
  return first;
}

/** Calls f on the nodes of an AST, nested functions included. */
function walkAll(node, f) {
  if (!node || typeof node.type !== "string") return;
  f(node);
  for (const k of Object.keys(node)) {
    if (k === "type" || k === "start" || k === "end") continue;
    const v = node[k];
    for (const c of Array.isArray(v) ? v : [v]) if (c && typeof c.type === "string") walkAll(c, f);
  }
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
