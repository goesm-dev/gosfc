module example.com/bench

go 1.27

replace github.com/goesm-dev/gosfc => ..

tool (
	github.com/goesm-dev/goesm/cmd/goesm
	github.com/goesm-dev/gosfc/cmd/gosfc
)

require (
	github.com/evanw/esbuild v0.28.2 // indirect
	github.com/goesm-dev/goesm v0.0.0-20261003192415-20dbf1d25fec // indirect
	github.com/goesm-dev/gosfc v0.0.0-00010101000000-000000000000 // indirect
	golang.org/x/mod v0.41.0 // indirect
	golang.org/x/sync v0.23.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/tools v0.51.0 // indirect
)
