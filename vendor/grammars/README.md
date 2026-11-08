# Vendored grammars

Each `NAME.wasm.gz` is a tree-sitter grammar compiled to WebAssembly. `manifest.json` records where it
comes from and the SHA-256 and size of the uncompressed `.wasm`; `test/vendor.test.mjs` checks every
file against it, and the index fingerprint covers the manifest, so a changed grammar rebuilds indexes.

- **`tag` and `asset`**: the `.wasm` published with that release of the grammar's repository,
  downloaded as is.
- **`commit` and `built`**: the grammar has no release with what graph-indexer needs (Kotlin: the
  latest release, 0.3.8, predates `fun interface` and Kotlin 2.x syntax), so the `.wasm` is built
  from that commit. The build is reproducible: anyone can check the vendored file against its
  source.

## Building a grammar from a commit

This is `tree-sitter build --wasm` with tree-sitter-cli 0.25.10, the version of the vendored
`web-tree-sitter`, run as the `emcc` command that CLI issues (`compile_parser_to_wasm` in
`cli/loader/src/lib.rs`), in the Emscripten image it pins. The checkout must be under a directory
the container can mount (with Colima, your home directory).

```sh
git clone https://github.com/fwcd/tree-sitter-kotlin && cd tree-sitter-kotlin
git checkout d6af96d2e23ef0a8ff5ab512864378cf08fba311
docker run --rm --platform linux/amd64 --workdir /src/src -v "$PWD":/src --user "$(id -u)" \
  emscripten/emsdk:4.0.4 emcc -o output.wasm -Os -s WASM=1 -s SIDE_MODULE=2 -s TOTAL_MEMORY=33554432 \
  -s NODEJS_CATCH_EXIT=0 -s 'EXPORTED_FUNCTIONS=["_tree_sitter_kotlin"]' -fno-exceptions -fvisibility=hidden \
  -I . scanner.c parser.c
shasum -a 256 src/output.wasm          # must equal manifest.json's sha256
gzip -9 -n -c src/output.wasm > kotlin.wasm.gz
```

For another grammar, replace the repository, the commit and the exported symbol
(`_tree_sitter_<name>`). The grammar's `src/parser.c` must declare `LANGUAGE_VERSION` 14 or 15,
the ABI versions web-tree-sitter 0.25 loads.

## Checking a new grammar before vendoring it

A grammar change can move or rename nodes the extraction queries in `src/parse/lang/` match. Before
replacing one:

1. `npm test`, which compiles every query against its grammar.
2. Parse a corpus of real code in that language with the old and the new grammar and compare the
   files with ERROR regions, the symbols (by kind and qualified name) and the references each
   extracts. A symbol that disappears needs a reason; one that changes its qualified name usually
   moved back into its class.
3. For a language with a compiler oracle (`bench/eval-graph*.mjs`), the references must keep their
   precision and recall.
