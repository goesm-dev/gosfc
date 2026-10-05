// Package synth builds the synthetic Go file for a <script setup lang="go">
// block.
//
// A setup block is not a Go source file: like Vue's <script setup>, its top
// level holds statements (`total := cart.Total(items)`) that run once per
// component instance. synth turns the block into an ordinary Go file that the
// Go toolchain (through goesm) parses and type-checks:
//
//	//line Summary.vue:7:1
//	package summary_vue
//
//	//line Summary.vue:8:1
//	import cart "example.com/app/src/features/cart/pkg"
//
//	//line Summary.vue:7:1
//	func GosfcSetup() func(string) any {
//	//line Summary.vue:10:1
//	items := []cart.Item{...}
//	...
//	//line Summary.vue:7:1
//	return func(name string) any { switch name { case "total": return total ... } }
//	}
//
// A block may declare the component's props as `type Props struct {...}`.
// That type is declared at package level, the setup function takes it as
// `props`, and a second function returns its zero value so the bridge can
// read the fields from the type descriptor:
//
//	type Props struct{ Route string }
//	func GosfcSetup(props Props) func(string) any { ... }
//	func GosfcProps() any { return Props{} }
//
// Constant and type declarations come first, then a variable for every
// function declaration (so functions may call each other and recurse), then
// the remaining code in its original order: the block runs top to bottom like
// the body of Vue's setup().
//
// Every piece of user text is copied verbatim behind a //line directive, so
// go/parser, go/types, goesm diagnostics and goesm source maps all report
// positions in the .vue file. The generated file's own positions are never
// shown to the user.
//
// synth does not parse Go. It splits the block into top-level items with the
// standard go/scanner (tracking only bracket depth and the automatic
// semicolons the scanner inserts) and looks at the first tokens of each item to
// classify it and to read the names it declares. Everything else, including
// all syntax and type errors, is left to the Go toolchain.
package synth

import (
	"fmt"
	"go/scanner"
	"go/token"
	"sort"
	"strconv"
	"strings"
)

// SetupFunc is the exported function of the synthetic package. It runs the
// block once and returns a lookup function from binding name to the binding's
// current value (boxed in an interface, so the value keeps its Go type).
const SetupFunc = "GosfcSetup"

// PropsFunc returns the zero value of the block's Props type (boxed in an
// interface), when the block declares one.
const PropsFunc = "GosfcProps"

// PropsType is the name of the type that declares a component's props.
const PropsType = "Props"

// Input describes one <script setup lang="go"> block.
type Input struct {
	File    string `json:"file"`    // absolute path of the .vue file
	Package string `json:"package"` // Go package name for the synthetic file
	Source  string `json:"source"`  // block content
	Line    int    `json:"line"`    // 1-based position of Source[0] in File
	Column  int    `json:"column"`
	TagLine int    `json:"tagLine"` // position of the <script setup lang="go"> tag,
	TagCol  int    `json:"tagColumn"`
}

// Binding is a top-level name of the block exposed to the template.
type Binding struct {
	Name string `json:"name"`
	Kind string `json:"kind"` // "var", "const" or "func"
}

// Diagnostic is a gosfc-level error at a .vue position. Go syntax and type
// errors are not reported here; they come from the Go toolchain.
type Diagnostic struct {
	Line    int    `json:"line"`
	Column  int    `json:"column"`
	Message string `json:"message"`
}

// Output is the synthetic Go file and what the template may reference.
type Output struct {
	Go          string       `json:"go"`
	Bindings    []Binding    `json:"bindings"`
	Diagnostics []Diagnostic `json:"diagnostics"`
	// Props is true when the block declares `type Props struct {...}`.
	Props bool `json:"props"`
}

type tok struct {
	off int // byte offset in the block
	end int
	tok token.Token
	lit string
}

type item struct {
	toks []tok
}

func (it item) start() int { return it.toks[0].off }
func (it item) end() int   { return it.toks[len(it.toks)-1].end }

