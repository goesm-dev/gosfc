// The PoC end to end: Astro -> @astrojs/vue -> @gosfc/vite -> goesm -> Vite,
// for Vue components with Go and for .astro files with Go.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const example = fileURLToPath(new URL("../examples/astro/", import.meta.url));
// Astro is a dependency of the example, not of the test runner.
const require = createRequire(path.join(example, "package.json"));
const { build, dev } = await import(pathToFileURL(require.resolve("astro")).href);
const chromium = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const outDir = path.join(example, "dist");
let built;
/** Builds the example once for the tests that read dist/. */
const buildExample = () =>
  (built ??= (async () => {
    rmSync(outDir, { recursive: true, force: true });
    await build({ root: example, logLevel: "error" });
  })());

const restore = new Map();
function edit(file, from, to) {
  if (!restore.has(file)) restore.set(file, readFileSync(file, "utf8"));
  const before = readFileSync(file, "utf8");
  assert.ok(before.includes(from), `${from} not in ${file}`);
  writeFileSync(file, before.replace(from, to));
}
after(() => {
  for (const [f, c] of restore) writeFileSync(f, c);
});

test("astro build renders Go bindings to HTML through Vue SSR", async () => {
  await buildExample();
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

test("astro build: Go frontmatter bindings, Props and JS imports in .astro files", async () => {
  await buildExample();
  const html = readFileSync(path.join(outDir, "go", "index.html"), "utf8");
  // pages/go.astro: ---go frontmatter, bindings and a Go function in the template.
  assert.match(html, /<title>GO FRONTMATTER<\/title>/);
  assert.match(html, /<p class="total">合計: ¥440 \(2 品目\)<\/p>/);
  // features/cart/Line.astro, imported with Go import syntax: Astro.props reach
  // `type Props struct` (a number expression and string attributes).
  assert.match(html, /<li class="line">りんご: 360<\/li><li class="line">みかん: 80<\/li>/);
  // Summary.vue, imported with Go import syntax, rendered by Vue SSR.
  assert.match(html, /<div> 合計: 200<\/div>/);
  // <script lang="go"> becomes a bundled module script.
  const src = /<script type="module" src="(\/_astro\/[^"]+\.js)"><\/script>/.exec(html)?.[1];
  assert.ok(src, "no module script in go/index.html");
  const js = readFileSync(path.join(outDir, src), "utf8");
  assert.match(js, /go-counter/);
  assert.doesNotMatch(html, /lang="go"|---go|syscall\/js/);
});

test("astro build: <script lang=go> runs in the browser", { skip: !existsSync(chromium) && "no Chromium" }, async (t) => {
  await buildExample();
  const server = createHttpServer((req, res) => {
    let file = path.join(outDir, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (file.endsWith("/")) file += "index.html";
    if (!existsSync(file)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8");
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { chromium: pw } = await import("playwright-core");
  const browser = await pw.launch({ executablePath: chromium });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.goto(`http://127.0.0.1:${server.address().port}/go/`, { waitUntil: "networkidle" });
  for (let i = 0; i < 3; i++) await page.click("#go-counter");
  await page.waitForFunction(() => document.querySelector("#go-counter")?.textContent === "3", null, { timeout: 5000 });
  assert.deepEqual(errors, []);
});

test("astro dev: Go frontmatter renders on the server and follows .go edits", async (t) => {
  const server = await dev({ root: example, logLevel: "silent", server: { port: 0 } });
  t.after(() => server.stop());
  const base = `http://localhost:${server.address.port}`;
  const get = async (p) => {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    return r.text();
  };
  let html = await get("/go/");
  assert.match(html, /合計: ¥440/);
  assert.match(html, /りんご: 360/);
  // The client script is served as a module.
  const script = /src="([^"]*go\.astro\?astro&(?:amp;)?type=script[^"]*)"/.exec(html)?.[1].replace(/&amp;/g, "&");
  assert.ok(script, "no client script in the page");
  const glue = await get(script);
  const id = /import "([^"]+)"/.exec(glue)?.[1];
  assert.ok(id, glue);
  assert.match(await get(id), /GosfcSetup\(\)/);

  edit(path.join(example, "src/features/cart/pkg/price.go"), "item.Price * item.Quantity", "item.Price * item.Quantity * 2");
  for (let i = 0; i < 50 && !/合計: ¥880/.test(html); i++) {
    await sleep(200);
    html = await get("/go/");
  }
  assert.match(html, /合計: ¥880/);
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

test("a Go type error in a Go frontmatter fails astro build with the .astro position", async (t) => {
  const srcDir = path.join(example, "tmp-astro-typeerror");
  rmSync(srcDir, { recursive: true, force: true });
  t.after(() => rmSync(srcDir, { recursive: true, force: true }));
  mkdirSync(path.join(srcDir, "pages"), { recursive: true });
  writeFileSync(
    path.join(srcDir, "pages", "index.astro"),
    '---go\nimport cart "example.com/app/src/features/cart/pkg"\n\ntotal := cart.Total("x")\n---\n\n<p>{total}</p>\n',
  );

  const err = await build({ root: example, srcDir, outDir: path.join(srcDir, "dist"), logLevel: "silent" }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "build should fail");
  assert.match(err.message, /tmp-astro-typeerror\/pages\/index\.astro:4:21: cannot use "x" .*\[go\/types\]/);
  assert.doesNotMatch(err.message, /setup\.go|_gosfc|\.ts:\d/);
});
