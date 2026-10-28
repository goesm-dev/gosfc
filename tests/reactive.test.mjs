// Reactivity of <script setup lang="go"> through the vue package
// (github.com/goesm-dev/gosfc/vue) in a browser: Refs set by goroutines,
// Computeds, watchers, lifecycle hooks, v-model, template refs, props that
// change, prop defaults and emits, and state shared by components.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import gosfc from "@gosfc/vite";
import { createServer } from "vite";

const root = fileURLToPath(new URL("./fixtures/app/", import.meta.url));
const chromium = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium";

test("vue package: Refs, Computeds, watchers, hooks, v-model, template refs, props and emits", { skip: !existsSync(chromium) && "no Chromium" }, async (t) => {
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
  await page.goto(new URL("reactive.html", server.resolvedUrls.local[0]).href, { waitUntil: "networkidle" });
  await page.waitForSelector(".ticks");
  const text = (sel) => page.textContent(sel);
  const waitText = (sel, v) => page.waitForFunction(([sel, v]) => document.querySelector(sel)?.textContent === v, [sel, v], { timeout: 20000 });

  // A goroutine started in OnMounted sets a Ref of another package three
  // times; the bound Ref, a Computed, a Go function called from the
  // template, a watcher and a child's props all follow.
  await waitText(".ticks", "3");
  assert.equal(await text(".doubled"), "6");
  assert.equal(await text(".parity"), "odd");
  assert.equal(await text(".watched"), "3");
  // A watcher runs only when its value changes, not on every change of
  // the Refs it reads.
  assert.equal(await text(".steady"), "0");
  await waitText(".slow", "3");
  assert.equal(await text(".mounted"), "true");
  assert.equal(await text(".canvas"), "CANVAS");

  // Both components import package clock: one Ref, one value.
  assert.equal(await text(".child .shared"), "3");
  assert.equal(await page.locator(".child .shared").nth(1).textContent(), "3");

  // Attributes that are not Props fields fall through to the root element.
  assert.equal(await page.locator(".child.first").count(), 1);

  // Props follow the parent; the child's watcher on a prop runs.
  assert.equal(await text(".child .label"), "gopher");
  assert.equal(await text(".child .seen"), "3");

  // v-model writes the Ref; the template and the child's prop follow.
  await page.fill("input.name", "vue");
  await waitText(".greeting", "Hello, VUE");
  assert.equal(await text(".child .label"), "vue");
  // Another prop changing does not wake the watcher on count.
  assert.equal(await text(".child .seen"), "3");

  // Prop defaults: a field's default tag fills a prop the parent leaves out.
  assert.equal(await text(".child .size"), "20");
  assert.equal(await page.locator(".child .label").nth(1).textContent(), "defaults");
  // A prop whose json key is hyphenated.
  assert.equal(await page.locator(".child .note").nth(1).textContent(), "noted");

  // Emits: the child's event reaches the parent's Go handler with its arguments.
  await page.click(".child button");
  await waitText(".picked", "vue:!!!");

  // A Go function held by a Ref updates the bindings it changes.
  await page.click("button.bump");
  await waitText("button.bump", "1");

  assert.deepEqual(errors, []);
});
