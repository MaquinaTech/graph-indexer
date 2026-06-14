/**
 * test/agent/benchmark.config.mjs
 *
 * The full-matrix agent benchmark: every supported language + framework, each as
 * a real indexed repo, exercised with FOUR task archetypes that together cover
 * the whole tool surface (not just resolve_symbol + get_call_graph):
 *
 *   symbol   — a known symbol: explain it, find usage, determine blast radius.
 *              (routes to resolve_symbol / get_call_graph / topology)
 *   behaviour— find code by BEHAVIOUR, no name given.  (forces search_code, NL)
 *   keyword  — find code by domain keywords.            (forces search_code, lexical)
 *   crosscut — a concern spanning files.                (multi-hop within budget)
 *
 * The behaviour/keyword/crosscut queries + their correct targets are shared with
 * the deterministic retrieval harness (search-cases.mjs) so the agent benchmark
 * and the LLM-free retrieval benchmark stay in lock-step.
 *
 * `layers` is exactly what `npx graph-indexer init` would assemble for that stack.
 * `answerKeys` are substrings a correct final answer is expected to contain
 * (symbol names / files), used by analyze.mjs to score answer quality.
 */
import { SEARCH_CASES } from './search-cases.mjs';

const JS = 'languages/JAVASCRIPT_TYPESCRIPT.md';
const L = {
    CORE: 'CORE.md',
    js: JS, ts: JS,
    py: 'languages/PYTHON.md', go: 'languages/GO.md', rust: 'languages/RUST.md',
    java: 'languages/JAVA.md', kotlin: 'languages/KOTLIN.md', csharp: 'languages/CSHARP.md',
    ruby: 'languages/RUBY.md', php: 'languages/PHP.md', css: 'languages/CSS_SCSS.md',
    fExpress: 'frameworks/NODE_EXPRESS_NESTJS.md', fReact: 'frameworks/REACT.md',
    fFastapi: 'frameworks/FASTAPI_DJANGO.md', fSpring: 'frameworks/SPRING_BOOT.md',
    fAndroid: 'frameworks/ANDROID.md', fAspnet: 'frameworks/ASPNET_CORE.md',
    fRails: 'frameworks/RAILS.md', fLaravel: 'frameworks/LARAVEL_SYMFONY.md',
};

/** Per-fixture symbol-known target + the files/symbols a correct blast-radius answer names. */
const SYMBOL = {
    axios:        { target: 'dispatchRequest', kind: 'function', answerKeys: ['Axios', 'request', 'interceptor'] },
    'express-js': { target: 'Layer',           kind: 'class',    answerKeys: ['Router', 'Route', 'layer.js'] },
    nestjs:       { target: 'Injector',        kind: 'class',    answerKeys: ['instance', 'provider', 'injector.ts'] },
    react:        { target: 'Modal',           kind: 'component',answerKeys: ['Modal', 'overlay'] },
    fastapi:      { target: 'APIRoute',        kind: 'class',    answerKeys: ['APIRouter', 'routing', 'endpoint'] },
    django:       { target: 'AbstractAddress', kind: 'model',    answerKeys: ['Address', 'abstract_models'] },
    gin:          { target: 'Engine',          kind: 'struct',   answerKeys: ['RouterGroup', 'gin.go', 'ServeHTTP'] },
    rust:         { target: 'Map',             kind: 'struct',   answerKeys: ['map.rs', 'Value', 'insert'] },
    spring:       { target: 'OwnerController', kind: 'class',    answerKeys: ['Owner', 'OwnerRepository'] },
    android:      { target: 'PlantListViewModel', kind: 'class', answerKeys: ['Plant', 'ViewModel'] },
    aspnet:       { target: 'BasketService',   kind: 'class',    answerKeys: ['Basket', 'IBasketService'] },
    rails:        { target: 'PostStatusService', kind: 'class',  answerKeys: ['Status', 'Account'] },
    laravel:      { target: 'SongRepository',  kind: 'class',    answerKeys: ['Song', 'Repository'] },
    symfony:      { target: 'FragmentHandler', kind: 'class',    answerKeys: ['Fragment', 'render'] },
    css:          { target: 'button-variant',  kind: 'SCSS @mixin', answerKeys: ['button-variant', 'button'] },
};

const LAYERS = {
    axios: [L.CORE, L.js],
    'express-js': [L.CORE, L.js, L.fExpress],
    nestjs: [L.CORE, L.ts, L.fExpress],
    react: [L.CORE, L.ts, L.fReact],
    fastapi: [L.CORE, L.py, L.fFastapi],
    django: [L.CORE, L.py, L.fFastapi],
    gin: [L.CORE, L.go],
    rust: [L.CORE, L.rust],
    spring: [L.CORE, L.java, L.fSpring],
    android: [L.CORE, L.kotlin, L.fAndroid],
    aspnet: [L.CORE, L.csharp, L.fAspnet],
    rails: [L.CORE, L.ruby, L.fRails],
    laravel: [L.CORE, L.php, L.fLaravel],
    symfony: [L.CORE, L.php, L.fLaravel],
    css: [L.CORE, L.css],
};

const LANGUAGE = {
    axios: 'JavaScript', 'express-js': 'JavaScript', nestjs: 'TypeScript', react: 'TypeScript',
    fastapi: 'Python', django: 'Python', gin: 'Go', rust: 'Rust', spring: 'Java',
    android: 'Kotlin', aspnet: 'C#', rails: 'Ruby', laravel: 'PHP', symfony: 'PHP', css: 'SCSS',
};

/** Build the BENCHMARKS array from the layer/symbol/search-case tables. */
export const BENCHMARKS = Object.keys(LAYERS).map(fixture => {
    const cases = SEARCH_CASES[fixture] || [];
    const byKind = (k) => cases.find(c => c.kind === k);
    const sym = SYMBOL[fixture];
    const tasks = {};
    if (sym) tasks.symbol = {
        prompt: `Explore and summarize how \`${sym.target}\` (a ${sym.kind}) works in this codebase. Then (1) identify exactly where and how it is used, (2) map its dependencies, and (3) determine its blast radius — what would break if its signature changed.`,
        answerKeys: sym.answerKeys, target: sym.target,
    };
    const b = byKind('nl'); if (b) tasks.behaviour = { prompt: `Find and explain the code that does this (you are NOT given its name): ${b.query}.`, answerKeys: asKeys(b.expect), query: b.query };
    const k = byKind('kw'); if (k) tasks.keyword = { prompt: `Locate the code for: ${k.query}. Identify the responsible symbol and where it is used.`, answerKeys: asKeys(k.expect), query: k.query };
    const x = byKind('xc'); if (x) tasks.crosscut = { prompt: `Investigate this concern across the codebase: ${x.query}. Explain how it works and which components participate.`, answerKeys: asKeys(x.expect), query: x.query };
    return { fixture, language: LANGUAGE[fixture], layers: LAYERS[fixture], tasks };
});

function asKeys(expect) {
    const arr = Array.isArray(expect) ? expect : [expect];
    return [...new Set(arr.flatMap(e => [e.name, e.file].filter(Boolean)))];
}

export const ARCHETYPES = ['symbol', 'behaviour', 'keyword', 'crosscut'];
