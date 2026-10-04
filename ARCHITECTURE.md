# gosfc architecture

gosfc は、Vue SFC の `<script setup lang="go">` を本物の Go として扱うための薄い統合レイヤーです。
Go のコンパイルは goesm、SFC と template は Vue tooling、build は Vite / Rolldown、ページと SSR は Astro が担当します。gosfc はそれらをつなぐことだけをします。

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
| gosfc | `.vue` の Go block の検出、synthetic Go の構築、goesm 呼び出し、template binding の公開、位置情報の維持、Vite plugin、Astro integration | Go の parse / 型検査 / module・package 解決 / lowering、template・style のコンパイル、bundle、SSR |
| goesm | Go package graph、Go Modules、構文解析、型検査、Go 意味論、TypeScript への lowering、TS→Go の source map | Vue / SFC のこと |
| Vue tooling | SFC parse、template compile、scoped CSS、HMR の判定 | Go |
| Vite / Rolldown | 開発サーバー、TS→JS、bundle、source map の合成 | Go、SFC |
| Astro | ページ、SSR、SSG、islands、`client:*` | Go、SFC の中身 |

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

`core` を別 package にはしていません。今のところ利用者は Vite plugin だけなので、`packages/vite/src/compile.js` が core の役割を持ちます。formatter や language server が同じ処理を必要とした時点で切り出します。

## 3. 処理の流れ

1. `@gosfc/vite`（`enforce: "pre"`）は `.vue` の main request のうち `<script setup lang="go">` を含むものだけを変換します。それ以外の `.vue`（`lang="ts"`、素の `<script setup>`）には触れず、`@vitejs/plugin-vue` がそのまま処理します。
2. `@vue/compiler-sfc` の `parse` で descriptor を得ます。Vue parser は自作しません。
3. Go block を `go tool gosfc synth` に渡し、synthetic Go とトップレベル binding の一覧を得ます（§4）。
4. synthetic Go を `go tool goesm emit-ts -overlay` に渡します（§5）。成功すれば package ごとの TypeScript と source map、失敗すれば `.vue` 位置の診断が返ります。
5. Go block だけを次の `<script setup lang="ts">` に置き換えます。template、`<style>`、`<style scoped>`、素の `<script>` は 1 byte も変えません。行数も保つので、後ろにある block の位置はずれません。

   ```ts
   import { GosfcSetup as __gosfc_setup } from "go:example.com/app/src/features/cart/_gosfc/summary_vue";
   import { useGo as __gosfc_useGo } from "gosfc:bridge.js";
   const __gosfc = __gosfc_useGo(__gosfc_setup, "7a4085be24760462");
   const items = __gosfc.binding("items");
   const total = __gosfc.binding("total");
   ```

6. 以降は普通の Vue SFC として `@vitejs/plugin-vue` が template / style をコンパイルします。`go:` import は plugin が goesm の出力（仮想 module、id は `gosfc:goesm/<import path>.ts`、runtime は `gosfc:goesm/@goesm/runtime/*.ts`。goesm の module 同士は相対 `./x.ts` で import し合うので、plugin はそれを同じ仮想ツリー内で解決する）に解決し、TypeScript は Vite 自身の変換に任せます。
7. `.vue` 以外の module（`.js`、`.ts`、`.astro`）が `go:<import path>` を import している場合は、その module の transform で、import したファイルが属する Go module を基準に `goesm emit-ts <import path>` を実行し、同じ仮想ツリーに登録します。`.go` ファイルはその module の watch 対象になり、編集すると module が読み直されます。

## 4. synthetic Go

`<script setup lang="go">` は Go のソースファイルではなく、Vue の `<script setup>` と同じく「component instance ごとに 1 回実行される本体」です。gosfc はこれを普通の Go ファイルに組み直します。

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

* ユーザーのテキストは全て `//line` directive の後ろにそのまま写します。Go の文法は変えません。go/parser、go/types、goesm の診断と source map は全て `.vue` の位置を指します。生成ファイル自身の位置（`_gosfc/.../setup.go`）が利用者に見えることはありません。
* 並び：const / type 宣言 → 各 `func F(...)` のための `var F func(...)` → 残りを元の順で。`func F() {...}` は `F=func() {...}` に置き換えます。`F=func` は `func F` と同じ長さなので列もずれません。関数同士の相互参照・再帰ができ、本体は上から順に実行されます（Vue の `setup()` と同じ）。宣言より前で関数を呼ぶと nil func の panic になります。
* 返り値の lookup 関数が template binding の入口です。値は `any` に box されるので Go の型 descriptor を保ったまま JS 側に渡ります。全 binding がここで参照されるため、template からしか使わない変数も Go の「declared and not used」にはなりません。未使用 import は通常どおり Go のエラーです。
* package は `.vue` と同じディレクトリの下の、ディスクには存在しない `_gosfc/<name>_vue/` に置きます（goesm の overlay で渡す）。そのため import path は `<module>/<dir>/_gosfc/<name>_vue` になり、`internal/` の可視性も `.vue` の場所を基準に普通の Go と同じく働きます。ユーザーのソースツリーには何も書きません。
* gosfc は Go を parse しません。`internal/synth` は標準の `go/scanner` でトークン化し、括弧の深さと scanner が挿入するセミコロンだけでトップレベルの区切りを決め、各要素の先頭トークン（`import` / `func 名前` / `var` / `const` / `type` / `a, b :=`）を見て分類と名前の取得をします。構文・型のエラーは全て Go toolchain が報告します。
* gosfc が自分で出す診断は Go の外の制約だけです：メソッド宣言、generic 関数、import の位置、JavaScript の予約語と衝突する binding 名（`new`、`class` など）、`<script lang="go">`（setup なし）。

