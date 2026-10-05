# gosfc architecture

[English](ARCHITECTURE.md) | 日本語

gosfc は、Vue SFC の `<script setup lang="go">` を本物の Go として扱うための薄い統合レイヤーです。
Go のコンパイルは goesm、SFC とテンプレートは Vue tooling、ビルドは Vite / Rolldown、ページと SSR は Astro が担当します。gosfc はそれらをつなぐことだけをします。

## 1. 責務境界

```
Vue SFC (.vue)
  │  @vue/compiler-sfc の parse（Vue tooling）
  ▼
gosfc ─────────────── <script setup lang="go"> を見つけ、synthetic Go を作り、
  │                    goesm の出力を Vue が扱える <script setup> に接続する
  ▼
goesm ─────────────── Go toolchain（go list / go/parser / go/types）で解決・型検査し、
  │                    Go の意味論を TypeScript に lowering する
  ▼
TypeScript (ESM) + source map
  │
  ▼
Vue / Vite ────────── @vitejs/plugin-vue が template / style / HMR、Vite が TS 変換、
  │                    Rolldown が bundle
  ▼
Astro ─────────────── routing / SSR / SSG / islands / client:* / HTML
```

| 層 | 担当すること | 担当しないこと |
|---|---|---|
| gosfc | `.vue` の Go ブロックの検出、synthetic Go の構築、goesm 呼び出し、テンプレートバインディングの公開、位置情報の維持、Vite プラグイン、Astro インテグレーション | Go のパース / 型検査 / モジュール・パッケージ解決 / lowering、テンプレート・スタイルのコンパイル、バンドル、SSR |
| goesm | Go パッケージグラフ、Go Modules、構文解析、型検査、Go 意味論、TypeScript への lowering、TS→Go のソースマップ | Vue / SFC のこと |
| Vue tooling | SFC のパース、テンプレートのコンパイル、scoped CSS、HMR の判定 | Go |
| Vite / Rolldown | 開発サーバー、TS→JS、バンドル、ソースマップの合成 | Go、SFC |
| Astro | ページ、SSR、SSG、アイランド、`client:*` | Go、SFC の中身 |

## 2. リポジトリ構成

```
cmd/gosfc/          Go 側の CLI（`gosfc synth`）。アプリの go.mod に tool として入る
internal/synth/     <script setup lang="go"> → synthetic Go（go/scanner のみ使用）
packages/vite/      @gosfc/vite: Vite plugin。src/compile.js が SFC 変換の中心、
                    src/goesm.js が goesm との唯一の境界、runtime/bridge.js が template binding
packages/astro/     @gosfc/astro: @astrojs/vue + @gosfc/vite を設定するだけの integration
examples/astro/     PoC（Astro → Vue → gosfc → goesm → Vite）
tests/              Node のテスト（Astro build、Vite build / SSR / HMR、診断）と fixture
```

`core` を別パッケージにはしていません。今のところ利用者は Vite プラグインだけなので、`packages/vite/src/compile.js` が core の役割を持ちます。フォーマッターや language server が同じ処理を必要とした時点で切り出します。

## 3. 処理の流れ

1. `@gosfc/vite`（`enforce: "pre"`）は `.vue` のメインリクエストのうち `<script setup lang="go">` を含むものだけを変換します。それ以外の `.vue`（`lang="ts"`、素の `<script setup>`）には触れず、`@vitejs/plugin-vue` がそのまま処理します。
2. `@vue/compiler-sfc` の `parse` でディスクリプターを得ます。Vue のパーサーは自作しません。
3. Go ブロックを `go tool gosfc synth` に渡し、synthetic Go とトップレベルのバインディングの一覧を得ます（§4）。
4. synthetic Go を `go tool goesm emit-ts -overlay` に渡します（§5）。成功すればパッケージごとの TypeScript とソースマップ、失敗すれば `.vue` 位置の診断が返ります。
5. Go ブロックだけを次の `<script setup lang="ts">` に置き換えます。テンプレート、`<style>`、`<style scoped>`、素の `<script>` は 1 バイトも変えません。行数も保つので、後ろにあるブロックの位置はずれません。

   ```ts
   import { GosfcSetup as __gosfc_setup } from "go:example.com/app/src/features/cart/_gosfc/summary_vue";
   import { useGo as __gosfc_useGo } from "gosfc:bridge.js";
   const __gosfc = __gosfc_useGo(__gosfc_setup, "7a4085be24760462");
   const items = __gosfc.binding("items");
   const total = __gosfc.binding("total");
   ```

