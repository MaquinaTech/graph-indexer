/**
 * @file mcp/topology.mjs
 * @description MCP topology helpers: caller classification, symbol references,
 *              route mapping, connected-subgraph traversal, and HyDE.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { isNaturalLanguageQuery } from '../search-core.mjs';
import { extractSignatureLine } from './format.mjs';

// ─── Low-confidence handoff ───────────────────────────────────────────────────
// The dominant failure mode for behavioural queries is "didn't nail the exact
// symbol" — yet most of those misses still land the correct FILE in the top
// results. When a natural-language query yields no dominant match, surfacing the
// distinct candidate files lets the agent `get_file_skeleton` them instead of
// reading whole files blind. The gate is derived entirely from the returned
// ranking (no extra work, a few tokens) and is deliberately conservative so it
// NEVER fires on a confident symbolic hit:
//   • a pinned `exact_tokens` → the caller already knows the symbol;
//   • a keyword / symbol-lookup query (not natural language) → rank-1-dominant;
//   • a top result that clearly separates from #2 (≥2× the fused score, the same
//     factor as the exact-name boost) → a dominant match;
//   • results confined to a single file → nothing cross-file to hand off.
// The 2× separation maps to fuseAndRank's exact-name boost multiplier — it is a
// structural constant, not a value fit to the benchmark queries.
export function assessConfidence(matches, fullQuery, exactPinned, limit = 5) {
    const distinctFiles = [];
    const seen = new Set();
    for (const m of matches) {
        const fp = m?.chunk?.file_path;
        if (fp && !seen.has(fp)) { seen.add(fp); distinctFiles.push(fp); }
    }
    const dominates = matches.length >= 2 && matches[0].score >= 2 * matches[1].score;
    const lowConfidence = !exactPinned
        && isNaturalLanguageQuery(fullQuery)
        && matches.length >= 2
        && !dominates
        && distinctFiles.length >= 2;
    return { lowConfidence, candidateFiles: lowConfidence ? distinctFiles.slice(0, limit) : [] };
}

// ─── Query-side HyDE (opt-in) ─────────────────────────────────────────────────
// Behavioural queries often share NO vocabulary with the code that answers them.
// HyDE (Hypothetical Document Embeddings) closes that gap on the QUERY side: a
// local LLM writes a short hypothetical implementation of the request, we embed
// THAT, and blend it with the raw query vector (never replace it — the raw query
// is the anchor). The chunk side already does this via chunk.hyde/summaries; this
// is its query-time complement. Gated off by default → when disabled, search is
// byte-identical and the eval/parity are untouched. Per-query result is cached for
// the process lifetime so repeated queries pay the generation cost once.
const HYDE_ALPHA = 0.5;          // blend weight on the hypothetical vector (0 = pure query, 1 = pure HyDE)
const _hydeCache = new Map();    // normalized query → blended Float32Array

// ─── Repo-language detection (drives the language-aware HyDE prompt) ───────────
const _EXT_FAMILY = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    py: 'python', go: 'go', rs: 'rust', java: 'java',
    kt: 'kotlin', kts: 'kotlin', cs: 'csharp', rb: 'ruby', php: 'php',
    swift: 'swift', c: 'c', h: 'c',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    scss: 'scss', css: 'scss', sass: 'scss',
};
const _LARAVEL_DIRS = new Set([
    'models', 'http', 'controllers', 'console', 'providers',
    'middleware', 'requests', 'builders', 'repositories', 'services',
]);

/**
 * Pick the canonical language/framework key for a repo from its index stats.
 * @param {Map<string, number>} extCounts  extension → chunk count (db.stats().extCounts)
 * @param {Iterable<{file_path?:string}>} chunksIterable  bounded path scan (db.iterateChunks())
 * @returns {string|null} one of typescript|javascript|python|go|rust|java-spring|java|
 *   kotlin|csharp|ruby|php-laravel|php|swift|c|bash|scss, or null when ambiguous/unknown
 *   (null → buildHydePrompt falls back to the generic, never-regressing prompt).
 */
