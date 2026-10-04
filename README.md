# gosfc

English | [日本語](README.ja.md)

[![Status: PoC](https://img.shields.io/badge/status-PoC-orange)](ARCHITECTURE.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Go 1.27](https://img.shields.io/badge/Go-1.27-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![Vite 8](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Astro 7](https://img.shields.io/badge/Astro-7-BC52EE?logo=astro&logoColor=white)](https://astro.build/)
[![goesm](https://img.shields.io/badge/compiled%20by-goesm-00ADD8)](https://github.com/goesm-dev/goesm)

An integration layer for using real Go in the `<script setup>` of Vue Single File Components.

```vue
<template>
  <div>
    Total: {{ total }}
  </div>
</template>

<script setup lang="go">
import cart "example.com/app/src/features/cart/pkg"

items := []cart.Item{
	{
		Price:    100,
		Quantity: 2,
	},
}

total := cart.Total(items)
</script>
```

`.go` files are ordinary Go packages, and imports are ordinary Go imports. Go compilation is handled by [goesm](https://github.com/goesm-dev/goesm), SFCs and templates by the Vue tooling, builds by Vite, and pages and SSR by Astro. See [ARCHITECTURE.md](ARCHITECTURE.md) (Japanese) for the design.

**Status: PoC.** What is not implemented yet is listed in ARCHITECTURE.md, section 11 (「未実装・未決事項」).

## Usage (Astro)

1. Add goesm and gosfc to your Go module as tools. Their versions are pinned by go.mod / go.sum.

   ```sh
   go get -tool github.com/goesm-dev/goesm/cmd/goesm@<version>
   go get -tool github.com/goesm-dev/gosfc/cmd/gosfc@<version>
   ```

2. Add the integration to Astro. `@astrojs/vue` is added if it is not already there.

   ```js
   // astro.config.mjs
   import { defineConfig } from "astro/config";
   import gosfc from "@gosfc/astro";

   export default defineConfig({
     integrations: [gosfc()],
   });
   ```

3. Use `<script setup lang="go">` in your `.vue` files.

   ```astro
   ---
   import Summary from "../features/cart/Summary.vue";
   ---

   <Summary />
   ```

To use gosfc with Vite alone, put `@gosfc/vite` before `@vitejs/plugin-vue`.

```js
import vue from "@vitejs/plugin-vue";
import gosfc from "@gosfc/vite";

export default { plugins: [gosfc(), vue()] };
```

Components using `lang="ts"` or a plain `<script setup>` keep working alongside them. gosfc only touches components with `lang="go"`.

## Writing the Go block

* Like Vue's `<script setup>`, the top level runs once, top to bottom, per component instance. You can write `x := ...`, `var`, `const`, `type`, and `func F() {...}`.
* Top-level variables, constants, and functions are available in the template. When the template calls a Go function (for example `@click="Increment"`), the rendered output follows the Go values.
* Only Go imports are allowed. You cannot import `.vue`, `.ts`, or `.go` files.
* Put methods and generic functions in a Go package.

## Importing Go from JavaScript

A `.js`, `.ts` or `.astro` module inside a Go module can import a Go package directly with a `go:` specifier. gosfc compiles the package with goesm in the Go module of the importing file, and Vite bundles it like any other module. The API is goesm's: exported functions and types, with Go strings and slices converted through the runtime each module re-exports as `$runtime`.

```astro
---
// src/pages/[slug].astro
import { Slugs, $runtime as rt } from "go:example.com/app/content";

export function getStaticPaths() {
  return rt.toArray(Slugs()).map((s) => ({ params: { slug: rt.toJSString(s) } }));
}
---
```

## Benchmark

The same components written with `<script setup lang="go">` and with `<script setup lang="ts">` ([bench/](bench)), built with Vite 8 and `@vitejs/plugin-vue`. The Go side adds `@gosfc/vite` in front; nothing else differs.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="bench/results-dark.svg">
  <img alt="Bar chart of the benchmark: gosfc vs. Vue for client build time, client JS size and SSR render time (numbers in the table below)" src="bench/results-light.svg">
</picture>

| | gosfc (`lang="go"`) | Vue (`lang="ts"`) | ratio |
|---|---:|---:|---:|
| Client build time | 196 ms | 130 ms | 1.51x |
| Client JS (minified) | 68.2 KiB | 59.8 KiB | 1.14x |
| Client JS (gzip) | 26.4 KiB | 23.3 KiB | 1.13x |
| SSR render, small component | 13.8 µs | 12.9 µs | 1.07x |
| SSR render, 1,000,000 items | 104.9 ms | 95.8 ms | 1.09x |

* **Client build time**: `vite build` of a page with a counter and a cart summary. Median of 9 builds, alternating which side builds first, after one warm-up build per side, so the goesm binary and the go command's build cache are warm, as in an edit-and-rebuild loop.
* **Client JS**: every JS file of that build, Vue runtime included. The difference (+8.4 KiB, +3.1 KiB gzip) is goesm's runtime and the code that keeps Go semantics.
* **SSR render**: `renderToString` with the production SSR build, both sides rendering the same HTML. Each side and component is measured in its own fresh Node process, 5 times with the order alternating, and the table shows the median. "small component" is a cart summary of 3 items; "1,000,000 items" builds and sums 1,000,000 items in the component's setup, which on both sides is mostly allocation. The small gap there is presumably the code goesm generates to keep Go semantics (for example, `range` copies each struct value); it has not been profiled.

Measured with `pnpm bench` on 2026-10-04 with the `mise.toml` versions (Node.js 26.10.0, Go 1.27.1) and goesm 20dbf1d, on a 4 vCPU Intel Xeon 2.80GHz cloud VM. Sizes are exact; timings move between runs on that machine (over 6 runs the ratios ranged from 1.51x to 1.73x for the build, 1.02x to 1.26x for the small component and 1.09x to 1.20x for 1,000,000 items).

## Development

Go, Node.js, and pnpm are pinned to the versions in `mise.toml` with [mise](https://mise.jdx.dev/).

```sh
mise install
pnpm install
pnpm test                      # go test ./... and tests/*.test.mjs
pnpm bench                     # bench/run.mjs: prints the Benchmark table, rewrites bench/results-*.svg
cd examples/astro && pnpm build   # dist/index.html contains 「合計: 200」
cd examples/astro && pnpm dev
```

The browser HMR test uses Chromium at `/opt/pw-browsers/chromium` (or the `CHROMIUM` environment variable) and is skipped if it is not found.

## Contributing / License

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute and for the design principles. gosfc is released under the [MIT License](LICENSE).