6. 以降は普通の Vue SFC として `@vitejs/plugin-vue` がテンプレート / スタイルをコンパイルします。`go:` のインポートはプラグインが goesm の出力（仮想モジュール、id は `gosfc:goesm/<import path>.<hash>.ts`、ランタイムは `gosfc:goesm/@goesm/runtime/*.ts`）に解決し、TypeScript は Vite 自身の変換に任せます。コンポーネント（と `go:` をインポートする JS モジュール）はそれぞれ別の goesm プログラムで、パッケージの出力はプログラム全体に依存します（ある関数値が一方では async、他方では同期になる、など）。そのため id のハッシュはモジュールのコードと、それがインポートするパッケージの id から作り、goesm の相対インポート（`./x.ts`）はその id に書き換えます。コードが一致するパッケージは 1 つのモジュール（とバンドラーのチャンク）を共有し、一致しないものは別々のモジュールになります。ランタイムはどのプログラムでも同じなので普通の id のままです。
7. `.vue` 以外のモジュール（`.js`、`.ts`、`.astro`）が `go:<import path>` をインポートしている場合は、そのモジュールの transform で、インポートしたファイルが属する Go モジュールを基準に `goesm emit-ts <import path>` を実行し、同じ仮想ツリーに登録します。`.go` ファイルはそのモジュールの watch 対象になり、編集するとモジュールが読み直されます。

## 4. synthetic Go

`<script setup lang="go">` は Go のソースファイルではなく、Vue の `<script setup>` と同じく「コンポーネントインスタンスごとに 1 回実行される本体」です。gosfc はこれを普通の Go ファイルに組み直します。

```go
//line /abs/Summary.vue:7:1
package summary_vue

//line /abs/Summary.vue:8:1
import cart "example.com/app/src/features/cart/pkg"

//line /abs/Summary.vue:7:1
func GosfcSetup() func(string) any {
//line /abs/Summary.vue:10:1
items := []cart.Item{{Price: 100, Quantity: 2}}
//line /abs/Summary.vue:12:1
total := cart.Total(items)
//line /abs/Summary.vue:7:1
return func(gosfcBinding string) any {
	switch gosfcBinding {
	case "items": return items
	case "total": return total
	}
	return nil
}
}
```

