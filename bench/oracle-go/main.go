// Command oracle-go answers questions about a Go module with the Go type checker. It backs the
// Go benchmarks: reference accuracy (bench/eval-graph-go.mjs) and the agent tasks
// (bench/agentic/gen-qa-go.mjs, gen-refactor-go.mjs).
//
//	oracle-go -dir <module> [-mode refs] < queries.json
//
// Input: JSON [{"path":"rel/file.go","line":12,"col":5}], each the position of a declared name.
// Output: JSON {"files":["rel",…],"answers":[answer | null]}, answers in query order, files the Go
// files the default build (no extra tags) type-checked. An answer holds:
//
//	exact     every line with an identifier the checker binds to that object (types.Info.Uses),
//	          the declaration's own line excluded;
//	dispatch  exact plus, for methods, the uses of the interface methods it implements (a call through
//	          the interface may run it) and, for an interface method, the uses of the concrete methods
//	          that implement it — the same contract as the TypeScript benchmark's dispatch oracle;
//	related   whether such interface relations exist (then exact and dispatch may differ);
//	uses      the exact uses in detail: whether each is a call, and the function declaration it is in;
//	impls     for an interface, the module's named types that implement it, directly or through a
//	          pointer ("rel:line" of the name, and their declarations as spans).
//
//	oracle-go -dir <module> -mode typecheck
//
// Prints every type error of the module's packages, tests included, as "rel:line: message" and
// exits 1 when there is one.
//
//	oracle-go -mode struct -spec task.spec.json -dir <checkout>
//
// Checks a refactoring structurally with go/parser: the target method has the expected name and
// parameter count, and the methods of other types that share its name are unchanged.
//
//	oracle-go -mode apply -spec task.spec.json -dir <checkout>
//
// Writes the reference solution of a refactoring task from the type checker's bindings: renames
// the target and every identifier bound to it, or adds `strict bool` to its parameters and
// `false` to every call of it.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"
)

type query struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Col  int    `json:"col"`
}

type span struct {
	Path     string `json:"path"`
	Start    int    `json:"start"`
	End      int    `json:"end"`
	Name     string `json:"name"`
	NameLine int    `json:"nameLine,omitempty"`
	NameCol  int    `json:"nameCol,omitempty"` // 1-based
}

type use struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Call bool   `json:"call"`
	Fn   *span  `json:"fn"`
}

type answer struct {
	Exact     []string `json:"exact"`
	Dispatch  []string `json:"dispatch"`
	Related   bool     `json:"related"`
	Uses      []use    `json:"uses"`
	Impls     []string `json:"impls,omitempty"`
	ImplSpans []span   `json:"implSpans,omitempty"`
}

// With Tests, a package is loaded twice (plain and with its tests); a declaration then has one
// object per variant. Objects are keyed by their declaring position so both variants agree.
type key struct {
	file string
	off  int
}

func main() {
	dir := flag.String("dir", ".", "module root")
	mode := flag.String("mode", "refs", "refs | typecheck | struct")
	specFile := flag.String("spec", "", "struct mode: the task's spec file")
	flag.Parse()
	root, _ := filepath.Abs(*dir)
	switch *mode {
	case "struct":
		os.Exit(checkStruct(root, *specFile))
	case "typecheck":
		os.Exit(typecheck(root))
	case "apply":
		os.Exit(apply(root, *specFile))
	case "refs":
		refs(root)
	default:
		fmt.Fprintln(os.Stderr, "unknown mode", *mode)
		os.Exit(2)
	}
}

func load(root string) []*packages.Package {
	cfg := &packages.Config{Mode: packages.LoadAllSyntax, Dir: root, Tests: true}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	return pkgs
}

func inside(root, file string) bool {
	r, err := filepath.Rel(root, file)
	return err == nil && len(r) > 0 && !strings.HasPrefix(r, "../")
}

func typecheck(root string) int {
	seen := map[string]bool{}
	var out []string
	packages.Visit(load(root), nil, func(p *packages.Package) {
		for _, e := range p.Errors {
			pos := e.Pos
			if i := strings.Index(pos, ":"); i > 0 && filepath.IsAbs(pos[:i]) {
				if !inside(root, pos[:i]) {
					continue
				}
				if r, err := filepath.Rel(root, pos[:i]); err == nil {
					pos = filepath.ToSlash(r) + pos[i:]
				}
			}
			line := fmt.Sprintf("%s: %s", pos, e.Msg)
			if !seen[line] {
				seen[line] = true
				out = append(out, line)
			}
		}
	})
	sort.Strings(out)
	for _, l := range out {
		fmt.Println(l)
	}
	if len(out) > 0 {
		return 1
	}
	return 0
}

