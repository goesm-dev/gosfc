# @gosfc/astro

[Astro](https://astro.build/) integration for [gosfc](https://goesm.dev/gosfc): adds `@astrojs/vue` when the project uses Vue and wires in [`@gosfc/vite`](https://www.npmjs.com/package/@gosfc/vite) for Go in Vue and `.astro` files.

**Status: PoC.** Full docs: [goesm.dev/gosfc](https://goesm.dev/gosfc). Source and architecture: [GitHub](https://github.com/goesm-dev/gosfc).

## Prerequisites

Install goesm and gosfc as Go tools in your module (versions are pinned in `go.mod` / `go.sum`). gosfc requires goesm v0.0.1-beta.3 or later.

```sh
go get -tool github.com/goesm-dev/goesm/cmd/goesm@<version>
go get -tool github.com/goesm-dev/gosfc/cmd/gosfc@<version>
```

## Install

```sh
npm install @gosfc/astro
# or: pnpm add @gosfc/astro / bun add @gosfc/astro
```

Peer dependencies: `astro` ^7, and `@astrojs/vue` ^7 for Vue components (optional: Go in `.astro` files does not need it).

## Setup

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import gosfc from "@gosfc/astro";

export default defineConfig({
  integrations: [gosfc()],
});
```

When `@astrojs/vue` is installed and not already configured, it is added. `gosfc({ vue: false })` never adds it, and `gosfc({ vue: { ... } })` passes options to it.

Use `<script setup lang="go">` in `.vue` files and Go in `.astro` frontmatter as described in the main docs.

The TypeScript types of the Go packages that TypeScript imports with `go:` are written to `.astro/integrations/_gosfc_astro/go-imports.d.ts`, which `.astro/types.d.ts` references (with goesm after v0.0.1-beta.7). `astro sync` and `astro check` compile the Go to write them.

For Vite + Vue without Astro, use [`@gosfc/vite`](https://www.npmjs.com/package/@gosfc/vite) instead.

## Documentation

- [gosfc docs](https://goesm.dev/gosfc)
- [Source repository](https://github.com/goesm-dev/gosfc)
