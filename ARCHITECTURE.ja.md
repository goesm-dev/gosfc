# gosfc architecture

[English](ARCHITECTURE.md) | 日本語

gosfc は、Vue SFC の `<script setup lang="go">` と、`.astro` ファイルの Go のフロントマター（`---go`）と `<script lang="go">` を本物の Go として扱うための薄い統合レイヤーです。
Go のコンパイルは goesm、SFC とテンプレートは Vue tooling、`.astro` のテンプレートとページと SSR は Astro、ビルドは Vite / Rolldown が担当します。gosfc はそれらをつなぐことだけをします。下の図は `.vue` ファイルの流れで、`.astro` ファイルは §9 で説明します。

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
| gosfc | `.vue` の Go ブロックと `.astro` の Go のフロントマター・`<script lang="go">` の検出、synthetic Go の構築、goesm 呼び出し、テンプレートバインディングの公開、位置情報の維持、Vite プラグイン、Astro インテグレーション | Go のパース / 型検査 / モジュール・パッケージ解決 / lowering、テンプレート・スタイルのコンパイル、バンドル、SSR |
| goesm | Go パッケージグラフ、Go Modules、構文解析、型検査、Go 意味論、TypeScript への lowering、TS→Go のソースマップ | Vue / SFC / Astro のこと |
| Vue tooling | SFC のパース、テンプレートのコンパイル、scoped CSS、HMR の判定 | Go |
| Vite / Rolldown | 開発サーバー、TS→JS、バンドル、ソースマップの合成 | Go、SFC |
| Astro | ページ、SSR、SSG、アイランド、`client:*` | Go、SFC の中身 |

## 2. リポジトリ構成

```
cmd/gosfc/          Go 側の CLI（`gosfc synth`）。アプリの go.mod に tool として入る
vue/, astro/        アプリが使う Go のパッケージ。vue はコンポーネントのリアクティビティ・フック・emit、
                    astro は Astro のグローバルとエンドポイント・ミドルウェアのコンテキスト
internal/synth/     <script setup lang="go"> と .astro の Go → synthetic Go（go/scanner のみ使用）
packages/vite/      @gosfc/vite: Vite plugin。src/compile.js が SFC と .astro の変換の中心、
                    src/program.js がアプリの Go を環境ごとに 1 つの goesm プログラムにまとめる、
                    src/goesm.js が goesm との唯一の境界、runtime/bridge.js が template binding、
                    runtime/astro.js が Go のフロントマターの binding、runtime/convert.js が両者のバインディングの値と props、
                    src/language.js（vue-language-plugin.cjs）が vue-tsc から見た Go のコンポーネントの型（§13）、
                    src/blocking.js が Vue のコンポーネントが待てない所でブロックする Go の検出（§6）、
                    runtime/handles.js がテンプレートに見せる Go のオブジェクト（§6）、src/index.d.ts がパッケージの型
packages/astro/     @gosfc/astro: @gosfc/vite（と、インストールされていれば @astrojs/vue）を設定するだけの integration。
                    @gosfc/vite の Vue の言語プラグインも再エクスポートする。src/index.d.ts がその型
examples/astro/     PoC（Astro → Vue → gosfc → goesm → Vite）と Go で書いた .astro のページ
examples/astro-go/  Vue をインストールせず、Go を .astro ファイルだけに書く例（Go で書いたエンドポイントとミドルウェアも含む）
tests/              Node のテスト（Astro build、Vite build / SSR / HMR、診断）と fixture
```

`core` を別パッケージにはしていません。`packages/vite/src/compile.js` が core の役割を持ち、Vite プラグインと Vue の言語プラグイン（§13）が同じパッケージの中から使います。フォーマッターや language server が同じ処理を必要とした時点で切り出します。

## 3. 処理の流れ