func refs(root string) {
	pkgs := load(root)
	var queries []query
	if err := json.NewDecoder(os.Stdin).Decode(&queries); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	var fset *token.FileSet
	rel := func(p token.Pos) (string, int, int) {
		pos := fset.Position(p)
		r, err := filepath.Rel(root, pos.Filename)
		if err != nil || strings.HasPrefix(r, "../") {
			return "", 0, 0
		}
		return filepath.ToSlash(r), pos.Line, pos.Column
	}
	objKey := func(o types.Object) key {
		if o == nil || !o.Pos().IsValid() {
			return key{}
		}
		pos := fset.Position(o.Pos())
		return key{pos.Filename, pos.Offset}
	}
	spanOf := func(n ast.Node, name string, nameAt token.Pos) *span {
		f, s, _ := rel(n.Pos())
		_, e, _ := rel(n.End())
		_, nl, nc := rel(nameAt)
		return &span{Path: f, Start: s, End: e, Name: name, NameLine: nl, NameCol: nc}
	}

	uses := map[key]map[string]*use{} // declaration → uses by "rel:line"
	defs := map[string]key{}           // "rel:line:col" of a declared name → declaration
	typeSpans := map[key]*span{}       // named type → its declaration
	var methods []*types.Func          // every method declared in the module
	var ifaces, named []*types.Named   // the module's named interfaces, and its other named types
	files := map[string]bool{}
	seenPkg := map[*types.Package]bool{}
	packages.Visit(pkgs, nil, func(p *packages.Package) {
		if p.TypesInfo == nil || len(p.GoFiles) == 0 || !inside(root, p.GoFiles[0]) {
			return
		}
		fset = p.Fset
		for _, f := range p.CompiledGoFiles {
			if r, err := filepath.Rel(root, f); err == nil {
				files[filepath.ToSlash(r)] = true
			}
		}
		for id, o := range p.TypesInfo.Defs {
			if o == nil {
				continue
			}
			f, l, c := rel(id.Pos())
			defs[fmt.Sprintf("%s:%d:%d", f, l, c)] = objKey(o)
		}
		for _, file := range p.Syntax {
			var stack []ast.Node
			var fn *ast.FuncDecl
			ast.Inspect(file, func(n ast.Node) bool {
				if n == nil {
					stack = stack[:len(stack)-1]
					if len(stack) == 0 || fn != nil && !containsNode(stack, fn) {
						fn = nil
					}
					return false
				}
				stack = append(stack, n)
				switch x := n.(type) {
				case *ast.FuncDecl:
					fn = x
				case *ast.TypeSpec:
					if o := p.TypesInfo.Defs[x.Name]; o != nil {
						typeSpans[objKey(o)] = spanOf(x, x.Name.Name, x.Name.Pos())
					}
				case *ast.Ident:
					o := p.TypesInfo.Uses[x]
					k := objKey(o)
					if k.file == "" {
						return true
					}
					f, l, _ := rel(x.Pos())
					if f == "" {
						return true
					}
					at := fmt.Sprintf("%s:%d", f, l)
					if uses[k] == nil {
						uses[k] = map[string]*use{}
					}
					u := uses[k][at]
					if u == nil {
						u = &use{Path: f, Line: l}
						if fn != nil {
							u.Fn = spanOf(fn, funcName(fn), fn.Name.Pos())
						}
						uses[k][at] = u
					}
					if isCall(stack) {
						u.Call = true
					}
				}
				return true
			})
		}
		if seenPkg[p.Types] {
			return
		}
		seenPkg[p.Types] = true
		scope := p.Types.Scope()
		for _, name := range scope.Names() {
			tn, ok := scope.Lookup(name).(*types.TypeName)
			if !ok || tn.IsAlias() {
				continue
			}
			nt, ok := tn.Type().(*types.Named)
			if !ok {
				continue
			}
			if types.IsInterface(nt) {
				ifaces = append(ifaces, nt)
			} else {
				named = append(named, nt)
			}
			for i := 0; i < nt.NumMethods(); i++ {
				methods = append(methods, nt.Method(i))
			}
		}
	})

	// method ↔ interface-method relations (by declaration key)
	related := map[key]map[key]bool{}
	link := func(a, b key) {
		if related[a] == nil {
			related[a] = map[key]bool{}
		}
		related[a][b] = true
	}
	for _, m := range methods {
		recv := m.Type().(*types.Signature).Recv()
		if recv == nil || types.IsInterface(recv.Type()) {
			continue
		}
		T := recv.Type()
		if p, ok := T.(*types.Pointer); ok {
			T = p.Elem()
		}
		for _, it := range ifaces {
			iface := it.Underlying().(*types.Interface)
			if !types.Implements(T, iface) && !types.Implements(types.NewPointer(T), iface) {
				continue
			}
			for i := 0; i < iface.NumMethods(); i++ {
				im := iface.Method(i)
				if im.Name() == m.Name() {
					link(objKey(m), objKey(im))
					link(objKey(im), objKey(m))
				}
			}
		}
	}

	out := make([]*answer, len(queries))
	for i, q := range queries {
		k, ok := defs[fmt.Sprintf("%s:%d:%d", q.Path, q.Line, q.Col)]
		if !ok {
			continue
		}
		self := fmt.Sprintf("%s:%d", q.Path, q.Line)
		collect := func(keys ...key) []string {
			set := map[string]bool{}
			for _, k := range keys {
				for u := range uses[k] {
					set[u] = true
				}
			}
			delete(set, self)
			return sorted(set)
		}
		ks := []key{k}
		for r := range related[k] {
			ks = append(ks, r)
		}
		a := &answer{Exact: collect(k), Dispatch: collect(ks...), Related: len(related[k]) > 0}
		for at, u := range uses[k] {
			if at != self {
				a.Uses = append(a.Uses, *u)
			}
		}
		sort.Slice(a.Uses, func(i, j int) bool {
			return a.Uses[i].Path < a.Uses[j].Path || a.Uses[i].Path == a.Uses[j].Path && a.Uses[i].Line < a.Uses[j].Line
		})
		// an interface queried: which named types satisfy it. The interface and the types exist once
		// per package variant (with and without its tests), and a type satisfies the variant its
		// package imports: the answer is the union over the variants.
		impls, spans := map[string]bool{}, map[string]span{}
		for _, it := range ifaces {
			if objKey(it.Obj()) != k {
				continue
			}
			iface := it.Underlying().(*types.Interface)
			for _, t := range named {
				if iface.NumMethods() > 0 && (types.Implements(t, iface) || types.Implements(types.NewPointer(t), iface)) {
					f, l, _ := rel(t.Obj().Pos())
					impls[fmt.Sprintf("%s:%d", f, l)] = true
					if s := typeSpans[objKey(t.Obj())]; s != nil {
						spans[fmt.Sprintf("%s:%d", s.Path, s.Start)] = *s
					}
				}
			}
		}
		if len(impls) > 0 {
			a.Impls = sorted(impls)
			for _, x := range sorted(func() map[string]bool {
				m := map[string]bool{}
				for k := range spans {
					m[k] = true
				}
				return m
			}()) {
				a.ImplSpans = append(a.ImplSpans, spans[x])
			}
		}
		out[i] = a
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"files": sorted(files), "answers": out})
}