export function detectRepoLanguage(extCounts, chunksIterable = []) {
    const score = new Map();
    if (extCounts && typeof extCounts.forEach === 'function') {
        for (const [ext, n] of extCounts) {
            const fam = _EXT_FAMILY[String(ext).toLowerCase()];
            if (fam) score.set(fam, (score.get(fam) || 0) + n);
        }
    }
    if (score.size === 0) return null;

    let springSignal = false;
    const laravelDirs = new Set();
    let laravelKw = false;
    let scanned = 0;
    for (const chunk of (chunksIterable || [])) {
        if (scanned++ >= 400) break;
        const fp = String(chunk?.file_path || '').toLowerCase();
        if (!fp) continue;
        if (fp.includes('springframework')) springSignal = true;
        for (const seg of fp.split('/')) {
            if (_LARAVEL_DIRS.has(seg)) laravelDirs.add(seg);
            if (seg === 'laravel' || seg === 'eloquent' || seg === 'artisan' || seg === 'symfony') laravelKw = true;
        }
    }

        const ts = score.get('typescript') || 0;
    const js = score.get('javascript') || 0;
    const web = ts + js;
    const ranking = [];
    for (const [fam, n] of score) {
        if (fam === 'typescript' || fam === 'javascript') continue;
        ranking.push([fam, n]);
    }
    if (web > 0) ranking.push(['web', web]);
    ranking.sort((a, b) => b[1] - a[1]);
    const [topFam, topScore] = ranking[0];
    const secondScore = ranking[1]?.[1] ?? 0;

    if ((score.get('java') || 0) > 0 && springSignal) return 'java-spring';

    if (secondScore > 0 && secondScore >= 0.9 * topScore) return null;

    if (topFam === 'web') return ts >= 0.6 * web ? 'typescript' : 'javascript';
    if (topFam === 'php') return (laravelKw || laravelDirs.size >= 2) ? 'php-laravel' : 'php';
    if (topFam === 'java') return springSignal ? 'java-spring' : 'java';
    return topFam;
}

// HyDE must never degrade below no-HyDE when language is unknown/ambiguous.
function _genericHydePrompt(query) {
    return (
        `Write a short, realistic code snippet (5-15 lines, any language) that implements or `
        + `directly answers the request below. Output ONLY code — no prose, no markdown fences, `
        + `no comments explaining yourself.\n\nRequest: ${query}\n\nCode:`
    );
}

