# @gosfc/astro

[Astro](https://astro.build/) integration for [gosfc](https://github.com/goesm-dev/gosfc): adds `@astrojs/vue` when needed and wires in [`@gosfc/vite`](https://www.npmjs.com/package/@gosfc/vite) for Go in Vue and `.astro` files.

**Status: PoC.** See the [repository README](https://github.com/goesm-dev/gosfc#readme) and [ARCHITECTURE.md](https://github.com/goesm-dev/gosfc/blob/main/ARCHITECTURE.md) for scope and limitations.

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

- [gosfc repository](https://github.com/goesm-dev/gosfc)
- [Usage (Astro)](https://github.com/goesm-dev/gosfc#usage-astro)
