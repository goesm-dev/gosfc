# gosfc

Vue Single File Component の `<script setup>` で本物の Go を使うための統合レイヤーです。

```vue
<template>
  <div>
    合計: {{ total }}
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

`.go` は普通の Go package、import は普通の Go import です。Go のコンパイルは [goesm](https://github.com/goesm-dev/goesm)、SFC と template は Vue tooling、build は Vite、ページと SSR は Astro が担当します。設計は [ARCHITECTURE.md](ARCHITECTURE.md) を見てください。

**状態：PoC。** 未実装の項目は ARCHITECTURE.md の「未実装・未決事項」にあります。

## 使い方（Astro）

1. Go module に goesm と gosfc を tool として追加します。バージョンは go.mod / go.sum で固定されます。

   ```sh
   go get -tool github.com/goesm-dev/goesm/cmd/goesm@<version>
   go get -tool github.com/goesm-dev/gosfc/cmd/gosfc@<version>
   ```

2. Astro に integration を追加します。`@astrojs/vue` が無ければ追加されます。

   ```js
   // astro.config.mjs
   import { defineConfig } from "astro/config";
   import gosfc from "@gosfc/astro";

   export default defineConfig({
     integrations: [gosfc()],
   });
   ```

3. `.vue` で `<script setup lang="go">` を使います。

   ```astro
   ---
   import Summary from "../features/cart/Summary.vue";
   ---

   <Summary />
   ```

Vite だけで使う場合は `@vitejs/plugin-vue` の前に `@gosfc/vite` を置きます。

```js
import vue from "@vitejs/plugin-vue";
import gosfc from "@gosfc/vite";

export default { plugins: [gosfc(), vue()] };
```

`lang="ts"` や素の `<script setup>` の component はそのまま共存できます。gosfc が触るのは `lang="go"` の component だけです。

## Go block の書き方

* トップレベルは Vue の `<script setup>` と同じく component instance ごとに上から 1 回実行されます。`x := ...`、`var`、`const`、`type`、`func F() {...}` が書けます。
* トップレベルの変数・定数・関数は template から参照できます。Go 関数を template から呼ぶ（`@click="Increment"` など）と、表示が Go の値に追従します。
* import は Go の import だけです。`.vue`、`.ts`、`.go` ファイルの import はできません。
* メソッドと generic 関数は Go package に置いてください。

## 開発

前提：Go（go.mod が選ぶ toolchain を自動取得）、Node.js 22、pnpm。goesm は private repository なので `GOPRIVATE=github.com/goesm-dev` と GitHub の認証が必要です。

```sh
pnpm install
pnpm test                      # go test ./... と tests/*.test.mjs
cd examples/astro && pnpm build   # dist/index.html に「合計: 200」
cd examples/astro && pnpm dev
```

ブラウザでの HMR テストは `/opt/pw-browsers/chromium`（または `CHROMIUM` 環境変数）の Chromium を使い、無ければ skip します。

## Contributing / ライセンス

contribution の方法と設計原則は [CONTRIBUTING.md](CONTRIBUTING.md) を見てください。gosfc は [MIT License](LICENSE) で公開されています。
