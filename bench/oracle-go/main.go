// Command oracle-go answers, with the Go type checker, which lines use each queried declaration.
//
// Input (stdin): JSON [{"path":"rel/file.go","line":12,"col":5}] — the position of a declared name.
// Output (stdout): JSON {"files":["rel",…],"answers":[{"exact":["rel:line",…],"dispatch":[…],"impls":[…]} | null]}
// with the answers in query order and files the Go files the build (default tags) type-checked.
//
//	exact     every identifier the checker binds to that object (types.Info.Uses), declaration excluded;
//	dispatch  exact plus, for methods, the uses of the interface methods it implements (a call through
//	          the interface may run it) and, for an interface method, the uses of the concrete methods
//	          that implement it — the same contract as the TypeScript benchmark's dispatch oracle;
//	impls     for an interface, the declarations ("rel:line") of the module's named types that
//	          implement it, directly or through a pointer.
//
// Run from the module root: go run ./bench/oracle-go -dir <module> < queries.json
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"sort"

	"golang.org/x/tools/go/packages"
)

type query struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Col  int    `json:"col"`
}

type answer struct {
	Exact    []string `json:"exact"`
	Dispatch []string `json:"dispatch"`
	Impls    []string `json:"impls,omitempty"`
}

func main() {
	dir := flag.String("dir", ".", "module root")
	tests := flag.Bool("tests", true, "include _test.go files")
	flag.Parse()
	root, _ := filepath.Abs(*dir)

	cfg := &packages.Config{Mode: packages.LoadAllSyntax, Dir: root, Tests: *tests}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var queries []query
	if err := json.NewDecoder(os.Stdin).Decode(&queries); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	// With Tests, a package is loaded twice (plain and with its tests); a declaration then has one
	// object per variant. Objects are keyed by their declaring position so both variants agree.
	type key struct {
		file string
		off  int
	}
	rel := func(fset *token.FileSet, p token.Pos) (string, int, int) {
		pos := fset.Position(p)
		r, err := filepath.Rel(root, pos.Filename)
		if err != nil {
			return "", 0, 0
		}
		return filepath.ToSlash(r), pos.Line, pos.Column
	}
	objKey := func(fset *token.FileSet, o types.Object) key {
		if o == nil || !o.Pos().IsValid() {
			return key{}
		}
		pos := fset.Position(o.Pos())
		return key{pos.Filename, pos.Offset}
	}

	uses := map[key]map[string]bool{} // declaration → "rel:line" of its uses
	defs := map[string]key{}          // "rel:line:col" of a declared name → declaration
	var methods []*types.Func         // every method declared in the module
	var ifaces []*types.Named         // every named interface declared in the module
	var named []*types.Named          // every other named type declared in the module
	files := map[string]bool{}
	var fset *token.FileSet
	seenPkg := map[*types.Package]bool{}
	packages.Visit(pkgs, nil, func(p *packages.Package) {
		if p.TypesInfo == nil || p.Module == nil && len(p.GoFiles) > 0 && !inside(root, p.GoFiles[0]) {
			return
		}
		if len(p.GoFiles) == 0 || !inside(root, p.GoFiles[0]) {
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
			f, l, c := rel(p.Fset, id.Pos())
			defs[fmt.Sprintf("%s:%d:%d", f, l, c)] = objKey(p.Fset, o)
		}
		for id, o := range p.TypesInfo.Uses {
			k := objKey(p.Fset, o)
			if k.file == "" {
				continue
			}
			f, l, _ := rel(p.Fset, id.Pos())
			if f == "" || len(f) > 2 && f[:3] == "../" {
				continue
			}
			if uses[k] == nil {
				uses[k] = map[string]bool{}
			}
			uses[k][fmt.Sprintf("%s:%d", f, l)] = true
		}
		if seenPkg[p.Types] {
			return
		}
		seenPkg[p.Types] = true
		scope := p.Types.Scope()
		for _, name := range scope.Names() {
			tn, ok := scope.Lookup(name).(*types.TypeName)
			if !ok {
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
					link(objKey(fset, m), objKey(fset, im))
					link(objKey(fset, im), objKey(fset, m))
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
			xs := make([]string, 0, len(set))
			for x := range set {
				xs = append(xs, x)
			}
			sort.Strings(xs)
			return xs
		}
		ks := []key{k}
		for r := range related[k] {
			ks = append(ks, r)
		}
		out[i] = &answer{Exact: collect(k), Dispatch: collect(ks...)}
		// an interface queried: which named types satisfy it
		for _, it := range ifaces {
			if objKey(fset, it.Obj()) != k {
				continue
			}
			iface := it.Underlying().(*types.Interface)
			impls := map[string]bool{}
			for _, t := range named {
				if iface.NumMethods() > 0 && (types.Implements(t, iface) || types.Implements(types.NewPointer(t), iface)) {
					f, l, _ := rel(fset, t.Obj().Pos())
					impls[fmt.Sprintf("%s:%d", f, l)] = true
				}
			}
			for x := range impls {
				out[i].Impls = append(out[i].Impls, x)
			}
			sort.Strings(out[i].Impls)
		}
	}
	fileList := make([]string, 0, len(files))
	for f := range files {
		fileList = append(fileList, f)
	}
	sort.Strings(fileList)
	json.NewEncoder(os.Stdout).Encode(map[string]any{"files": fileList, "answers": out})
}

func inside(root, file string) bool {
	r, err := filepath.Rel(root, file)
	return err == nil && len(r) > 0 && !(len(r) > 2 && r[:3] == "../")
}
