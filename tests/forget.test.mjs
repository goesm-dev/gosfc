// A component whose Go block is removed, or a JavaScript module's go:
// import that is removed, leaves the program: the next compilation of
// another component no longer lowers the packages only it imported. Runs in its own process because
// @vitejs/plugin-vue keeps module-level descriptor caches.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import gosfc from "@gosfc/vite";
import { createServer } from "vite";

const root = fileURLToPath(new URL("./fixtures/app/", import.meta.url));
const dir = path.join(root, "src", "forget");
after(() => rmSync(dir, { recursive: true, force: true }));

const goComponent = (imp, expr) => `<template><p>{{ n }}</p></template>

<script setup lang="go">
${imp}
n := ${expr}
</script>
`;

test("a removed Go block leaves the program", async (t) => {
  mkdirSync(path.join(dir, "only"), { recursive: true });
  writeFileSync(path.join(dir, "only", "only.go"), "package only\n\nfunc N() int { return 1 }\n");
  writeFileSync(path.join(dir, "A.vue"), goComponent('import "example.com/fixture/src/forget/only"', "only.N()"));
  writeFileSync(path.join(dir, "B.vue"), goComponent("", "2"));

  const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [gosfc(), vue()], server: { watch: null, port: 0 } });
  t.after(() => server.close());
  const transform = async (f) => {
    const m = await server.moduleGraph.getModuleByUrl("/src/forget/" + f);
    if (m) server.moduleGraph.invalidateModule(m);
    return server.transformRequest("/src/forget/" + f);
  };
  assert.ok(await transform("A.vue"));
  assert.ok(await transform("B.vue"));

  // A no longer has Go; package only, which only A imported, breaks.
  writeFileSync(path.join(dir, "A.vue"), "<template><p>a</p></template>\n\n<script setup>\nconst a = 1;\n</script>\n");
  assert.ok(await transform("A.vue"));
  writeFileSync(path.join(dir, "only", "only.go"), 'package only\n\nfunc N() int { return "x" }\n');

  // B compiles again (its Go changed) without package only.
  writeFileSync(path.join(dir, "B.vue"), goComponent("", "3"));
  assert.match((await transform("B.vue")).code, /gosfc/);

  // The same for a JavaScript module that stops importing package only.
  writeFileSync(path.join(dir, "only", "only.go"), "package only\n\nfunc N() int { return 1 }\n");
  writeFileSync(path.join(dir, "use.js"), 'import { N } from "go:example.com/fixture/src/forget/only";\nexport const n = N();\n');
  await transform("use.js");
  writeFileSync(path.join(dir, "use.js"), "export const n = 1;\n");
  await transform("use.js");
  writeFileSync(path.join(dir, "only", "only.go"), 'package only\n\nfunc N() int { return "x" }\n');
  writeFileSync(path.join(dir, "B.vue"), goComponent("", "4"));
  assert.match((await transform("B.vue")).code, /gosfc/);

  // Two components that would be one Go package.
  writeFileSync(path.join(dir, "Foo-Bar.vue"), goComponent("", "5"));
  writeFileSync(path.join(dir, "foo_bar.vue"), goComponent("", "6"));
  assert.ok(await transform("Foo-Bar.vue"));
  await assert.rejects(transform("foo_bar.vue"), (e) => /foo_bar\.vue and Foo-Bar\.vue would both be Go package foo_bar_vue/.test(e.message));
});

test("go: imports removed from an .astro file leave the program", async (t) => {
  mkdirSync(path.join(dir, "only"), { recursive: true });
  const only = (body) => writeFileSync(path.join(dir, "only", "only.go"), `package only\n\nfunc N() int { return ${body} }\n`);
  only("1");
  writeFileSync(path.join(dir, "B.vue"), goComponent("", "2"));
  const page = path.join(dir, "page.astro");
  writeFileSync(page, "<p>no Go</p>\n");
  const script = "?astro&type=script&index=0&lang.ts";
  const imp = 'import { N } from "go:example.com/fixture/src/forget/only";\nN();\n';
  // The modules Astro compiles page.astro to, as the plugin sees them: the
  // component, which renders its script by id, and the script.
  const out = new Map();
  const astro = {
    name: "astro-modules",
    load(id) {
      if (out.has(id)) return out.get(id);
    },
  };
  const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [gosfc(), astro, vue()], server: { watch: null, port: 0 } });
  t.after(() => server.close());
  const transform = async (url, ssr) => {
    const m = await server.moduleGraph.getModuleByUrl(url, ssr);
    if (m) server.moduleGraph.invalidateModule(m);
    return server.transformRequest(url, { ssr });
  };
  const component = () => transform("/src/forget/page.astro", true);
  const runScript = () => transform("/src/forget/page.astro" + script, false);
  const goStillCompiles = async (n) => {
    only('"x"');
    writeFileSync(path.join(dir, "B.vue"), goComponent("", String(n)));
    assert.match((await transform("/src/forget/B.vue")).code, /gosfc/);
    only("1");
  };
  assert.ok(await transform("/src/forget/B.vue"));

  // A frontmatter import, removed.
  out.set(page, imp + "export default 1;\n");
  await component();
  out.set(page, "export default 1;\n");
  await component();
  await goStillCompiles(3);

  // A script's import; the script is removed, and its module is not
  // transformed again.
  out.set(page, `export default ${JSON.stringify(page + script)};\n`);
  out.set(page + script, imp);
  await component();
  await runScript();
  // Still imported while the component renders the script.
  out.set(page, `export default ${JSON.stringify(page + script)}; // edited\n`);
  await component();
  only('"x"');
  writeFileSync(path.join(dir, "B.vue"), goComponent("", "4"));
  await assert.rejects(transform("/src/forget/B.vue"));
  only("1");
  out.set(page, "export default 2;\n");
  await component();
  await goStillCompiles(5);
});

test("a <script lang=go> removed from an .astro file and restored as it was is lowered again", async (t) => {
  mkdirSync(path.join(dir, "only"), { recursive: true });
  const only = (body) => writeFileSync(path.join(dir, "only", "only.go"), `package only\n\nfunc N() int { return ${body} }\n`);
  only("1");
  writeFileSync(path.join(dir, "B.vue"), goComponent("", "2"));
  const page = path.join(dir, "script.astro");
  const withScript = '<p>hi</p>\n<script lang="go">\nimport "example.com/fixture/src/forget/only"\n\nprintln(only.N())\n</script>\n';
  writeFileSync(page, withScript);
  const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [gosfc(), vue()], server: { watch: null, port: 0 } });
  t.after(() => server.close());
  const { astroScriptId } = await import("../packages/vite/src/compile.js");
  const load = (id) => server.pluginContainer.load(id);
  assert.match((await load(astroScriptId(page, 0))).code, /GosfcSetup/);

  // The script is removed: its block leaves the program.
  writeFileSync(page, "<p>hi</p>\n");
  await server.environments.ssr.pluginContainer.load(page);
  // Restored as it was: loading it again puts the block back.
  writeFileSync(page, withScript);
  assert.match((await load(astroScriptId(page, 0))).code, /GosfcSetup/);
  only('"x"');
  writeFileSync(path.join(dir, "B.vue"), goComponent("", "3"));
  const m = await server.moduleGraph.getModuleByUrl("/src/forget/B.vue");
  if (m) server.moduleGraph.invalidateModule(m);
  await assert.rejects(server.transformRequest("/src/forget/B.vue"), (e) => /only\.go/.test(e.message));
});
