# gosfc

[English](README.md) | 日本語

[![Status: PoC](https://img.shields.io/badge/status-PoC-orange)](ARCHITECTURE.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Go 1.27](https://img.shields.io/badge/Go-1.27-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![Vite 8](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Astro 7](https://img.shields.io/badge/Astro-7-BC52EE?logo=astro&logoColor=white)](https://astro.build/)
[![goesm](https://img.shields.io/badge/compiled%20by-goesm-00ADD8)](https://github.com/goesm-dev/goesm)

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

## ベンチマーク

同じ component を `<script setup lang="go">` と `<script setup lang="ts">` で書いて比べています（[bench/](bench)）。どちらも Vite 8 と `@vitejs/plugin-vue` で build し、Go 側は前に `@gosfc/vite` を置く以外は同じ設定です。

| | gosfc (`lang="go"`) | Vue (`lang="ts"`) | ratio |
|---|---:|---:|---:|
| Client build time | 159 ms | 105 ms | 1.52x |
| Client JS (minified) | 68.2 KiB | 59.8 KiB | 1.14x |
| Client JS (gzip) | 26.4 KiB | 23.3 KiB | 1.13x |
| SSR render, small component | 14.5 µs | 14.9 µs | 0.97x |
| SSR render, 1,000,000 items | 107.5 ms | 96.6 ms | 1.11x |

* **Client build time**：counter と cart summary を置いたページの `vite build`。それぞれ warm-up の build を 1 回してから、先に build する側を入れ替えながら 9 回測った中央値です。goesm の binary と go command の build cache は温まった状態で、編集して build し直すときと同じ条件です。
* **Client JS**：その build の JS ファイルすべて（Vue runtime を含む）。差（+8.4 KiB、gzip で +3.1 KiB）は goesm の runtime と Go の意味論を守るためのコードです。
* **SSR render**：production の SSR build で `renderToString` した時間で、両者は同じ HTML を出力します。side と component ごとに新しい Node process で、順番を入れ替えながら 5 回測った中央値です。「small component」は 3 品の cart summary、「1,000,000 items」は component の setup で 1,000,000 品を作って合計するもので、どちらも時間の大半はメモリ確保です。そこでの小さな差は、goesm が Go の意味論を守るために生成するコード（たとえば `range` での struct の値コピー）によるものと思われますが、profile はまだ取っていません。

2026-10-04 に `pnpm bench` で測りました。`mise.toml` のバージョン（Node.js 26.10.0、Go 1.27.1）と goesm 20dbf1d を使い、4 vCPU の Intel Xeon 2.80GHz のクラウド VM で実行しています。サイズは決定的ですが、時間はこの環境では実行ごとに揺れます（5 回の実行で、比は build が 1.39x〜1.96x、small component が 0.95x〜1.07x、1,000,000 items が 1.11x〜1.18x でした）。

## 開発

Go、Node.js、pnpm は [mise](https://mise.jdx.dev/) で `mise.toml` のバージョンに揃えます。

```sh
mise install
pnpm install
pnpm test                      # go test ./... と tests/*.test.mjs
pnpm bench                     # bench/run.mjs（ベンチマークの表）
cd examples/astro && pnpm build   # dist/index.html に「合計: 200」
cd examples/astro && pnpm dev
```

ブラウザでの HMR テストは `/opt/pw-browsers/chromium`（または `CHROMIUM` 環境変数）の Chromium を使い、無ければ skip します。

## Contributing / ライセンス

contribution の方法と設計原則は [CONTRIBUTING.md](CONTRIBUTING.md) を見てください。gosfc は [MIT License](LICENSE) で公開されています。
