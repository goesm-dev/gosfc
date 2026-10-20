// Compiling single components with the gosfc core (no Vite): bindings,
// coexistence rules and diagnostics at .vue and .astro positions.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileAstro, compileSfc } from "@gosfc/vite";

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

test("only the names the template uses become bindings", async () => {
  const source = `<template>
  <canvas ref="canvas" :width="w" />
  <MyBadge v-focus :label="label" />
  <Form.Input />
  <p>{{ 合計 }}</p>
</template>

<script setup lang="go">
import "syscall/js"

var canvas js.Value
w := 300
label := "x"
MyBadge := 1
vFocus := 2
Form := 3
合計 := 4

func helper() int { return w * 2 }

unused := helper()
</script>

<style>
canvas { height: v-bind(w); }
</style>
`;
  const file = component("TmpUsed.vue", source);
  const r = await compileSfc(source, file, { root: app });
  for (const n of ["canvas", "w", "label", "MyBadge", "vFocus", "Form", "合計"]) assert.match(r.code, new RegExp(`const ${n} = __gosfc\\.binding\\("${n}"\\);`), n);
  assert.doesNotMatch(r.code, /binding\("(helper|unused)"\)/);
  const setup = r.modules.find((m) => m.importPath.endsWith("/tmpused_vue"));
  assert.doesNotMatch(setup.code, /"(helper|unused)"/, "the lookup returns a binding the template does not use");
});

test("a template in another file keeps every binding", async () => {
  const source = `<template src="./TmpExt.html"></template>

<script setup lang="go">
total := 1
</script>
`;
  const file = component("TmpExt.vue", source);
  const r = await compileSfc(source, file, { root: app });
  assert.match(r.code, /const total = __gosfc\.binding\("total"\);/);
});

