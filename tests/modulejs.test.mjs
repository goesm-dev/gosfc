// The JavaScript files of gosfc's Go packages (imported by their
// //goesm:import directives) are served from wherever the Go module is, such
// as the module cache, where a bare import like "vue" does not resolve to the
// project's copy. They must import nothing but relative files.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const skip = new Set(["node_modules", "packages", "tests", "bench", "examples", "docs", ".git"]);

function goPackageJS(dir, out = []) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const isGo = entries.some((e) => e.isFile() && e.name.endsWith(".go"));
  for (const e of entries) {
    if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith(".")) goPackageJS(path.join(dir, e.name), out);
    else if (isGo && e.isFile() && /\.m?js$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

test("JavaScript files of Go packages import only relative files", () => {
  const files = goPackageJS(repo);
  assert.ok(files.length > 0, "no JavaScript files found in Go packages");
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1] ?? m[2];
      assert.ok(spec.startsWith("./") || spec.startsWith("../"), `${path.relative(repo, f)} imports ${JSON.stringify(spec)}`);
    }
  }
});