1. `@gosfc/vite`（`enforce: "pre"`）は `.vue` のメインリクエストのうち `<script setup lang="go">` を含むものだけを変換します。それ以外の `.vue`（`lang="ts"`、素の `<script setup>`）には触れず、`@vitejs/plugin-vue` がそのまま処理します。
2. `@vue/compiler-sfc` の `parse` でディスクリプターを得ます。Vue のパーサーは自作しません。
3. Go ブロックを `go tool gosfc synth` に渡し、synthetic Go とトップレベルのバインディングの一覧を得ます（§4）。
4. synthetic Go を、アプリのほかのすべての Go ブロックの synthetic Go と、JavaScript が `go:` でインポートするパッケージと一緒に `go tool goesm emit-ts -overlay` に渡します（§5）。1 つの Go モジュールの Go は、環境ごとに 1 つの goesm プログラムです（`packages/vite/src/program.js`）。goesm がパッケージに出すコードはプログラム全体で決まるので、ブラウザのプログラムにはサーバーだけで動く Go（Go のフロントマター、`.astro` のフロントマターと `serverOnly` オプションが示すファイルの `go:` インポート）を入れません。成功すればパッケージごとの TypeScript とソースマップ、失敗すれば `.vue` 位置の診断が返ります。
5. Go ブロックだけを次の `<script setup lang="ts">` に置き換えます。テンプレート、`<style>`、`<style scoped>`、素の `<script>` は 1 バイトも変えません。行数も保つので、後ろにあるブロックの位置はずれません。

   ```ts
   import { GosfcSetup as __gosfc_setup } from "go:example.com/app/src/features/cart/_gosfc/summary_vue";
   import { useGo as __gosfc_useGo } from "gosfc:bridge.js";
   const __gosfc = __gosfc_useGo(__gosfc_setup, "7a4085be24760462");
   const items = __gosfc.binding("items");
   const total = __gosfc.binding("total");
   ```

