// HMR of components with <script setup lang="go"> in a browser, through
// Vite's and @vitejs/plugin-vue's own HMR. Runs in its own process because
// @vitejs/plugin-vue keeps module-level descriptor caches.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import gosfc from "@gosfc/vite";
import { createServer } from "vite";

const root = fileURLToPath(new URL("./fixtures/app/", import.meta.url));
const src = (f) => path.join(root, "src", f);
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

const chromium = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium";

test("Go edits reload the component, template edits keep Go state, .go edits update users", { skip: !existsSync(chromium) && "no Chromium" }, async (t) => {
  const { chromium: pw } = await import("playwright-core");
  const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [gosfc(), vue()], server: { port: 0 } });
  await server.listen();
  t.after(() => server.close());
  const browser = await pw.launch({ executablePath: chromium });
  t.after(() => browser.close());
  const page = await browser.newPage();
  // Vite may re-optimize dependencies and reload once on the first visit.
  await page.goto(server.resolvedUrls.local[0], { waitUntil: "networkidle" });
  await page.waitForSelector(".count");
  assert.match(await page.textContent("body"), /合計: 200/);
  await page.evaluate(() => (window.__marker = 1));
  const count = () => page.textContent(".count");
  const waitCount = (v) => page.waitForFunction((v) => document.querySelector(".count")?.textContent === v, v, { timeout: 20000 });

  await page.click("button");
  assert.equal(await count(), "1");

  // Go edit: the component reloads and runs the new Go code.
  edit(src("Counter.vue"), "total := 0", "total := 100");
  edit(src("Counter.vue"), "total++", "total += 10");
  await waitCount("100");
  await page.click("button");
  assert.equal(await count(), "110");

  // Template-only edit: re-render; the Go setup does not run again, so the
  // Go state (110) survives.
  edit(src("Counter.vue"), "<button @click", '<button class="add" @click');
  await page.waitForSelector("button.add", { timeout: 20000 });
  assert.equal(await count(), "110");

  // Go package edit: components using the package update.
  edit(src("cart/pkg/price.go"), "item.Price * item.Quantity", "item.Price * item.Quantity * 3");
  await page.waitForFunction(() => document.body.textContent.includes("合計: 600"), null, { timeout: 20000 });

  assert.equal(await page.evaluate(() => window.__marker), 1, "the page was fully reloaded");
});
