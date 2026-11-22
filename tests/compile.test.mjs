// Compiling single components with the gosfc core (no Vite): bindings,
// coexistence rules and diagnostics at .vue and .astro positions.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileAstro, compileSfc, goPrerender } from "@gosfc/vite";

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

test("types and methods declared in the Go block, used by Props", async () => {
  const source = `<template>
  <p>{{ label }} {{ Next() }}</p>
</template>

<script setup lang="go">
import "strings"

type Tag string

func (t Tag) Label() string { return "#" + strings.ToUpper(string(t)) }

type Level int

type Props struct {
	Tag   Tag
	Level Level
}

func (p Props) Higher() Level { return p.Level + 1 }

label := props.Tag.Label()

func Next() Level { return props.Higher() }
</script>
`;
  const file = component("TmpBlockTypes.vue", source);
  const r = await compileSfc(source, file, { root: app });
  const setup = r.modules.find((m) => m.importPath.endsWith("/tmpblocktypes_vue"));
  assert.ok(setup, "synthetic package was not lowered");
  // The methods map back to the .vue file.
  assert.deepEqual(setup.map.sources, [file]);

  const outside = `<template><p>{{ n }}</p></template>\n<script setup lang="go">\ntype T int\n\nn := 1\n\nfunc (T) M() int { return n }\n</script>\n`;
  const e = await compileError(component("TmpMethodScope.vue", outside), outside);
  assert.match(e.message, /src\/TmpMethodScope\.vue:7:27: undefined: n \[go\/types\]/);
});

test("gosfc-level errors: JS reserved words, <script lang=go>", async () => {
  let e;
  const reserved = `<script setup lang="go">\nnew := 1\n</script>\n`;
  e = await compileError(component("TmpReserved.vue", reserved), reserved);
  assert.match(e.message, /src\/TmpReserved\.vue:2:1: new is a reserved word in JavaScript/);

  const plain = `<script lang="go">\nx := 1\n</script>\n`;
  e = await compileError(component("TmpPlain.vue", plain), plain);
  assert.match(e.message, /<script lang="go"> is not supported/);
});

test("a name the template reads that nothing declares is an error at its template position", async () => {
  const source = `<template>
  <div v-if="missing" :title="label" @click="Pick($event, $attrs.x)">
    <p v-for="(it, i) in items" :key="i">{{ it }} {{ Math.max(i, n) }} {{ shared }} {{ fromTs }}</p>
    <Comp v-slot="{ row }">{{ row }} {{ $slots }} {{ props.Label }}</Comp>
    <p>{{ other.field }}</p>
    <button @click="Pick" @dblclick="Unpick">x</button>
  </div>
</template>

<script lang="ts">
import { ref as fromTs } from "vue";
export const shared = 1;
</script>

<script setup lang="go">
type Props struct {
	Label string
}

items := []int{1}
n := 2

func Pick() {}
</script>
`;
  const file = component("TmpUndeclared.vue", source);
  const e = await compileError(file, source);
  assert.equal(e.name, "GosfcError");
  const lines = e.message.split("\n").filter((l) => l.startsWith("src/"));
  assert.deepEqual(
    lines.map((l) => l.slice(0, l.indexOf(" is not declared"))),
    ["src/TmpUndeclared.vue:2:14: missing", "src/TmpUndeclared.vue:5:11: other", "src/TmpUndeclared.vue:6:38: Unpick"],
  );
  assert.match(lines[0], /not a top-level name of the Go block, a prop, a variable of the template \(v-for, v-slot\) or a global Vue allows/);

  // A plain <script> with options (export default) may declare anything.
  const options = `<template><p>{{ fromOptions }}</p></template>\n<script lang="ts">\nexport default { data: () => ({ fromOptions: 1 }) };\n</script>\n<script setup lang="go">\nn := 1\n_ = n\n</script>\n`;
  await compileSfc(options, component("TmpOptions.vue", options), { root: app });
});

test("a Go block that blocks in the setup is an error naming the calls that block", async () => {
  const source = `<template>
  <p>{{ n }}</p>
</template>

<script setup lang="go">
import "example.com/fixture/src/slow"

n := slow.Load()
</script>
`;
  const file = component("TmpBlockingSetup.vue", source);
  const e = await compileError(file, source);
  assert.equal(e.name, "GosfcError");
  // At the statement, or at the call with goesm's explanation (goesm emit-ts -blocking).
  assert.equal(e.loc.line, 8);
  assert.ok([1, 6].includes(e.loc.column), String(e.loc.column));
  assert.match(
    e.message,
    /^src\/TmpBlockingSetup\.vue:8:[16]: the Go block blocks while the component is set up, which Vue cannot wait for:\n {4}src\/TmpBlockingSetup\.vue:8: n := slow\.Load\(\)\n {4}src\/slow\/slow\.go:7: return wait\(\)\n {4}src\/slow\/slow\.go:11: time\.Sleep\(time\.Millisecond\)(?:\n {4}\S*sleep\.go:\d+: receives from a channel)?\n {2}Run what blocks in a goroutine/,
  );
});