## 5. goesm との API 境界

境界は `packages/vite/src/goesm.js` の 1 ファイルだけです。gosfc は goesm の CLI を、アプリの go.mod の tool directive で固定された版で呼びます（`go tool -n goesm` でビルド済みバイナリを得る）。

```
goesm emit-ts -overlay <overlay.json> -o <dir> ./<rel>/_gosfc/<name>_vue
  入力:  overlay.json は go command 標準の -overlay 形式 {"Replace": {"/abs/.../setup.go": "<一時ファイル>"}}
  出力:  <dir>/<import path>.ts (+ .ts.map)      Go package ごとに 1 module、map は .vue / .go を指す
         <dir>/@goesm/runtime/*.ts               goesm runtime（module 間と runtime への import は相対 `.ts` 指定）
  失敗:  exit 1、stderr に "<file>:<line>:<col>: <message> [<layer>]"（layer は go/parser・go/types・go list・goesm lowering）
```

概念上の `Compile(source, context) → { code, map, bindings, diagnostics }` との対応：source = overlay の synthetic Go、context = module ディレクトリと package pattern、code / map = 出力 module、diagnostics = stderr。bindings は gosfc 自身が synthetic Go を作る時点で知っているので goesm には求めていません。

goesm 側の変更はこの PoC のために 1 つだけです：`build` / `emit-ts` に `-overlay` を追加（goesm PR #3、main にマージ済み）。go/packages の `Overlay` をそのまま使うので、module・package 解決は引き続き go command の仕事です。gosfc は Go AST にも go/packages にも依存しません。

## 6. template binding

`runtime/bridge.js` が `GosfcSetup()` を component instance ごとに 1 回呼び、各 binding を Vue の `computed` として公開します。

* Go のコードが変更するのは普通の Go 変数で、Vue はそれを観測できません。そこで binding 経由で Go の関数を呼ぶ（イベントハンドラ、template 内の呼び出し）たびに instance の version を進め、全 binding が Go から値を読み直します。Vue 自身の reactivity と scheduler だけを使い、別の renderer や scheduler はありません。
* 値は goesm の `toJS` で template 向けに変換します（Go 文字列 → JS 文字列、slice → 配列、struct → object）。これはスナップショットで、JS 側で書き換えても Go の状態は変わりません。
* Go 関数は宣言された引数の数だけ受け取ります。`@click="Increment"` に渡る DOM event は `func Increment()` には渡りません。string 引数は JS 文字列から Go 文字列へ変換します。blocking な Go 関数（Promise を返す）は解決後に更新します。

## 7. source map と診断

```
.vue ──//line──> synthetic Go ──goesm──> TypeScript ──Vite(oxc)──> JS ──Rolldown──> bundle
       位置は //line で .vue のまま   map: TS → .vue / .go      Vite が各段の map を合成
.vue ──MagicString──> 置き換え後の .vue ──plugin-vue──> JS      （template / glue 側）
```

* Go の診断（構文・型・import・goesm の lowering 制約）は最初から `.vue` の位置で出ます。Vite / Astro のエラーには `src/features/cart/Summary.vue:17:21: cannot use "x" ... [go/types]` と code frame 付きで渡します。
* 生成物の map は goesm が作る TS→Go の map（source は `.vue` と `.go`）を Vite の load hook で返すだけで、合成は Vite / Rolldown に任せます。テストで、bundle 中の `Total(items)` が `Summary.vue:17`、`item.Price * item.Quantity` が `price.go:7` に戻ることを確認しています。
* dev SSR で Go の panic が起きると、stack trace は Vite の `ssrFixStacktrace` を通して `TmpPanic.vue:6` を指します（テスト済み）。

## 8. HMR

独自の HMR runtime はありません。判定と更新は `@vitejs/plugin-vue` と Vite のものです。

