// The Go of an app as one goesm program.
//
// Every Go block of the app (the <script setup lang="go"> of each .vue file,
// the Go frontmatter and Go scripts of each .astro file) and every package a
// JavaScript module imports with go: is an entry of one goesm program per Go
// module, as the packages of one binary are in Go. The code goesm emits for a
// package depends on the whole program (which methods are called through
// interfaces, which function values block), so separate programs would each
// emit, and run, their own copy of a package the components share, and with
// it their own copy of its state. One program lowers each package once: a
// package-level vue.Ref is one Ref for every component.
//
// The program starts with the blocks and go: imports a scan of the app finds
// (scanGoModule in compile.js), so that the first compilation is already the
// whole program, and follows the blocks as they are edited. A block whose Go
// does not compile is left out of the program, and its error is reported for
// its file only; an error in a .go file is every block's error.

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { GosfcError, withFrame } from "./errors.js";
import { emitTS } from "./goesm.js";
import { goTool, readOnlyGoDirs } from "./gomod.js";

/**
 * A Go block made a Go package by gosfc synth (synthBlock in compile.js).
 * @typedef {{
 *   importPath: string,                      // of the synthetic package
 *   pattern: string,                         // its directory, relative to the module, for goesm
 *   synthDir: string,                        // its directory, which exists only in the overlay
 *   go: string,                              // its source
 *   filename: string,                        // the .vue or .astro file
 *   code: string,                            // the file's source
 *   lines: [number, number],                 // the lines of the block in the file
 *   tagPos: { line: number, column: number }, // the tag or fence that opens the block
 *   root: string,
 *   synth: any,
 * }} GoBlock
 * @typedef {import("./goesm.js").GoModuleOutput} GoModuleOutput
 * @typedef {import("./goesm.js").RuntimeFile} RuntimeFile
 * @typedef {import("./goesm.js").GoDiagnostic} GoDiagnostic
 * @typedef {{ modules: GoModuleOutput[], runtime: RuntimeFile[], goFiles: string[] }} Lowered
 * @typedef {Lowered & { key: string | null, failed: Map<string, GoDiagnostic[]>, error: GoDiagnostic[] | null }} Outcome
 */

export class GoProgram {
  /**
   * @param {import("./gomod.js").GoModule} mod
   * @param {() => Promise<{ blocks: GoBlock[], imports: string[] }>} [scan] the blocks and imports to start with
   */
  constructor(mod, scan) {
    this.mod = mod;
    /** @type {Map<string, GoBlock>} import path -> block */
    this.blocks = new Map();
    /** @type {Set<string>} packages imported from JavaScript */
    this.imports = new Set();
    /** @type {Outcome | null} */
    this.outcome = null;
    /** @type {Map<string, string[]>} import path -> goFilesOf */
    this.closures = new Map();
    this.queue = Promise.resolve();
    this.ready = scan
      ? scan().then(
          ({ blocks, imports }) => {
            for (const b of blocks) if (!this.blocks.has(b.importPath)) this.blocks.set(b.importPath, b);
            for (const i of imports) this.imports.add(i);
          },
          () => {},
        )
      : Promise.resolve();
  }

  /** The .go files of the last compilation, to watch. */
  get goFiles() {
    return this.outcome?.goFiles ?? [];
  }

  /**
   * Lowers the program with block in it (replacing an earlier version of the
   * block). Throws the block's own errors, or the program's.
   * @param {GoBlock} block
   * @returns {Promise<Lowered>}
   */
  async lowerBlock(block) {
    await this.ready;
    this.blocks.set(block.importPath, block);
    const o = await this.compile();
    const own = o.failed.get(block.importPath) ?? o.error;
    if (own) throw blockError(block, own);
    return { modules: o.modules, runtime: o.runtime, goFiles: this.goFilesOf(block.importPath) };
  }

  /**
   * Lowers the program with the package importPath, imported from the
   * JavaScript module importer, among its entries.
   * @param {string} importPath
   * @param {string} importer
   * @returns {Promise<Lowered>}
   */
  async lowerImport(importPath, importer) {
    await this.ready;
    this.imports.add(importPath);
    const o = await this.compile();
    if (o.error) {
      const lines = o.error.map((d) => {
        const at = d.file ? `${d.file}${d.line ? `:${d.line}:${d.column ?? 1}` : ""}: ` : "";
        return at + d.message + (d.layer ? ` [${d.layer}]` : "");
      });
      throw new Error(`gosfc: compiling go:${importPath} (imported by ${importer}) failed:\n${lines.join("\n")}`);
    }
    return { modules: o.modules, runtime: o.runtime, goFiles: this.goFilesOf(importPath) };
  }

  /**
   * Leaves out the blocks of file other than those in keep: its Go block
   * was removed, or the file was. Reports whether any was left out. (A scan
   * still running reads the file as it is now.)
   * @param {string} file
   * @param {Set<string>} keep import paths of its blocks still in it
   */
  forget(file, keep) {
    const abs = path.resolve(file);
    let any = false;
    for (const [importPath, b] of this.blocks) {
      if (path.resolve(b.filename) === abs && !keep.has(importPath)) {
        this.blocks.delete(importPath);
        any = true;
      }
    }
    return any;
  }

  /** Makes the next lowering compile again (a .go file changed). */
  invalidate() {
    if (this.outcome) this.outcome.key = null;
  }