* ユーザーのテキストは全て `//line` ディレクティブの後ろにそのまま写します。Go の文法は変えません。go/parser、go/types、goesm の診断とソースマップは全て `.vue` の位置を指します。生成ファイル自身の位置（`_gosfc/.../setup.go`）が利用者に見えることはありません。
* 並び：const / type 宣言 → 各 `func F(...)` のための `var F func(...)` → 残りを元の順で。`func F() {...}` は `F=func() {...}` に置き換えます。`F=func` は `func F` と同じ長さなので列もずれません。関数同士の相互参照・再帰ができ、本体は上から順に実行されます（Vue の `setup()` と同じ）。宣言より前で関数を呼ぶと nil func のパニックになります。
* goesm の `//goesm:import` ディレクティブが前にある `var` と本体のない関数は、Vue コンポーネントや TypeScript の関数などの ES モジュールの値を取り込む宣言です。これらはディレクティブとともにパッケージレベルに置きます。ディレクティブは宣言の直前の行に置き、その前の `//line` ディレクティブで宣言自身の位置が保たれるようにします。間に `//line` を挟むと、goesm が読むドキュメントコメントが途切れるからです。goesm は相対パスのモジュールを `//line` が指す `.vue` ファイルから解決し、`@gosfc/vite` はそのファイルの import を絶対パスに書き換えます。Vite はそれをほかのモジュールと同じように読み込みます。`js.Value` のバインディングはテンプレートでは保持している値そのものになるので、コンポーネントは `<Badge />` として使えます。
* 返り値のルックアップ関数がテンプレートバインディングの入口です。値は `any` にボックス化されるので Go の型ディスクリプターを保ったまま JS 側に渡ります。全バインディングがここで参照されるため、テンプレートからしか使わない変数も Go の「declared and not used」にはなりません。未使用のインポートは通常どおり Go のエラーです。
* パッケージは `.vue` と同じディレクトリの下の、ディスクには存在しない `_gosfc/<name>_vue/` に置きます（goesm のオーバーレイで渡す）。そのためインポートパスは `<module>/<dir>/_gosfc/<name>_vue` になり、`internal/` の可視性も `.vue` の場所を基準に普通の Go と同じく働きます。ユーザーのソースツリーには何も書きません。
* ブロックが `type Props struct {...}` を宣言すると、その型はパッケージレベルに置かれ、setup 関数は `func GosfcSetup(props Props)` になります。さらに `func GosfcProps() any { return Props{} }` を生成し、ブリッジはその型ディスクリプターのフィールドを見てコンポーネントの属性（`useAttrs()`）から Props の値を作ります。glue には `defineOptions({ inheritAttrs: false })` が入るので、属性はルート要素に落ちません。Props のフィールドの型はインポートした型か組み込み型に限られます（ブロック内の型はまだ宣言されていないため）。
* gosfc は Go をパースしません。`internal/synth` は標準の `go/scanner` でトークン化し、括弧の深さとスキャナーが挿入するセミコロンだけでトップレベルの区切りを決め、各要素の先頭トークン（`import` / `func 名前` / `var` / `const` / `type` / `a, b :=`）を見て分類と名前の取得をします。構文・型のエラーは全て Go ツールチェーンが報告します。
* gosfc が自分で出す診断は Go の外の制約だけです：メソッド宣言、ジェネリック関数、インポートの位置、JavaScript の予約語と衝突するバインディング名（`new`、`class` など）、`<script lang="go">`（setup なし）。

## 5. goesm との API 境界

境界は `packages/vite/src/goesm.js` の 1 ファイルだけです。gosfc は goesm の CLI を、アプリの go.mod の tool ディレクティブで固定された版で呼びます（`go tool -n goesm` でビルド済みバイナリを得る）。

```
goesm emit-ts -overlay <overlay.json> -o <dir> ./<rel>/_gosfc/<name>_vue
  入力:  overlay.json は go command 標準の -overlay 形式 {"Replace": {"/abs/.../setup.go": "<一時ファイル>"}}
  出力:  <dir>/<import path>.ts (+ .ts.map)      Go package ごとに 1 module、map は .vue / .go を指す
         <dir>/@goesm/runtime/*.ts               goesm runtime（module 間と runtime への import は相対 `.ts` 指定）
  失敗:  exit 1、stderr に "<file>:<line>:<col>: <message> [<layer>]"（layer は go/parser・go/types・go list・goesm lowering）
```

概念上の `Compile(source, context) → { code, map, bindings, diagnostics }` との対応：source = オーバーレイの synthetic Go、context = モジュールディレクトリとパッケージパターン、code / map = 出力モジュール、diagnostics = stderr。bindings は gosfc 自身が synthetic Go を作る時点で知っているので goesm には求めていません。

goesm 側の変更はこの PoC のために 1 つだけです：`build` / `emit-ts` に `-overlay` を追加（goesm PR #3、main にマージ済み）。go/packages の `Overlay` をそのまま使うので、モジュール・パッケージ解決は引き続き go コマンドの仕事です。gosfc は Go AST にも go/packages にも依存しません。

## 6. テンプレートバインディング

`runtime/bridge.js` が `GosfcSetup()` をコンポーネントインスタンスごとに 1 回呼び、各バインディングを Vue の `computed` として公開します。

