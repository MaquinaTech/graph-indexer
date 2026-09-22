/**
 * Tree-sitter runtime: the WASM build of tree-sitter (vendored web-tree-sitter) plus
 * gzip-compressed grammar binaries shipped in vendor/grammars. No native compilation,
 * no network, no per-platform binaries — the same bytes run on every OS and Node ≥ 22.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Parser, Language, Query } from '../../vendor/web-tree-sitter/web-tree-sitter.js';

const VENDOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vendor');
const RUNTIME_WASM = path.join(VENDOR, 'web-tree-sitter', 'web-tree-sitter.wasm');
const GRAMMAR_DIR = path.join(VENDOR, 'grammars');

let initPromise = null;
const grammarCache = new Map(); // grammar name -> Promise<Language>

export function initRuntime() {
    initPromise ??= Parser.init({ locateFile: () => RUNTIME_WASM });
    return initPromise;
}

export function availableGrammars() {
    return fs.readdirSync(GRAMMAR_DIR).filter(f => f.endsWith('.wasm.gz')).map(f => f.slice(0, -'.wasm.gz'.length));
}

export function loadGrammar(name) {
    let p = grammarCache.get(name);
    if (!p) {
        p = (async () => {
            await initRuntime();
            const bytes = zlib.gunzipSync(fs.readFileSync(path.join(GRAMMAR_DIR, `${name}.wasm.gz`)));
            return Language.load(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        })();
        grammarCache.set(name, p);
    }
    return p;
}

/** Compile a query, reporting the offending grammar on failure (queries are per-grammar). */
export function compileQuery(language, source, label) {
    try {
        return new Query(language, source);
    } catch (err) {
        throw new Error(`query compile failed for ${label}: ${err.message}`);
    }
}

export function createParser(language) {
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
}

export { Parser, Language, Query };
