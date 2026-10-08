# @gosfc/vite

Vite plugin for [gosfc](https://goesm.dev/gosfc): compiles `<script setup lang="go">` in Vue SFCs and Go in `.astro` files through [goesm](https://github.com/goesm-dev/goesm).

**Status: PoC.** Full docs: [goesm.dev/gosfc](https://goesm.dev/gosfc). Source and architecture: [GitHub](https://github.com/goesm-dev/gosfc).

## Prerequisites

Install goesm and gosfc as Go tools in your module (versions are pinned in `go.mod` / `go.sum`). gosfc requires goesm v0.0.1-beta.3 or later.

```sh
go get -tool github.com/goesm-dev/goesm/cmd/goesm@<version>
go get -tool github.com/goesm-dev/gosfc/cmd/gosfc@<version>
```

## Install

```sh
npm install @gosfc/vite
# or: pnpm add @gosfc/vite / bun add @gosfc/vite
```

Peer dependencies: `vite` ^8, `vue` ^3.5.

## Setup

Register `@gosfc/vite` **before** `@vitejs/plugin-vue`:

```js
import vue from "@vitejs/plugin-vue";
import gosfc from "@gosfc/vite";

export default {
  plugins: [gosfc(), vue()],
};
```

Use `<script setup lang="go">` in `.vue` files. Components with `lang="ts"` or plain `<script setup>` are unchanged.

For Astro, use [`@gosfc/astro`](https://www.npmjs.com/package/@gosfc/astro) instead.

## Documentation

- [gosfc docs](https://goesm.dev/gosfc)
- [Source repository](https://github.com/goesm-dev/gosfc)
