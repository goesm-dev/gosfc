// Compiling single components with the gosfc core (no Vite): bindings,
// coexistence rules and diagnostics at .vue positions.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileSfc } from "@gosfc/vite";

const app = fileURLToPath(new URL("./fixtures/app/", import.meta.url));
const tmp = [];
after(() => tmp.forEach((f) => rmSync(f, { force: true })));

function component(name, source) {
  const file = path.join(app, "src", name);
  writeFileSync(file, source);
  tmp.push(file);
  return file;
}

async function compileError(file, source) {
  try {
    await compileSfc(source, file, { root: app });
  } catch (e) {
    return e;
  }
  assert.fail("expected a compile error");
}

test("Go bindings become template bindings; template and style are untouched", async () => {
  const source = `<template>
  <button @click="Increment">{{ total }}</button>
</template>

<script setup lang="go">
total := 0

func Increment() {
	total++
}
</script>

<style scoped>
button { color: red; }
</style>
`;
  const file = component("TmpCounter.vue", source);
  const r = await compileSfc(source, file, { root: app });
  assert.match(r.code, /<script setup lang="ts">/);
  assert.match(r.code, /const total = __gosfc\.binding\("total"\);/);
  assert.match(r.code, /const Increment = __gosfc\.binding\("Increment"\);/);
  assert.match(r.code, /from "go:example\.com\/fixture\/src\/_gosfc\/tmpcounter_vue"/);
  assert.ok(r.code.startsWith(source.slice(0, source.indexOf("<script"))), "template changed");
  assert.ok(r.code.endsWith(source.slice(source.indexOf("</script>"))), "style changed");
  assert.equal(r.code.split("\n").length, source.split("\n").length, "line count changed");
  const setup = r.modules.find((m) => m.importPath.endsWith("/tmpcounter_vue"));
  assert.ok(setup, "synthetic package was not lowered");
  assert.deepEqual(setup.map.sources, [file], "TS of the Go block must map to the .vue file");
});

test("components without a Go block are left to the Vue tooling", async () => {
  for (const s of [
    `<template><p>{{ m }}</p></template>\n<script setup lang="ts">\nconst m = "ts"\n</script>\n`,
    `<template><p>{{ m }}</p></template>\n<script setup>\nconst m = "js"\n</script>\n`,
  ]) {
    assert.equal(await compileSfc(s, path.join(app, "src", "X.vue"), { root: app }), null);
  }
});

test("a plain <script lang=ts> next to the Go block keeps its language", async () => {
  const source = `<script lang="ts">\nexport const shared = 1\n</script>\n<script setup lang="go">\nn := 1\n</script>\n<template>{{ n }}</template>\n`;
  const file = component("TmpMixed.vue", source);
  const r = await compileSfc(source, file, { root: app });
  assert.match(r.code, /<script setup lang="ts">/);
  assert.match(r.code, /export const shared = 1/);
});

test("Go type errors are reported at the .vue position", async () => {
  const source = `<template>
  <div>{{ total }}</div>
</template>

<script setup lang="go">
import cart "example.com/fixture/src/cart/pkg"

total := cart.Total("x")
</script>
`;
  const file = component("TmpTypeError.vue", source);
  const e = await compileError(file, source);
  assert.equal(e.name, "GosfcError");
  assert.match(e.message, /^src\/TmpTypeError\.vue:8:21: cannot use "x" .* \[go\/types\]$/m);
  assert.deepEqual(e.loc, { file, line: 8, column: 21 });
  assert.doesNotMatch(e.message, /setup\.go|\.ts:|_gosfc/);
});

test("Go syntax errors and unused imports are reported at the .vue position", async () => {
  const source = `<template><div /></template>\n<script setup lang="go">\nimport "strings"\n\nx := 1 +\n</script>\n`;
  const file = component("TmpSyntax.vue", source);
  const e = await compileError(file, source);
  assert.match(e.message, /src\/TmpSyntax\.vue:\d+:\d+: .*\[go\/parser\]/);
  assert.doesNotMatch(e.message, /setup\.go|_gosfc/);

  const unused = `<template><div /></template>\n<script setup lang="go">\nimport "strings"\n\nx := 1\n</script>\n`;
  const e2 = await compileError(component("TmpUnused.vue", unused), unused);
  assert.match(e2.message, /src\/TmpUnused\.vue:3:8: "strings" imported and not used \[go\/types\]/);
});

test("gosfc-level errors: methods, JS reserved words, <script lang=go>", async () => {
  const methods = `<script setup lang="go">\ntype T struct{}\n\nfunc (T) M() {}\n</script>\n`;
  let e = await compileError(component("TmpMethod.vue", methods), methods);
  assert.match(e.message, /src\/TmpMethod\.vue:4:1: methods cannot be declared/);

  const reserved = `<script setup lang="go">\nnew := 1\n</script>\n`;
  e = await compileError(component("TmpReserved.vue", reserved), reserved);
  assert.match(e.message, /src\/TmpReserved\.vue:2:1: new is a reserved word in JavaScript/);

  const plain = `<script lang="go">\nx := 1\n</script>\n`;
  e = await compileError(component("TmpPlain.vue", plain), plain);
  assert.match(e.message, /<script lang="go"> is not supported/);
});
