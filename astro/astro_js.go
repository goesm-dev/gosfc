//go:build js

package astro

import (
	"net/url"
	"syscall/js"
)

// Context is Astro's context: the Astro global of a page, a layout or a
// component, or the context of an endpoint or a middleware (an APIContext).
// It is the JavaScript object itself, so Get, Call and the other methods of
// js.Value reach what the accessors below do not.
type Context struct {
	js.Value
}

// Params returns the parameters of the dynamic route ([slug] is "slug").
// A rest parameter that matched nothing is left out.
func (c Context) Params() map[string]string {
	p := c.Get("params")
	out := map[string]string{}
	if !p.Truthy() {
		return out
	}
	keys := js.Global().Get("Object").Call("keys", p)
	for i := 0; i < keys.Length(); i++ {
		k := keys.Index(i).String()
		if v := p.Get(k); v.Type() == js.TypeString {
			out[k] = v.String()
		}
	}
	return out
}

// Param returns the parameter name of the dynamic route, or "".
func (c Context) Param(name string) string {
	p := c.Get("params")
	if !p.Truthy() {
		return ""
	}
	if v := p.Get(name); v.Type() == js.TypeString {
		return v.String()
	}
	return ""
}

// URL returns the URL of the request (Astro.url).
func (c Context) URL() *url.URL { return parseURL(c.Get("url")) }

// Site returns the site of the configuration (Astro.site), or nil.
func (c Context) Site() *url.URL { return parseURL(c.Get("site")) }

func parseURL(v js.Value) *url.URL {
	if !v.Truthy() {
		return nil
	}
	u, err := url.Parse(v.Get("href").String())
	if err != nil {
		return nil
	}
	return u
}

// Props returns the props the component was given (Astro.props).
func (c Context) Props() js.Value { return c.Get("props") }

// Request returns the Request (Astro.request).
func (c Context) Request() js.Value { return c.Get("request") }

// Locals returns the object middleware shares with the pages (Astro.locals).
func (c Context) Locals() js.Value { return c.Get("locals") }

// Cookies returns the cookies of the request and response (Astro.cookies).
func (c Context) Cookies() js.Value { return c.Get("cookies") }

// Redirect returns a Response that redirects to path with status (0 is
// Astro's default, 302). An endpoint or a middleware returns it; a Go
// frontmatter passes it to Respond.
func (c Context) Redirect(path string, status int) js.Value {
	if status == 0 {
		return c.Call("redirect", path)
	}
	return c.Call("redirect", path, status)
}

// responseKey is where Respond keeps the response of a Go frontmatter on
// Astro's global, for the frontmatter gosfc generates, which returns it.
var responseKey = js.Global().Get("Symbol").Call("for", "gosfc.response")

// Respond makes r, a Response (such as one Redirect returns), what a page
// answers instead of its template, as `return Astro.redirect("/")` does in
// a TypeScript frontmatter. The Go frontmatter still runs to its end.
func (c Context) Respond(r js.Value) {
	js.Global().Get("Reflect").Call("set", c.Value, responseKey, r)
}

// StaticPath is a path of a page that GetStaticPaths returns: the
// parameters of its dynamic route and the props the page is given.
type StaticPath struct {
	Params map[string]string `json:"params"`
	Props  any               `json:"props,omitempty"`
}
