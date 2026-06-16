#!/usr/bin/env node
/**
 * test/languages.mjs
 *
 * Deterministic, fixture-free coverage for the C / Bash / Swift language
 * integrations: AST chunking, name extraction, local-import tracking, call-graph
 * edges, and god-class splitting — exercised through the SAME functions the
 * indexer uses (getParserForFile → extractSemanticChunks / extractImportsFromAST).
 *
 * No Ollama, no network, no clones. A language whose optional grammar is not
 * built is SKIPPED (not failed), mirroring the graceful-degradation contract in
 * parser-utils (_tryLang) — so CI without the native grammar still passes.
 *
 *   node test/languages.mjs        (exit 0 = pass, 1 = failure)
 */
import assert from 'node:assert/strict';
import {
    getParserForFile,
    extractSemanticChunks,
    extractImportsFromAST,
    EXTENSIONS,
} from '../parser-utils.mjs';

let passed = 0, failed = 0, skipped = 0;

function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

/** Run `fn` only if the language grammar for `ext` is installed; else SKIP. */
function withLang(label, ext, fn) {
    if (!getParserForFile(ext)) {
        skipped++;
        console.log(`  ⊘ ${label} — grammar for ${ext} not built (skipped)`);
        return;
    }
    fn();
}

/** Parse source and return { chunks, imports } as the indexer would. */
function parse(file, source) {
    const ext = '.' + file.split('.').pop();
    const tree = getParserForFile(ext).parse(source);
    return {
        chunks: extractSemanticChunks(tree.rootNode, file, source, ext),
        imports: extractImportsFromAST(tree.rootNode, ext),
    };
}
const byName = (chunks, name) => chunks.find(c => c.name === name);

console.log('\nLANGUAGE INTEGRATION TESTS (C / Bash / Swift)\n');

// ─── extension registry ─────────────────────────────────────────────────────
test('EXTENSIONS registers the new language file types', () => {
    for (const e of ['.c', '.h', '.sh', '.bash', '.swift']) {
        // Only assert when the grammar is present; absent grammar legitimately
        // drops its extensions from the map.
        if (getParserForFile(e)) assert.ok(EXTENSIONS.has(e), `${e} missing from EXTENSIONS`);
    }
});

// ─── C ───────────────────────────────────────────────────────────────────────
const C_SRC = `#include <stdio.h>
#include "net/socket.h"

typedef struct Point {
    int x;
    int y;
} Point;

typedef int (*Callback)(
    int code,
    const char *msg
);

enum Color {
    RED,
    GREEN,
    BLUE
};

union Data {
    int i;
    float f;
};

struct Node {
    int value;
    struct Node *next;
};

static int add(int a, int b) {
    return a + b;
}

int *make_buffer(size_t n) {
    int *buf = allocate(n);
    init_buffer(buf, n);
    return buf;
}

int main(int argc, char **argv) {
    int s = add(1, 2);
    printf("%d", s);
    return 0;
}`;

withLang('C', '.c', () => {
    const { chunks, imports } = parse('demo.c', C_SRC);

    test('C: extracts function definitions with correct names', () => {
        assert.ok(byName(chunks, 'add'), 'add missing');
        assert.ok(byName(chunks, 'main'), 'main missing');
        assert.equal(byName(chunks, 'add').node_type, 'function_definition');
    });

    test('C: resolves a name through a pointer return declarator (int *make_buffer)', () => {
        const fn = byName(chunks, 'make_buffer');
        assert.ok(fn, 'make_buffer not named correctly (declarator descent failed)');
    });

    test('C: chunks named struct / enum / union / typedef', () => {
        assert.equal(byName(chunks, 'Node')?.node_type, 'struct_specifier');
        assert.equal(byName(chunks, 'Color')?.node_type, 'enum_specifier');
        assert.equal(byName(chunks, 'Data')?.node_type, 'union_specifier');
        assert.equal(byName(chunks, 'Point')?.node_type, 'type_definition');
    });

    test('C: resolves a function-pointer typedef name (Callback)', () => {
        assert.ok(byName(chunks, 'Callback'), 'function-pointer typedef name unresolved');
    });

    test('C: tracks only quoted local includes, drops <system> headers', () => {
        assert.deepEqual(imports, ['net/socket.h']);
    });

    test('C: call edges resolve callee identifiers', () => {
        const main = byName(chunks, 'main');
        assert.ok(main.calls.includes('add'), 'main → add edge missing');
        const mk = byName(chunks, 'make_buffer');
        assert.ok(mk.calls.includes('init_buffer'), 'make_buffer → init_buffer edge missing');
    });
});