// Build builds the synthetic file.
func Build(in Input) Output {
	var out Output
	fset := token.NewFileSet()
	src := []byte(in.Source)
	file := fset.AddFile(in.File, -1, len(src))

	// pos converts a block offset into a .vue line and column.
	pos := func(off int) (int, int) {
		p := file.Position(file.Pos(off))
		line := in.Line + p.Line - 1
		col := p.Column
		if p.Line == 1 {
			col = in.Column + p.Column - 1
		}
		return line, col
	}
	diag := func(off int, format string, args ...any) {
		l, c := pos(off)
		out.Diagnostics = append(out.Diagnostics, Diagnostic{Line: l, Column: c, Message: fmt.Sprintf(format, args...)})
	}

	// Scan errors are not reported here: the same text reaches go/parser,
	// which reports them at the same position.
	var s scanner.Scanner
	s.Init(file, src, func(token.Position, string) {}, scanner.ScanComments)
	var items []item
	var cur []tok
	// directives holds the //goesm:import comment preceding an item, by
	// the item's index.
	directives := map[int]tok{}
	depth := 0
	for {
		p, t, lit := s.Scan()
		if t == token.EOF {
			break
		}
		off := file.Offset(p)
		if t == token.COMMENT {
			if depth == 0 && len(cur) == 0 && isJSImport(lit) {
				if _, dup := directives[len(items)]; dup {
					diag(off, "only one //goesm:import may precede a declaration")
					continue
				}
				directives[len(items)] = tok{off: off, end: off + len(lit), tok: t, lit: lit}
			}
			continue
		}
		end := off + len(t.String())
		if lit != "" {
			end = off + len(lit)
		}
		if t == token.SEMICOLON && lit == "\n" {
			end = off // automatic semicolon: no text
		}
		switch t {
		case token.LPAREN, token.LBRACK, token.LBRACE:
			depth++
		case token.RPAREN, token.RBRACK, token.RBRACE:
			depth--
		}
		if t == token.SEMICOLON && depth == 0 {
			if len(cur) > 0 {
				items = append(items, item{cur})
				cur = nil
			}
			continue
		}
		cur = append(cur, tok{off: off, end: end, tok: t, lit: lit})
	}
	if len(cur) > 0 {
		items = append(items, item{cur})
	}
	if d, ok := directives[len(items)]; ok {
		// Nothing follows the directive.
		diag(d.off, "//goesm:import must precede a function without a body or a var declaration")
	}

	directive := func(b *strings.Builder, line, col int) {
		fmt.Fprintf(b, "\n//line %s:%d:%d\n", in.File, line, col)
	}
	tag := func(b *strings.Builder) { directive(b, in.TagLine, in.TagCol) }

	var header, propsDecl, imported, decls, hoisted, body strings.Builder
	tag(&header)
	fmt.Fprintf(&header, "package %s\n", in.Package)

	seen := map[string]bool{}
	bind := func(name, kind string) {
		if name == "_" || seen[name] {
			return
		}
		seen[name] = true
		out.Bindings = append(out.Bindings, Binding{Name: name, Kind: kind})
	}
	text := func(from, to int) string { return in.Source[from:to] }

	importsDone := false
	for i, it := range items {
		t0 := it.toks[0]
		if d, ok := directives[i]; ok {
			// //goesm:import (goesm's JavaScript imports): the function
			// without a body or the variable it precedes is declared at
			// package level, directive first, so that goesm finds it there.
			name, ok := jsImportName(it.toks)
			if !ok {
				diag(d.off, "//goesm:import must precede a function without a body or a var declaration")
				continue
			}
			// The directive goes on the line right before the declaration
			// (no //line comment between them, which would end the doc
			// comment), numbered so that the declaration keeps its .vue
			// position.
			l, _ := pos(it.start())
			_, c := pos(d.off)
			directive(&imported, l-1, c)
			imported.WriteString(d.lit)
			imported.WriteByte('\n')
			imported.WriteString(text(it.start(), it.end()))
			imported.WriteByte('\n')
			kind := "var"
			if t0.tok == token.FUNC {
				kind = "func"
			}
			bind(name, kind)
			importsDone = true
			continue
		}
		switch t0.tok {
		case token.IMPORT:
			if importsDone {
				diag(t0.off, "imports must come before other code in <script setup lang=\"go\">")
				continue
			}
			l, c := pos(it.start())
			directive(&header, l, c)
			header.WriteString(text(it.start(), it.end()))
			header.WriteByte('\n')
			continue
		case token.FUNC:
			if len(it.toks) > 1 && it.toks[1].tok == token.IDENT {
				name := it.toks[1]
				if len(it.toks) > 2 && it.toks[2].tok == token.LBRACK {
					diag(t0.off, "generic function %s cannot be declared in <script setup lang=\"go\">; declare it in a Go package", name.lit)
					continue
				}
				lbrace := bodyStart(it.toks[2:])
				if lbrace < 0 {
					diag(t0.off, "function %s has no body", name.lit)
					continue
				}
				sig := text(name.end, lbrace)
				// func Name(...) {...}  becomes  Name=func(...) {...}
				// "Name=func" is as long as "func Name", so every column
				// after it stays where it was in the .vue file.
				l, c := pos(t0.off)
				directive(&hoisted, l, c)
				fmt.Fprintf(&hoisted, "var %s func%s\n", name.lit, sig)
				directive(&body, l, c)
				fmt.Fprintf(&body, "%s=func%s%s\n", name.lit, strings.Repeat(" ", name.off-t0.end-1), text(name.end, it.end()))
				bind(name.lit, "func")
				importsDone = true
				continue
			}
			if isMethod(it.toks) {
				diag(t0.off, "methods cannot be declared in <script setup lang=\"go\">; declare them in a Go package")
				continue
			}
		case token.CONST, token.TYPE:
			if t0.tok == token.TYPE && len(it.toks) > 2 && it.toks[1].tok == token.IDENT && it.toks[1].lit == PropsType {
				if it.toks[2].tok != token.STRUCT {
					diag(it.toks[1].off, "%s must be a struct type", PropsType)
					continue
				}
				// Props is the setup function's parameter type, so it is
				// declared at package level.
				out.Props = true
				importsDone = true
				l, c := pos(it.start())
				directive(&propsDecl, l, c)
				propsDecl.WriteString(text(it.start(), it.end()))
				propsDecl.WriteByte('\n')
				continue
			}
			// Constants and types have no run-time effect; they are declared
			// first so that hoisted function signatures can use them.
			if t0.tok == token.CONST {
				for _, n := range declNames(it.toks[1:]) {
					bind(n, "const")
				}
			}
			importsDone = true
			l, c := pos(it.start())
			directive(&decls, l, c)
			decls.WriteString(text(it.start(), it.end()))
			decls.WriteByte('\n')
			continue
		case token.VAR:
			for _, n := range declNames(it.toks[1:]) {
				bind(n, "var")
			}
		default:
			for _, n := range defineNames(it.toks) {
				bind(n, "var")
			}
		}
		importsDone = true
		l, c := pos(it.start())
		directive(&body, l, c)
		body.WriteString(text(it.start(), it.end()))
		body.WriteByte('\n')
	}

	var b strings.Builder
	b.WriteString("// Code generated by gosfc. DO NOT EDIT.\n")
	b.WriteString(header.String())
	b.WriteString(imported.String())
	param := ""
	if out.Props {
		b.WriteString(propsDecl.String())
		tag(&b)
		fmt.Fprintf(&b, "func %s() any { return %s{} }\n", PropsFunc, PropsType)
		param = "props " + PropsType
	}
	tag(&b)
	fmt.Fprintf(&b, "func %s(%s) func(string) any {\n", SetupFunc, param)
	b.WriteString(decls.String())
	b.WriteString(hoisted.String())
	b.WriteString(body.String())
	tag(&b)
	b.WriteString("return func(gosfcBinding string) any {\nswitch gosfcBinding {\n")
	names := append([]Binding(nil), out.Bindings...)
	sort.Slice(names, func(i, j int) bool { return names[i].Name < names[j].Name })
	for _, bd := range names {
		fmt.Fprintf(&b, "case %s:\nreturn %s\n", strconv.Quote(bd.Name), bd.Name)
	}
	b.WriteString("}\nreturn nil\n}\n}\n")
	out.Go = b.String()
	return out
}

