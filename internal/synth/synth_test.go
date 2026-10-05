package synth

import (
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"reflect"
	"strings"
	"testing"
)

const vue = "/app/src/Counter.vue"

func build(t *testing.T, src string) Output {
	t.Helper()
	// The block starts on line 10 right after `<script setup lang="go">`,
	// which is on line 9.
	return Build(Input{File: vue, Package: "counter_vue", Source: src, Line: 10, Column: 1, TagLine: 9, TagCol: 1})
}

// check type-checks the synthetic file with the standard library only and
// returns the errors, which must be reported at .vue positions.
func check(t *testing.T, out Output) []string {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "gen.go", out.Go, parser.ParseComments)
	if err != nil {
		t.Fatalf("synthetic file does not parse: %v\n%s", err, out.Go)
	}
	var errs []string
	conf := types.Config{Importer: importer.Default(), Error: func(err error) { errs = append(errs, err.Error()) }}
	conf.Check("counter_vue", fset, []*ast.File{f}, nil)
	return errs
}

func TestBindingsAndTypeCheck(t *testing.T) {
	src := `
import "strings"

total := 0
label, unit := strings.ToUpper("total"), "yen"

var (
	a, b = 1, 2
	c    int
)
const limit = 10

type pair struct{ x, y int }

func Increment() {
	if total < limit {
		total++
	}
}

func Describe(p pair) (s string) {
	return label + unit
}

_ = a + b + c
`
	out := build(t, src)
	if len(out.Diagnostics) != 0 {
		t.Fatalf("diagnostics: %v", out.Diagnostics)
	}
	var got []string
	for _, b := range out.Bindings {
		got = append(got, b.Name+":"+b.Kind)
	}
	want := []string{"total:var", "label:var", "unit:var", "a:var", "b:var", "c:var", "limit:const", "Increment:func", "Describe:func"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("bindings = %v, want %v", got, want)
	}
	if errs := check(t, out); len(errs) != 0 {
		t.Errorf("type errors: %v\n%s", errs, out.Go)
	}
}

// Errors in user code are reported at .vue positions, never at positions in
// the synthetic file.
func TestErrorsPointAtVue(t *testing.T) {
	src := "\nimport \"strings\"\n\ntotal := strings.ToUpper(1)\n\nfunc Increment() {\n\ttotal += \"x\" + 1\n}\n"
	errs := check(t, build(t, src))
	joined := strings.Join(errs, "\n")
	// Line 1 of the block is line 10 of the .vue file.
	for _, want := range []string{vue + ":13:26", vue + ":16:"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %s in:\n%s", want, joined)
		}
	}
	if strings.Contains(joined, "gen.go") {
		t.Errorf("synthetic positions leaked:\n%s", joined)
	}
}

// A function declaration keeps its columns: "Increment=func" has the same
// length as "func Increment".
func TestFuncColumnsPreserved(t *testing.T) {
	src := "\nn := 0\n\nfunc   Add(d string) { n += d }\n"
	errs := check(t, build(t, src))
	if len(errs) != 1 || !strings.Contains(errs[0], vue+":13:24") {
		t.Errorf("errors = %v", errs)
	}
}

func TestUnsupportedDeclarations(t *testing.T) {
	out := build(t, "\nx := 1\nimport \"fmt\"\nfunc (p *T) M() {}\nfunc G[T any]() {}\n")
	var got []string
	for _, d := range out.Diagnostics {
		got = append(got, d.Message[:strings.Index(d.Message, " ")]+"@"+string(rune('0'+d.Line-10)))
	}
	want := []string{"imports@2", "methods@3", "generic@4"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("diagnostics = %v, want %v", got, want)
	}
}