// ─── Bash ──────────────────────────────────────────────────────────────────────
const BASH_SRC = `#!/usr/bin/env bash
source ./lib/utils.sh
. /etc/profile

deploy_app() {
    local env=$1
    build_project
    docker push myimage
    echo "deployed to $env"
}

run_tests() {
    npm test
    deploy_app staging
}

main() {
    run_tests
    deploy_app production
}
main "$@"`;

withLang('Bash', '.sh', () => {
    const { chunks, imports } = parse('deploy.sh', BASH_SRC);

    test('Bash: chunks every function (and only functions)', () => {
        assert.ok(byName(chunks, 'deploy_app'));
        assert.ok(byName(chunks, 'run_tests'));
        assert.ok(byName(chunks, 'main'));
        assert.ok(chunks.every(c => c.node_type === 'function_definition'));
    });

    test('Bash: tracks source / dot includes as dependencies', () => {
        assert.ok(imports.includes('./lib/utils.sh'), 'source include missing');
    });

    test('Bash: call edges keep project + tool calls, drop builtins', () => {
        const rt = byName(chunks, 'run_tests');
        assert.ok(rt.calls.includes('deploy_app'), 'internal function call missing');
        const da = byName(chunks, 'deploy_app');
        assert.ok(da.calls.includes('docker'), 'external tool call missing');
        assert.ok(!da.calls.includes('echo'), 'builtin echo should be filtered');
        assert.ok(!da.calls.includes('local'), 'builtin local should be filtered');
    });
});

// ─── Swift ─────────────────────────────────────────────────────────────────────
const SWIFT_SRC = `import Foundation
import UIKit

protocol Drawable {
    func draw()
}

struct Point {
    let x: Int
    let y: Int
    func distance(to other: Point) -> Double { return 0.0 }
}

enum Direction {
    case north
    case south
}

class ViewController: UIViewController, Drawable {
    var titleText: String = ""
    func draw() { render() }
    func viewDidLoad() {
        super.viewDidLoad()
        loadData()
        manager.fetch(id: 5)
    }
}

extension Point {
    func magnitude() -> Double { return 0.0 }
}

func globalHelper(value: Int) -> Int {
    return value * 2
}`;

withLang('Swift', '.swift', () => {
    const { chunks, imports } = parse('View.swift', SWIFT_SRC);

    test('Swift: struct / class / enum / extension all surface as class_declaration', () => {
        const points = chunks.filter(c => c.name === 'Point');
        assert.equal(points.length, 2, 'struct + extension Point should be two chunks');
        assert.ok(points.every(c => c.node_type === 'class_declaration'));
        assert.equal(byName(chunks, 'ViewController')?.node_type, 'class_declaration');
        assert.equal(byName(chunks, 'Direction')?.node_type, 'class_declaration');
    });

    test('Swift: chunks protocols and free functions', () => {
        assert.equal(byName(chunks, 'Drawable')?.node_type, 'protocol_declaration');
        assert.equal(byName(chunks, 'globalHelper')?.node_type, 'function_declaration');
    });

    test('Swift: import declarations are tracked', () => {
        assert.ok(imports.includes('Foundation') && imports.includes('UIKit'));
    });

    test('Swift: call edges resolve self/super/obj method receivers', () => {
        const vc = byName(chunks, 'ViewController');
        assert.ok(vc.calls.includes('loadData'), 'free call loadData missing');
        assert.ok(vc.calls.includes('render'), 'self.render missing');
        assert.ok(vc.calls.includes('fetch'), 'manager.fetch missing');
    });

    test('Swift: a god-type is split so its methods become their own chunks', () => {
        // Build a >200-line class so the god-class pre-pass un-nests its methods.
        const methods = Array.from({ length: 60 }, (_, i) =>
            `    func method_${i}() {\n        helper_${i}()\n        log_${i}()\n    }`).join('\n');
        const src = `class HugeService {\n${methods}\n}`;
        const { chunks: gc } = parse('Huge.swift', src);
        assert.ok(gc.some(c => c.name === 'method_0'), 'god-class methods not split into chunks');
        assert.ok(gc.length > 5, 'expected many method chunks from a god-class');
    });
});

// ─── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(56)}`);
console.log(`  passed=${passed}  failed=${failed}  skipped=${skipped}`);
if (failed > 0) { console.log('\n✗ language integration tests FAILED\n'); process.exit(1); }
console.log('\n✓ language integration tests passed\n');
