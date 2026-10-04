// Compares the same components written with <script setup lang="go"> (gosfc)
// and <script setup lang="ts"> (plain Vue): client build time, client bundle
// size, and SSR render time of the production build.
//
//   node bench/run.mjs [runs]
//
// The components live in src/go and src/ts; both use the same Vite +
// @vitejs/plugin-vue config, the Go side with @gosfc/vite in front.

import { readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import vue from "@vitejs/plugin-vue";
import gosfc from "@gosfc/vite";
import { build } from "vite";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

const root = fileURLToPath(new URL(".", import.meta.url));
const runs = Number(process.argv[2] ?? 9);
const langs = ["go", "ts"];
const plugins = (lang) => (lang === "go" ? [gosfc(), vue()] : [vue()]);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const kb = (n) => (n / 1024).toFixed(1) + " KiB";

async function clientBuild(lang) {
  const outDir = path.join(root, "dist", lang);
  rmSync(outDir, { recursive: true, force: true });
  const t = performance.now();
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: plugins(lang),
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, "src", lang, "main.js") } },
  });
  const ms = performance.now() - t;
  const assets = path.join(outDir, "assets");
  let raw = 0;
  let gz = 0;
  for (const f of readdirSync(assets).filter((f) => f.endsWith(".js"))) {
    const code = readFileSync(path.join(assets, f));
    raw += code.length;
    gz += gzipSync(code).length;
  }
  return { ms, raw, gz };
}

async function ssrBuild(lang) {
  const outDir = path.join(root, "dist", "ssr-" + lang);
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: plugins(lang),
    build: { outDir, emptyOutDir: true, ssr: path.join(root, "src", lang, "ssr.js") },
  });
  return import(pathToFileURL(path.join(outDir, "ssr.js")).href);
}

// Median over `batches` batches of `perBatch` renders, in ms per render.
async function renderTime(component, batches, perBatch) {
  const render = () => renderToString(createSSRApp(component));
  for (let i = 0; i < Math.min(batches * perBatch, 200); i++) await render(); // warm up
  const samples = [];
  for (let b = 0; b < batches; b++) {
    const t = performance.now();
    for (let i = 0; i < perBatch; i++) await render();
    samples.push((performance.now() - t) / perBatch);
  }
  return median(samples);
}

const results = Object.fromEntries(langs.map((l) => [l, {}]));

// One unmeasured build per side first: it builds the goesm binary and fills
// the go command's build cache, as in any edit-reload loop after the first.
for (const lang of langs) await clientBuild(lang);
const times = Object.fromEntries(langs.map((l) => [l, []]));
for (let i = 0; i < runs; i++) {
  for (const lang of langs) {
    const r = await clientBuild(lang);
    times[lang].push(r.ms);
    Object.assign(results[lang], { raw: r.raw, gz: r.gz });
  }
}
for (const lang of langs) results[lang].buildMs = median(times[lang]);

for (const lang of langs) {
  const m = await ssrBuild(lang);
  const html = { summary: await renderToString(createSSRApp(m.Summary)), heavy: await renderToString(createSSRApp(m.Heavy)) };
  results[lang].html = html;
  results[lang].summaryUs = (await renderTime(m.Summary, 15, 2000)) * 1000;
  results[lang].heavyMs = await renderTime(m.Heavy, 31, 1);
}

rmSync(path.join(root, "dist"), { recursive: true, force: true });

const [go, ts] = [results.go, results.ts];
if (go.html.summary !== ts.html.summary || go.html.heavy !== ts.html.heavy) {
  throw new Error(`Go and TypeScript components render differently: ${JSON.stringify([go.html, ts.html])}`);
}
const ratio = (a, b) => (a / b).toFixed(2) + "x";
console.log(`Node ${process.version}, ${os.cpus()[0].model}, ${os.cpus().length} CPUs, median of ${runs} builds and of the SSR render samples\n`);
console.log("| | gosfc (`lang=\"go\"`) | Vue (`lang=\"ts\"`) | ratio |");
console.log("|---|---:|---:|---:|");
console.log(`| Client build time | ${go.buildMs.toFixed(0)} ms | ${ts.buildMs.toFixed(0)} ms | ${ratio(go.buildMs, ts.buildMs)} |`);
console.log(`| Client JS (minified) | ${kb(go.raw)} | ${kb(ts.raw)} | ${ratio(go.raw, ts.raw)} |`);
console.log(`| Client JS (gzip) | ${kb(go.gz)} | ${kb(ts.gz)} | ${ratio(go.gz, ts.gz)} |`);
console.log(`| SSR render, small component | ${go.summaryUs.toFixed(1)} µs | ${ts.summaryUs.toFixed(1)} µs | ${ratio(go.summaryUs, ts.summaryUs)} |`);
console.log(`| SSR render, 1,000,000 items | ${go.heavyMs.toFixed(1)} ms | ${ts.heavyMs.toFixed(1)} ms | ${ratio(go.heavyMs, ts.heavyMs)} |`);