// isJSImport reports whether the comment is a //goesm:import directive.
func isJSImport(comment string) bool {
	rest, ok := strings.CutPrefix(comment, "//goesm:import")
	return ok && (rest == "" || rest[0] == ' ' || rest[0] == '\t')
}

// jsImportName returns the name declared by an item that a //goesm:import
// directive may precede: `func name(...) ...` without a body, or
// `var name T`.
func jsImportName(toks []tok) (string, bool) {
	if len(toks) < 2 || toks[1].tok != token.IDENT {
		return "", false
	}
	switch toks[0].tok {
	case token.FUNC:
		return toks[1].lit, bodyStart(toks[2:]) < 0
	case token.VAR:
		return toks[1].lit, true
	}
	return "", false
}

// bodyStart returns the offset of the "{" that opens a function body in the
// tokens after the function name: the first "{" at depth 0 that does not
// belong to a struct or interface type in the signature.
func bodyStart(toks []tok) int {
	depth := 0
	for i, t := range toks {
		switch t.tok {
		case token.LPAREN, token.LBRACK:
			depth++
		case token.RPAREN, token.RBRACK:
			depth--
		case token.LBRACE:
			if depth == 0 && (i == 0 || (toks[i-1].tok != token.STRUCT && toks[i-1].tok != token.INTERFACE)) {
				return t.off
			}
			depth++
		case token.RBRACE:
			depth--
		}
	}
	return -1
}

