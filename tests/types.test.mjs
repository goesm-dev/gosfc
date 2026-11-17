// vue-tsc with the Vue language plugin of @gosfc/vite: a TypeScript component
// importing a Go component (tests/fixtures/app/src/typed: Review.vue imports
// Rating.vue) type-checks, with the props goesm gives the Go Props fields
// and the events the Go block emits.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { goView } from "../packages/vite/src/language.js";
import { scanGoImportTypes, writeTypes } from "@gosfc/vite";
import { parse } from "vue/compiler-sfc";

const root = fileURLToPath(new URL("./fixtures/app/", import.meta.url));
const src = (f) => path.join(root, "src", f);
const types = path.join(root, "gosfc.d.ts");
const vueTsc = createRequire(import.meta.url).resolve("vue-tsc/bin/vue-tsc.js");

/**
 * Runs vue-tsc --noEmit on the fixture (its tsconfig.json names the plugin).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ code: number, out: string }>}
 */
function typeCheck(env = process.env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [vueTsc, "--noEmit", "-p", root], { cwd: root, env }, (err, stdout, stderr) => {
      resolve({ code: err ? Number(err.code) : 0, out: stdout + stderr });
    });
  });
}

/** Writes a file for one test. */
function temp(t, file, content) {
  writeFileSync(file, content);
  t.after(() => rmSync(file, { force: true }));
}

test("the view of a Go block declares its props, events and bindings", () => {
  const file = src("typed/Rating.vue");
  const code = readFileSync(file, "utf8");
  const view = goView(code, file, parse(code, { filename: file }).descriptor);
  assert.match(view, /typeof import\("go:example\.com\/fixture\/src\/typed\/_gosfc\/rating_vue"\)/);
  // The names the glue declares the props by: json and js tags, camelized.
  assert.match(view, /type __gosfc_Fields = \{ "label": __gosfc_Prop<"Label">; "max": __gosfc_Prop<"Max">; "tags": __gosfc_Prop<"Tags">; "noteText": __gosfc_Prop<"note-text">; "itemId": __gosfc_Prop<"itemId"> \};/);
  // Max has a default tag: optional whatever its type.
  assert.match(view, /type __gosfc_Optional<K extends keyof __gosfc_Fields> = K extends "max" \? true : null extends __gosfc_Fields\[K\] \? true : \[__gosfc_Fields\[K\]\] extends \[boolean\] \? true : false;/);
  assert.match(view, /^defineProps<.*__gosfc_Optional<K> extends true \? K : never\]\?: __gosfc_Fields\[K\] \} & .*>\(\);$/m);
  assert.match(view, /defineEmits<\{ "rated": any\[\] \}>\(\);/);
  for (const b of ["props", "emit", "stars", "Rate"]) assert.match(view, new RegExp(`^let ${b}!: any;$`, "m"));
});

test("vue-tsc: a TypeScript component imports a Go component before the Go is compiled", async () => {
  rmSync(types, { force: true });
  const r = await typeCheck();
  assert.equal(r.code, 0, r.out);
});

test("vue-tsc: the props of a Go component have the types goesm gives its Props fields", async (t) => {
  const content = await scanGoImportTypes(root);
  if (!content?.includes("_gosfc/rating_vue")) return t.skip("the pinned goesm writes no declaration files (emit-ts -dts)");
  writeTypes(types, content);
  assert.match(readFileSync(types, "utf8"), /GosfcSetup\(props: \{ Label\?: string; Max\?: number; Tags\?: Array<string> \| null; "note-text"\?: string; itemId\?: number \}\)/);
  let r = await typeCheck();
  assert.equal(r.code, 0, r.out);

  // Props of the wrong types are errors in the TypeScript parent; a name
  // the Go block does not declare is an error in the Go component's
  // template.
  temp(
    t,
    src("typed/TmpWrongProp.vue"),
    `<template>
  <Rating :max="'three'" :tags="tags" />
</template>

<script setup lang="ts">
import Rating from "./Rating.vue";
const tags = [1, 2];
</script>
`,
  );
  // The fields without a default tag, omitempty, nil or bool are required.
  temp(
    t,
    src("typed/TmpMissingProp.vue"),
    `<template>
  <Rating label="Size" />
</template>

<script setup lang="ts">
import Rating from "./Rating.vue";
</script>
`,
  );
  temp(
    t,
    src("typed/TmpUnknownBinding.vue"),
    `<template>
  <p>{{ stars }} {{ missing }}</p>
</template>

<script setup lang="go">
stars := 3
</script>
`,
  );
  r = await typeCheck();
  assert.notEqual(r.code, 0);
  assert.match(r.out, /TmpWrongProp\.vue\(2,12\): error TS2322: Type 'string' is not assignable to type 'number'/);
  assert.match(r.out, /TmpWrongProp\.vue\(2,27\): error TS2322: Type 'number\[\]' is not assignable to type 'string\[\]'/);
  assert.match(r.out, /TmpUnknownBinding\.vue\(2,21\): error TS2339: Property 'missing' does not exist/);
  const missing = r.out.split("\n").filter((l) => l.includes("TmpMissingProp.vue"));
  assert.equal(missing.length, 1, r.out);
  assert.match(missing[0], /TmpMissingProp\.vue\(2,4\): error TS2345: Argument of type '\{ label: string; \}' is not assignable/);
  assert.match(missing[0], /readonly max\?: number \| undefined; readonly tags\?: string\[\] \| null \| undefined; readonly label: string; readonly noteText: string; readonly itemId: number;/);
  assert.doesNotMatch(r.out, /TmpWrongProp\.vue.*is missing/);
  // Only those: the fixture's own components still type-check.
  assert.doesNotMatch(r.out, /Rating\.vue|Review\.vue/);
});

test("vue-tsc: without the go command, a Go component's props and bindings are any", async () => {
  // Node only: no go command on PATH.
  const r = await typeCheck({ ...process.env, PATH: path.dirname(process.execPath) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /gosfc: the Go components of .* are typed as any/);
});

test("vue-tsc: the options of the Vite plugin have types", async (t) => {
  temp(
    t,
    src("TmpViteConfig.ts"),
    `import gosfc, { compileSfc, type GosfcOptions } from "@gosfc/vite";
import type { Plugin } from "vite";

const options: GosfcOptions = { dts: false, serverOnly: (file) => file.endsWith(".server.ts") };
export const plugin: Plugin = gosfc(options);
export const compiled = compileSfc("", "/app/src/App.vue", { root: "/app" }).then((r) => r?.code);
// @ts-expect-error dts is a path, false or a function
gosfc({ dts: 1 });
`,
  );
  const r = await typeCheck();
  assert.equal(r.code, 0, r.out);
});