6. 以降は普通の Vue SFC として `@vitejs/plugin-vue` がテンプレート / スタイルをコンパイルします。`go:` のインポートはプラグインが goesm の出力（仮想モジュール、id は `gosfc:goesm/<import path>.ts`、ランタイムは `gosfc:goesm/@goesm/runtime/*.ts`）に解決し、TypeScript は Vite 自身の変換に任せます。goesm がパッケージに出力するコードはプログラム全体に依存します（どのメソッドがインターフェース経由で呼ばれるか、関数値がブロックしうるか）。そのためコンポーネントごとに別のプログラムにすると、共有するパッケージをプログラムごとに出力して実行することになり、パッケージの変数もプログラムごとに別になってしまいます。1 つのプログラムなら各パッケージを 1 回だけ変換するので、Go のバイナリと同じく、パッケージレベルの `vue.Ref` はどのコンポーネントにとっても 1 つの Ref です（Vite のルートに複数の Go モジュールがある場合、2 つ目以降のプログラムは id に番号を付けます）。
7. `.vue` 以外のモジュール（`.js`、`.ts`、`.astro`）が `go:<import path>` をインポートしている場合、そのパッケージは、インポートしたファイルが属する Go モジュールのプログラムのエントリーになります。`.go` ファイルはそのモジュールの watch 対象になり、編集するとモジュールが読み直されます。
8. プログラムは、Vite のルートをスキャンして見つかったもの（`.vue` と `.astro` の Go ブロック、JavaScript のモジュールの `go:` のインポート）から始めます。隠しディレクトリ、`node_modules`、ビルドの出力先、Cargo の `target` のように `CACHEDIR.TAG` のあるディレクトリは飛ばします。こうすると最初のコンパイルからアプリ全体になり、不完全なプログラムのモジュールを配信することがありません。Go がコンパイルできないブロックはプログラムから外し、そのファイルだけのエラーとして報告します。`.go` ファイルのエラーはすべてのブロックのエラーになります。

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
* 並び：const / type 宣言とメソッドはパッケージレベル。setup 関数の中は、各 `func F(...)` のための `var F func(...)` → 残りを元の順で。`func F() {...}` は `F=func() {...}` に置き換えます。`F=func` は `func F` と同じ長さなので列もずれません。関数同士の相互参照・再帰ができ、本体は上から順に実行されます（Vue の `setup()` と同じ）。宣言より前で関数を呼ぶと nil func のパニックになります。
* goesm の `//goesm:import` ディレクティブが前にある `var` と本体のない関数は、Vue コンポーネントや TypeScript の関数などの ES モジュールの値を取り込む宣言です。これらはディレクティブとともにパッケージレベルに置きます。ディレクティブは宣言の直前の行に置き、その前の `//line` ディレクティブで宣言自身の位置が保たれるようにします。間に `//line` を挟むと、goesm が読むドキュメントコメントが途切れるからです。goesm は相対パスのモジュールを `//line` が指す `.vue` ファイルから解決し、`@gosfc/vite` はそのファイルの import を絶対パスに書き換えます。Vite はそれをほかのモジュールと同じように読み込みます。`js.Value` のバインディングはテンプレートでは保持している値そのものになるので、コンポーネントは `<Badge />` として使えます。
* 返り値のルックアップ関数がテンプレートバインディングの入口です。`GosfcSetup` はコンポーネントのパッケージがエクスポートする関数なので、ルックアップ関数の引数と戻り値は goesm の [JS 呼び出し ABI](https://github.com/goesm-dev/goesm/blob/main/docs/js-exports.ja.md) が変換します。各値は動的な型に従って変換され、JavaScript に渡ります。ルックアップが返すのはテンプレートが使うバインディングだけです。`@gosfc/vite` はテンプレートを `@vue/compiler-sfc` でコンパイルし、そこから setup のスコープを読む名前（`_ctx.x`、解決するコンポーネントとディレクティブ、静的な `ref="..."` の値、`<style>` の `v-bind()` の識別子）を `used` として synth に渡します。glue もそれだけを宣言するので、goesm は残りを削ったりインライン化したりできます（テンプレートがコンパイルできない場合や HTML でない場合は全バインディングを使います）。残りも `_ = x` で参照するので、テンプレートからしか使わない変数も Go の「declared and not used」にはなりません。未使用のインポートは通常どおり Go のエラーです。
* パッケージは `.vue` と同じディレクトリの下の、ディスクには存在しない `_gosfc/<name>_vue/` に置きます（goesm のオーバーレイで渡す）。そのためインポートパスは `<module>/<dir>/_gosfc/<name>_vue` になり、`internal/` の可視性も `.vue` の場所を基準に普通の Go と同じく働きます。ユーザーのソースツリーには何も書きません。
* ブロックが `type Props struct {...}` を宣言すると、その型はパッケージレベルに置かれ、setup 関数は `func GosfcSetup(props Props)` になります。さらに `func GosfcProps() any { return Props{} }` を生成します。この値は、goesm の ABI がフィールドに付ける名前（`js` タグ、なければ JSON 名）をキーとする普通のオブジェクトとして JavaScript に渡ります。glue はフィールドを Vue の props として宣言し（`defineProps(propOptions(GosfcProps, [...], defaults))`。名前は synth が `propKeys` として返すキーの先頭の大文字を小文字にしたもの。ブリッジの `propOptions` は、ゼロ値が boolean のフィールドを `Boolean` の prop にして、値のない属性を Vue が `true` にするようにし、`default` タグのあるフィールドにはその値を標準値として付けます）、ブリッジはその props（と Go のフィールド名で書いた属性）でこのオブジェクトのコピーを埋めて setup 関数に渡し、setup 関数の ABI がそれを Props に変換します。ほかの属性（`class`、`style`、リスナー）は、普通の Vue のコンポーネントと同じくルート要素に落ちます。Props のフィールドの型には、インポートした型、組み込み型、ブロックで宣言した型（これもパッケージレベルの型）を使えます。
* gosfc は Go をパースしません。`internal/synth` は標準の `go/scanner` でトークン化し、括弧の深さとスキャナーが挿入するセミコロンだけでトップレベルの区切りを決め、各要素の先頭トークン（`import` / `func 名前` / `var` / `const` / `type` / `a, b :=`）を見て分類と名前の取得をします。構文・型のエラーは全て Go ツールチェーンが報告します。
* gosfc が自分で出す診断は Go の外の制約だけです：ジェネリック関数、インポートの位置、JavaScript の予約語と衝突するバインディング名（`new`、`class` など）、`<script lang="go">`（setup なし）。
* `@gosfc/vite` は、テンプレートが読むのに何も宣言していない名前も報告します。`prefixIdentifiers` でコンパイルしたテンプレートは、コンポーネントの名前を `_ctx.x` の単純式として、それぞれテンプレート上の位置付きで読みます（`v-for`・`v-slot`・`$event` の名前と、Vue が許すグローバルは `_ctx` から読みません）。バインディング、宣言した prop、`$` プロパティ、普通の `<script>` のトップレベルの名前のどれでもない名前は、その位置のエラーです。

## 5. goesm との API 境界

境界は `packages/vite/src/goesm.js` の 1 ファイルだけです。gosfc は goesm の CLI を、アプリの go.mod の tool ディレクティブで固定された版で呼びます（`go tool -n goesm` でビルド済みバイナリを得る）。

```
goesm emit-ts -overlay <overlay.json> -o <dir> ./<rel>/_gosfc/<name>_vue ... <go: の import path> ...
  入力:  overlay.json は go command 標準の -overlay 形式 {"Replace": {"/abs/.../setup.go": "<一時ファイル>", ...}}
         指定したパッケージはすべて 1 つのプログラムのエントリーになる（goesm v0.0.1-beta.5 以降）
  出力:  <dir>/<import path>.ts (+ .ts.map)      Go package ごとに 1 module、map は .vue / .go を指す
         <dir>/@goesm/runtime/*.ts               goesm runtime（module 間と runtime への import は相対 `.ts` 指定）
  失敗:  exit 1、stderr に "<file>:<line>:<col>: <message> [<layer>]"（layer は go/parser・go/types・go list・goesm lowering）
```

概念上の `Compile(source, context) → { code, map, bindings, diagnostics }` との対応：source = オーバーレイの synthetic Go、context = モジュールディレクトリとパッケージパターン、code / map = 出力モジュール、diagnostics = stderr。bindings は gosfc 自身が synthetic Go を作る時点で知っているので goesm には求めていません。

goesm 側の変更はこの PoC のために 1 つだけです：`build` / `emit-ts` に `-overlay` を追加（goesm PR #3、main にマージ済み）。go/packages の `Overlay` をそのまま使うので、モジュール・パッケージ解決は引き続き go コマンドの仕事です。gosfc は Go AST にも go/packages にも依存しません。

## 6. テンプレートバインディング

`runtime/bridge.js` が `GosfcSetup()` をコンポーネントインスタンスごとに 1 回呼び、各バインディングを Vue の `computed` として公開します。

* Go のコードが変更するのは普通の Go 変数で、Vue はそれを観測できません。そこでバインディング経由で Go の関数を呼ぶ（イベントハンドラ、テンプレート内の呼び出し）たびにインスタンスのバージョンを進め、全バインディングが Go から値を読み直します。Vue 自身のリアクティビティとスケジューラーだけを使い、別のレンダラーやスケジューラーはありません。
* 値は goesm の JS 呼び出し ABI でテンプレート向けに変換します（Go 文字列 → JS 文字列、スライス → 配列、struct → オブジェクト、関数 → 関数）。これはスナップショットで、JS 側で書き換えても Go の状態は変わりません。
* メソッドを持つ struct 型へのポインタを、ABI は Go のオブジェクトのまま（ハンドルとして）渡します。そのフィールドは Go の名前のまま Go 自身の表現を持っています。そこで `runtime/handles.js` は、値の中の各ハンドルの代わりにビューをテンプレートに見せます。ビューは、struct 型の `goToJS` が変換するフィールド（`js` タグか `json` タグの名前。別のハンドルを持つフィールドは、読んだときにビューを作る）を持つ普通のオブジェクトで、列挙されないエクスポートされたメソッドはハンドルのメソッドを呼び、ほかの呼び出しと同じく変更を知らせます。Go に戻したビュー（Go 関数の引数、`vue.Ref` の `Set`）はハンドルに戻るので、Go には自分のオブジェクトが届きます。goesm のランタイムの `classTypes`、`Kind`、`goToJS` を使います。
* Vue は setup を同期的に実行し、レンダーは呼び出しが返したものを表示するので、どちらも Promise を待てません。`computed` も待てません。Vue は読まれたときに computed を計算し、ゲッターが返るまでに読んだ ref だけを追跡します。そのため、ゲッターがブロックする `vue.Computed` は前回の計算の値（最初と、サーバーでのレンダーではゼロ値）を返し、ゲッターが待った後に読むものを追跡しません。`src/blocking.js` はブロックのパッケージの lower した TypeScript を読み（`async` の関数があるときだけ）、async の `GosfcSetup` と、補間か `v-on` 以外のディレクティブから呼ばれるバインディングの async のクロージャをコンパイルエラーにします。ゲッターが async の関数か、async の関数を呼ぶもの（メソッド値）である `vue.NewComputed` の呼び出しもコンパイルエラーにします。ブロックのパッケージと、ブロックが直接または間接に import するモジュールのパッケージを読みます。関数値を通って `NewComputed` に届くゲッターはここでは見えません。その Computed は、ゲッターが終わる前に Vue に返ったことを `Get` で見つけて panic します。エラーには、ブロックする呼び出しの連なりを示します。v0.0.1-beta.9 より後の goesm はその理由を書き出します（`goesm emit-ts -blocking`、`<package>.blocking.json`）。連なりは待つ操作まで続き、標準ライブラリの中も、インターフェースのメソッドや関数値の呼び出しもたどります。そうした呼び出しでは、届きうるもののうちブロックするメソッドか関数を goesm が挙げます。gosfc は各ステップの行を示し、行から呼び出し先が分からないところには goesm の説明を添えます。それより古い goesm では、各関数の最初の `await` を、そのモジュールと import するモジュールの中でたどり、ソースマップで Go の位置に戻します。標準ライブラリの呼び出しか、モジュールから見えない呼び出し（インターフェース経由のメソッド、関数値）で止まります。
* `vue.Ref` や `vue.Computed`（`vue` パッケージ。目印のメソッド `GosfcRef` を持つ goesm のハンドル）を持つバインディングは `Get()` の値として読みます。Ref の `Get` は Vue の `shallowRef` を読み、`Set` はそれをトリガーします。そのため、誰が `Set` を呼んでも、バインディングの computed、レンダー（テンプレートから呼んだ Go 関数）、ウォッチャーが Ref を追跡します。バインディングの computed は書き込み可能で、`v-model` と `ref="..."` は `Set` を呼びます。ただし、Ref が既に持っている値と同じなら呼びません。
* Vue のレンダー中や、レンダーした結果でページをパッチしている間（Vue がパッチのたびに呼ぶ関数 ref、`:ref="(el) => SetEl(el)"`）に呼ばれた Go 関数ではバージョンを進めません。進めると、レンダーが読んだものが無効になり、レンダーとその関数の呼び出しが際限なく繰り返されるためです。Vue はパッチの間カレントインスタンスを設定しないので、ブリッジはコンポーネントの `onBeforeMount` / `onBeforeUpdate` フックから `onMounted` / `onUpdated` フックまで（またはタスクの終わりまで）をパッチの間とみなします。
* `type Props` がある場合、ブリッジは属性を監視し、新しい props をルックアップの `gosfc:props` セッターで渡してから、バージョンと props のバージョンを進めます。setup 中に `vue` パッケージで作ったウォッチャーと computed は、この props のバージョンも読みます。
* `vue.Emitter` は setup 中にインスタンスの `emit` を取っておきます。
* glue の最後は `defineExpose(__gosfc.exposed)` です。ブリッジがインスタンスに空のオブジェクトを渡し、`vue.Expose` が名前ごとにゲッターを足します。ゲッターはバインディングの値と同じように値を見せます（関数は呼ばれたら変更を知らせます）。synth は `vue.Expose` に文字列リテラルで渡された名前を `exposes` として返し、§13 のビューが使います。
* Go 関数は宣言された引数の数だけ受け取ります。`@click="Increment"` に渡る DOM イベントは `func Increment()` には渡りません。引数は struct やスライスも含めて ABI が変換し、最後の `error` の戻り値は例外として投げられます。ブロッキングする Go 関数（Promise を返す）は解決後に更新します。

## 7. ソースマップと診断

```
.vue ──//line──> synthetic Go ──goesm──> TypeScript ──Vite(oxc)──> JS ──Rolldown──> bundle
       位置は //line で .vue のまま   map: TS → .vue / .go      Vite が各段の map を合成
.vue ──MagicString──> 置き換え後の .vue ──plugin-vue──> JS      （template / glue 側）
```

* Go の診断（構文・型・インポート・goesm の lowering 制約）は最初から `.vue` の位置で出ます。`.astro` の Go の診断は `.astro` の位置で出ます。Vite / Astro のエラーには `src/features/cart/Summary.vue:17:21: cannot use "x" ... [go/types]` とコードフレーム付きで渡します。
* 生成物のマップは goesm が作る TS→Go のマップ（ソースは `.vue` と `.go`）を Vite の load フックで返すだけで、合成は Vite / Rolldown に任せます。テストで、バンドル中の `Total(...)` が `Summary.vue:17`、`item.Price * item.Quantity` が `price.go:7` に戻ることを確認しています。
* dev SSR で Go のパニックが起きると、スタックトレースは Vite の `ssrFixStacktrace` を通して `TmpPanic.vue:6` を指します（テスト済み）。

## 8. HMR

独自の HMR ランタイムはありません。判定と更新は `@vitejs/plugin-vue` と Vite のものです。

* plugin-vue は HMR 時にファイルを読み直して前後のディスクリプターを比べます。gosfc は `handleHotUpdate` で HMR コンテキストの `read()` を差し替え、plugin-vue にはコンパイル後の SFC を見せます。その結果、テンプレートだけの変更は再レンダリング（Go の状態は残る）、Go ブロックの変更はコンポーネントのリロード（Go を再実行）になります。テンプレートの変更で使うバインディングが変わると glue も変わるので、コンポーネントはリロードされます。
* バインディングが変わらない Go の変更でもスクリプトが変わるよう、glue にはそのコンポーネントのパッケージの lowering 後のコードのハッシュを `useGo` の引数として入れています（plugin-vue はスクリプトを AST で比べるのでコメントでは足りません）。
* `.go` ファイルを変更するとプログラムを再コンパイルし、変わったモジュールは Vite の HMR でそれをインポートするコンポーネントに伝わってリロードされます。そのファイルをインポートするパッケージを持つ `.vue` も無効化します。`addWatchFile` も登録しているので、HMR を切った開発サーバーや `vite build --watch` でも再コンパイルされます。
* 生成モジュールは内容が変わった時だけ Vite のモジュールグラフで無効化し、Vite が付ける `?t=` で新しい版が読み込まれます。コンポーネントの編集で、ページがすでに実行している、そのコンポーネント自身のパッケージ以外のモジュールが変わった場合（プログラムの事実が変わった場合）は、ページをリロードします。それらのモジュールは古いプログラムの状態を持っているためです。
* `.astro` については、Astro 自身の HMR が前後のソースを比べ、スタイルだけが変わった場合はスタイルだけを更新します。gosfc は同じ方法で Astro に書き換え後のソースを見せます。`.go` の変更は、そのパッケージを使う `.astro` と `<script lang="go">` のモジュールを無効化します。
* watch するのはユーザーの `.go` ファイルだけです。GOROOT とモジュールキャッシュのファイル、goesm による標準パッケージの置き換えは watch しません。

## 9. Astro

`@gosfc/astro` は `@gosfc/vite` を設定し、プロジェクトに `@astrojs/vue` がインストールされていて設定に無ければ、それも追加するだけです。Go を `.astro` ファイルだけに書くプロジェクトには、Vue も `@astrojs/vue` も要りません。`vue` と `@astrojs/vue` は任意のピア依存です。Go ブロックを持つコンポーネントは Astro から見て普通の Vue コンポーネントで、`client:*` なしなら Astro の SSR で静的 HTML に、`client:load` なら同じ SSR HTML をハイドレートするアイランドになります。Go native SSR のような別のレンダラーはなく、SSR とクライアントは同じ lowering 済みのモジュールを実行します。

### .astro ファイルの Go

フロントマターが `---go` で始まる `.astro` ファイルと、`<script lang="go">` を含む `.astro` ファイルは、プラグインの `transform` ではなく `load` フックで書き換えます。Astro 自身のプラグインは `.astro` を `transform` でコンパイルし、そのプラグインも `enforce: "pre"` なので gosfc より先に動くことがあります。また Astro は、`?astro&type=script` やスタイルのサブリクエストのためのソースをプラグインコンテナーの `load` で読みます。`load` で書き換えることで、Astro が見るのは常に TypeScript のフロントマターと普通の `<script>` 要素になります。

* **フロントマター。** `compileAstro` は Go のフロントマターを `.vue` のブロックと同じ経路に通します。`gosfc synth` の後に `goesm emit-ts -overlay` を実行し、synthetic なパッケージはファイルの隣の `_gosfc/<file>_astro` に置きます。synth には JavaScript のインポートを許可すると伝えます。パスが相対パスか絶対パスか `@scope/...` であるか、`:` を含む spec は JavaScript のインポートです。判定は `synth.IsJSImport` が行います。synth はその spec をオフセットを保ったまま Go のファイルから空白で消し、JavaScript のインポートとして返します。フロントマターは同じ行数の TypeScript に置き換えるので、テンプレートの位置はずれません。

  ```ts
  ---
  import Line from "../features/cart/Line.astro";
  import { GosfcSetup as __gosfc_setup } from "gosfc:goesm/example.com/app/src/pages/_gosfc/go_astro.<hash>.ts";
  import { runGo as __gosfc_run } from "gosfc:astro.js";
  const __gosfc = await __gosfc_run(__gosfc_setup, null, Astro.props);
  const total = __gosfc("total");
  ---
  ```

  `runtime/astro.js` はレンダリングごとに setup を 1 回実行し、ブロックする setup はその完了を待ちます。`Props` には Vue のブリッジと同じ規則（`runtime/convert.js`）で `Astro.props` を入れ、値は同じ ABI で変換されます。Astro はテンプレートを 1 回しかレンダリングしないので、リアクティビティはありません。パッケージのインポートには `go:` ではなく内容から決まる仮想 ID を使います。`.vue` 以外のモジュールから `go:` でインポートすると、パッケージが overlay なしでコンパイルされるためです。

  synth にはブロックがフロントマターであること（`astro`）を伝えます。ブロックが識別子 `Astro` を読むと、setup 関数は最後の引数として Astro のグローバルを受け取り（ABI がそのまま渡す `js.Value`）、最初に `Astro := astro.Context{Value: ...}`（このモジュールのパッケージ `astro`）を宣言します。フロントマターは `Astro` を渡し、`Astro.Respond` がグローバルの `Symbol.for("gosfc.response")` に残した Response を返します。ページのエクスポートは Go の名前で書きます（`AstroExport`）。`func GetStaticPaths` はパッケージレベルで宣言され、goesm がエクスポートし、フロントマターが `getStaticPaths` として再エクスポートします。リテラルの `const Prerender` / `const Partial` は `export const prerender = ...` になります。Astro は `prerender` をプラグインが動く前にディスク上のファイルから読むので、`@gosfc/astro` は `astro:route:setup` フックで Go のフロントマターから `route.prerender` も設定します（`goPrerender`）。
* **Go で書いたエンドポイントとミドルウェア。** `@gosfc/astro` のオプション `routes` と `middleware` は Go のパッケージを指定します。インテグレーションはそれぞれについて、パッケージを再エクスポートするモジュール（`export * from "go:..."`、`GetStaticPaths` を `getStaticPaths` に、`OnRequest` を `onRequest` に）を `.astro/` の自分のディレクトリ（`createCodegenDir`）に書き、`injectRoute` か `addMiddleware` に渡します。Astro はルートのファイルを読むので、仮想モジュールではなくファイルにしています。その `go:` インポートは、プラグインがほかと同じくプロジェクトの Go モジュールでコンパイルします。
* **クライアントスクリプト。** `<script lang="go">` はそれぞれ `<script>import "gosfc:astro-script/<n>/<file>.js"</script>` になり、Astro からは処理対象の普通のスクリプトに見えます。Astro はクライアントを専用の Vite の環境でビルドするので、ID にファイルと番号を含めています。この ID を読み込むと、`.astro` ファイルを読み直し、n 番目の Go のスクリプトをプログラムのほかの部分と一緒にコンパイルし、`import { GosfcSetup } from "<id>"; GosfcSetup();` を返します。SSR の環境では Astro がスクリプトを読み込まず、クライアントの環境では `.astro` のモジュールを書き換えません。クライアントの環境の `.astro` のモジュールは Astro がスタブに置き換えるためです。
* Vite の依存関係スキャナーは `.astro` の `<script>` 要素を TypeScript として読みます。Go を含むファイルについては、代わりに Go のフロントマターと他のスクリプトの JavaScript のインポートを見せます。

## 10. セキュリティ

* gosfc にプラグインや拡張の仕組みはありません。Go の依存をインポートしても、それがコンパイラの中で実行されることはありません。
* 実行されるのは go.mod の tool ディレクティブで固定され、go.sum で検証された `gosfc` と `goesm` だけです。goesm は `go list` を実行するので、go コマンドの信頼境界（環境変数、`go.work`、GOPROXY からの取得）をそのまま引き継ぎます。
* Go のソースはソースマップの `sourcesContent` と goesm のパニックメッセージに含まれます。公開するバンドルのマップにはソースが入ります。
* テンプレート側の値はスナップショットなので、テンプレートから Go の状態を直接書き換える経路はありません。

## 11. 未実装・未決事項

未実装：

* slots を Go から扱う方法。
* `gosfc fmt`（§12）、language server、VS Code extension。
* ジェネリック関数を Go ブロック内で宣言すること（Go パッケージに置く必要がある）。
* ゴルーチンやタイマーなど、バインディング経由の呼び出し以外で起きた普通の Go 変数（`vue.Ref` ではないもの）の変更をテンプレートに反映すること。
* 普通の Go 変数への `v-model`（`vue.Ref` には使えます）。

未決事項：

* `.go` の HMR は依存するコンポーネントをリロードします。パッケージのモジュール単位で差し替えることはしていません。
* 開発サーバー起動直後の最初の HMR は、テンプレートだけの変更でもリロードになります。plugin-vue が最初の transform のときにディスクから生の `.vue` を読んで HMR 用のキャッシュに入れるためで、2 回目以降は §8 のとおり動きます。plugin-vue の `compiler` オプションで `parse` を包めば解消できますが、plugin-vue の設定に手を入れることになるので保留しています。
* HMR コンテキストの `read()` の差し替えは、Vite が `handleHotUpdate` のプラグイン間で同じコンテキストを渡すことに依存しています。plugin-vue 側に「スクリプトの前処理」を差し込む公式の入口があればそちらに移すべきです。
* `go:` specifier を Vite で解決する処理は gosfc のプラグインにあります。goesm の ESM 接続の責務と考えれば、`@goesm/vite` のような形で goesm 側に移すのが自然です。
* コンポーネントごとに goesm を 1 回起動し、依存パッケージも毎回 lowering します。キャッシュや常駐プロセスによる高速化はまだありません。

## 12. フォーマッターとエディター統合の方針

* **フォーマッター**：`gofmt` 相当は `go/format` を使います。`go/format.Source` は「宣言の列」や「文の列」も整形できるので、`internal/synth` のトップレベル分割を使ってインポート群・宣言・文をそれぞれ `go/format` に通し、元の空行で繋ぎ直せば Go ブロックだけを整形できます。`gosfc fmt` はそれを `.vue` の該当範囲に書き戻すだけにし、テンプレート / スタイルは Prettier や Vue Language Tools に任せます。
* **language server**：`.vue` の Go ブロックから、ここで使っている synthetic Go をそのまま仮想の Go ドキュメントにし、gopls にオーバーレイとして渡します（gopls も go/packages のオーバーレイを使う）。`//line` ディレクティブがあるので gopls の診断・位置は `.vue` の座標に戻せます。completion・hover・definition・references・rename・code action・import completion は gopls のものを中継するだけにし、gosfc 独自の Go 補完は作りません。テンプレート / スタイルは Vue Language Tools の担当のままにして、`.vue` を 2 つの language server で分担します。VS Code extension は薄い LSP クライアントにします。
* **テンプレート ↔ Go**：テンプレートの識別子と Go のバインディングの対応は、glue（`const total = __gosfc.binding("total")`）と synthetic Go のルックアップ（`case "total": return total`）の両方に現れます。Vue Language Tools が glue の `total` を辿れれば、その位置を synthetic Go 経由で gopls の定義に繋ぐことで definition / rename を双方向にできます。この橋渡しはまだ設計だけです。

## 13. vue-tsc とエディターから見た型

vue-tsc と Vue のエディター拡張は、TypeScript か JavaScript の `<script setup>` からだけ TypeScript を生成します。Go ブロックからは何も生成しないので、そのコンポーネントを import する TypeScript のコンポーネントは TS2306（"is not a module"）で失敗します。`@gosfc/vite/vue-language-plugin`（`packages/vite/src/language.js`）は `@vue/language-core` のプラグインで、`tsconfig.json` の `vueCompilerOptions.plugins` に書きます。中身は 2 つのプラグインです。

* 言語ツールが `.vue` ファイルを解析する前に（`parseSFC2`、`order: -1`）、Go ブロックのあるファイルを `@vue/compiler-sfc` で解析し、ブロックの中身を、その代わりになる `<script setup lang="ts">`（ビュー）に置き換えます。

  ```ts
  type __gosfc_In = [typeof import("go:example.com/app/src/_gosfc/rating_vue")] extends [{ GosfcSetup(props: infer P): any }] ? P : unknown;
  type __gosfc_Prop<K extends string> = __gosfc_In extends { [k in K]?: infer T } ? T : any;
  type __gosfc_Fields = { "label": __gosfc_Prop<"Label">; "max": __gosfc_Prop<"Max"> };
  type __gosfc_Optional<K extends keyof __gosfc_Fields> = K extends "max" ? true : null extends __gosfc_Fields[K] ? true : [__gosfc_Fields[K]] extends [boolean] ? true : false;
  defineProps<{ [K in keyof __gosfc_Fields as __gosfc_Optional<K> extends true ? K : never]?: __gosfc_Fields[K] } & { [K in keyof __gosfc_Fields as __gosfc_Optional<K> extends true ? never : K]: __gosfc_Fields[K] }>();
  defineEmits<{ "rated": any[] }>();
  let props!: any;
  let Rate!: any;
  ```

  あとは言語ツールが TypeScript のコンポーネントと同じようにコンポーネントを生成し、テンプレートをバインディングに対してチェックします。
* 言語ツールが TypeScript を生成したあとで（`resolveEmbeddedCode`、`order: 1`）、ビューから生成したコードの対応付けを外し、どこも Go のコードに対応しないようにします。ビューのエラーは捨てられ、ホバーやフォーマットは Go ブロックに及びません。

ビューに必要なブロックの情報は gosfc synth が返します（§4）。バインディング、`propKeys`、そして `vue.Emitter()` を代入した変数に渡す文字列リテラルの `emits` です。言語ツールは同期的に動くので、プラグインは `go tool gosfc synth` を `execFileSync` で実行します。実行できないときは、props は `any`、バインディングはテンプレートが読む名前（`templateNames`）になります。props の名前は glue が宣言する名前（`propFields`）です。props の型は goesm のものです。setup 関数は Props を受け取るので、goesm がブロックのパッケージに書き出す宣言ファイル（`emit-ts -dts`）にはフィールドの JavaScript の型があり、`go:` の import の型ファイル（`types.js`）は、各 `.vue` ファイルのブロックのパッケージを glue が import する `go:` specifier で宣言します。Go をコンパイルするまでは、そのモジュールはプレースホルダーの `any`（または未解決で、そのエラーは対応付けのないビューの中で捨てられる）になり、props も `any` になります。gosfc 自身は Go の型を TypeScript の型に対応付けません。

`astro check` は `.vue` ファイルを `@astrojs/vue` を通して読みます。`@astrojs/vue` は props をスクリプトの `defineProps` から読み（Go のコンポーネントの props は `Record<string, any>` になる）、`.vue` ファイル自体はチェックしません。`astro check` にはプラグインがなく、Go のフロントマターは TypeScript として読みます。