const _HYDE_LANG = {
    typescript: {
        name: 'TypeScript',
        idioms: 'Match NestJS/React idioms: @Injectable/@Controller providers with constructor injection (private readonly svc: Service) and async handlers, or a React FC using useState/useEffect with a typed props interface.',
        primer: 'export ',
    },
    javascript: {
        name: 'JavaScript',
        idioms: 'Match Axios/Express idioms: middleware (req, res, next), router.get/post, module.exports, request/response interceptors, and promise chains.',
        primer: 'const ',
    },
    python: {
        name: 'Python',
        idioms: 'Match FastAPI/Django idioms: @router.get/@router.post async handlers with Depends() and Pydantic BaseModel, or Django class-based views and models with CharField/ForeignKey and QuerySet .filter()/.select_related().',
        primer: 'async def ',
    },
    go: {
        name: 'Go',
        idioms: 'Match Gin idioms: handlers func(c *gin.Context) calling c.JSON(http.StatusOK, ...) and c.ShouldBindJSON(&req), middleware as gin.HandlerFunc, and router groups r.Group("/api").',
        primer: 'func ',
    },
    rust: {
        name: 'Rust',
        idioms: 'Match idiomatic Rust: pub struct/trait definitions, impl blocks, #[derive(Debug, Clone)], Result/Option return types, match arms, and use crate:: imports.',
        primer: 'pub ',
    },
    'java-spring': {
        name: 'Java (Spring Boot)',
        idioms: 'Match Spring Boot idioms: @Service/@Repository/@RestController annotations, constructor injection, @Transactional, ResponseEntity<T>, JpaRepository<Entity, ID>, and @GetMapping/@PostMapping.',
        primer: 'import org.springframework.',
    },
    java: {
        name: 'Java',
        idioms: 'Match standard Java idioms: class/interface definitions, generics, Optional<T>, try/catch, and stream().filter().map().collect().',
        primer: 'public class ',
    },
    kotlin: {
        name: 'Kotlin (Android)',
        idioms: 'Match Android/Kotlin idioms: ViewModel with LiveData/StateFlow, coroutines (suspend fun, viewModelScope.launch), Hilt injection (@HiltViewModel, @Inject constructor), and companion object.',
        primer: 'class ',
    },
    csharp: {
        name: 'C# (ASP.NET Core)',
        idioms: 'Match ASP.NET Core idioms: [ApiController]/[Route] controllers, async Task<IActionResult>, [HttpGet]/[HttpPost], ILogger<T> injection, and Entity Framework (.Include, .Where, .FirstOrDefaultAsync).',
        primer: 'public class ',
    },
    ruby: {
        name: 'Ruby (Rails)',
        idioms: 'Match Rails idioms: ActiveRecord models (belongs_to, has_many, scope, validate), controller actions (def index/show/create) with before_action, and render json:.',
        primer: 'class ',
    },
    'php-laravel': {
        name: 'PHP (Laravel/Symfony)',
        idioms: 'Match Laravel idioms: Eloquent models (extends Model, $fillable, hasMany/belongsTo), Service classes with constructor injection, Controllers extending Controller, Artisan commands (extends Command, handle()), and Facades (Route::, Auth::). For Symfony use #[Route] attributes and autowired services.',
        primer: '<?php\n\nnamespace App\\',
    },
    php: {
        name: 'PHP',
        idioms: 'Match idiomatic PHP: namespaced classes, typed properties and method signatures, constructor injection, and interface implementations.',
        primer: '<?php\n\n',
    },
    swift: {
        name: 'Swift',
        idioms: 'Match Swift/Alamofire idioms: AF.request(...).responseDecodable, Session, RequestInterceptor/EventMonitor, Result<T, Error> completion handlers, @discardableResult, and protocol conformances.',
        primer: 'public ',
    },
    c: {
        name: 'C',
        idioms: 'Match idiomatic C: function definitions with pointer parameters, struct definitions, malloc/free with NULL checks, and a typed C API (e.g. cJSON_Parse, cJSON_GetObjectItem, cJSON_CreateObject).',
        primer: 'static ',
    },
    bash: {
        name: 'Bash',
        idioms: 'Match idiomatic Bash: function definitions name() { ... }, local variables, case statements, [[ ]] conditionals, $() command substitution, and return 0/1.',
        primer: null,
    },
    scss: {
        name: 'SCSS',
        idioms: 'Match idiomatic SCSS: @mixin definitions used via @include, nested selectors, $variable declarations, @extend, and &:hover/&:focus patterns.',
        primer: null,
    },
};

export function buildHydePrompt(query, lang = null) {
    const spec = lang ? _HYDE_LANG[lang] : null;
    if (!spec) return _genericHydePrompt(query);
    const primer = spec.primer ?? `${spec.name} code:\n`;
    return (
        `Write a short, realistic ${spec.name} code snippet (5-15 lines) that implements or `
        + `directly answers the request below. ${spec.idioms} Output ONLY code — no prose, `
        + `no markdown fences, no comments explaining yourself.\n\nRequest: ${query}\n\n${primer}`
    );
}

export function blendVectors(a, b, alpha = HYDE_ALPHA) {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = (1 - alpha) * a[i] + alpha * b[i];
    return out;
}

/**
 * Augment a query vector with a hypothetical-snippet embedding. Best-effort: any
 * failure (generator down, dim mismatch, empty snippet) returns the raw vector
 * unchanged, so HyDE can never degrade a query below the no-HyDE baseline.
 */