* Go のコードが変更するのは普通の Go 変数で、Vue はそれを観測できません。そこでバインディング経由で Go の関数を呼ぶ（イベントハンドラ、テンプレート内の呼び出し）たびにインスタンスのバージョンを進め、全バインディングが Go から値を読み直します。Vue 自身のリアクティビティとスケジューラーだけを使い、別のレンダラーやスケジューラーはありません。
* 値は goesm の `toJS` でテンプレート向けに変換します（Go 文字列 → JS 文字列、スライス → 配列、struct → オブジェクト）。これはスナップショットで、JS 側で書き換えても Go の状態は変わりません。
* Go 関数は宣言された引数の数だけ受け取ります。`@click="Increment"` に渡る DOM イベントは `func Increment()` には渡りません。string 引数は JS 文字列から Go 文字列へ変換します。ブロッキングする Go 関数（Promise を返す）は解決後に更新します。

## 7. ソースマップと診断

```
.vue ──//line──> synthetic Go ──goesm──> TypeScript ──Vite(oxc)──> JS ──Rolldown──> bundle
       位置は //line で .vue のまま   map: TS → .vue / .go      Vite が各段の map を合成
.vue ──MagicString──> 置き換え後の .vue ──plugin-vue──> JS      （template / glue 側）
```

* Go の診断（構文・型・インポート・goesm の lowering 制約）は最初から `.vue` の位置で出ます。Vite / Astro のエラーには `src/features/cart/Summary.vue:17:21: cannot use "x" ... [go/types]` とコードフレーム付きで渡します。
* 生成物のマップは goesm が作る TS→Go のマップ（ソースは `.vue` と `.go`）を Vite の load フックで返すだけで、合成は Vite / Rolldown に任せます。テストで、バンドル中の `Total(items)` が `Summary.vue:17`、`item.Price * item.Quantity` が `price.go:7` に戻ることを確認しています。
* dev SSR で Go のパニックが起きると、スタックトレースは Vite の `ssrFixStacktrace` を通して `TmpPanic.vue:6` を指します（テスト済み）。

## 8. HMR

独自の HMR ランタイムはありません。判定と更新は `@vitejs/plugin-vue` と Vite のものです。

* plugin-vue は HMR 時にファイルを読み直して前後のディスクリプターを比べます。gosfc は `handleHotUpdate` で HMR コンテキストの `read()` を差し替え、plugin-vue にはコンパイル後の SFC を見せます。その結果、テンプレートだけの変更は再レンダリング（Go の状態は残る）、Go ブロックの変更はコンポーネントのリロード（Go を再実行）になります。
* バインディングが変わらない Go の変更でもスクリプトが変わるよう、glue には lowering 後のコードのハッシュを `useGo` の引数として入れています（plugin-vue はスクリプトを AST で比べるのでコメントでは足りません）。
* `.go` ファイルの変更は、そのパッケージを使う `.vue` を無効化してリロードします。`addWatchFile` も登録しているので、HMR を切った開発サーバーや `vite build --watch` でも再コンパイルされます。
* 生成モジュールは内容が変わった時だけ Vite のモジュールグラフで無効化し、Vite が付ける `?t=` で新しい版が読み込まれます。

## 9. Astro

`@gosfc/astro` は `@astrojs/vue`（まだ無ければ）と `@gosfc/vite` を設定するだけです。Go ブロックを持つコンポーネントは Astro から見て普通の Vue コンポーネントで、`client:*` なしなら Astro の SSR で静的 HTML に、`client:load` なら同じ SSR HTML をハイドレートするアイランドになります。Go native SSR のような別のレンダラーはなく、SSR とクライアントは同じ lowering 済みのモジュールを実行します。

## 10. セキュリティ