// Recursion works because functions are declared before the setup code runs.
func TestRecursiveFunc(t *testing.T) {
	src := "\nfunc Fib(n int) int {\n\tif n < 2 {\n\t\treturn n\n\t}\n\treturn Fib(n-1) + Fib(n-2)\n}\n\nf := Fib(10)\n"
	if errs := check(t, build(t, src)); len(errs) != 0 {
		t.Errorf("errors: %v", errs)
	}
}

func TestProps(t *testing.T) {
	out := build(t, `
import "strings"

type Props struct {
	Route string
	Count int `+"`json:\"n\"`"+`
}

upper := strings.ToUpper(props.Route)
`)
	if !out.Props {
		t.Fatal("Props not detected")
	}
	if errs := check(t, out); len(errs) > 0 {
		t.Fatalf("%v\n%s", errs, out.Go)
	}
	for _, want := range []string{"func GosfcProps() any { return Props{} }", "func GosfcSetup(props Props) func(string) any {"} {
		if !strings.Contains(out.Go, want) {
			t.Errorf("missing %q in\n%s", want, out.Go)
		}
	}
	if got := names(out.Bindings); !reflect.DeepEqual(got, []string{"upper"}) {
		t.Errorf("bindings %v", got)
	}

	out = build(t, "type Props int\n")
	if len(out.Diagnostics) != 1 || !strings.Contains(out.Diagnostics[0].Message, "Props must be a struct type") {
		t.Errorf("%+v", out.Diagnostics)
	}
}

func names(bs []Binding) []string {
	var out []string
	for _, b := range bs {
		out = append(out, b.Name)
	}
	return out
}

// //goesm:import declarations are moved to package level with their
// directive, where goesm reads them; they are bindings like any other.
func TestJSImports(t *testing.T) {
	src := `
import "syscall/js"

//goesm:import "./Badge.vue"
var Badge js.Value

//goesm:import "./format.ts" formatPrice
func formatPrice(yen int) string

label := formatPrice(120)

//goesm:import "./x.ts" y
z := 1
`
	out := build(t, src)
	if len(out.Diagnostics) != 1 || out.Diagnostics[0].Line != 21 || !strings.Contains(out.Diagnostics[0].Message, "//goesm:import must precede") {
		t.Errorf("diagnostics = %+v, want one at line 21", out.Diagnostics)
	}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "gen.go", out.Go, parser.ParseComments)
	if err != nil {
		t.Fatalf("synthetic file does not parse: %v\n%s", err, out.Go)
	}
	found := map[string]string{}
	for _, d := range f.Decls {
		var doc *ast.CommentGroup
		var name string
		switch d := d.(type) {
		case *ast.FuncDecl:
			if d.Body != nil {
				continue
			}
			doc, name = d.Doc, d.Name.Name
		case *ast.GenDecl:
			if d.Tok != token.VAR {
				continue
			}
			doc, name = d.Doc, d.Specs[0].(*ast.ValueSpec).Names[0].Name
		default:
			continue
		}
		if doc == nil {
			continue
		}
		for _, c := range doc.List {
			if strings.HasPrefix(c.Text, "//goesm:") {
				found[name] = c.Text
				found[name+"@"] = fset.Position(c.Pos()).String()
				found[name+"#"] = fset.Position(d.Pos()).String()
			}
		}
	}
	want := map[string]string{
		"Badge":        `//goesm:import "./Badge.vue"`,
		"Badge@":       vue + ":13:1",
		"Badge#":       vue + ":14:1",
		"formatPrice":  `//goesm:import "./format.ts" formatPrice`,
		"formatPrice@": vue + ":16:1",
		"formatPrice#": vue + ":17:1",
	}
	if !reflect.DeepEqual(found, want) {
		t.Errorf("package-level imports = %v, want %v\n%s", found, want, out.Go)
	}
	var names []string
	for _, b := range out.Bindings {
		names = append(names, b.Name+":"+b.Kind)
	}
	if got := strings.Join(names, " "); got != "Badge:var formatPrice:func label:var" {
		t.Errorf("bindings = %s", got)
	}
}