export async function hydeQueryVector(query, rawVec, { embedder, generate, lang = null }) {
    if (!rawVec || !embedder || !generate) return rawVec;
    const norm = query.trim().toLowerCase();
    if (_hydeCache.has(norm)) return _hydeCache.get(norm);
    let blended = rawVec;
    try {
        const snippet = await generate(buildHydePrompt(query, lang));
        if (snippet && snippet.trim()) {
            const hydeVec = await embedder.embedQuery(snippet.slice(0, 2000));
            if (hydeVec && hydeVec.length === rawVec.length) blended = blendVectors(rawVec, hydeVec);
        }
    } catch { /* keep the raw vector */ }
    _hydeCache.set(norm, blended);
    return blended;
}

/** Lowercased capitalized type tokens from a type / return-type string —
 *  "Promise<OrderRepo>" → ["promise","orderrepo"]. Lets an inferred receiver type
 *  (parse/metadata.mjs attaches recv_type / recv_via_call to call sites) be matched
 *  against a target method's defining class without parsing the type grammar. */
function _typeMatchTokens(str) {
    const out = [];
    if (!str) return out;
    for (const m of String(str).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []) {
        if (/^[A-Z]/.test(m)) out.push(m.toLowerCase());
    }
    return out;
}

// ─── Call-graph confidence (precise blast radius) ────────────────────────────────

/**
 * Split the bare name-match callers of a function into **high-confidence** (the
 * real blast radius) vs **name-only** (an ambiguous same-named symbol elsewhere).
 *
 * The call graph matches by callee name, so `get_call_graph("save")` otherwise
 * returns callers of *every* `save()` in the repo. This re-classifies them using
 * only cheap, index-time signals — no type inference:
 *   • target uniqueness  — one symbol named X ⇒ every caller is unambiguous;
 *   • receiver hints      — `this.X` from the same class, or a direct `X()` to a
 *                           free function (captured by parse/metadata.mjs extractCallSites);
 *   • the file import graph — a caller whose file imports the file defining X is
 *                            very likely calling that X.
 * `targetClass` scopes the question to one class's method.
 *
 * @returns {{ high:Array, nameOnly:Array, targetDefs:object[], ambiguous:boolean,
 *             hasSiteData:boolean, classFiltered:boolean }}
 *          high/nameOnly items are { chunk, reason, recvHint }.
 */