func sorted(set map[string]bool) []string {
	xs := make([]string, 0, len(set))
	for x := range set {
		xs = append(xs, x)
	}
	sort.Strings(xs)
	return xs
}

func containsNode(stack []ast.Node, n ast.Node) bool {
	for _, x := range stack {
		if x == n {
			return true
		}
	}
	return false
}

// isCall: the identifier on top of the stack is what a call expression calls (`f(…)`, `x.f(…)`).
func isCall(stack []ast.Node) bool {
	n := len(stack)
	id := stack[n-1]
	if n >= 2 {
		if c, ok := stack[n-2].(*ast.CallExpr); ok && c.Fun == id {
			return true
		}
	}
	if n >= 3 {
		if s, ok := stack[n-2].(*ast.SelectorExpr); ok && s.Sel == id {
			if c, ok := stack[n-3].(*ast.CallExpr); ok && c.Fun == s {
				return true
			}
		}
	}
	return false
}

// recvName: the receiver's type name (`(s *Server)` → Server, `(l *List[T])` → List).
func recvName(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 {
		return ""
	}
	t := fn.Recv.List[0].Type
	for {
		switch x := t.(type) {
		case *ast.StarExpr:
			t = x.X
		case *ast.IndexExpr:
			t = x.X
		case *ast.IndexListExpr:
			t = x.X
		case *ast.Ident:
			return x.Name
		default:
			return ""
		}
	}
}

