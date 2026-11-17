// Go objects in templates: a pointer to a struct type with methods (a goesm
// handle) is shown to the template as a view of its fields, named by their
// json tags, with its methods callable, and is the same Go object again when
// the template passes it back to Go.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import gosfc from "@gosfc/vite";
import { createServer } from "vite";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

const root = fileURLToPath(new URL("./fixtures/app/", import.meta.url));
const chromium = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium";

test("a pointer to a struct with methods: fields, methods and identity in the template (SSR)", async (t) => {
  const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [gosfc(), vue()], appType: "custom", server: { middlewareMode: true, hmr: false } });
  t.after(() => server.close());
  const { default: Accounts } = await server.ssrLoadModule("/src/handles/Accounts.vue");
  assert.equal(
    await renderToString(createSSRApp(Accounts)),
    '<div><p class="fields">ゴー 10 2 本店</p><p class="method">ゴー:10</p><p class="call">本店 </p><p class="list">本店,ゴー</p><p class="same">true</p><button class="deposit">+5</button><button class="give">give</button><p class="given"></p></div>',
  );
});

test("a pointer to a struct with methods: a method call and a handle passed back (browser)", { skip: !existsSync(chromium) && "no Chromium" }, async (t) => {
  const { chromium: pw } = await import("playwright-core");
  const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [gosfc(), vue()], server: { port: 0 } });
  await server.listen();
  t.after(() => server.close());
  const browser = await pw.launch({ executablePath: chromium });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "warning" && errors.push(m.text()));
  await page.goto(new URL("handles.html", server.resolvedUrls.local[0]).href, { waitUntil: "networkidle" });
  await page.waitForSelector(".fields");
  const waitText = (sel, v) => page.waitForFunction(([sel, v]) => document.querySelector(sel)?.textContent === v, [sel, v], { timeout: 20000 });

  assert.equal(await page.textContent(".fields"), "ゴー 10 2 本店");
  // A method of the view calls the handle's: the template follows.
  await page.click("button.deposit");
  await waitText(".fields", "ゴー 15 2 本店");
  assert.equal(await page.textContent(".method"), "ゴー:15");
  // The view passed to a Go function is the Go object itself.
  await page.click("button.give");
  await waitText(".given", "ゴー:15 (same)");
  assert.deepEqual(errors, []);
});
