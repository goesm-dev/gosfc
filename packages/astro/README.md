# @gosfc/astro

[Astro](https://astro.build/) integration for [gosfc](https://goesm.dev/gosfc): adds `@astrojs/vue` when needed and wires in [`@gosfc/vite`](https://www.npmjs.com/package/@gosfc/vite) for Go in Vue and `.astro` files.

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

Peer dependencies: `astro` ^7, `@astrojs/vue` ^7.

## Setup

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import gosfc from "@gosfc/astro";

export default defineConfig({
  integrations: [gosfc()],
});
```

`@astrojs/vue` is added automatically if it is not already configured.

Use `<script setup lang="go">` in `.vue` files and Go in `.astro` frontmatter as described in the main docs.

For Vite + Vue without Astro, use [`@gosfc/vite`](https://www.npmjs.com/package/@gosfc/vite) instead.

## Documentation

- [gosfc docs](https://goesm.dev/gosfc)
- [Source repository](https://github.com/goesm-dev/gosfc)