  /** @returns {Promise<Outcome>} */
  compile() {
    const p = this.queue.then(() => this.compileNow());
    this.queue = p.catch(() => {});
    return p;
  }

  /** What the program is compiled from: its blocks, its imports and the .go files it read. */
  key(goFiles) {
    const h = createHash("sha256");
    for (const b of [...this.blocks.values()].sort((a, b) => (a.importPath < b.importPath ? -1 : 1))) h.update(b.importPath + "\0" + b.go + "\0");
    for (const i of [...this.imports].sort()) h.update(i + "\0");
    h.update(goFiles.map((f) => (existsSync(f) ? statSync(f).mtimeMs : 0)).join(","));
    return h.digest("hex");
  }

  /** @returns {Promise<Outcome>} */
  async compileNow() {
    if (this.outcome?.key && this.outcome.key === this.key(this.outcome.goFiles)) return this.outcome;
    const goesm = await goTool(this.mod.dir, "goesm");
    const active = new Map(this.blocks);
    /** @type {Map<string, GoDiagnostic[]>} */
    const failed = new Map();
    for (;;) {
      const patterns = [...[...active.values()].map((b) => b.pattern), ...this.imports];
      if (!patterns.length) return this.done({ modules: [], runtime: [], goFiles: [], failed, error: null });
      const overlay = {};
      for (const b of active.values()) overlay[path.join(b.synthDir, "setup.go")] = b.go;
      const res = await emitTS({ goesm, moduleDir: this.mod.dir, overlay, patterns });
      if (!res.ok && res.diagnostics.some((d) => /expected exactly one package/.test(d.message))) {
        // goesm before v0.0.1-beta.5 lowers one package at a time.
        res.diagnostics = [{ message: "gosfc needs goesm v0.0.1-beta.5 or newer, which builds several packages as one program: go get -tool github.com/goesm-dev/goesm/cmd/goesm@latest" }];
      }
      if (res.ok) {
        const goFiles = await watchedGoFiles(res.modules, this.mod.dir);
        return this.done({ modules: res.modules, runtime: res.runtime, goFiles, failed, error: null });
      }
      // The errors of blocks leave those blocks out; any other error is the
      // whole program's.
      const byBlock = new Map();
      let general = false;
      for (const d of res.diagnostics) {
        const b = d.file && blockOf([...active.values()], d);
        if (!b) {
          general = true;
          break;
        }
        if (!byBlock.has(b.importPath)) byBlock.set(b.importPath, []);
        byBlock.get(b.importPath).push(d);
      }
      if (general || !byBlock.size) {
        // Not kept: the next lowering compiles again.
        this.outcome = { key: null, modules: [], runtime: [], goFiles: this.goFiles, failed, error: res.diagnostics };
        return this.outcome;
      }
      for (const [p, ds] of byBlock) {
        failed.set(p, ds);
        active.delete(p);
      }
    }
  }

  /** @param {Omit<Outcome, "key">} o */
  done(o) {
    this.outcome = { ...o, key: this.key(o.goFiles) };
    this.closures = new Map();
    return this.outcome;
  }

  /**
   * The watched .go files the package importPath is lowered from, with those
   * of the packages it imports: a change to one of them changes what the
   * package does.
   * @param {string} importPath
   * @returns {string[]}
   */
  goFilesOf(importPath) {
    const o = this.outcome;
    if (!o) return [];
    const watched = new Set(o.goFiles);
    const byPath = new Map(o.modules.map((m) => [m.importPath, m]));
    const files = new Set();
    const seen = new Set();
    const visit = (p) => {
      if (seen.has(p)) return;
      seen.add(p);
      const m = byPath.get(p);
      if (!m) return;
      if (this.closures.has(p)) {
        for (const f of this.closures.get(p)) files.add(f);
        return;
      }
      for (const s of m.map.sources ?? []) if (watched.has(s)) files.add(s);
      for (const [, spec] of m.code.matchAll(/\b(?:from|import)\s*\(?\s*"(\.\.?\/[^"]+)\.ts"/g)) visit(path.posix.join(path.posix.dirname(p), spec));
    };
    visit(importPath);
    const out = [...files];
    this.closures.set(importPath, out);
    return out;
  }
}

/** The block a diagnostic is in: by its file and lines (an .astro file has several blocks). */
function blockOf(blocks, d) {
  const inFile = blocks.filter((b) => d.file === b.filename || d.file.startsWith(b.synthDir + path.sep));
  if (inFile.length <= 1) return inFile[0];
  return inFile.find((b) => d.line && d.line >= b.lines[0] && d.line <= b.lines[1]) ?? inFile[0];
}

/**
 * The diagnostics of a block, or of the program, at their .vue / .astro
 * positions. A diagnostic without a position is reported at the block's tag.
 * @param {GoBlock} block
 * @param {GoDiagnostic[]} diags
 */
function blockError(block, diags) {
  return new GosfcError(
    diags.map((d) => {
      const file = d.file && !d.file.startsWith(block.synthDir) ? d.file : block.filename;
      const pos = d.file && d.line ? { line: d.line, column: d.column ?? 1 } : block.tagPos;
      const message = d.layer ? `${d.message} [${d.layer}]` : d.message;
      return file === block.filename ? withFrame({ file, ...pos, message }, block.code) : { file, ...pos, message };
    }),
    block.root,
  );
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
