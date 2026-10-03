// The boundary between gosfc and goesm.
//
// This is the only file that knows how goesm is invoked and how its output is
// laid out. gosfc hands goesm one generated Go file through the go command's
// standard overlay mechanism and gets TypeScript modules with source maps, or
// diagnostics, back:
//
//   goesm emit-ts -overlay <overlay.json> -o <dir> <package pattern>
//     -> <dir>/go/<import path>.ts (+ .ts.map)  one module per Go package
//     -> <dir>/@goesm/runtime/src/*.ts           the goesm runtime
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
 * @typedef {{ importPath: string, code: string, map: any }} GoModuleOutput
 * @typedef {{ file: string, code: string }} RuntimeFile
 * @typedef {{ file?: string, line?: number, column?: number, message: string, layer?: string }} GoDiagnostic
 * @typedef {{ ok: true, modules: GoModuleOutput[], runtime: RuntimeFile[] }
 *   | { ok: false, diagnostics: GoDiagnostic[] }} GoesmResult
 */

/**
 * Lowers the Go package `pattern` (and its dependencies) to TypeScript.
 * @param {object} opts
 * @param {string} opts.goesm path of the goesm binary
 * @param {string} opts.moduleDir directory of the main module's go.mod
 * @param {Record<string, string>} opts.overlay absolute path -> file contents
 * @param {string} opts.pattern Go package pattern, relative to moduleDir
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
    const r = await run(opts.goesm, ["emit-ts", "-overlay", overlayFile, "-o", outDir, opts.pattern], {
      cwd: opts.moduleDir,
    });
    if (r.code !== 0) {
      return { ok: false, diagnostics: parseDiagnostics(r.stderr) };
    }

    const goDir = path.join(outDir, "go");
    /** @type {GoModuleOutput[]} */
    const modules = [];
    for (const line of r.stdout.split("\n")) {
      const tsFile = line.trim();
      if (!tsFile.endsWith(".ts")) continue;
      const importPath = path.relative(goDir, tsFile).split(path.sep).join("/").replace(/\.ts$/, "");
      const code = stripSourceMapComment(await readFile(tsFile, "utf8"));
      const map = JSON.parse(await readFile(tsFile + ".map", "utf8"));
      modules.push({ importPath, code, map });
    }
    const runtimeDir = path.join(outDir, "@goesm", "runtime", "src");
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

/** @param {string} code */
function stripSourceMapComment(code) {
  return code.replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/, "\n");
}
