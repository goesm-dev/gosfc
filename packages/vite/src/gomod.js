// Locating the Go module of a .vue file and running the Go tools it pins.
//
// gosfc does not resolve Go modules or packages. It only finds the nearest
// go.mod (the directory the go command would treat as the main module) so it
// can run the go command there; the go command does everything else.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {{ dir: string, modulePath: string }} GoModule
 */

/** @type {Map<string, GoModule | null>} */
const moduleCache = new Map();

/**
 * Returns the Go module containing dir, or null when there is none.
 * @param {string} dir
 * @returns {GoModule | null}
 */
export function findGoModule(dir) {
  if (moduleCache.has(dir)) return moduleCache.get(dir) ?? null;
  let result = null;
  const gomod = path.join(dir, "go.mod");
  if (existsSync(gomod)) {
    // The module path is needed to name the synthetic package's import path;
    // it is the argument of the module directive.
    const m = /^\s*module\s+("?)([^\s"]+)\1/m.exec(readFileSync(gomod, "utf8"));
    if (m) result = { dir, modulePath: m[2] };
  } else {
    const parent = path.dirname(dir);
    if (parent !== dir) result = findGoModule(parent);
  }
  moduleCache.set(dir, result);
  return result;
}

/** @type {Map<string, Promise<string>>} */
const toolCache = new Map();

/**
 * Returns the path of the binary of a tool declared with a tool directive in
 * the module's go.mod (`go tool -n` builds it with the toolchain the module
 * selects and prints its path), so the versions of goesm and gosfc are the
 * ones pinned in go.mod and verified by go.sum.
 * @param {string} moduleDir
 * @param {string} name
 */
export function goTool(moduleDir, name) {
  const key = moduleDir + "\0" + name;
  let p = toolCache.get(key);
  if (!p) {
    p = run("go", ["tool", "-n", name], { cwd: moduleDir }).then((r) => {
      if (r.code !== 0) {
        throw new Error(
          `gosfc: \`go tool ${name}\` is not available in ${moduleDir}.\n` +
            `Add it to go.mod with \`go get -tool <module>/cmd/${name}\`.\n${r.stderr}`,
        );
      }
      return r.stdout.trim().split("\n").pop().trim();
    });
    p.catch(() => toolCache.delete(key));
    toolCache.set(key, p);
  }
  return p;
}

/**
 * Runs a command and collects its output.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, input?: string }} opts
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 256 << 20 }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") {
        reject(err);
        return;
      }
      resolve({ code: err ? /** @type {number} */ (err.code) : 0, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}
