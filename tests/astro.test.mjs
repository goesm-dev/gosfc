// The PoC end to end: Astro -> @astrojs/vue -> @gosfc/vite -> goesm -> Vite.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const example = fileURLToPath(new URL("../examples/astro/", import.meta.url));
// Astro is a dependency of the example, not of the test runner.
const require = createRequire(path.join(example, "package.json"));
const { build } = await import(pathToFileURL(require.resolve("astro")).href);

test("astro build renders Go bindings to HTML through Vue SSR", async () => {
  const outDir = path.join(example, "dist");
  rmSync(outDir, { recursive: true, force: true });
  await build({ root: example, logLevel: "error" });
  const html = readFileSync(path.join(outDir, "index.html"), "utf8");

  // Summary.vue: <script setup lang="go">, no client:* directive -> static
  // HTML from Astro's SSR, no island.
  assert.match(html, /<div> 合計: 200<\/div>/);
  // Counter.vue: Go block, client:load -> SSR HTML inside an island.
  assert.match(html, /<astro-island[^>]*client="load"[^>]*>.*<span class="count"[^>]*>0<\/span>/s);
  assert.equal(html.match(/<astro-island /g).length, 1);
  // Vue + TypeScript and plain <script setup> components next to them.
  assert.match(html, /Hello from TypeScript/);
  assert.match(html, /Plain script setup/);

  // The island's client bundle maps back to Counter.vue (Vue and Go code).
  const assets = path.join(outDir, "_astro");
  const counter = readdirSync(assets).find((f) => /^Counter\..*\.js$/.test(f));
  const map = JSON.parse(readFileSync(path.join(assets, counter + ".map"), "utf8"));
  assert.ok(map.sources.some((s) => s.endsWith("src/features/counter/Counter.vue")), map.sources.join(", "));
  assert.ok(!map.sources.some((s) => /_gosfc|setup\.go/.test(s)), "generated files leaked into the source map");
});

test("a Go type error fails astro build with the .vue position", async (t) => {
  // A second source tree in the same Go module and Astro project.
  const srcDir = path.join(example, "tmp-typeerror");
  rmSync(srcDir, { recursive: true, force: true });
  t.after(() => rmSync(srcDir, { recursive: true, force: true }));
  mkdirSync(path.join(srcDir, "pages"), { recursive: true });
  mkdirSync(path.join(srcDir, "features", "cart"), { recursive: true });
  writeFileSync(path.join(srcDir, "pages", "index.astro"), '---\nimport Summary from "../features/cart/Summary.vue";\n---\n\n<Summary />\n');
  const summary = readFileSync(path.join(example, "src/features/cart/Summary.vue"), "utf8");
  writeFileSync(path.join(srcDir, "features/cart/Summary.vue"), summary.replace("cart.Total(items)", 'cart.Total("x")'));

  const err = await build({ root: example, srcDir, outDir: path.join(srcDir, "dist"), logLevel: "silent" }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "build should fail");
  assert.match(err.message, /tmp-typeerror\/features\/cart\/Summary\.vue:17:21: cannot use "x" .*\[go\/types\]/);
  assert.doesNotMatch(err.message, /setup\.go|_gosfc|\.ts:\d/);
});
