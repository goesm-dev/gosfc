// Package api is an endpoint written in Go: astro.config.mjs routes
// /api/[id].json to it.
package api

import (
	"encoding/json"
	"syscall/js"

	"github.com/goesm-dev/gosfc/astro"
)

// GET answers /api/<id>.json.
func GET(ctx js.Value) (js.Value, error) {
	c := astro.Context{Value: ctx}
	body, err := json.Marshal(map[string]string{"id": c.Param("id"), "path": c.URL().Path})
	if err != nil {
		return js.Null(), err
	}
	init := map[string]any{"headers": map[string]any{"content-type": "application/json"}}
	return js.Global().Get("Response").New(string(body), init), nil
}

// GetStaticPaths lists the ids the build writes.
func GetStaticPaths() []astro.StaticPath {
	return []astro.StaticPath{
		{Params: map[string]string{"id": "apple"}},
		{Params: map[string]string{"id": "orange"}},
	}
}
