// A component whose Go block is removed leaves the program: the next
// compilation of another component no longer lowers the packages only the
// removed block imported. Runs in its own process because
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
});