export function classifyCallers(db, targetFunction, { targetClass = null } = {}) {
    const callers = db.findCallers(targetFunction);
    const allDefs = db.resolveSymbol(targetFunction);
    let targetDefs = allDefs;

    let classFiltered = false;
    if (targetClass) {
        const tcl = String(targetClass).toLowerCase();
        const scoped = allDefs.filter(d => (d.class_context || '').toLowerCase() === tcl);
        if (scoped.length) { targetDefs = scoped; classFiltered = true; }
    }

    const targetClasses = new Set(targetDefs.map(d => (d.class_context || '').toLowerCase()).filter(Boolean));
    const targetFiles = new Set(targetDefs.map(d => d.file_path));
    const targetIsFreeFn = targetDefs.some(d => !d.class_context);
    const uniqueTarget = targetDefs.length <= 1;
    const ambiguous = allDefs.length > 1;
    const tcl = targetClass ? String(targetClass).toLowerCase() : null;

    // Receiver-type promotion: a caller through a typed/inferred receiver whose type is
    // the class that defines the target method is a real caller, even though its raw
    // receiver hint is a variable name (`const s = getStore(); s.save()`). Match the
    // inferred type against the target's defining class(es) — or an explicit target
    // class. recv_via_call factories are resolved to their recorded return type here,
    // at query time, so no extra index state is needed (memoised per call).
    const typeMatchSet = new Set(targetClasses);
    if (tcl) typeMatchSet.add(tcl);
    const classDisplay = new Map();
    for (const d of targetDefs) { const c = d.class_context; if (c) classDisplay.set(c.toLowerCase(), c); }
    if (targetClass) classDisplay.set(String(targetClass).toLowerCase(), String(targetClass));
    const returnTokenCache = new Map();
    const calleeReturnTokens = (callee) => {
        if (returnTokenCache.has(callee)) return returnTokenCache.get(callee);
        const toks = new Set();
        for (const def of db.resolveSymbol(callee) || []) for (const t of _typeMatchTokens(def.return_type)) toks.add(t);
        returnTokenCache.set(callee, toks);
        return toks;
    };

    let hasSiteData = false;
    const high = [], nameOnly = [];

    for (const caller of callers) {
        const sites = (caller.call_sites || []).filter(s => s && s.name === targetFunction);
        if (sites.length) hasSiteData = true;
        const recvs = new Set(sites.map(s => s.recv));
        const callerClass = (caller.class_context || '').toLowerCase();
        const deps = db.getDependencies(caller.file_path) || [];

        // First site whose inferred receiver type names a target class (lowercased token).
        let typeMatch = null;
        if (typeMatchSet.size) {
            for (const s of sites) {
                // Precedence: intra-procedural receiver type → the opt-in inter-procedural
                // fixpoint result (recv_resolved_type, written at index time) → the 1-hop
                // query-time factory return-type fallback. The fixpoint resolves multi-hop /
                // unannotated factory chains the 1-hop path cannot.
                const toks = s.recv_type ? _typeMatchTokens(s.recv_type)
                    : s.recv_resolved_type ? _typeMatchTokens(s.recv_resolved_type)
                        : s.recv_via_call ? [...calleeReturnTokens(s.recv_via_call)] : null;
                const m = toks && toks.find(t => typeMatchSet.has(t));
                if (m) { typeMatch = m; break; }
            }
        }

        let reason = '';
        if (uniqueTarget && !classFiltered) reason = 'sole definition';
        else if (recvs.has('this') && callerClass && targetClasses.has(callerClass)) reason = `this.${targetFunction}()`;
        else if (recvs.has('') && targetIsFreeFn) reason = `${targetFunction}()`;
        else if (typeMatch) reason = `${classDisplay.get(typeMatch) || typeMatch}.${targetFunction}()`;
        else if (deps.some(d => targetFiles.has(d))) reason = 'imports definition';
        else if (targetFiles.has(caller.file_path)) reason = 'same file';
        else if (tcl && [...recvs].some(r => r && r.toLowerCase() === tcl)) reason = `${targetClass}.${targetFunction}()`;

        const recvHint = [...recvs].map(r =>
            r === '' ? `${targetFunction}()` : r === 'this' ? `this.${targetFunction}()` : `${r}.${targetFunction}()`
        ).join(', ');

        (reason ? high : nameOnly).push({ chunk: caller, reason, recvHint });
    }

    return { high, nameOnly, targetDefs, ambiguous, hasSiteData, classFiltered };
}

// ─── Symbol-level references (file→file topology, sharpened to symbol→symbol) ─────

/**
 * Resolve *which symbols* reference a target symbol — not just which files. Fuses
 * the three reference kinds the index records and classifies each by confidence
 * using the same cheap, index-time signals as the call graph (no type inference):
 *
 *   • calls    — `findCallers` + classifyCallers (high / name-only blast radius);
 *   • inherits — chunks whose `extends` names the symbol (subclasses / implementers);
 *   • types    — chunks whose `type_refs` names the symbol (params, returns, fields).
 *
 * For the non-call kinds, a referer is **high-confidence** when the target is the
 * sole definition, the referer's file imports a file that defines it, or it is
 * defined in the same file; otherwise it is **name-only** (a same-named symbol
 * may be meant). This is the symbol-granular "used by" that file-level topology
 * (getImportedBy) can only approximate.
 *
 * @returns {{ symbol:string, targetDefs:object[], ambiguous:boolean,
 *             calls:ReturnType<typeof classifyCallers>,
 *             inherits:Array, types:Array }}
 *          inherits/types items are { chunk, confidence, reason }.
 */