test("a Go block that binds nothing still compiles", async () => {
  const source = `<template>
  <p>static</p>
</template>

<script setup lang="go">
import "example.com/fixture/src/cart/pkg"

_ = cart.Total(nil)
</script>
`;
  const file = component("TmpNoBindings.vue", source);
  const r = await compileSfc(source, file, { root: app });
  assert.match(r.code, /__gosfc_useGo\(__gosfc_setup, "[0-9a-f]+"\);/);
  assert.doesNotMatch(r.code, /__gosfc\.binding/);
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

test(".astro: a ---go frontmatter becomes TypeScript, <script lang=go> a module import", async () => {
  const source = `---go
import (
	cart "example.com/fixture/src/cart/pkg"
	Card "./Card.vue"
	_ "./global.css"
)

type Props struct{ Title string }

title := props.Title
total := cart.Total([]cart.Item{{Price: 3, Quantity: 2}})
---

<Card>{title}: {total}</Card>
<script lang="go">
println("hi")
</script>
`;
  const file = component("TmpPage.astro", source);
  const r = await compileAstro(source, file, { root: app });
  const fm = r.code.slice(0, r.code.indexOf("\n---\n") + 5);
  assert.match(fm, /^---\n/);
  assert.match(fm, /^import Card from "\.\/Card\.vue";$/m);
  assert.match(fm, /^import "\.\/global\.css";$/m);
  assert.match(fm, /import \{ GosfcSetup as __gosfc_setup, GosfcProps as __gosfc_props \} from "go:example\.com\/fixture\/src\/_gosfc\/tmppage_astro";/);
  assert.match(fm, /const __gosfc = await __gosfc_run\(__gosfc_setup, __gosfc_props, Astro\.props\);/);
  assert.match(fm, /const title = __gosfc\("title"\);/);
  assert.match(fm, /const total = __gosfc\("total"\);/);
  assert.equal(r.code.split("\n").length, source.split("\n").length, "line count changed");
  assert.ok(r.code.includes("\n---\n\n<Card>{title}: {total}</Card>\n"), "template changed");
  assert.match(r.code, /<script>import "gosfc:astro-script\/0\/.*\/src\/TmpPage\.astro\.js";\n\n<\/script>/);
  // The import paths of the file's blocks, for the program to forget the
  // ones removed later.
  assert.deepEqual(r.blocks, ["example.com/fixture/src/_gosfc/tmppage_astro", "example.com/fixture/src/_gosfc/tmppage_astro_script0"]);

  // Errors are reported at .astro positions.
  const bad = `---go\nimport Card "./Card.vue"\n\nn := 1\nvar s string = n\nCard := 2\n---\n`;
  const e = await compileAstro(bad, component("TmpBad.astro", bad), { root: app }).then(() => assert.fail("expected an error"), (e) => e);
  assert.match(e.message, /src\/TmpBad\.astro:5:16: cannot use n .*\[go\/types\]/);
  const clash = `---go\nimport Card "./Card.vue"\n\nCard := 2\n---\n`;
  const e2 = await compileAstro(clash, component("TmpClash.astro", clash), { root: app }).then(() => assert.fail("expected an error"), (e) => e);
  assert.match(e2.message, /src\/TmpClash\.astro:4:1: Card is also the name of the import of "\.\/Card\.vue"/);
});

test("go: imports in comments and other strings import nothing", async () => {
  const { goImports } = await import("../packages/vite/src/compile.js");
  const code = [
    'import { A } from "go:example.com/a";',
    '// import "go:example.invalid/line"',
    '/* export { B } from "go:example.invalid/block" */',
    'const s = \'import "go:example.invalid/string"\';',
    "const t = `from 'go:example.invalid/template'`;",
    "<!-- import 'go:example.invalid/html' -->",
    'const b = await import("go:example.com/b");',
    "export * from 'go:example.com/c';",
  ].join("\n");
  assert.deepEqual(goImports(code), ["example.com/a", "example.com/b", "example.com/c"]);
});

test("files imported by //goesm:import, lazy ones too, become absolute paths", async () => {
  const { absoluteFileImports } = await import("../packages/vite/src/goesm.js");
  const out = path.join(path.sep, "tmp", "out");
  const ts = path.join(out, "example.com", "app", "pkg.ts");
  const code = [
    `import { render as jsImport } from "../../../src/render.ts";`,
    `import { a } from "../other.ts";`,
    `let jsLazy$m: Promise<any> | undefined;`,
    `const jsLazy = (): Promise<any> => (jsLazy$m ??= import("../../../src/pdf.ts"));`,
    `const s = "import(\\"../../../src/x.ts\\")";`,
  ].join("\n");
  assert.equal(
    absoluteFileImports(code, ts, out),
    [
      `import { render as jsImport } from "/tmp/src/render.ts";`,
      `import { a } from "../other.ts";`,
      `let jsLazy$m: Promise<any> | undefined;`,
      `const jsLazy = (): Promise<any> => (jsLazy$m ??= import("/tmp/src/pdf.ts"));`,
      `const s = "import(\\"../../../src/x.ts\\")";`,
    ].join("\n"),
  );
});

test("go: imports are declared as modules from goesm's declaration files", async () => {
  const { goImportTypes } = await import("../packages/vite/src/types.js");
  const program = (imports, modules, error = null) => ({ imports, outcome: { modules, error } });
  const dts = "// Code generated by goesm.\nexport function Total(items: Array<{ Price?: number }> | null): number;\n";
  const out = goImportTypes([
    program(["example.com/app/cart"], [
      { importPath: "example.com/app/cart", dts },
      { importPath: "example.com/app/_gosfc/Shop", dts: "export function GosfcSetup(): void;\n" },
    ]),
    program(["example.com/other/x"], [{ importPath: "example.com/other/x", dts }], [{ message: "failed" }]),
  ]);
  assert.equal(
    out,
    "// Generated by gosfc: the types of the Go packages JavaScript imports with go:. DO NOT EDIT.\n" +
      '\ndeclare module "go:example.com/app/cart" {\n  export function Total(items: Array<{ Price?: number }> | null): number;\n}\n',
  );
  assert.equal(goImportTypes([program(["a"], [{ importPath: "a" }])]), null);
});
