# gosfc

English | [日本語](README.ja.md)

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

## Development

Prerequisites: Go (the toolchain selected by go.mod is downloaded automatically), Node.js 22, and pnpm. goesm is a private repository, so you need `GOPRIVATE=github.com/goesm-dev` and GitHub authentication.

```sh
pnpm install
pnpm test                      # go test ./... and tests/*.test.mjs
cd examples/astro && pnpm build   # dist/index.html contains 「合計: 200」
cd examples/astro && pnpm dev
```

The browser HMR test uses Chromium at `/opt/pw-browsers/chromium` (or the `CHROMIUM` environment variable) and is skipped if it is not found.