// isMethod reports whether func ( ... ) is followed by a name, i.e. a method
// declaration rather than a function literal.
func isMethod(toks []tok) bool {
	if len(toks) < 2 || toks[1].tok != token.LPAREN {
		return false
	}
	depth := 0
	for i := 1; i < len(toks); i++ {
		switch toks[i].tok {
		case token.LPAREN:
			depth++
		case token.RPAREN:
			depth--
			if depth == 0 {
				return i+1 < len(toks) && toks[i+1].tok == token.IDENT
			}
		}
	}
	return false
}

// declNames returns the names declared by the tokens after var or const:
// `a, b T = ...` or a parenthesized group of such specs.
func declNames(toks []tok) []string {
	if len(toks) == 0 {
		return nil
	}
	if toks[0].tok != token.LPAREN {
		return identList(toks)
	}
	var names []string
	depth := 0
	var spec []tok
	for _, t := range toks {
		switch t.tok {
		case token.LPAREN, token.LBRACK, token.LBRACE:
			depth++
			if depth == 1 {
				continue
			}
		case token.RPAREN, token.RBRACK, token.RBRACE:
			depth--
			if depth == 0 {
				names = append(names, identList(spec)...)
				spec = nil
				continue
			}
		case token.SEMICOLON:
			if depth == 1 {
				names = append(names, identList(spec)...)
				spec = nil
				continue
			}
		}
		spec = append(spec, t)
	}
	return names
}

func identList(toks []tok) []string {
	var names []string
	for i := 0; i < len(toks); i += 2 {
		if toks[i].tok != token.IDENT {
			break
		}
		names = append(names, toks[i].lit)
		if i+1 >= len(toks) || toks[i+1].tok != token.COMMA {
			break
		}
	}
	return names
}

// defineNames returns the names of a short variable declaration
// `a, b := ...`, or nil for any other statement.
func defineNames(toks []tok) []string {
	names := identList(toks)
	n := 2*len(names) - 1
	if len(names) == 0 || n >= len(toks) || toks[n].tok != token.DEFINE {
		return nil
	}
	return names
}
