// Package server is a middleware written in Go: astro.config.mjs runs its
// OnRequest before every page.
package server

import (
	"syscall/js"

	"github.com/goesm-dev/goesm/promise"
	"github.com/goesm-dev/gosfc/astro"
)

// OnRequest gives the pages a greeting in Astro.locals, then renders them.
func OnRequest(ctx js.Value, next js.Value) (js.Value, error) {
	astro.Context{Value: ctx}.Locals().Set("greeting", "hello from Go middleware")
	return promise.Await(next.Invoke())
}
