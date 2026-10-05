# Contributing to gosfc

[English](CONTRIBUTING.md) | 日本語

gosfc へのコントリビューションを歓迎します。issue、プルリクエストのどちらからでも始めてください。大きな変更や責務境界に関わる変更は、先に issue で方針を相談してもらえると助かります。

gosfc は **PoC 段階** です。全体像は [README.ja.md](README.ja.md)、設計と未実装の項目は [ARCHITECTURE.ja.md](ARCHITECTURE.ja.md) にあります。

## 設計原則

gosfc の目的は「Go 風のフロントエンド言語を作ること」ではなく、**本物の Go を Vue SFC のエコシステムへ自然に接続すること** です。gosfc は Vue SFC と goesm をつなぐアダプターに留め、他のレイヤーの責務を持ち込みません。

判断に迷ったら、次の順で優先してください。

1. Go のエコシステムとの互換性
2. 通常の Go のコードをそのまま利用できること
3. Vue SFC として自然であること
4. Vite との統合が自然であること
5. Astro との統合が自然であること
6. 独自仕様を増やさないこと

次のものは gosfc に実装しません。必要になったら、それぞれの担当に委ねてください。

| 実装しないもの | 担当 |
|---|---|
| Go のパーサー / 型チェッカー、Go Modules・パッケージの解決 | Go ツールチェーン |
| Go → TypeScript / ESM の変換、Go の意味論 | goesm |
| SFC のパーサー、テンプレートコンパイラ、Vue ランタイム | Vue tooling |
| バンドラー、開発サーバー | Vite / Rolldown |
| ルーティング、SSR、アイランド、`client:*`、ページ生成 | Astro |

あわせて、次の約束を守ってください。

* 独自のインポート記法（`import "./cart.go"`、`import "./Button.vue"`、`import Button from "./Button.vue"` など）は導入しません。Go ブロックのインポートは普通の Go のインポートだけです。
* `.go` ファイルは普通の Go パッケージのままにします。gosfc 専用の `.go` 形式は作りません。
* `go`、`gofmt`、`gopls`、`go vet` などと競合する独自のツールは作りません。
* `lang="go"` 以外の `.vue` には触れません。`lang="ts"` のコンポーネントはそのまま Vue / Vite に渡します。

## goesm との境界

* gosfc は goesm を CLI（`go tool goesm emit-ts -overlay ...`）経由でのみ呼びます。goesm の Go パッケージは `internal/` なのでインポートしません。
* 境界は `packages/vite/src/goesm.js` の 1 ファイルだけです。goesm の呼び方を変えるときはここだけを変更してください。
* goesm 側の変更が必要な場合は [goesm](https://github.com/goesm-dev/goesm) にプルリクエストを出してください。goesm に Vue や SFC の知識を入れず、汎用的な機能（例：`-overlay`）として提案します。
* goesm はリリース（`v0.0.1-beta.N`）で固定します。新しいリリースが出たら、`examples/astro/go.mod`、`tests/fixtures/app/go.mod`、`bench/go.mod` で `go get -tool github.com/goesm-dev/goesm/cmd/goesm@<version>` を実行します。

## 開発環境

開発ツールは [mise](https://mise.jdx.dev/) で揃えます。Go、Node.js、pnpm のバージョンは `mise.toml` で pin しています。

```sh
mise install
pnpm install
```

* ツールを最新に上げるときは `mise upgrade --bump`（`-b`）を実行し、`pnpm test` が通ることを確認してから更新後の `mise.toml` をコミットしてください。
* pnpm のバージョンは `mise.toml` だけで管理します。`package.json` に `packageManager` は書きません。
* ビルドスクリプトを実行してよい依存は `pnpm-workspace.yaml` の `allowBuilds` に列挙しています。

## テスト

```sh
pnpm test
```

`go test ./...`（`internal/synth` など）と `tests/*.test.mjs`（Astro のビルド、Vite のビルド / SSR / HMR、診断）が走ります。ブラウザでの HMR テストは `/opt/pw-browsers/chromium` または `CHROMIUM` 環境変数の Chromium を使い、見つからなければスキップします。

サンプルを手元で動かす場合：

```sh
cd examples/astro
pnpm build   # dist/index.html に「合計: 200」
pnpm dev
```

## プルリクエスト

* 1 つのプルリクエストには 1 つの目的だけを入れてください。
* 動作が変わる変更にはテストを追加してください。
* Go のコードは `gofmt` と `go vet ./...` を通してください。
* 責務境界、goesm との API、未実装・未決事項が変わる場合は ARCHITECTURE.ja.md も更新してください。
* `pnpm test` が通ることを確認してから提出してください。

## ライセンス

gosfc は [MIT License](LICENSE) で公開されています。コントリビューションは同じ MIT License の下で提供されたものとして扱います。npm パッケージにも同梱するため、`packages/vite/LICENSE` と `packages/astro/LICENSE` はルートの `LICENSE` の写しにしています。
