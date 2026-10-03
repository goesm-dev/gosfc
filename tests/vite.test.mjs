// @gosfc/vite inside plain Vite + @vitejs/plugin-vue: production build with
// source maps and SSR in the dev server. (HMR: hmr.test.mjs.)
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import vue from "@vitejs/plugin-vue";
import gosfc from "@gosfc/vite";
import { build, createServer } from "vite";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

const root = fileURLToPath(new URL("./fixtures/app/", import.meta.url));
const src = (f) => path.join(root, "src", f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const restore = new Map();
function edit(file, from, to) {
  if (!restore.has(file)) restore.set(file, readFileSync(file, "utf8"));
  const before = readFileSync(file, "utf8");
  assert.ok(before.includes(from), `${from} not in ${file}`);
  writeFileSync(file, before.replace(from, to));
}
async function restoreAll() {
  if (!restore.size) return;
  for (const [f, c] of restore) writeFileSync(f, c);
  restore.clear();
  await sleep(1000); // let file watchers of the next server settle
}
after(restoreAll);

const plugins = () => [gosfc(), vue()];

/** Position (line 1-based, column 0-based) of the first occurrence of s. */
function find(code, s) {
  const i = code.indexOf(s);
  assert.ok(i >= 0, `${s} not found in output`);
  const before = code.slice(0, i);
  return { line: before.split("\n").length, column: i - before.lastIndexOf("\n") - 1 };
}

test("production build: source maps lead from the bundle back to .vue and .go", async () => {
  const outDir = path.join(root, "dist");
  rmSync(outDir, { recursive: true, force: true });
  await build({ root, configFile: false, logLevel: "silent", plugins: plugins(), build: { outDir, minify: false, sourcemap: true } });
  const assets = path.join(outDir, "assets");
  const js = (await import("node:fs")).readdirSync(assets).find((f) => f.endsWith(".js"));
  const code = readFileSync(path.join(assets, js), "utf8");
  const map = new TraceMap(readFileSync(path.join(assets, js + ".map"), "utf8"));

  const call = originalPositionFor(map, find(code, "= Total(items)"));
  assert.ok(call.source.endsWith("src/Summary.vue"), call.source);
  assert.equal(call.line, 17); // total := cart.Total(items)

  const mul = originalPositionFor(map, find(code, ".Price * "));
  assert.ok(mul.source.endsWith("src/cart/pkg/price.go"), mul.source);
  assert.equal(mul.line, 7); // total += item.Price * item.Quantity
  rmSync(outDir, { recursive: true, force: true });
});

test("dev server: SSR renders Go bindings and picks up edits without a restart", async (t) => {
  t.after(restoreAll);
  const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: plugins(), appType: "custom", server: { middlewareMode: true, hmr: false } });
  t.after(() => server.close());
  const render = async (file) => {
    const mod = await server.ssrLoadModule(file);
    return renderToString(createSSRApp(mod.default));
  };
  assert.match(await render("/src/Summary.vue"), /合計: 200/);
  assert.match(await render("/src/Hello.vue"), /Hello from TypeScript/);

  edit(src("Summary.vue"), "Quantity: 2,", "Quantity: 3,");
  let html;
  for (let i = 0; i < 50 && !/合計: 300/.test(html ?? ""); i++) {
    await sleep(200);
    html = await render("/src/Summary.vue");
  }
  assert.match(html, /合計: 300/);

  edit(src("cart/pkg/price.go"), "item.Price * item.Quantity", "item.Price * item.Quantity * 2");
  for (let i = 0; i < 50 && !/合計: 600/.test(html); i++) {
    await sleep(200);
    html = await render("/src/Summary.vue");
  }
  assert.match(html, /合計: 600/);
});

test("dev server: a Go panic's stack trace points at the .vue file", async (t) => {
  const file = src("TmpPanic.vue");
  writeFileSync(file, `<template><div>{{ v }}</div></template>

<script setup lang="go">
var xs []int

v := xs[3]
</script>
`);
  t.after(() => rmSync(file, { force: true }));
  const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: plugins(), appType: "custom", server: { middlewareMode: true, hmr: false } });
  t.after(() => server.close());
  const mod = await server.ssrLoadModule("/src/TmpPanic.vue");
  const err = await renderToString(createSSRApp(mod.default)).then(() => null, (e) => e);
  assert.ok(err, "expected a panic");
  server.ssrFixStacktrace(err);
  assert.match(String(err.message), /index out of range/);
  assert.match(err.stack, /src\/TmpPanic\.vue:6:\d+/);
});