test("a Go function that blocks is an error where the template calls it while it renders", async () => {
  const source = `<template>
  <p :title="Late()">{{ Late() + 1 }}</p>
  <button @click="Late">wait</button>
</template>

<script setup lang="go">
import "time"

func Late() int {
	time.Sleep(time.Millisecond)
	return 1
}
</script>
`;
  const file = component("TmpBlockingCall.vue", source);
  const e = await compileError(file, source);
  assert.deepEqual(
    e.errors.map((x) => [x.line, x.column]),
    [
      [2, 14],
      [2, 25],
    ],
  );
  assert.match(e.errors[0].message, /^Late blocks, and the template calls it while it renders, which cannot wait for it:\n {4}src\/TmpBlockingCall\.vue:10: time\.Sleep\(time\.Millisecond\)(?:\n {4}\S*sleep\.go:\d+: receives from a channel)?\n {2}A Go function the template calls must return at once/);

  // An event handler may block: the bindings are read again when it returns.
  const handler = source.replace(`  <p :title="Late()">{{ Late() + 1 }}</p>\n`, "");
  await compileSfc(handler, component("TmpBlockingHandler.vue", handler), { root: app });
});

test("the blocking chain goes on through interface methods and function values (goesm emit-ts -blocking)", async () => {
  const source = `<template>
  <p>{{ n }} {{ Label() }}</p>
</template>

<script setup lang="go">
import "example.com/fixture/src/slowdyn"

n := slowdyn.First()

func Label() string { return slowdyn.Run() }
</script>
`;
  const file = component("TmpBlockingDynamic.vue", source);
  const e = await compileError(file, source);
  // At the statement, or at the call with goesm's explanation (goesm emit-ts -blocking).
  assert.equal(e.loc.line, 8);
  assert.ok([1, 6].includes(e.loc.column), String(e.loc.column));
  const setup = e.errors[0].message;
  assert.match(setup, /^the Go block blocks while the component is set up, which Vue cannot wait for:\n {4}src\/TmpBlockingDynamic\.vue:8: n := slowdyn\.First\(\)\n {4}src\/slowdyn\/slowdyn\.go:25: func First\(\) int \{ return Sources\[0\]\.Next\(\) \}/);
  // goesm after v0.0.1-beta.9 explains the calls its output does not show:
  // the method of the interface, down to what waits in the standard library.
  if (/\(calls the method/.test(setup)) {
    assert.match(
      setup,
      /slowdyn\.go:25: func First\(\) int \{ return Sources\[0\]\.Next\(\) \} \(calls the method Next of slowdyn\.Source, which may be \(slowdyn\.ticker\)\.Next\)\n {4}src\/slowdyn\/slowdyn\.go:13: time\.Sleep\(time\.Millisecond\)\n {4}\S*sleep\.go:\d+: receives from a channel\n {2}Run what blocks/,
    );
  }
  // A Go function the template calls: the function value Run calls.
  const call = e.errors[1].message;
  assert.match(call, /^Label blocks, and the template calls it while it renders, which cannot wait for it:\n {4}src\/TmpBlockingDynamic\.vue:10: func Label\(\) string \{ return slowdyn\.Run\(\) \}\n {4}src\/slowdyn\/slowdyn\.go:31: func Run\(\) string \{ return Hook\(\) \}/);
  if (/\(calls a function value/.test(call)) {
    assert.match(
      call,
      /slowdyn\.go:31: func Run\(\) string \{ return Hook\(\) \} \(calls a function value of type func\(\) string, which may be slowdyn\.slowHook\)\n {4}src\/slowdyn\/slowdyn\.go:39: time\.Sleep\(time\.Millisecond\)\n {4}\S*sleep\.go:\d+: receives from a channel\n {2}A Go function the template calls/,
    );
  }
});

test("a vue.Computed whose getter blocks is an error at the call of vue.NewComputed", async () => {
  const source = `<template>
  <p>{{ doubled }} {{ named }} {{ quick }} {{ total }}</p>
</template>

<script setup lang="go">
import (
	"time"

	"example.com/fixture/src/slowcomputed"
	"github.com/goesm-dev/gosfc/vue"
)

base := vue.NewRef(1)
doubled := vue.NewComputed(func() int {
	time.Sleep(time.Millisecond)
	return base.Get() * 2
})

func Slowly() int {
	time.Sleep(time.Millisecond)
	return 5
}

named := vue.NewComputed(Slowly)
quick := vue.NewComputed(func() int { return base.Get() + 1 })
total := slowcomputed.Total
</script>
`;
  const file = component("TmpBlockingComputed.vue", source);
  const e = await compileError(file, source);
  // A function literal and a function of the block, at the call; the
  // Computeds of an imported package (a function, a method value), at the
  // script with the call's position. The getter that does not block is not
  // an error.
  assert.deepEqual(
    e.errors.map((x) => [x.line, x.column]),
    [
      [14, 12],
      [24, 10],
      [5, 1],
      [5, 1],
    ],
  );
  const sleep = String.raw`(?:\n {4}\S*sleep\.go:\d+: receives from a channel)?`;
  const fix = String.raw`\n {2}A Computed's getter must return at once: run what blocks in a goroutine \(go func\(\) \{ \.\.\. \}\(\)\) and keep its result in a vue\.Ref\.$`;
  const [literal, named, method, fn] = e.errors.map((x) => x.message);
  assert.match(literal, new RegExp(String.raw`^the getter of this vue\.Computed blocks, and Vue computes a Computed when it is read, without waiting:\n {4}src/TmpBlockingComputed\.vue:15: time\.Sleep\(time\.Millisecond\)` + sleep + fix));
  assert.match(named, new RegExp(String.raw`^the getter of this vue\.Computed blocks, .*:\n {4}src/TmpBlockingComputed\.vue:20: time\.Sleep\(time\.Millisecond\)` + sleep + fix));
  assert.match(method, new RegExp(String.raw`^the getter of the vue\.Computed made at src/slowcomputed/slowcomputed\.go:27 blocks, .*:\n {4}src/slowcomputed/slowcomputed\.go:22: time\.Sleep\(time\.Millisecond\)` + sleep + fix));
  assert.match(fn, new RegExp(String.raw`^the getter of the vue\.Computed made at src/slowcomputed/slowcomputed\.go:17 blocks, .*:\n {4}src/slowcomputed/slowcomputed\.go:12: time\.Sleep\(time\.Millisecond\)` + sleep + fix));

  // A block that only reads a Computed of the package, whose own Go has no
  // function that blocks.
  const reader = `<template>\n  <p>{{ total }}</p>\n</template>\n\n<script setup lang="go">\nimport "example.com/fixture/src/slowcomputed"\n\ntotal := slowcomputed.Total\n</script>\n`;
  const r = await compileError(component("TmpComputedReader.vue", reader), reader);
  assert.deepEqual(
    r.errors.map((x) => [x.line, x.column, /made at src\/slowcomputed\/slowcomputed\.go:(\d+)/.exec(x.message)?.[1]]),
    [
      [5, 1, "27"],
      [5, 1, "17"],
    ],
  );
});

test("blockingCalls takes the chain from goesm's explanation when there is one", async () => {
  const { blockingCalls } = await import("../packages/vite/src/blocking.js");
  const { parse } = await import("vue/compiler-sfc");
  const file = path.join(app, "src/slowdyn/slowdyn.go");
  const at = (line, column) => ({ file, line, column });
  const modules = [
    {
      importPath: "example.com/fixture/src/_gosfc/x_vue",
      code: "async function GosfcSetup(props) {\n  await First();\n}\nexport { GosfcSetup };\n",
      map: { version: 3, sources: [], names: [], mappings: "" },
      blocking: [
        {
          name: "x_vue.GosfcSetup",
          ...at(1, 1),
          steps: [
            { ...at(25, 27), what: "calls the method Next of slowdyn.Source, which may be (slowdyn.ticker).Next" },
            { ...at(13, 2), what: "calls time.Sleep" },
            { file: "goesm/natives/patch/time/sleep.go", line: 56, column: 2, what: "receives from a channel" },
          ],
        },
      ],
    },
  ];
  const { descriptor } = parse("<template><p /></template>\n");
  const [b] = blockingCalls({ importPath: modules[0].importPath, modules, descriptor, bindings: [] });
  assert.deepEqual(b.chain, [
    { ...at(25, 27), text: "func First() int { return Sources[0].Next() }", what: "calls the method Next of slowdyn.Source, which may be (slowdyn.ticker).Next" },
    { ...at(13, 2), text: "time.Sleep(time.Millisecond)" },
    // A file of goesm's own tree: the step says what it does.
    { file: "goesm/natives/patch/time/sleep.go", line: 56, column: 2, text: "", what: "receives from a channel" },
  ]);
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

test(".astro: a Go frontmatter reads Astro and declares the page's exports", async () => {
  const source = `---go
import "github.com/goesm-dev/gosfc/astro"

const Prerender = true

func GetStaticPaths() []astro.StaticPath {
	return []astro.StaticPath{{Params: map[string]string{"slug": "a"}}}
}

slug := Astro.Param("slug")
if slug == "" {
	Astro.Respond(Astro.Redirect("/", 0))
}
---

<p>{slug}</p>
`;
  const file = component("TmpAstroGlobal.astro", source);
  const r = await compileAstro(source, file, { root: app });
  const fm = r.code.slice(0, r.code.indexOf("\n---\n") + 5);
  const id = "go:example.com/fixture/src/_gosfc/tmpastroglobal_astro";
  assert.ok(fm.includes(`export { GetStaticPaths as getStaticPaths } from "${id}";`), fm);
  // As Astro reads it from the source.
  assert.match(fm, /^export const prerender = true;$/m);
  // The setup takes Astro's global; a response the Go gives is the page's.
  assert.match(fm, /const __gosfc = await __gosfc_run\(__gosfc_setup, null, Astro\.props, undefined, Astro\);/);
  assert.match(fm, /const __gosfc_response = Astro\[Symbol\.for\("gosfc\.response"\)\]; if \(__gosfc_response\) return __gosfc_response;/);
  assert.equal(r.code.split("\n").length, source.split("\n").length, "line count changed");
  const setup = r.modules.find((m) => m.importPath.endsWith("/tmpastroglobal_astro"));
  assert.match(setup.code, / as "GetStaticPaths"/);
});

test("goPrerender reads const Prerender of a Go frontmatter", () => {
  assert.equal(goPrerender("---go\nconst Prerender = false\n---\n<p />\n"), false);
  assert.equal(goPrerender("---go\nconst (\n\tPartial = true\n\tPrerender = true // on demand\n)\n---\n"), true);
  assert.equal(goPrerender("---go\nn := 1\n---\nconst Prerender = true\n"), undefined);
  assert.equal(goPrerender("---\nexport const prerender = false\n---\n"), undefined);
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

test("a directory written two ways is one Go module", async () => {
  // Vite's ids use slashes on Windows, path.join backslashes.
  const { findGoModule } = await import("../packages/vite/src/gomod.js");
  const a = findGoModule(path.join(app, "src"));
  assert.equal(findGoModule(app + "src/./"), a);
  assert.equal(a.dir, path.resolve(app));
});

test("go: imports and Go components are declared as modules from goesm's declaration files", async () => {
  const { goImportTypes } = await import("../packages/vite/src/types.js");
  const program = (imports, modules, error = null, blocks = []) => ({
    imports,
    blocks: new Map(blocks.map(([importPath, filename]) => [importPath, { importPath, filename }])),
    outcome: { modules, error },
  });
  const dts = "// Code generated by goesm.\nexport function Total(items: Array<{ Price?: number }> | null): number;\n";
  const out = goImportTypes([
    program(
      ["example.com/app/cart"],
      [
        { importPath: "example.com/app/cart", dts },
        { importPath: "example.com/app/_gosfc/shop_vue", dts: "export function GosfcSetup(props: { Title?: string }): void;\n" },
        { importPath: "example.com/app/_gosfc/page_astro", dts: "export function GosfcSetup(): void;\n" },
        { importPath: "example.com/app/util", dts: "export function Util(): void;\n" },
      ],
      null,
      // The blocks of .vue files are declared; those of .astro files are not.
      [
        ["example.com/app/_gosfc/shop_vue", "/app/Shop.vue"],
        ["example.com/app/_gosfc/page_astro", "/app/page.astro"],
      ],
    ),
    program(["example.com/other/x"], [{ importPath: "example.com/other/x", dts }], [{ message: "failed" }]),
  ]);
  assert.equal(
    out,
    "// Generated by gosfc: the types of the Go packages JavaScript imports with go: and of the Go blocks of .vue files. DO NOT EDIT.\n" +
      '\ndeclare module "go:example.com/app/_gosfc/shop_vue" {\n  export function GosfcSetup(props: { Title?: string }): void;\n}\n' +
      '\ndeclare module "go:example.com/app/cart" {\n  export function Total(items: Array<{ Price?: number }> | null): number;\n}\n',
  );
  assert.equal(goImportTypes([program(["a"], [{ importPath: "a" }])]), null);
});
