// Package astro lets Go read Astro's context: the Astro global of a Go
// frontmatter (---go in an .astro file), and the context Astro passes to an
// endpoint or a middleware written in Go.
//
// In a Go frontmatter, Astro is a Context:
//
//	---go
//	import "github.com/goesm-dev/gosfc/astro"
//
//	slug := Astro.Param("slug")
//	path := Astro.URL().Path
//
//	func GetStaticPaths() []astro.StaticPath {
//		return []astro.StaticPath{{Params: map[string]string{"slug": "hello"}}}
//	}
//	---
//
// An endpoint or a middleware is a Go package whose exported functions take
// the context as a js.Value (astro.Context{Value: ctx} gives its accessors)
// and return a Response, which @gosfc/astro routes (see its README).
//
// The package needs goesm (GOOS=js): Context is a syscall/js value.
package astro
