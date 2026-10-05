# gosfc architecture

English | [日本語](ARCHITECTURE.ja.md)

gosfc is a thin integration layer for treating the `<script setup lang="go">` of a Vue SFC as real Go.
goesm compiles Go, the Vue tooling handles SFCs and templates, Vite / Rolldown handle the build, and Astro handles pages and SSR. gosfc only connects them.

## 1. Responsibility boundaries

```
Vue SFC (.vue)
  │  parse with @vue/compiler-sfc (Vue tooling)
  ▼
gosfc ─────────────── finds <script setup lang="go">, builds synthetic Go,
  │                    and connects goesm's output to a <script setup> Vue can handle
  ▼
goesm ─────────────── resolves and type-checks with the Go toolchain (go list / go/parser / go/types),
  │                    and lowers Go semantics to TypeScript
  ▼
TypeScript (ESM) + source map
  │
  ▼
Vue / Vite ────────── @vitejs/plugin-vue handles template / style / HMR, Vite transforms TS,
  │                    Rolldown bundles
  ▼
Astro ─────────────── routing / SSR / SSG / islands / client:* / HTML
```

| Layer | Responsible for | Not responsible for |
|---|---|---|
| gosfc | Detecting the Go block in `.vue` and the Go frontmatter / `<script lang="go">` in `.astro`, building synthetic Go, invoking goesm, exposing template bindings, preserving positions, the Vite plugin, the Astro integration | Go parsing / type checking / module and package resolution / lowering, compiling templates and styles, bundling, SSR |
| goesm | The Go package graph, Go Modules, parsing, type checking, Go semantics, lowering to TypeScript, TS→Go source maps | Anything about Vue / SFCs |
| Vue tooling | SFC parsing, template compilation, scoped CSS, HMR decisions | Go |
| Vite / Rolldown | Dev server, TS→JS, bundling, source map composition | Go, SFCs |
| Astro | Pages, SSR, SSG, islands, `client:*` | Go, the contents of SFCs |

## 2. Repository layout

```
cmd/gosfc/          The Go-side CLI (`gosfc synth`). Added to the app's go.mod as a tool
internal/synth/     <script setup lang="go"> (and the Go of .astro files) → synthetic Go (uses only go/scanner)
packages/vite/      @gosfc/vite: the Vite plugin. src/compile.js is the core of the SFC and .astro transforms,
                    src/goesm.js is the only boundary with goesm, runtime/bridge.js handles template bindings,
                    runtime/astro.js the bindings of a Go frontmatter, runtime/convert.js the value conversions of both
packages/astro/     @gosfc/astro: an integration that only configures @astrojs/vue + @gosfc/vite
examples/astro/     The PoC (Astro → Vue → gosfc → goesm → Vite), and an .astro page written in Go
tests/              Node tests (Astro build, Vite build / SSR / HMR, diagnostics) and fixtures
```

There is no separate `core` package. For now the Vite plugin is the only consumer, so `packages/vite/src/compile.js` plays the role of the core. It will be split out once a formatter or language server needs the same processing.

## 3. Processing flow

1. `@gosfc/vite` (`enforce: "pre"`) transforms only those main requests for `.vue` files that contain `<script setup lang="go">`. Other `.vue` files (`lang="ts"`, a plain `<script setup>`) are left untouched and processed by `@vitejs/plugin-vue` as usual.
2. The descriptor is obtained with `parse` from `@vue/compiler-sfc`. gosfc does not have its own Vue parser.
3. The Go block is passed to `go tool gosfc synth`, which returns the synthetic Go and the list of top-level bindings (§4).
4. The synthetic Go is passed to `go tool goesm emit-ts -overlay` (§5). On success it returns TypeScript and a source map per package; on failure it returns diagnostics at `.vue` positions.
5. Only the Go block is replaced with the following `<script setup lang="ts">`. The template, `<style>`, `<style scoped>`, and a plain `<script>` are not changed by a single byte. The line count is preserved too, so the positions of later blocks do not shift.

   ```ts
   import { GosfcSetup as __gosfc_setup } from "go:example.com/app/src/features/cart/_gosfc/summary_vue";
   import { useGo as __gosfc_useGo } from "gosfc:bridge.js";
   const __gosfc = __gosfc_useGo(__gosfc_setup, "7a4085be24760462");
   const items = __gosfc.binding("items");
   const total = __gosfc.binding("total");
   ```

