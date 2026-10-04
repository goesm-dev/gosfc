# Contributing to gosfc

gosfc への contribution を歓迎します。issue、pull request のどちらからでも始めてください。大きな変更や責務境界に関わる変更は、先に issue で方針を相談してもらえると助かります。

gosfc は **PoC 段階** です。全体像は [README.md](README.md)、設計と未実装の項目は [ARCHITECTURE.md](ARCHITECTURE.md) にあります。

## 設計原則

gosfc の目的は「Go 風のフロントエンド言語を作ること」ではなく、**本物の Go を Vue SFC ecosystem へ自然に接続すること** です。gosfc は Vue SFC と goesm をつなぐ adapter に留め、他のレイヤーの責務を持ち込みません。

判断に迷ったら、次の順で優先してください。

1. Go ecosystem との互換性
2. 通常の Go code をそのまま利用できること
3. Vue SFC として自然であること
4. Vite との統合が自然であること
5. Astro との統合が自然であること
6. 独自仕様を増やさないこと

次のものは gosfc に実装しません。必要になったら、それぞれの担当に委ねてください。

| 実装しないもの | 担当 |
|---|---|
| Go parser / type checker、Go Modules・package の解決 | Go toolchain |
| Go → TypeScript / ESM の変換、Go の意味論 | goesm |
| SFC parser、template compiler、Vue runtime | Vue tooling |
| bundler、開発サーバー | Vite / Rolldown |
| routing、SSR、islands、`client:*`、page generation | Astro |

あわせて、次の約束を守ってください。

* 独自の import 記法（`import "./cart.go"`、`import "./Button.vue"`、`import Button from "./Button.vue"` など）は導入しません。Go block の import は普通の Go import だけです。
* `.go` ファイルは普通の Go package のままにします。gosfc 専用の `.go` 形式は作りません。
* `go`、`gofmt`、`gopls`、`go vet` などと競合する独自 tooling は作りません。
* `lang="go"` 以外の `.vue` には触れません。`lang="ts"` の component はそのまま Vue / Vite に渡します。

## goesm との境界

* gosfc は goesm を CLI（`go tool goesm emit-ts -overlay ...`）経由でのみ呼びます。goesm の Go package は `internal/` なので import しません。
* 境界は `packages/vite/src/goesm.js` の 1 ファイルだけです。goesm の呼び方を変えるときはここだけを変更してください。
* goesm 側の変更が必要な場合は [goesm](https://github.com/goesm-dev/goesm) に pull request を出してください。goesm に Vue や SFC の知識を入れず、汎用的な機能（例：`-overlay`）として提案します。
* goesm の変更が main にマージされたら、`examples/astro/go.mod` と `tests/fixtures/app/go.mod` の goesm の pseudo-version を更新します。

## 開発環境

開発ツールは [mise](https://mise.jdx.dev/) で揃えます。Go、Node.js、pnpm のバージョンは `mise.toml` で pin しています。

```sh
mise install
pnpm install
```

* `mise.toml` は `GOPRIVATE=github.com/goesm-dev` も設定します。goesm は private repository なので、取得には GitHub の認証も必要です（proxy.golang.org からは取得できません）。
* ツールを最新に上げるときは `mise upgrade --bump`（`-b`）を実行し、`pnpm test` が通ることを確認してから更新後の `mise.toml` を commit してください。
* pnpm のバージョンは `mise.toml` だけで管理します。`package.json` に `packageManager` は書きません。
* build script を実行してよい依存は `pnpm-workspace.yaml` の `allowBuilds` に列挙しています。

## テスト

```sh
pnpm test
```

`go test ./...`（`internal/synth` など）と `tests/*.test.mjs`（Astro build、Vite build / SSR / HMR、診断）が走ります。ブラウザでの HMR テストは `/opt/pw-browsers/chromium` または `CHROMIUM` 環境変数の Chromium を使い、見つからなければ skip します。

example を手元で動かす場合：

```sh
cd examples/astro
pnpm build   # dist/index.html に「合計: 200」
pnpm dev
```

## Pull request

* 1 つの pull request には 1 つの目的だけを入れてください。
* 動作が変わる変更にはテストを追加してください。
* Go のコードは `gofmt` と `go vet ./...` を通してください。
* 責務境界、goesm との API、未実装・未決事項が変わる場合は ARCHITECTURE.md も更新してください。
* `pnpm test` が通ることを確認してから提出してください。

## ライセンス

gosfc は [MIT License](LICENSE) で公開されています。contribution は同じ MIT License の下で提供されたものとして扱います。npm package にも同梱するため、`packages/vite/LICENSE` と `packages/astro/LICENSE` はルートの `LICENSE` の写しにしています。