export function findReferences(db, symbol, { targetClass = null } = {}) {
    const calls = classifyCallers(db, symbol, { targetClass });
    const { targetDefs, ambiguous } = calls;
    const targetFiles = new Set(targetDefs.map(d => d.file_path));
    const uniqueTarget = targetDefs.length <= 1;
    const key = String(symbol).toLowerCase().trim();

    const inherits = [], types = [];
    for (const ref of db.findReferers(symbol)) {
        const deps = db.getDependencies(ref.file_path) || [];
        const imports = deps.some(d => targetFiles.has(d));
        const sameFile = targetFiles.has(ref.file_path);
        const reason = uniqueTarget ? 'sole definition'
            : imports ? 'imports definition'
                : sameFile ? 'same file' : '';
        const confidence = reason ? 'high' : 'name-only';
        if ((ref.extends || []).some(t => t.toLowerCase() === key)) inherits.push({ chunk: ref, confidence, reason });
        if ((ref.type_refs || []).some(t => t.toLowerCase() === key)) types.push({ chunk: ref, confidence, reason });
    }
    const order = (a, b) => (a.confidence === b.confidence
        ? a.chunk.file_path.localeCompare(b.chunk.file_path)
        : a.confidence === 'high' ? -1 : 1);
    inherits.sort(order); types.sort(order);

    return { symbol, targetDefs, ambiguous, calls, inherits, types };
}

// ─── HTTP route → handler resolution ──────────────────────────────────────────────

/**
 * HTTP routes mapped to their handler chunks. Pure helper over the store contract
 * (`db.findRoutes`), so it is backend-agnostic and importable by tests/agent-trace.
 *
 * Filtering:
 *   • method — optional HTTP verb, case-insensitive (GET/POST/…); omitted = all.
 *   • path   — a query starting with '/' is a PREFIX match (uses the backend's
 *              indexed prefix filter); one containing '{' or ':' (a route-pattern
 *              hint) — or any other non-'/' query — is a CONTAINS match.
 *
 * Each result inlines the handler chunk's id/name/node_type/start_line/end_line
 * (null when the handler isn't a chunk). Deterministically sorted (file_path, line,
 * method, path) so the in-memory and SQLite backends return byte-identical output.
 *
 * @returns {Array<{method,path,handler_name,handler_chunk_id,file_path,line,framework,
 *                  name,node_type,start_line,end_line,id}>}
 */