6. From here on, `@vitejs/plugin-vue` compiles the template / style as for an ordinary Vue SFC. The plugin resolves `go:` imports to goesm's output (virtual modules with ids `gosfc:goesm/<import path>.<hash>.ts`, and `gosfc:goesm/@goesm/runtime/*.ts` for the runtime), and leaves TypeScript to Vite's own transform. Each component (and each JS module that imports `go:`) is a separate goesm program, and a package's output depends on the whole program (for example, a function value may be async in one program and synchronous in another). The hash in the id is therefore computed from the module's code and the ids of the packages it imports, and goesm's relative imports (`./x.ts`) are rewritten to those ids. Packages whose code matches share one module (and one bundler chunk); those that differ become separate modules. The runtime is the same in every program, so it keeps a plain id.
7. When a module other than `.vue` (`.js`, `.ts`, `.astro`) imports `go:<import path>`, that module's transform runs `goesm emit-ts <import path>` relative to the Go module the importing file belongs to, and registers the result in the same virtual tree. The `.go` files become watched files of that module, and editing them reloads the module.

## 4. Synthetic Go

`<script setup lang="go">` is not a Go source file; like Vue's `<script setup>`, it is "a body that runs once per component instance". gosfc reassembles it into an ordinary Go file.

```go
//line /abs/Summary.vue:7:1
package summary_vue

//line /abs/Summary.vue:8:1
import cart "example.com/app/src/features/cart/pkg"

//line /abs/Summary.vue:7:1
func GosfcSetup() func(string) any {
//line /abs/Summary.vue:10:1
items := []cart.Item{{Price: 100, Quantity: 2}}
//line /abs/Summary.vue:12:1
total := cart.Total(items)
//line /abs/Summary.vue:7:1
return func(gosfcBinding string) any {
	switch gosfcBinding {
	case "items": return items
	case "total": return total
	}
	return nil
}
}
```