func funcName(fn *ast.FuncDecl) string {
	if r := recvName(fn); r != "" {
		return r + "." + fn.Name.Name
	}
	return fn.Name.Name
}

func paramCount(fn *ast.FuncDecl) int {
	n := 0
	for _, f := range fn.Type.Params.List {
		if len(f.Names) == 0 {
			n++
		} else {
			n += len(f.Names)
		}
	}
	return n
}

type method struct {
	File     string `json:"file"`
	Cls      string `json:"cls"`
	Name     string `json:"name"`
	NewName  string `json:"newName,omitempty"`
	Params   int    `json:"params"`
	LastType string `json:"lastType,omitempty"`
}

// checkStruct: the target method (in its file) has its new name, or the expected number of
// parameters with the expected last type, and every decoy is still declared as it was.
func checkStruct(root, specFile string) int {
	var spec struct {
		Target method   `json:"target"`
		Decoys []method `json:"decoys"`
	}
	b, err := os.ReadFile(specFile)
	if err == nil {
		err = json.Unmarshal(b, &spec)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	find := func(file, cls, name string) (*ast.FuncDecl, *token.FileSet) {
		fs := token.NewFileSet()
		f, err := parser.ParseFile(fs, filepath.Join(root, file), nil, 0)
		if err != nil {
			return nil, nil
		}
		for _, d := range f.Decls {
			if fn, ok := d.(*ast.FuncDecl); ok && fn.Name.Name == name && recvName(fn) == cls {
				return fn, fs
			}
		}
		return nil, nil
	}
	fail := 0
	t := spec.Target
	if t.NewName != "" {
		if fn, _ := find(t.File, t.Cls, t.Name); fn != nil {
			fmt.Printf("FAIL %s.%s is still declared in %s\n", t.Cls, t.Name, t.File)
			fail++
		}
		if fn, _ := find(t.File, t.Cls, t.NewName); fn == nil {
			fmt.Printf("FAIL %s.%s is not declared in %s\n", t.Cls, t.NewName, t.File)
			fail++
		}
	} else if fn, fs := find(t.File, t.Cls, t.Name); fn == nil {
		fmt.Printf("FAIL %s.%s is not declared in %s\n", t.Cls, t.Name, t.File)
		fail++
	} else if n := paramCount(fn); n != t.Params {
		fmt.Printf("FAIL %s.%s has %d parameters, expected %d\n", t.Cls, t.Name, n, t.Params)
		fail++
	} else if t.LastType != "" {
		last := fn.Type.Params.List[len(fn.Type.Params.List)-1]
		var sb strings.Builder
		if err := printType(&sb, fs, last.Type); err != nil || sb.String() != t.LastType {
			fmt.Printf("FAIL %s.%s's last parameter is %q, expected %q\n", t.Cls, t.Name, sb.String(), t.LastType)
			fail++
		}
	}
	for _, d := range spec.Decoys {
		fn, _ := find(d.File, d.Cls, d.Name)
		if fn == nil {
			fmt.Printf("FAIL %s.%s (same name, another type) is no longer declared in %s\n", d.Cls, d.Name, d.File)
			fail++
		} else if n := paramCount(fn); n != d.Params {
			fmt.Printf("FAIL %s.%s (same name, another type) now has %d parameters, it had %d\n", d.Cls, d.Name, n, d.Params)
			fail++
		}
	}
	if fail > 0 {
		return 1
	}
	fmt.Println("ok")
	return 0
}

func printType(sb *strings.Builder, fs *token.FileSet, e ast.Expr) error {
	switch x := e.(type) {
	case *ast.Ident:
		sb.WriteString(x.Name)
	case *ast.StarExpr:
		sb.WriteString("*")
		return printType(sb, fs, x.X)
	case *ast.SelectorExpr:
		if err := printType(sb, fs, x.X); err != nil {
			return err
		}
		sb.WriteString("." + x.Sel.Name)
	default:
		return fmt.Errorf("unsupported type expression")
	}
	return nil
}

type edit struct {
	off  int
	del  int
	text string
}

// apply: the reference solution of a refactoring task (see the command's doc).
func apply(root, specFile string) int {
	var spec struct {
		Target method `json:"target"`
	}
	b, err := os.ReadFile(specFile)
	if err == nil {
		err = json.Unmarshal(b, &spec)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	t := spec.Target
	target := filepath.Join(root, t.File)
	edits := map[string]map[int]edit{} // file → offset → edit (packages load twice with tests)
	add := func(fset *token.FileSet, at token.Pos, del int, text string) {
		p := fset.Position(at)
		if edits[p.Filename] == nil {
			edits[p.Filename] = map[int]edit{}
		}
		edits[p.Filename][p.Offset] = edit{p.Offset, del, text}
	}
	found := false
	packages.Visit(load(root), nil, func(p *packages.Package) {
		if p.TypesInfo == nil {
			return
		}
		// the target's object in this package variant, if it declares it
		var obj types.Object
		var decl *ast.FuncDecl
		for i, f := range p.Syntax {
			if i >= len(p.CompiledGoFiles) || p.CompiledGoFiles[i] != target {
				continue
			}
			for _, d := range f.Decls {
				if fn, ok := d.(*ast.FuncDecl); ok && fn.Name.Name == t.Name && recvName(fn) == t.Cls {
					obj, decl = p.TypesInfo.Defs[fn.Name], fn
				}
			}
		}
		if decl != nil {
			found = true
			if t.NewName != "" {
				add(p.Fset, decl.Name.Pos(), len(t.Name), t.NewName)
			} else if n := decl.Type.Params.NumFields(); n > 0 {
				last := decl.Type.Params.List[len(decl.Type.Params.List)-1]
				add(p.Fset, last.End(), 0, ", strict bool")
			} else {
				add(p.Fset, decl.Type.Params.Opening+1, 0, "strict bool")
			}
		}
		same := func(o types.Object) bool {
			if o == nil || !o.Pos().IsValid() {
				return false
			}
			a := p.Fset.Position(o.Pos())
			return a.Filename == target && a.Line == declLine(root, t)
		}
		for _, f := range p.Syntax {
			ast.Inspect(f, func(n ast.Node) bool {
				switch x := n.(type) {
				case *ast.Ident:
					if t.NewName != "" && x.Name == t.Name && (p.TypesInfo.Uses[x] == obj && obj != nil || same(p.TypesInfo.Uses[x])) {
						add(p.Fset, x.Pos(), len(t.Name), t.NewName)
					}
				case *ast.CallExpr:
					if t.NewName != "" {
						return true
					}
					var id *ast.Ident
					switch fn := x.Fun.(type) {
					case *ast.SelectorExpr:
						id = fn.Sel
					case *ast.Ident:
						id = fn
					}
					if id == nil || id.Name != t.Name || !same(p.TypesInfo.Uses[id]) {
						return true
					}
					if len(x.Args) > 0 {
						add(p.Fset, x.Args[len(x.Args)-1].End(), 0, ", false")
					} else {
						add(p.Fset, x.Lparen+1, 0, "false")
					}
				}
				return true
			})
		}
	})
	if !found {
		fmt.Fprintf(os.Stderr, "%s.%s not found in %s\n", t.Cls, t.Name, t.File)
		return 1
	}
	for file, es := range edits {
		src, err := os.ReadFile(file)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		list := make([]edit, 0, len(es))
		for _, e := range es {
			list = append(list, e)
		}
		sort.Slice(list, func(i, j int) bool { return list[i].off > list[j].off })
		for _, e := range list {
			src = append(src[:e.off], append([]byte(e.text), src[e.off+e.del:]...)...)
		}
		if err := os.WriteFile(file, src, 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
	}
	return 0
}

var declLines = map[string]int{}

// declLine: the line of the target method's name in its file (as parsed before any edit).
func declLine(root string, t method) int {
	k := t.File + "|" + t.Cls + "|" + t.Name
	if l, ok := declLines[k]; ok {
		return l
	}
	fs := token.NewFileSet()
	f, err := parser.ParseFile(fs, filepath.Join(root, t.File), nil, 0)
	line := -1
	if err == nil {
		for _, d := range f.Decls {
			if fn, ok := d.(*ast.FuncDecl); ok && fn.Name.Name == t.Name && recvName(fn) == t.Cls {
				line = fs.Position(fn.Name.Pos()).Line
			}
		}
	}
	declLines[k] = line
	return line
}