export function findRoutes(db, { method = null, path: pathQuery = null } = {}) {
    const isPrefix = typeof pathQuery === 'string' && pathQuery.startsWith('/');
    const base = db.findRoutes({ method: method || null, pathPrefix: isPrefix ? pathQuery : null });
    const needle = (typeof pathQuery === 'string' && pathQuery && !isPrefix) ? pathQuery.toLowerCase() : null;
    const rows = (needle ? base.filter(r => String(r.path || '').toLowerCase().includes(needle)) : base)
        .map(r => {
            const c = r.chunk || null;
            return {
                method: r.method, path: r.path, handler_name: r.handler_name,
                handler_chunk_id: r.handler_chunk_id, file_path: r.file_path,
                line: r.line, framework: r.framework,
                name: c?.name ?? null, node_type: c?.node_type ?? null,
                start_line: c?.start_line ?? null, end_line: c?.end_line ?? null,
                id: c?.id ?? null,
            };
        });
    rows.sort((a, b) =>
        (a.file_path < b.file_path ? -1 : a.file_path > b.file_path ? 1 : 0)
        || ((a.line || 0) - (b.line || 0))
        || (a.method < b.method ? -1 : a.method > b.method ? 1 : 0)
        || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return rows;
}

// ─── Bounded connected-subgraph traversal (multi-hop in one call) ─────────────────

/** ~tokens for a node card (1 token ≈ 4 chars). */
function _subgraphCardTokens(c) {
    return Math.ceil(`${c.class_context ? c.class_context + '.' : ''}${c.name} [${c.node_type}] ${c.file_path}:${c.start_line}-${c.end_line} ${extractSignatureLine(c.code_snippet).split('\n')[0]}`.length / 4);
}

/** Stable order so the subgraph is byte-identical across backends and runs. */
function _subgraphSort(arr) {
    return arr.slice().sort((a, b) =>
        (a.file_path < b.file_path ? -1 : a.file_path > b.file_path ? 1 : 0)
        || (a.start_line - b.start_line)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Breadth-first connected subgraph around a seed symbol — callees (what it calls),
 * high-confidence callers (the precise blast radius, via classifyCallers), and
 * type/inheritance referers — bounded by node count, hop depth AND a token budget.
 * One call replaces the search_code → get_call_graph → find_references round-trips a
 * "trace this flow across files" task otherwise needs. Reuses only index-time signals
 * (no type inference); fully deterministic (every neighbour list is sorted, ties broken
 * on id) so it is reproducible and backend-agnostic.
 *
 * @returns {{ seed:string, found:boolean, truncated:boolean,
 *             nodes:Array<{id,name,node_type,class_context,file_path,start_line,end_line,signature,depth}>,
 *             edges:Array<{from:string,to:string,kind:'calls'|'references'}> }}
 */
export function buildSubgraph(db, seed, { maxNodes = 12, maxDepth = 2, tokenBudget = null } = {}) {
    const seedDefs = db.resolveSymbol(seed);
    if (seedDefs.length === 0) return { seed, found: false, truncated: false, nodes: [], edges: [] };

    const nodes = new Map();           // id → { chunk, depth }
    const edges = [];
    const edgeSeen = new Set();
    let budget = (tokenBudget != null && tokenBudget > 0) ? tokenBudget : Infinity;
    let truncated = false;

    const addEdge = (from, to, kind) => {
        if (!from || !to || from === to) return;
        const k = `${from} ${to} ${kind}`;
        if (!edgeSeen.has(k)) { edgeSeen.add(k); edges.push({ from, to, kind }); }
    };
    const tryAdd = (c, depth) => {
        if (!c) return false;
        if (nodes.has(c.id)) return false;
        if (nodes.size >= maxNodes) { truncated = true; return false; }
        const t = _subgraphCardTokens(c);
        if (nodes.size > 0 && t > budget) { truncated = true; return false; }
        nodes.set(c.id, { chunk: c, depth });
        budget -= t;
        return true;
    };

    const queue = [];
    for (const d of _subgraphSort(seedDefs)) if (tryAdd(d, 0)) queue.push(d.id);

    for (let head = 0; head < queue.length; head++) {
        const entry = nodes.get(queue[head]);
        if (!entry || entry.depth >= maxDepth) continue;
        const chunk = entry.chunk;
        const d = entry.depth + 1;

        for (const name of [...new Set(chunk.calls || [])].sort()) {
            const defs = db.resolveSymbol(name);
            if (!defs.length) continue;
            const target = _subgraphSort(defs)[0];
            const added = tryAdd(target, d);
            if (nodes.has(target.id)) addEdge(chunk.id, target.id, 'calls');
            if (added) queue.push(target.id);
        }
        if (chunk.name && chunk.name !== 'anonymous') {
            for (const caller of _subgraphSort(classifyCallers(db, chunk.name).high.map(h => h.chunk))) {
                const added = tryAdd(caller, d);
                if (nodes.has(caller.id)) addEdge(caller.id, chunk.id, 'calls');
                if (added) queue.push(caller.id);
            }
            for (const ref of _subgraphSort(db.findReferers(chunk.name))) {
                const added = tryAdd(ref, d);
                if (nodes.has(ref.id)) addEdge(ref.id, chunk.id, 'references');
                if (added) queue.push(ref.id);
            }
        }
    }

    const nodeList = [...nodes.values()].map(({ chunk: c, depth }) => ({
        id: c.id, name: c.name, node_type: c.node_type, class_context: c.class_context || null,
        file_path: c.file_path, start_line: c.start_line, end_line: c.end_line,
        signature: extractSignatureLine(c.code_snippet).split('\n')[0].trim().slice(0, 120), depth,
    }));
    return { seed, found: true, truncated, nodes: nodeList, edges };
}

/**
 * Reverse-direction transitive blast radius (C4): from a set of seed chunks (the symbols /
 * files about to change), the transitively-affected REFERRERS — callers, subclasses, and type
 * users — bounded by hop depth and node count.
 *
 * Uses the persistent symbol graph (getEdges) when present — precise and chunk-level — and
 * otherwise falls back to query-time classifyCallers / findReferences. HIGH-confidence
 * referrers drive the transitive closure (a precise blast radius that does not explode on
 * ambiguous names); the DIRECT name_only referrers of the seed are surfaced separately for the
 * agent to verify. Fully deterministic (every list is sorted: depth, file, line, id).
 *
 * @param {object} db
 * @param {object[]} seedChunks  The chunks being changed.
 * @param {object} [opts]
 * @param {number} [opts.maxDepth]  Transitive hops to follow (default 3).
 * @param {number} [opts.maxNodes]  Cap on impacted chunks (default 200).
 * @returns {{ impacted:Array<{chunk,depth,kind}>, ambiguous:Array<{chunk,kind}>,
 *             truncated:boolean, usedGraph:boolean }}
 */
export function buildImpact(db, seedChunks, { maxDepth = 3, maxNodes = 200 } = {}) {
    const hasGraph = typeof db.hasSymbolGraph === 'function' && db.hasSymbolGraph();
    const seedIds = new Set(seedChunks.map(c => c.id));

    const highReferrers = (chunk) => {
        const out = [];
        if (hasGraph) {
            for (const e of db.getEdges(chunk.id, { direction: 'in' }))
                if (e.chunk && e.confidence === 'high') out.push({ chunk: e.chunk, kind: e.kind });
            return out;
        }
        if (!chunk.name || chunk.name === 'anonymous') return out;
        const tcl = chunk.class_context || null;
        const seen = new Set();
        for (const h of classifyCallers(db, chunk.name, { targetClass: tcl }).high)
            if (!seen.has(h.chunk.id)) { seen.add(h.chunk.id); out.push({ chunk: h.chunk, kind: 'calls' }); }
        const refs = findReferences(db, chunk.name, { targetClass: tcl });
        for (const r of refs.inherits) if (r.confidence === 'high' && !seen.has(r.chunk.id)) { seen.add(r.chunk.id); out.push({ chunk: r.chunk, kind: 'extends' }); }
        for (const r of refs.types) if (r.confidence === 'high' && !seen.has(r.chunk.id)) { seen.add(r.chunk.id); out.push({ chunk: r.chunk, kind: 'type' }); }
        return out;
    };
    const nameOnlyReferrers = (chunk) => {
        const out = [];
        if (hasGraph) {
            for (const e of db.getEdges(chunk.id, { direction: 'in' }))
                if (e.chunk && e.confidence === 'name_only') out.push({ chunk: e.chunk, kind: e.kind });
            return out;
        }
        if (!chunk.name || chunk.name === 'anonymous') return out;
        for (const n of classifyCallers(db, chunk.name, { targetClass: chunk.class_context || null }).nameOnly)
            out.push({ chunk: n.chunk, kind: 'calls' });
        return out;
    };

    const ambiguous = new Map();
    for (const s of seedChunks) for (const r of nameOnlyReferrers(s))
        if (!seedIds.has(r.chunk.id) && !ambiguous.has(r.chunk.id)) ambiguous.set(r.chunk.id, r);

    const impacted = new Map();
    const visited = new Set(seedIds);
    let truncated = false;
    let frontier = seedChunks.map(c => ({ chunk: c }));
    for (let depth = 1; depth <= maxDepth && !truncated; depth++) {
        const next = [];
        for (const { chunk } of frontier) {
            for (const r of highReferrers(chunk)) {
                if (visited.has(r.chunk.id)) continue;
                if (impacted.size >= maxNodes) { truncated = true; break; }
                visited.add(r.chunk.id);
                impacted.set(r.chunk.id, { chunk: r.chunk, depth, kind: r.kind });
                next.push({ chunk: r.chunk });
            }
            if (truncated) break;
        }
        if (next.length === 0) break;
        frontier = next;
    }

    const byPlace = (a, b) => (a.chunk.file_path < b.chunk.file_path ? -1 : a.chunk.file_path > b.chunk.file_path ? 1 : 0)
        || (a.chunk.start_line - b.chunk.start_line) || (a.chunk.id < b.chunk.id ? -1 : 1);
    const impactedList = [...impacted.values()].sort((a, b) => (a.depth - b.depth) || byPlace(a, b));
    const ambiguousList = [...ambiguous.values()].sort(byPlace);
    return { impacted: impactedList, ambiguous: ambiguousList, truncated, usedGraph: hasGraph };
}