* All user text is copied verbatim after `//line` directives. Go syntax is not changed. Diagnostics and source maps from go/parser, go/types, and goesm all point at positions in the `.vue` file. Positions in the generated file itself (`_gosfc/.../setup.go`) are never visible to the user.
* Order: const / type declarations → a `var F func(...)` for each `func F(...)` → the rest in the original order. `func F() {...}` is replaced with `F=func() {...}`. `F=func` has the same length as `func F`, so columns do not shift either. Functions can refer to each other and recurse, and the bodies run from top to bottom (as in Vue's `setup()`). Calling a function before its declaration causes a nil func panic.
* A `var` or a function without a body preceded by goesm's `//goesm:import` directive (a Vue component, a TypeScript function, any value of an ES module) is declared at package level with its directive, which is placed right before it with a `//line` directive giving the declaration's own position (a `//line` between them would end the doc comment goesm reads). goesm resolves a relative module against the `.vue` file named by the `//line` directive, and `@gosfc/vite` turns its import of that file into an absolute path, which Vite loads like any other module. A `js.Value` binding reaches the template as the value it holds, so a component works as `<Badge />`.
* The returned lookup function is the entry point for template bindings. Values are boxed in `any`, so they reach the JS side with their Go type descriptors intact. Every binding is referenced here, so a variable used only from the template does not trigger Go's "declared and not used" error. Unused imports are a Go error as usual.
* The package is placed in `_gosfc/<name>_vue/` under the same directory as the `.vue` file; this directory does not exist on disk (it is passed through goesm's overlay). The import path therefore becomes `<module>/<dir>/_gosfc/<name>_vue`, and `internal/` visibility works relative to the `.vue` file's location, just as in ordinary Go. Nothing is written to the user's source tree.
* When the block declares `type Props struct {...}`, that type is placed at package level and the setup function becomes `func GosfcSetup(props Props)`. gosfc also generates `func GosfcProps() any { return Props{} }`, and the bridge looks at the fields of that type descriptor to build a Props value from the component's attributes (`useAttrs()`). The glue includes `defineOptions({ inheritAttrs: false })`, so the attributes do not fall through to the root element. The types of Props fields are limited to imported types and built-in types (because types in the block have not been declared yet).
* gosfc does not parse Go. `internal/synth` tokenizes with the standard `go/scanner`, determines top-level boundaries using only bracket depth and the semicolons the scanner inserts, and classifies each item and obtains its name by looking at its leading tokens (`import` / `func name` / `var` / `const` / `type` / `a, b :=`). All syntax and type errors are reported by the Go toolchain.
* The only diagnostics gosfc emits itself are for constraints outside Go: method declarations, generic functions, the position of imports, binding names that collide with JavaScript reserved words (`new`, `class`, and so on), and `<script lang="go">` (without setup).

## 5. API boundary with goesm

The boundary is a single file, `packages/vite/src/goesm.js`. gosfc calls goesm's CLI at the version pinned by the tool directive in the app's go.mod (it gets the built binary with `go tool -n goesm`).

```
goesm emit-ts -overlay <overlay.json> -o <dir> ./<rel>/_gosfc/<name>_vue
  Input:   overlay.json uses the go command's standard -overlay format {"Replace": {"/abs/.../setup.go": "<temporary file>"}}
  Output:  <dir>/<import path>.ts (+ .ts.map)      one module per Go package; maps point at .vue / .go
           <dir>/@goesm/runtime/*.ts               the goesm runtime (imports between modules and into the runtime use relative `.ts` paths)
  Failure: exit 1, with "<file>:<line>:<col>: <message> [<layer>]" on stderr (layer is go/parser, go/types, go list, or goesm lowering)
```

Mapping to the conceptual `Compile(source, context) → { code, map, bindings, diagnostics }`: source = the synthetic Go in the overlay, context = the module directory and the package pattern, code / map = the output modules, diagnostics = stderr. gosfc already knows the bindings when it builds the synthetic Go, so it does not ask goesm for them.

Only one change was made on the goesm side for this PoC: adding `-overlay` to `build` / `emit-ts` (goesm PR #3, merged into main). It uses go/packages' `Overlay` as is, so module and package resolution remain the go command's job. gosfc depends on neither the Go AST nor go/packages.

## 6. Template bindings

`runtime/bridge.js` calls `GosfcSetup()` once per component instance and exposes each binding as a Vue `computed`.

* What Go code changes are ordinary Go variables, which Vue cannot observe. So every time a Go function is called through a binding (an event handler, a call in the template), the instance's version is advanced and every binding re-reads its value from Go. Only Vue's own reactivity and scheduler are used; there is no separate renderer or scheduler.
* Values are converted for the template with goesm's `toJS` (Go string → JS string, slice → array, struct → object). This is a snapshot: modifying it on the JS side does not change Go state.
* A Go function receives only as many arguments as it declares. The DOM event passed by `@click="Increment"` is not passed to `func Increment()`. String arguments are converted from JS strings to Go strings. For a blocking Go function (one that returns a Promise), the update happens after it resolves.

## 7. Source maps and diagnostics

```
.vue ──//line──> synthetic Go ──goesm──> TypeScript ──Vite(oxc)──> JS ──Rolldown──> bundle
       positions stay in .vue via //line   map: TS → .vue / .go      Vite composes each stage's map
.vue ──MagicString──> rewritten .vue ──plugin-vue──> JS      (template / glue side)
```

* Go diagnostics (syntax, types, imports, goesm lowering constraints) are reported at `.vue` (or `.astro`) positions from the start. They are passed to Vite / Astro errors as `src/features/cart/Summary.vue:17:21: cannot use "x" ... [go/types]` with a code frame.
* For the generated code's map, gosfc simply returns the TS→Go map that goesm produces (whose sources are `.vue` and `.go`) from Vite's load hook, and leaves composition to Vite / Rolldown. Tests confirm that `Total(items)` in the bundle maps back to `Summary.vue:17` and `item.Price * item.Quantity` to `price.go:7`.
* When a Go panic occurs during dev SSR, the stack trace goes through Vite's `ssrFixStacktrace` and points at `TmpPanic.vue:6` (tested).

## 8. HMR

There is no custom HMR runtime. The decisions and updates are those of `@vitejs/plugin-vue` and Vite.

* On HMR, plugin-vue re-reads the file and compares the old and new descriptors. gosfc replaces the HMR context's `read()` in `handleHotUpdate`, so plugin-vue sees the compiled SFC. As a result, a template-only change causes a re-render (Go state is kept), and a change to the Go block causes a component reload (Go runs again).
* So that the script changes even for a Go change that leaves the bindings unchanged, the glue passes a hash of the lowered code as an argument to `useGo` (plugin-vue compares scripts by AST, so a comment would not be enough).
* A change to a `.go` file invalidates and reloads the `.vue` files that use that package. `addWatchFile` is also registered, so recompilation also happens on a dev server with HMR disabled and with `vite build --watch`.
* Generated modules are invalidated in Vite's module graph only when their content changes, and the new version is loaded via the `?t=` that Vite adds.
* For `.astro` files, Astro's own HMR compares the old and new source to update styles alone when only styles changed; gosfc shows it the rewritten source the same way. A `.go` change invalidates the `.astro` files and the `<script lang="go">` modules that use the package.
* Only the user's `.go` files are watched; files in GOROOT and the module cache, and goesm's replacements of standard packages, are not.

## 9. Astro

`@gosfc/astro` only configures `@astrojs/vue` (if not already present) and `@gosfc/vite`. To Astro, a component with a Go block is an ordinary Vue component: without `client:*` it becomes static HTML through Astro's SSR, and with `client:load` it becomes an island that hydrates the same SSR HTML. There is no separate renderer such as Go-native SSR; SSR and the client run the same lowered modules.

### Go in .astro files

An `.astro` file whose frontmatter opens with `---go`, or that contains `<script lang="go">`, is rewritten in the plugin's `load` hook, not in `transform`. Astro's own plugin compiles `.astro` files in its `transform` (also `enforce: "pre"`, and it may run first), and it reads the source for its sub-requests (`?astro&type=script`, styles) through the plugin container's `load`. Rewriting in `load` means Astro only ever sees a TypeScript frontmatter and plain `<script>` elements.

* **Frontmatter.** `compileAstro` passes the Go frontmatter through the same path as a `.vue` block (`gosfc synth`, then `goesm emit-ts -overlay`, with the synthetic package in `_gosfc/<file>_astro` next to the file). synth is told that JavaScript imports are allowed: a spec whose path is a relative or absolute path, `@scope/...`, or contains `:` (`synth.IsJSImport`) is blanked out of the Go file, keeping offsets, and returned as a JS import. The frontmatter is replaced with TypeScript of the same line count, so template positions do not move:

  ```ts
  ---
  import Line from "../features/cart/Line.astro";
  import { GosfcSetup as __gosfc_setup } from "gosfc:goesm/example.com/app/src/pages/_gosfc/go_astro.<hash>.ts";
  import { runGo as __gosfc_run } from "gosfc:astro.js";
  const __gosfc = await __gosfc_run(__gosfc_setup, null, Astro.props);
  const total = __gosfc("total");
  ---
  ```

  `runtime/astro.js` runs the setup once per render and awaits it when it blocks, fills `Props` from `Astro.props` with the rules of the Vue bridge, and converts values with the same code (`runtime/convert.js`). Astro renders a template once, so there is no reactivity. The package is imported by its content-addressed id rather than `go:`, because a `go:` import from a module that is not a `.vue` file compiles the package without the overlay.
* **Client scripts.** Each `<script lang="go">` becomes `<script>import "gosfc:astro-script/<n>/<file>.js"</script>`, an ordinary processed script to Astro. The id names the file and the index because Astro builds the client in a Vite environment of its own: loading the id re-reads the `.astro` file, compiles its n-th Go script as a goesm program of its own, and returns `import { GosfcSetup } from "<id>"; GosfcSetup();`. In the SSR environment Astro does not load scripts, and in the client environment `.astro` modules are not rewritten (Astro replaces them with a stub).
* Vite's dependency scanner reads the `<script>` elements of `.astro` files as TypeScript; for a file with Go it is shown the JavaScript imports of the Go frontmatter and of the other scripts instead.

## 10. Security

* gosfc has no plugin or extension mechanism. Importing a Go dependency never causes it to run inside the compiler.
* The only things executed are `gosfc` and `goesm`, pinned by the tool directive in go.mod and verified by go.sum. goesm runs `go list`, so it inherits the go command's trust boundary as is (environment variables, `go.work`, fetching from GOPROXY).
* Go source is included in source maps' `sourcesContent` and in goesm's panic messages. The maps of a published bundle contain the source.
* Values on the template side are snapshots, so there is no path for the template to modify Go state directly.

## 11. Not yet implemented / open questions

Not yet implemented:

* A way to handle emits / slots from Go. Props can be received with `type Props` from §4, but they are a snapshot taken at setup time and do not follow changes.
* `gosfc fmt` (§12), a language server, a VS Code extension.
* Declaring methods and generic functions inside the Go block (they must go in a Go package).
* Reflecting in the template changes to Go state that happen other than through calls via bindings, such as from goroutines or timers.
* Modifying Go values from the template (`v-model` and so on).
* JS value ⇔ Go value conversion for template bindings is limited to goesm's `toJS` and string arguments. There is no conversion for calling, from the template, a Go function that takes a struct or slice argument (goesm has a calling ABI only for Go calling JavaScript, `//goesm:import`).

Open questions:

* HMR for `.go` files reloads the components that depend on them. Swapping in a package's module on its own is not done.
* The first HMR right after the dev server starts causes a reload even for a template-only change. This is because plugin-vue reads the raw `.vue` from disk during the first transform and stores it in its HMR cache; from the second time on it works as described in §8. Wrapping `parse` through plugin-vue's `compiler` option would fix this, but it means modifying plugin-vue's configuration, so it is on hold.
* Replacing the HMR context's `read()` relies on Vite passing the same context between plugins in `handleHotUpdate`. If plugin-vue offers an official entry point for inserting "script preprocessing", this should move there.
* Resolving the `go:` specifier and `@goesm/runtime` in Vite is handled in gosfc's plugin. If this is considered part of goesm's responsibility for ESM integration, it would be natural to move it to the goesm side, in a form such as `@goesm/vite`.
* goesm is started once per component, and dependent packages are lowered every time. There is no speedup through caching or a resident process yet.

## 12. Formatter and editor integration plan

* **formatter**: `gofmt`-equivalent formatting uses `go/format`. `go/format.Source` can also format "a list of declarations" or "a list of statements", so the Go block alone can be formatted by using the top-level split from `internal/synth` to pass the import group, declarations, and statements through `go/format` separately and rejoining them with the original blank lines. `gosfc fmt` will only write that back to the corresponding range of the `.vue` file, leaving the template / style to Prettier or Vue Language Tools.
* **language server**: from the Go block in a `.vue` file, the synthetic Go used here becomes a virtual Go document as is and is passed to gopls as an overlay (gopls also uses go/packages overlays). Because of the `//line` directives, gopls diagnostics and positions can be mapped back to `.vue` coordinates. Completion, hover, definition, references, rename, code actions, and import completion will simply relay those from gopls; gosfc will not build its own Go completion. The template / style stay the responsibility of Vue Language Tools, so `.vue` files are shared between two language servers. The VS Code extension will be a thin LSP client.
* **template ↔ Go**: the correspondence between template identifiers and Go bindings appears both in the glue (`const total = __gosfc.binding("total")`) and in the synthetic Go's lookup (`case "total": return total`). If Vue Language Tools can follow `total` in the glue, connecting that position to gopls's definition via the synthetic Go makes definition / rename work in both directions. This bridge exists only as a design so far.
