# Contributing to gosfc

English | [日本語](CONTRIBUTING.ja.md)

Contributions to gosfc are welcome. You can start with either an issue or a pull request. For large changes or changes that affect the responsibility boundaries, it helps if you discuss the approach in an issue first.

gosfc is at the **PoC stage**. The overview is in [README.md](README.md), and the design and the items not yet implemented are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Design principles

The goal of gosfc is not "to create a Go-like frontend language" but **to connect real Go naturally to the Vue SFC ecosystem**. gosfc stays an adapter between Vue SFCs and goesm, and does not take on the responsibilities of other layers.

When in doubt, prioritize in this order:

1. Compatibility with the Go ecosystem
2. Ordinary Go code can be used as is
3. Being natural as a Vue SFC
4. Natural integration with Vite
5. Natural integration with Astro
6. Not adding custom specifications

The following are not implemented in gosfc. When they are needed, leave them to the layer responsible for each.

| Not implemented | Responsible |
|---|---|
| Go parser / type checker, Go Modules and package resolution | Go toolchain |
| Go → TypeScript / ESM conversion, Go semantics | goesm |
| SFC parser, template compiler, Vue runtime | Vue tooling |
| Bundler, dev server | Vite / Rolldown |
| Routing, SSR, islands, `client:*`, page generation | Astro |

In addition, please keep the following commitments:

* Do not introduce custom import syntax (`import "./cart.go"`, `import "./Button.vue"`, `import Button from "./Button.vue"`, and so on). Imports in the Go block are ordinary Go imports only.
* `.go` files stay ordinary Go packages. Do not create a gosfc-specific `.go` format.
* Do not build custom tooling that competes with `go`, `gofmt`, `gopls`, `go vet`, and so on.
* Do not touch `.vue` files other than those with `lang="go"`. Components with `lang="ts"` are passed to Vue / Vite as is.

## Boundary with goesm

* gosfc calls goesm only through its CLI (`go tool goesm emit-ts -overlay ...`). goesm's Go packages are under `internal/`, so they are not imported.
* The boundary is a single file, `packages/vite/src/goesm.js`. When changing how goesm is called, change only this file.
* If a change is needed on the goesm side, open a pull request against [goesm](https://github.com/goesm-dev/goesm). Do not put knowledge of Vue or SFCs into goesm; propose it as a general-purpose feature (for example, `-overlay`).
* goesm is pinned to a release (`v0.0.1-beta.N`). When a new release comes out, run `go get -tool github.com/goesm-dev/goesm/cmd/goesm@<version>` in `examples/astro/go.mod`, `tests/fixtures/app/go.mod`, and `bench/go.mod`.

## Development environment

Development tools are set up with [mise](https://mise.jdx.dev/). The Go, Node.js, and pnpm versions are pinned in `mise.toml`.

```sh
mise install
pnpm install
```

* To upgrade the tools to the latest versions, run `mise upgrade --bump` (`-b`), confirm that `pnpm test` passes, and then commit the updated `mise.toml`.
* The pnpm version is managed only in `mise.toml`. Do not add `packageManager` to `package.json`.
* Dependencies that are allowed to run build scripts are listed in `allowBuilds` in `pnpm-workspace.yaml`.

## Tests

```sh
pnpm test
```

This runs `go test ./...` (`internal/synth` and so on) and `tests/*.test.mjs` (Astro build, Vite build / SSR / HMR, diagnostics). The browser HMR test uses Chromium at `/opt/pw-browsers/chromium` or from the `CHROMIUM` environment variable, and is skipped if it is not found.

To run the example locally:

```sh
cd examples/astro
pnpm build   # dist/index.html contains 「合計: 200」
pnpm dev
```

## Pull requests

* Put only one purpose in each pull request.
* Add tests for changes that alter behavior.
* Go code must pass `gofmt` and `go vet ./...`.
* If the responsibility boundaries, the API with goesm, or the items not yet implemented / open questions change, update ARCHITECTURE.md as well.
* Confirm that `pnpm test` passes before submitting.

## License

gosfc is released under the [MIT License](LICENSE). Contributions are treated as provided under the same MIT License. Because they are also bundled in the npm packages, `packages/vite/LICENSE` and `packages/astro/LICENSE` are copies of the root `LICENSE`.