* gosfc にプラグインや拡張の仕組みはありません。Go の依存をインポートしても、それがコンパイラの中で実行されることはありません。
* 実行されるのは go.mod の tool ディレクティブで固定され、go.sum で検証された `gosfc` と `goesm` だけです。goesm は `go list` を実行するので、go コマンドの信頼境界（環境変数、`go.work`、GOPROXY からの取得）をそのまま引き継ぎます。
* Go のソースはソースマップの `sourcesContent` と goesm のパニックメッセージに含まれます。公開するバンドルのマップにはソースが入ります。
* テンプレート側の値はスナップショットなので、テンプレートから Go の状態を直接書き換える経路はありません。

## 11. 未実装・未決事項

未実装：

* emits / slots を Go から扱う方法。props は §4 の `type Props` で受け取れますが、setup 時のスナップショットで、変更には追従しません。
* `gosfc fmt`（§12）、language server、VS Code extension。
* メソッド、ジェネリック関数を Go ブロック内で宣言すること（Go パッケージに置く必要がある）。
* ゴルーチンやタイマーなど、バインディング経由の呼び出し以外で起きた Go の状態の変更をテンプレートに反映すること。
* テンプレートから Go の値を書き換えること（`v-model` など）。
* テンプレートバインディングでの JS 値 ⇔ Go 値の変換は goesm の `toJS` と string 引数のみ。struct・スライスを引数に取る Go 関数をテンプレートから呼ぶ場合の変換はありません。goesm の呼び出し ABI は Go から JavaScript を呼ぶ方向の `//goesm:import` だけです。

未決事項：

* `.go` の HMR は依存するコンポーネントをリロードします。パッケージのモジュール単位で差し替えることはしていません。
* 開発サーバー起動直後の最初の HMR は、テンプレートだけの変更でもリロードになります。plugin-vue が最初の transform のときにディスクから生の `.vue` を読んで HMR 用のキャッシュに入れるためで、2 回目以降は §8 のとおり動きます。plugin-vue の `compiler` オプションで `parse` を包めば解消できますが、plugin-vue の設定に手を入れることになるので保留しています。
* HMR コンテキストの `read()` の差し替えは、Vite が `handleHotUpdate` のプラグイン間で同じコンテキストを渡すことに依存しています。plugin-vue 側に「スクリプトの前処理」を差し込む公式の入口があればそちらに移すべきです。
* `go:` specifier と `@goesm/runtime` を Vite で解決する処理は gosfc のプラグインにあります。goesm の ESM 接続の責務と考えれば、`@goesm/vite` のような形で goesm 側に移すのが自然です。
* コンポーネントごとに goesm を 1 回起動し、依存パッケージも毎回 lowering します。キャッシュや常駐プロセスによる高速化はまだありません。

## 12. フォーマッターとエディター統合の方針

* **フォーマッター**：`gofmt` 相当は `go/format` を使います。`go/format.Source` は「宣言の列」や「文の列」も整形できるので、`internal/synth` のトップレベル分割を使ってインポート群・宣言・文をそれぞれ `go/format` に通し、元の空行で繋ぎ直せば Go ブロックだけを整形できます。`gosfc fmt` はそれを `.vue` の該当範囲に書き戻すだけにし、テンプレート / スタイルは Prettier や Vue Language Tools に任せます。
* **language server**：`.vue` の Go ブロックから、ここで使っている synthetic Go をそのまま仮想の Go ドキュメントにし、gopls にオーバーレイとして渡します（gopls も go/packages のオーバーレイを使う）。`//line` ディレクティブがあるので gopls の診断・位置は `.vue` の座標に戻せます。completion・hover・definition・references・rename・code action・import completion は gopls のものを中継するだけにし、gosfc 独自の Go 補完は作りません。テンプレート / スタイルは Vue Language Tools の担当のままにして、`.vue` を 2 つの language server で分担します。VS Code extension は薄い LSP クライアントにします。
* **テンプレート ↔ Go**：テンプレートの識別子と Go のバインディングの対応は、glue（`const total = __gosfc.binding("total")`）と synthetic Go のルックアップ（`case "total": return total`）の両方に現れます。Vue Language Tools が glue の `total` を辿れれば、その位置を synthetic Go 経由で gopls の定義に繋ぐことで definition / rename を双方向にできます。この橋渡しはまだ設計だけです。