* plugin-vue は HMR 時にファイルを読み直して前後の descriptor を比べます。gosfc は `handleHotUpdate` で HMR context の `read()` を差し替え、plugin-vue にはコンパイル後の SFC を見せます。その結果、template だけの変更は re-render（Go の状態は残る）、Go block の変更は component の reload（Go を再実行）になります。
* binding が変わらない Go の変更でも script が変わるよう、glue には lowering 後のコードの hash を `useGo` の引数として入れています（plugin-vue は script を AST で比べるのでコメントでは足りません）。
* `.go` ファイルの変更は、その package を使う `.vue` を無効化して reload します。`addWatchFile` も登録しているので、HMR を切った dev server や `vite build --watch` でも再コンパイルされます。
* 生成 module は内容が変わった時だけ Vite の module graph で無効化し、Vite が付ける `?t=` で新しい版が読み込まれます。

## 9. Astro

`@gosfc/astro` は `@astrojs/vue`（まだ無ければ）と `@gosfc/vite` を設定するだけです。Go block を持つ component は Astro から見て普通の Vue component で、`client:*` なしなら Astro の SSR で静的 HTML に、`client:load` なら同じ SSR HTML を hydrate する island になります。Go native SSR のような別 renderer はなく、SSR と client は同じ lowering 済み module を実行します。

## 10. セキュリティ

* gosfc に plugin や拡張の仕組みはありません。Go の依存を import しても、それがコンパイラの中で実行されることはありません。
* 実行されるのは go.mod の tool directive で固定され、go.sum で検証された `gosfc` と `goesm` だけです。goesm は `go list` を実行するので、go command の信頼境界（環境変数、`go.work`、GOPROXY からの取得）をそのまま引き継ぎます。
* Go のソースは source map の `sourcesContent` と goesm の panic メッセージに含まれます。公開する bundle の map にはソースが入ります。
* template 側の値はスナップショットなので、template から Go の状態を直接書き換える経路はありません。

## 11. 未実装・未決事項

未実装：

* props / emits / slots を Go から扱う方法（`defineProps` 相当）。現状、Go block は外から値を受け取れません。
* `gosfc fmt`（§12）、language server、VS Code extension。
* メソッド、generic 関数を Go block 内で宣言すること（Go package に置く必要がある）。
* goroutine やタイマーなど、binding 経由の呼び出し以外で起きた Go 状態の変更を template に反映すること。
* template から Go の値を書き換えること（`v-model` など）。
* JS 値 ⇔ Go 値の変換は goesm の `toJS` と string 引数のみ。struct・slice を引数に取る Go 関数を template から呼ぶ場合の変換はありません（goesm に JS 呼び出し ABI がまだ無い）。

未決事項：

* `.go` の HMR は依存する component を reload します。package の module 単位で差し替えることはしていません。
* dev server 起動直後の最初の HMR は、template だけの変更でも reload になります。plugin-vue が最初の transform のときにディスクから生の `.vue` を読んで HMR 用の cache に入れるためで、2 回目以降は §8 のとおり動きます。plugin-vue の `compiler` option で `parse` を包めば解消できますが、plugin-vue の設定に手を入れることになるので保留しています。
* HMR context の `read()` の差し替えは、Vite が `handleHotUpdate` の plugin 間で同じ context を渡すことに依存しています。plugin-vue 側に「script の前処理」を差し込む公式の入口があればそちらに移すべきです。
* `go:` specifier と `@goesm/runtime` を Vite で解決する処理は gosfc の plugin にあります。goesm の ESM 接続の責務と考えれば、`@goesm/vite` のような形で goesm 側に移すのが自然です。
* component ごとに goesm を 1 回起動し、依存 package も毎回 lowering します。キャッシュや常駐プロセスによる高速化はまだありません。

## 12. formatter と editor integration の方針

* **formatter**：`gofmt` 相当は `go/format` を使います。`go/format.Source` は「宣言の列」や「文の列」も整形できるので、`internal/synth` のトップレベル分割を使って import 群・宣言・文をそれぞれ `go/format` に通し、元の空行で繋ぎ直せば Go block だけを整形できます。`gosfc fmt` はそれを `.vue` の該当範囲に書き戻すだけにし、template / style は Prettier や Vue Language Tools に任せます。
* **language server**：`.vue` の Go block から、ここで使っている synthetic Go をそのまま virtual Go document にし、gopls に overlay として渡します（gopls も go/packages の overlay を使う）。`//line` directive があるので gopls の診断・位置は `.vue` の座標に戻せます。completion・hover・definition・references・rename・code action・import completion は gopls のものを中継するだけにし、gosfc 独自の Go 補完は作りません。template / style は Vue Language Tools の担当のままにして、`.vue` を 2 つの language server で分担します。VS Code extension は薄い LSP client にします。
* **template ↔ Go**：template の識別子と Go の binding の対応は、glue（`const total = __gosfc.binding("total")`）と synthetic Go の lookup（`case "total": return total`）の両方に現れます。Vue Language Tools が glue の `total` を辿れれば、その位置を synthetic Go 経由で gopls の定義に繋ぐことで definition / rename を双方向にできます。この橋渡しはまだ設計だけです。
