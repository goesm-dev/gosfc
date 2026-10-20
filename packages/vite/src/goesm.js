// The boundary between gosfc and goesm.
//
// This is the only file that knows how goesm is invoked and how its output is
// laid out. gosfc hands goesm generated Go files through the go command's
// standard overlay mechanism and gets TypeScript modules with source maps, or
// diagnostics, back:
//
//   goesm emit-ts -overlay <overlay.json> -o <dir> <package pattern>...
//     -> <dir>/<import path>.ts (+ .ts.map)     one module per Go package
//     -> <dir>/@goesm/runtime/*.ts               the goesm runtime
//     -> <dir>/<import path>.d.ts                the exports of an entry (-dts, goesm
//                                                 after v0.0.1-beta.7): the types of go: imports
//     modules import each other and the runtime with relative "./x.ts" specifiers
//     -> exit 1 and "<file>:<line>:<col>: <message> [<layer>]" on stderr
//
// Parsing, type checking, module and package resolution and lowering all
// happen inside goesm (and the go command it drives). gosfc never looks at a
// Go AST.

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./gomod.js";

/**
 * @typedef {{ importPath: string, code: string, map: any, dts?: string }} GoModuleOutput
 * @typedef {{ file: string, code: string }} RuntimeFile
 * @typedef {{ file?: string, line?: number, column?: number, message: string, layer?: string }} GoDiagnostic
 * @typedef {{ ok: true, modules: GoModuleOutput[], runtime: RuntimeFile[] }
 *   | { ok: false, diagnostics: GoDiagnostic[] }} GoesmResult
 */

/**
 * Lowers the Go packages `patterns` (and their dependencies) to TypeScript,
 * as one program whose entries they are.
 * @param {object} opts
 * @param {string} opts.goesm path of the goesm binary
 * @param {string} opts.moduleDir directory of the main module's go.mod
 * @param {Record<string, string>} opts.overlay absolute path -> file contents
 * @param {string[]} opts.patterns Go package patterns, relative to moduleDir
 * @returns {Promise<GoesmResult>}
 */
export async function emitTS(opts) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "gosfc-"));
  try {
    const replace = {};
    let i = 0;
    for (const [target, content] of Object.entries(opts.overlay)) {
      const file = path.join(tmp, `overlay${i++}.go`);
      await writeFile(file, content);
      replace[target] = file;
    }
    const overlayFile = path.join(tmp, "overlay.json");
    await writeFile(overlayFile, JSON.stringify({ Replace: replace }));
    const outDir = path.join(tmp, "out");
    const emit = (flags) => run(opts.goesm, ["emit-ts", ...flags, "-overlay", overlayFile, "-o", outDir, ...opts.patterns], { cwd: opts.moduleDir });
    let r = await emit(["-dts"]);
    // goesm v0.0.1-beta.7 and older write no declaration files.
    if (r.code !== 0 && /flag provided but not defined: -dts/.test(r.stderr)) r = await emit([]);
    if (r.code !== 0) {
      return { ok: false, diagnostics: parseDiagnostics(r.stderr) };
    }

    /** @type {GoModuleOutput[]} */
    const modules = [];
    for (const line of r.stdout.split("\n")) {
      const tsFile = line.trim();
      if (!tsFile.endsWith(".ts")) continue;
      const importPath = path.relative(outDir, tsFile).split(path.sep).join("/").replace(/\.ts$/, "");
      const code = absoluteFileImports(stripSourceMapComment(await readFile(tsFile, "utf8")), tsFile, outDir);
      const map = JSON.parse(await readFile(tsFile + ".map", "utf8"));
      const dts = await readFile(tsFile.replace(/\.ts$/, ".d.ts"), "utf8").catch(() => undefined);
      modules.push({ importPath, code, map, dts });
    }
    const runtimeDir = path.join(outDir, "@goesm", "runtime");
    /** @type {RuntimeFile[]} */
    const runtime = [];
    for (const file of await readdir(runtimeDir)) {
      if (file.endsWith(".ts")) runtime.push({ file, code: await readFile(path.join(runtimeDir, file), "utf8") });
    }
    return { ok: true, modules, runtime };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * goesm writes one diagnostic per line: "<pos>: <message> [<layer>]", where
 * <pos> is file:line:col as reported by the Go frontend, or no position.
 * @param {string} stderr
 * @returns {GoDiagnostic[]}
 */
export function parseDiagnostics(stderr) {
  /** @type {GoDiagnostic[]} */
  const out = [];
  for (const raw of stderr.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (/^\s/.test(line) && out.length) {
      out[out.length - 1].message += "\n" + line;
      continue;
    }
    let message = line;
    let layer;
    const lm = / \[([^\]]+)\]$/.exec(message);
    if (lm) {
      layer = lm[1];
      message = message.slice(0, lm.index);
    }
    const pm = /^(.+?):(\d+):(\d+): (.*)$/s.exec(message);
    if (pm) {
      out.push({ file: pm[1], line: Number(pm[2]), column: Number(pm[3]), message: pm[4], layer });
    } else {
      out.push({ message, layer });
    }
  }
  return out;
}

/**
 * goesm writes the files that //goesm:import directives import (a .ts
 * function, a .vue component) relative to the module's place in the output
 * directory. The modules live in Vite's module graph under virtual ids, so
 * those imports become absolute paths of the files, the dynamic import()
 * of a lazy directive too.
 * @param {string} code
 * @param {string} tsFile
 * @param {string} outDir
 */
export function absoluteFileImports(code, tsFile, outDir) {
  /** @param {string} spec */
  const absolute = (spec) => {
    const target = path.resolve(path.dirname(tsFile), spec);
    return target.startsWith(outDir + path.sep) ? undefined : JSON.stringify(target.split(path.sep).join("/"));
  };
  return code
    .replace(/^(import\b[^"\n]*from )"(\.\.?\/[^"\n]*)";$/gm, (line, head, spec) => {
      const abs = absolute(spec);
      return abs ? `${head}${abs};` : line;
    })
    .replace(
      // The loader of a lazy //goesm:import: const f = (): Promise<any> => (f$m ??= import("./x.ts"));
      /^(const ([\w$]+) = \(\): Promise<any> => \(\2\$m \?\?= import\()"(\.\.?\/[^"\n]*)"(\)\);)$/gm,
      (line, head, _name, spec, tail) => {
        const abs = absolute(spec);
        return abs ? `${head}${abs}${tail}` : line;
      },
    );
}

/** @param {string} code */
function stripSourceMapComment(code) {
  return code.replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/, "\n");
}
