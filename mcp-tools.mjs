/**
 * @file mcp-tools.mjs
 * @description MCP tool definitions for graph-indexer. Every tool is written
 *              against the storage contract (see storage.mjs) — never a concrete
 *              backend — so the identical surface serves both the in-memory engine
 *              and the disk-backed SQLite store. `registerTools(server, db, opts)`
 *              wires them onto an McpServer instance.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { z } from 'zod';
import fs from 'fs';
import path, { resolve } from 'path';
import { computePageRank, isNaturalLanguageQuery } from './search-core.mjs';
import { getParserForFile, extractFileSkeleton } from './parser-utils.mjs';
import { describeEmbedder } from './embeddings.mjs';
import { rerankResults, ollamaGenerate } from './enrichment.mjs';
import { coChangesFor, gitBoostScore, computeFreshness, currentGitState } from './git-signals.mjs';

// ─── Rendering helpers ──────────────────────────────────────────────────────────

/** Extract just the function signature (first lines up to the opening brace). */
export function extractSignatureLine(codeSnippet) {
    if (!codeSnippet) return '';
    const lines = codeSnippet.split('\n');
    const sigLines = [];
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
        sigLines.push(lines[i]);
        const l = lines[i];
        if (i > 0 && (l.trimEnd().endsWith('{') || l.includes('=>') || l.trimEnd().endsWith(':'))) break;
    }
    return sigLines.join('\n');
}

/**
 * Prune a function body: keep signature + query-relevant lines + tail.
 *
 * Semantic fallback: when no lexical token matches (the agent used a high-level
 * description like "authentication bottleneck" that isn't in the code verbatim),
 * preserve the structural skeleton — control-flow lines and calls — rather than
 * blindly truncating, so 'smart' detail always returns meaningful context.
 */
export function pruneBodyByQuery(codeSnippet, queryTokens, maxLines = 40) {
    if (!codeSnippet) return '';
    const lines = codeSnippet.split('\n');
    if (lines.length <= maxLines) return codeSnippet;

    const querySet = new Set(queryTokens.filter(t => t.length >= 3).map(t => t.toLowerCase()));
    if (querySet.size === 0) return lines.slice(0, maxLines).join('\n') + '\n// …';

    const SIG_LINES = Math.min(5, lines.length);
    const TAIL_LINES = Math.min(3, lines.length);
    const sigBlock = lines.slice(0, SIG_LINES);
    const tailBlock = lines.slice(Math.max(lines.length - TAIL_LINES, SIG_LINES));

    const bodyLines = lines.slice(SIG_LINES, lines.length - TAIL_LINES);
    const relevant = bodyLines.filter(line => {
        const ll = line.toLowerCase();
        if (/^\s*(return|throw|raise|yield)\b/.test(ll)) return true;
        return [...querySet].some(token => ll.includes(token));
    });

    if (relevant.length === 0) {
        const budget = Math.max(4, maxLines - SIG_LINES - TAIL_LINES);
        const structural = bodyLines.filter(line => {
            const ll = line.trimStart().toLowerCase();
            if (/^(if |else |for |while |switch |try |catch |finally |return |throw |raise |yield |await )/.test(ll)) return true;
            if (/[a-zA-Z_]\w*\s*\(/.test(line) && line.trim().length > 4) return true;
            return false;
        }).slice(0, budget);
        if (structural.length > 0) return [...sigBlock, ...structural, ...tailBlock].join('\n');
        return lines.slice(0, maxLines).join('\n') + '\n// …';
    }
    return [...sigBlock, ...relevant, ...tailBlock].join('\n');
}

// ─── Structured (JSON) output helpers ────────────────────────────────────────────

/**
 * Wrap a structured payload as an MCP tool result. The JSON is emitted as a text
 * block (so every client can read it) AND as `structuredContent` (so SDK-aware
 * clients get typed fields without parsing prose). No outputSchema is declared,
 * so the SDK passes structuredContent through without validation.
 */
function jsonResult(payload) {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
    };
}

/** Typed projection of a chunk for JSON output (no code body unless asked). */
function chunkCard(chunk) {
    return {
        id: chunk.id,
        name: chunk.name,
        node_type: chunk.node_type,
        file_path: chunk.file_path,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        class_context: chunk.class_context || null,
        params: chunk.params || [],
        return_type: chunk.return_type || null,
        type_refs: chunk.type_refs || [],
        decorators: chunk.decorators || [],
        extends: chunk.extends || [],
        docstring: chunk.docstring || null,
        calls: chunk.calls || [],
    };
}

/**
 * Files that historically change together with the target's file(s) — a git
 * blast-radius hint. Aggregates co-change across all defining files, drops the
 * target's own files, and returns the strongest partners. Empty when no signals.
 */
function coChangeFiles(gitSignals, files, limit = 5) {
    if (!gitSignals) return [];
    const own = new Set(files);
    const agg = new Map();
    for (const f of files) {
        for (const { file, count } of coChangesFor(gitSignals, f, limit)) {
            if (own.has(file)) continue;
            agg.set(file, Math.max(agg.get(file) || 0, count));
        }
    }
    return [...agg.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([file, count]) => ({ file, count }));
}

/** One-line git co-change blast-radius hint for markdown output. */
function coChangeLine(coChanges) {
    return `🔄 Historically changes with: ${coChanges.map(c => `\`${c.file}\` (${c.count}×)`).join(', ')}`;
}

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

export function buildHydePrompt(query) {
    return (
        `Write a short, realistic code snippet (5-15 lines, any language) that implements or `
        + `directly answers the request below. Output ONLY code — no prose, no markdown fences, `
        + `no comments explaining yourself.\n\nRequest: ${query}\n\nCode:`
    );
}

/** Blend two vectors (cosine normalises magnitude, so only the direction matters). */
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
export async function hydeQueryVector(query, rawVec, { embedder, generate }) {
    if (!rawVec || !embedder || !generate) return rawVec;
    const norm = query.trim().toLowerCase();
    if (_hydeCache.has(norm)) return _hydeCache.get(norm);
    let blended = rawVec;
    try {
        const snippet = await generate(buildHydePrompt(query));
        if (snippet && snippet.trim()) {
            const hydeVec = await embedder.embedQuery(snippet.slice(0, 2000));
            if (hydeVec && hydeVec.length === rawVec.length) blended = blendVectors(rawVec, hydeVec);
        }
    } catch { /* keep the raw vector */ }
    _hydeCache.set(norm, blended);
    return blended;
}

/** Typed projection of a referencing chunk (caller / subclass / type user). */
function refCard({ chunk, recvHint, reason, confidence }) {
    return {
        id: chunk.id,
        name: chunk.name,
        node_type: chunk.node_type,
        class_context: chunk.class_context || null,
        file_path: chunk.file_path,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        via: recvHint || null,
        confidence: confidence || (reason ? 'high' : 'name-only'),
        reason: reason || null,
    };
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
 *                           free function (captured by parser-utils.extractCallSites);
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

    let hasSiteData = false;
    const high = [], nameOnly = [];

    for (const caller of callers) {
        const sites = (caller.call_sites || []).filter(s => s && s.name === targetFunction);
        if (sites.length) hasSiteData = true;
        const recvs = new Set(sites.map(s => s.recv));
        const callerClass = (caller.class_context || '').toLowerCase();
        const deps = db.getDependencies(caller.file_path) || [];

        let reason = '';
        if (uniqueTarget && !classFiltered) reason = 'sole definition';
        else if (recvs.has('this') && callerClass && targetClasses.has(callerClass)) reason = `this.${targetFunction}()`;
        else if (recvs.has('') && targetIsFreeFn) reason = `${targetFunction}()`;
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
    // High-confidence first, then by file for stable output.
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
        const k = `${from} ${to} ${kind}`;
        if (!edgeSeen.has(k)) { edgeSeen.add(k); edges.push({ from, to, kind }); }
    };
    // Add a node if it fits the node-count and token budgets. Returns true when newly added.
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

        // Callees: symbols this chunk calls (first matching def, deterministic).
        for (const name of [...new Set(chunk.calls || [])].sort()) {
            const defs = db.resolveSymbol(name);
            if (!defs.length) continue;
            const target = _subgraphSort(defs)[0];
            const added = tryAdd(target, d);
            if (nodes.has(target.id)) addEdge(chunk.id, target.id, 'calls');
            if (added) queue.push(target.id);
        }
        // High-confidence callers (real blast radius).
        if (chunk.name && chunk.name !== 'anonymous') {
            for (const caller of _subgraphSort(classifyCallers(db, chunk.name).high.map(h => h.chunk))) {
                const added = tryAdd(caller, d);
                if (nodes.has(caller.id)) addEdge(caller.id, chunk.id, 'calls');
                if (added) queue.push(caller.id);
            }
            // Type / inheritance referers.
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

// ─── Tool registration ──────────────────────────────────────────────────────────

/**
 * Register every graph-indexer tool on an MCP server.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {object} db    A loaded store implementing the storage contract.
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.artifactPath      Index file whose mtime represents freshness.
 * @param {string} opts.pidFile           Watch-daemon PID file (may not exist).
 * @param {boolean} opts.embeddingsEnabled
 * @param {object} [opts.embedder]        Query embedder (embeddings.createEmbedder); its
 *                                        provider/model must match the index that was built.
 * @param {{enabled:boolean, model:string, topM:number}} [opts.rerank] LLM rerank config.
 * @param {string} [opts.ollamaHost]      Ollama endpoint for the rerank judge.
 * @param {object|null} [opts.gitSignals] Loaded git-signals sidecar (churn/recency/co-change), or null.
 * @param {number} [opts.gitRankBoost]    0..1 opt-in recency/churn weight in search_code (0 = ranking unchanged).
 */
export function registerTools(server, db, { projectRoot, artifactPath, pidFile, embeddingsEnabled, embedder, rerank, hyde, ollamaHost = 'http://localhost:11434', gitSignals = null, gitRankBoost = 0 }) {

    // ── Index-freshness contract ──────────────────────────────────────────────
    // A stale call graph silently misleads the agent, so tool responses carry a
    // freshness signal: index age, the commit it was built at (git-signals stamp),
    // and whether the working tree has drifted since. Computed once per call
    // (cheap, cached git read). JSON always carries the structured `index` field;
    // the markdown footer is shown ONLY when the index is NOT fresh — so confident,
    // up-to-date cards keep their lean token size (no per-call bloat).
    const isDaemonAlive = () => {
        try {
            if (!pidFile || !fs.existsSync(pidFile)) return false;
            process.kill(parseInt(fs.readFileSync(pidFile, 'utf-8'), 10), 0);
            return true;
        } catch { return false; }
    };
    const indexFreshness = () => {
        let ageSeconds = null;
        try { ageSeconds = Math.floor((Date.now() - fs.statSync(artifactPath).mtimeMs) / 1000); } catch { /* no index file */ }
        return computeFreshness({
            ageSeconds,
            indexedCommit: gitSignals?.head ?? null,
            current: currentGitState(projectRoot),
            daemonRunning: isDaemonAlive(),
        });
    };
    /** Compact one-line freshness footer, or null when the index is fresh (keep cards lean). */
    const freshnessNote = (f) => {
        if (!f.stale && !f.syncing && !(f.pendingChanges > 0) && !f.commitMoved) return null;
        const bits = [`🕰 index ${f.ageLabel} old`];
        if (f.indexedCommit) bits.push(`built @ ${f.indexedCommit}`);
        if (f.pendingChanges > 0) bits.push(`${f.pendingChanges} uncommitted source change(s)`);
        if (f.commitMoved) bits.push(`HEAD now ${f.currentCommit}`);
        bits.push(f.stale
            ? '⚠️ STALE — results may miss recent edits; run `npm run mcp:index`'
            : 'daemon syncing…');
        return bits.join(' · ');
    };

    // ─── search_code ────────────────────────────────────────────────────────────
    server.tool(
        'search_code',
        'CRITICAL: ALWAYS USE THIS TOOL FIRST to find code. High-precision AST hybrid search returning exact chunks and cross-file topology.',
        {
            query: z.string().describe('Natural language description of the logic to find.'),
            exact_tokens: z.string().optional().describe('Exact symbol name for guaranteed rank-1 placement.'),
            include_topology: z.boolean().default(true),
            min_score: z.number().min(0).max(1).default(0.3),
            top_k: z.number().int().min(1).max(20).default(5),
            token_budget: z.number().int().min(100).optional().describe(
                'Token budget for code bodies (1 token ≈ 4 chars). Omit to use smart default.'
            ),
            detail: z.enum(['signatures', 'smart', 'full']).default('smart').describe(
                "'signatures': compact cards only (~20 tok each, no bodies) — fastest. "
                + "'smart' (default): signatures + query-relevant body snippets. "
                + "'full': signatures + complete bodies."
            ),
            rerank: z.boolean().optional().describe(
                'Rerank the top results with a local LLM judge (+50% rank-1 on '
                + 'natural-language queries, ~1–2 s extra). Defaults to the '
                + '`rerank.enabled` project config; only fires on NL queries.'
            ),
            hyde: z.boolean().optional().describe(
                'Query-side HyDE: generate a hypothetical code snippet for the query, '
                + 'embed it and blend with the query vector to bridge vocabulary gaps on '
                + 'behavioural queries (~1 s extra). Defaults to the `hyde.enabled` project '
                + 'config; only fires on NL queries with a vector channel.'
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default): token-efficient cards for an LLM to read. "
                + "'json': typed structured fields (id, file, lines, signature, topology, body) "
                + 'for programmatic clients — avoids parsing prose.'
            ),
        },
        async ({ query, exact_tokens, include_topology, min_score, top_k, token_budget, detail, rerank: rerankParam, hyde: hydeParam, response_format }) => {
            try {
                const fullQuery = exact_tokens ? `${query} ${exact_tokens}` : query;
                let queryVector = null;
                if (embedder) {
                    try { queryVector = await embedder.embedQuery(fullQuery); }
                    catch { /* lexical fallback */ }
                }

                // Opt-in query-side HyDE: blend a hypothetical-snippet embedding into
                // the query vector for natural-language queries (never when a symbol
                // is pinned). Off → queryVector is untouched (byte-identical search).
                const wantHyde = hydeParam ?? Boolean(hyde?.enabled);
                if (wantHyde && queryVector && !exact_tokens && isNaturalLanguageQuery(fullQuery)) {
                    queryVector = await hydeQueryVector(fullQuery, queryVector, {
                        embedder,
                        generate: (prompt) => ollamaGenerate(prompt, {
                            model: hyde?.model || 'qwen2.5-coder:1.5b',
                            ollamaHost, timeoutMs: 20000,
                            options: { temperature: 0.2, num_predict: 220 },
                        }),
                    });
                }

                // Opt-in LLM rerank: only for natural-language queries (symbol
                // lookups are already rank-1-dominant), never when the caller
                // pinned an exact symbol. Best-effort — order is preserved on
                // any model failure.
                const wantRerank = rerankParam ?? Boolean(rerank?.enabled);
                const willRerank = wantRerank && !exact_tokens && isNaturalLanguageQuery(fullQuery);

                // When reranking, OVER-FETCH a deeper candidate pool and let the
                // judge reorder it, then truncate to top_k. Without this the judge
                // only ever sees the top_k it was asked for (default 5), so it can
                // reorder but never RESCUE a correct-but-deep hit into the top_k —
                // which is exactly where the semantic recall lives. Pool size is
                // capped well above top_k; the user still receives only top_k cards.
                // Opt-in git ranking boost (default OFF): nudge results toward
                // recently-/frequently-changed files. Like rerank it over-fetches so
                // a hot-but-deep hit can be rescued into top_k. It lives here in the
                // tool layer — never in db.searchHybrid — so the measured retrieval
                // ranking (and backend parity) is unchanged unless explicitly enabled.
                const applyGitBoost = gitRankBoost > 0 && gitSignals;
                const poolSize = willRerank
                    ? Math.min(Math.max(top_k, rerank?.poolSize ?? 15), 25)
                    : applyGitBoost ? Math.min(Math.max(top_k * 2, 12), 25) : top_k;
                let matches = db.searchHybrid(fullQuery, queryVector, poolSize, min_score, exact_tokens || null);

                let rerankFailed = false;
                if (willRerank && matches.length > 1) {
                    try {
                        matches = await rerankResults(fullQuery, matches, {
                            topM: Math.min(rerank?.topM ?? 12, matches.length),
                            generate: (prompt) => ollamaGenerate(prompt, {
                                model: rerank?.model || 'qwen2.5-coder:7b',
                                ollamaHost, timeoutMs: 60000,
                                options: { temperature: 0, num_predict: 40 },
                            }),
                        });
                    } catch {
                        // Rerank is a best-effort rank-1 lever: an unreachable or slow
                        // Ollama judge must degrade to the un-reranked fused pool, never
                        // turn the whole search into an error. `matches` keeps its pre-rerank
                        // order because the throwing await never reassigned it.
                        rerankFailed = true;
                    }
                }
                if (applyGitBoost && matches.length > 1) {
                    matches = matches
                        .map(m => ({ ...m, score: m.score * (1 + gitRankBoost * gitBoostScore(gitSignals, m.chunk.file_path)) }))
                        .sort((a, b) => b.score - a.score);
                }
                matches = matches.slice(0, top_k);
                if (matches.length === 0) {
                    const indexEmpty = db.chunkCount() === 0;
                    const emptyHint = 'Index is empty — run `npm run mcp:index` (or `idx-index --repo <path>`) to build it.';
                    return response_format === 'json'
                        ? jsonResult({ query: fullQuery, count: 0, ...(indexEmpty ? { index_status: 'empty', hint: emptyHint } : {}), results: [] })
                        : { content: [{ type: 'text', text: indexEmpty ? `⚠️ ${emptyHint}` : 'No results found.' }] };
                }

                const { lowConfidence, candidateFiles } = assessConfidence(matches, fullQuery, Boolean(exact_tokens));
                const fresh = indexFreshness();

                if (response_format === 'json') {
                    const qTokens = fullQuery.toLowerCase().split(/[\s\W_]+/).filter(t => t.length >= 3);
                    const results = matches.map(({ score, chunk }, i) => {
                        const result = { rank: i + 1, score: Number(score.toFixed(4)), ...chunkCard(chunk) };
                        if (include_topology) {
                            result.topology = {
                                dependencies: db.getDependencies(chunk.file_path),
                                used_by: db.getImportedBy(chunk.file_path),
                            };
                        }
                        if (detail !== 'signatures' && chunk.code_snippet) {
                            result.body = detail === 'full'
                                ? chunk.code_snippet
                                : pruneBodyByQuery(chunk.code_snippet, qTokens);
                        }
                        return result;
                    });
                    return jsonResult({
                        query: fullQuery, count: results.length, reranked: willRerank && !rerankFailed, detail,
                        ...(rerankFailed ? { rerank_failed: true } : {}),
                        low_confidence: lowConfidence,
                        ...(lowConfidence ? { candidate_files: candidateFiles } : {}),
                        index: fresh,
                        results,
                    });
                }

                const depSignature = (depPath) => {
                    const syms = [];
                    for (const c of db.getChunksByFile(depPath)) {
                        if (c.name && c.node_type !== 'expression_statement') {
                            syms.push(c.name);
                            if (syms.length >= 4) break;
                        }
                    }
                    return syms.length ? `${depPath} [${syms.join(', ')}]` : depPath;
                };

                const lines = [`🔍 QUERY: "${fullQuery}" — ${matches.length} result(s)\n`];

                for (let i = 0; i < matches.length; i++) {
                    const { score, chunk } = matches[i];
                    lines.push(`${'─'.repeat(50)}`);
                    lines.push(`#${i + 1} · **${chunk.name}** [${chunk.node_type}]`);
                    lines.push(`📄 ${chunk.file_path}:${chunk.start_line}–${chunk.end_line} · ID: \`${chunk.id}\` · RRF: ${score.toFixed(4)}`);

                    const sig = [];
                    if (chunk.params?.length) sig.push(`(${chunk.params.slice(0, 4).join(', ')})`);
                    if (chunk.return_type) sig.push(`→ ${chunk.return_type}`);
                    if (chunk.type_refs?.length) sig.push(`types: ${chunk.type_refs.slice(0, 4).join(', ')}`);
                    if (sig.length) lines.push(`🔤 ${sig.join('  ')}`);

                    if (chunk.decorators?.length) lines.push(`🏷  ${chunk.decorators.slice(0, 6).map(d => '@' + d).join(' ')}`);
                    if (chunk.extends?.length) lines.push(`🧬 extends/implements: ${chunk.extends.slice(0, 5).join(', ')}`);
                    if (chunk.docstring) lines.push(`💬 ${chunk.docstring.slice(0, 140).replace(/\n/g, ' ')}`);

                    if (include_topology) {
                        const deps = db.getDependencies(chunk.file_path).slice(0, 3);
                        const usedBy = db.getImportedBy(chunk.file_path).slice(0, 3);
                        if (deps.length) lines.push(`⬇️  Deps:    ${deps.map(depSignature).join(' | ')}`);
                        if (usedBy.length) lines.push(`⬆️  Used by: ${usedBy.join(', ')}`);
                        if (chunk.calls?.length) lines.push(`🔗 Calls:   ${chunk.calls.slice(0, 6).join(', ')}`);
                    }
                    lines.push(`↩️  Expand: get_chunk("${chunk.id}")`);
                }

                if (detail !== 'signatures') {
                    const CHARS_PER_TOKEN = 4;
                    const defaultBudget = detail === 'full' ? 6000 : 2000;
                    let remainingChars = token_budget != null ? token_budget * CHARS_PER_TOKEN : defaultBudget;

                    lines.push(`\n${'═'.repeat(50)}`);
                    lines.push(`CODE BODIES (detail: ${detail}, budget: ~${Math.round(remainingChars / CHARS_PER_TOKEN)} tok)\n`);

                    const queryTokens = fullQuery.toLowerCase().split(/[\s\W_]+/).filter(t => t.length >= 3);

                    for (const { chunk } of matches) {
                        if (remainingChars <= 0) break;
                        const raw = chunk.code_snippet || '';
                        if (!raw) continue;
                        const snippet = detail === 'full'
                            ? raw.slice(0, remainingChars)
                            : pruneBodyByQuery(raw, queryTokens).slice(0, remainingChars);
                        lines.push(`### ${chunk.name} — ${chunk.file_path}`);
                        lines.push('```\n' + snippet + '\n```\n');
                        remainingChars -= snippet.length;
                    }
                }

                // Low-confidence handoff: no dominant match on a behavioural query —
                // point the agent at the distinct candidate files to skeleton next.
                if (lowConfidence) {
                    lines.push(`\n${'─'.repeat(50)}`);
                    lines.push(`⚠️ Low confidence — no dominant match. Candidate files (top distinct): ${candidateFiles.map(f => `\`${f}\``).join(', ')}`);
                    lines.push(`→ Try \`get_file_skeleton\` on these, or refine with a symbol name / \`exact_tokens\`.`);
                }

                if (rerankFailed) lines.push('', '⚠️ Rerank was requested but the judge model was unreachable — results are in raw fused order (not reranked).');
                const _note = freshnessNote(fresh);
                if (_note) lines.push('', _note);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── get_chunk ────────────────────────────────────────────────────────────────
    server.tool(
        'get_chunk',
        'CRITICAL: Use this INSTEAD of reading full files. Returns the complete body of a function/class by its chunk_id from search_code results.',
        {
            chunk_id: z.string().describe('The chunk ID shown in search_code results.'),
            view: z.enum(['full', 'signature']).default('full').describe(
                "'full': complete source body. 'signature': just the function signature line (~5 tokens)."
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed fields + topology + code)."
            ),
        },
        async ({ chunk_id, view, response_format }) => {
            try {
                const chunk = db.getChunk(chunk_id);
                if (!chunk) {
                    return response_format === 'json'
                        ? jsonResult({ chunk_id, found: false })
                        : { content: [{ type: 'text', text: `Chunk '${chunk_id}' not found. Run search_code to get valid IDs.` }] };
                }

                if (response_format === 'json') {
                    return jsonResult({
                        ...chunkCard(chunk),
                        topology: {
                            dependencies: db.getDependencies(chunk.file_path),
                            used_by: db.getImportedBy(chunk.file_path),
                        },
                        code: view === 'signature' ? extractSignatureLine(chunk.code_snippet) : chunk.code_snippet,
                    });
                }

                const parts = [
                    `# ${chunk.name}`,
                    `**File:** \`${chunk.file_path}\` · **Lines:** ${chunk.start_line}–${chunk.end_line} · **Type:** ${chunk.node_type}`,
                ];
                if (chunk.params?.length) parts.push(`**Params:** ${chunk.params.join(', ')}`);
                if (chunk.return_type) parts.push(`**Returns:** ${chunk.return_type}`);
                if (chunk.type_refs?.length) parts.push(`**Type refs:** ${chunk.type_refs.join(', ')}`);
                if (chunk.decorators?.length) parts.push(`**Decorators:** ${chunk.decorators.map(d => '@' + d).join(', ')}`);
                if (chunk.extends?.length) parts.push(`**Inherits:** ${chunk.extends.join(', ')}`);
                if (chunk.docstring) parts.push(`**Doc:** ${chunk.docstring}`);

                const deps = db.getDependencies(chunk.file_path);
                const usedBy = db.getImportedBy(chunk.file_path);
                if (deps.length) parts.push(`⬇️ Imports: ${deps.join(', ')}`);
                if (usedBy.length) parts.push(`⬆️ Used by: ${usedBy.join(', ')}`);
                if (chunk.calls?.length) parts.push(`🔗 Calls: ${chunk.calls.join(', ')}`);

                if (view === 'signature') parts.push('', '```', extractSignatureLine(chunk.code_snippet), '```');
                else parts.push('', '```', chunk.code_snippet, '```');
                return { content: [{ type: 'text', text: parts.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── resolve_symbol ─────────────────────────────────────────────────────────
    server.tool(
        'resolve_symbol',
        'Instantly finds the definition of any symbol (function, class, type, variable) by exact name — O(1) lookup, no search needed. Returns the defining chunk and cross-file topology.',
        {
            symbol: z.string().describe("Exact symbol name (e.g. 'validateToken', 'User', 'PaymentService')."),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed definition list + topology)."
            ),
        },
        async ({ symbol, response_format }) => {
            try {
                const defs = db.resolveSymbol(symbol);
                if (defs.length === 0) {
                    const indexEmpty = db.chunkCount() === 0;
                    const emptyHint = 'Index is empty — run `npm run mcp:index` (or `idx-index --repo <path>`) to build it.';
                    return response_format === 'json'
                        ? jsonResult({ symbol, count: 0, ...(indexEmpty ? { index_status: 'empty', hint: emptyHint } : {}), definitions: [] })
                        : { content: [{ type: 'text', text: indexEmpty ? `⚠️ ${emptyHint}` : `Symbol '${symbol}' not in index. Try search_code(query="${symbol}") for fuzzy search.` }] };
                }
                if (response_format === 'json') {
                    return jsonResult({
                        symbol,
                        count: defs.length,
                        definitions: defs.map(chunk => ({
                            ...chunkCard(chunk),
                            topology: {
                                dependencies: db.getDependencies(chunk.file_path),
                                used_by: db.getImportedBy(chunk.file_path),
                            },
                            signature: extractSignatureLine(chunk.code_snippet),
                        })),
                    });
                }
                const lines = [`# Symbol: \`${symbol}\` — ${defs.length} definition(s)\n`];
                for (const chunk of defs) {
                    lines.push(`${'─'.repeat(50)}`);
                    lines.push(`**${chunk.name}** [${chunk.node_type}]`);
                    lines.push(`📄 ${chunk.file_path}:${chunk.start_line}–${chunk.end_line} · ID: \`${chunk.id}\``);
                    if (chunk.params?.length) lines.push(`🔤 Params: ${chunk.params.join(', ')}`);
                    if (chunk.return_type) lines.push(`🔤 Returns: ${chunk.return_type}`);
                    if (chunk.type_refs?.length) lines.push(`🔗 Type refs: ${chunk.type_refs.join(', ')}`);
                    if (chunk.decorators?.length) lines.push(`🏷  ${chunk.decorators.slice(0, 6).map(d => '@' + d).join(' ')}`);
                    if (chunk.docstring) lines.push(`💬 ${chunk.docstring.slice(0, 160).replace(/\n/g, ' ')}`);
                    const deps = db.getDependencies(chunk.file_path).slice(0, 4);
                    const usedBy = db.getImportedBy(chunk.file_path).slice(0, 4);
                    if (deps.length) lines.push(`⬇️  Imports: ${deps.join(', ')}`);
                    if (usedBy.length) lines.push(`⬆️  Used by: ${usedBy.join(', ')}`);
                    if (chunk.calls?.length) lines.push(`🔗 Calls: ${chunk.calls.slice(0, 8).join(', ')}`);
                    lines.push(`\n\`\`\`\n${extractSignatureLine(chunk.code_snippet)}\n\`\`\``);
                    lines.push(`↩️  Full body: get_chunk("${chunk.id}")`);
                }
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── get_chunk_summary ──────────────────────────────────────────────────────
    server.tool(
        'get_chunk_summary',
        'Returns the function/class signature + docstring + called functions — no full body. ~50 tokens vs ~300 for full body. Use when you only need to understand the interface, not the implementation.',
        {
            chunk_id: z.string().describe('The chunk ID from search_code results.'),
            expand_calls: z.boolean().default(false).describe(
                'When true, resolves the signatures of outgoing dependencies inline (~150 tok vs ~50 tok). '
                + 'Use when you need to understand the interfaces of called functions in a single shot, '
                + 'without issuing a separate tool call per dependency.'
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed signature + docstring + resolved calls)."
            ),
        },
        async ({ chunk_id, expand_calls, response_format }) => {
            try {
                const chunk = db.getChunk(chunk_id);
                if (!chunk) {
                    return response_format === 'json'
                        ? jsonResult({ chunk_id, found: false })
                        : { content: [{ type: 'text', text: `Chunk '${chunk_id}' not found.` }] };
                }

                const resolveCalls = () => {
                    const out = [];
                    const seen = new Set();
                    for (const callName of (chunk.calls || [])) {
                        if (seen.size >= 6) break;
                        const key = callName.toLowerCase();
                        if (seen.has(key)) continue;
                        seen.add(key);
                        const target = db.resolveSymbol(callName)[0];
                        if (!target?.code_snippet) continue;
                        out.push({
                            name: callName,
                            file_path: target.file_path,
                            start_line: target.start_line,
                            signature: extractSignatureLine(target.code_snippet).split('\n')[0].trim().slice(0, 120),
                        });
                    }
                    return out;
                };

                if (response_format === 'json') {
                    return jsonResult({
                        id: chunk.id,
                        name: chunk.name,
                        node_type: chunk.node_type,
                        file_path: chunk.file_path,
                        start_line: chunk.start_line,
                        end_line: chunk.end_line,
                        params: chunk.params || [],
                        return_type: chunk.return_type || null,
                        type_refs: chunk.type_refs || [],
                        decorators: chunk.decorators || [],
                        docstring: chunk.docstring || null,
                        signature: extractSignatureLine(chunk.code_snippet),
                        calls: chunk.calls || [],
                        resolved_calls: expand_calls ? resolveCalls() : undefined,
                    });
                }

                const lines = [
                    `# ${chunk.name} · ${chunk.file_path}:${chunk.start_line}–${chunk.end_line}`,
                    `**Type:** ${chunk.node_type}`,
                ];
                if (chunk.params?.length) lines.push(`**Params:** ${chunk.params.join(', ')}`);
                if (chunk.return_type) lines.push(`**Returns:** ${chunk.return_type}`);
                if (chunk.type_refs?.length) lines.push(`**Type refs:** ${chunk.type_refs.join(', ')}`);
                if (chunk.decorators?.length) lines.push(`**Decorators:** ${chunk.decorators.map(d => '@' + d).join(', ')}`);
                if (chunk.docstring) lines.push(`\n**Doc:** ${chunk.docstring.slice(0, 300)}`);

                if (chunk.calls?.length) {
                    if (!expand_calls) {
                        lines.push(`**Calls:** ${chunk.calls.join(', ')}`);
                    } else {
                        const expanded = [];
                        const seen = new Set();
                        const SIG_BUDGET = 6;
                        for (const callName of chunk.calls) {
                            if (seen.size >= SIG_BUDGET) break;
                            const key = callName.toLowerCase();
                            if (seen.has(key)) continue;
                            seen.add(key);
                            const target = db.resolveSymbol(callName)[0];
                            if (!target?.code_snippet) continue;
                            const sig = extractSignatureLine(target.code_snippet).split('\n')[0].trim().slice(0, 120);
                            expanded.push(
                                `  **${callName}** → \`${target.file_path}:${target.start_line}\``
                                + `\n  \`\`\`\n  ${sig}\n  \`\`\``
                            );
                        }
                        const unresolved = chunk.calls.length - expanded.length;
                        lines.push(`\n**Calls (${expanded.length} resolved${unresolved > 0 ? `, ${unresolved} unindexed` : ''}):**`);
                        if (expanded.length > 0) lines.push(...expanded);
                        else lines.push('  _(none resolved in index)_');
                    }
                }

                lines.push('', '```', extractSignatureLine(chunk.code_snippet), '```');
                lines.push(`\n↩️  Full body: get_chunk("${chunk.id}")`);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── get_file_skeleton ──────────────────────────────────────────────────────
    server.tool(
        'get_file_skeleton',
        'Returns all top-level exports and definitions in a file with line numbers — no code bodies (~50 tokens vs 5000).',
        {
            file_path: z.string().describe("Relative path (e.g. 'src/app.ts')."),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' ({ file_path, skeleton } string fields)."
            ),
        },
        async ({ file_path, response_format }) => {
            try {
                const absolutePath = resolve(projectRoot, file_path);
                const safeRoot = path.normalize(projectRoot);
                const norm = path.normalize(absolutePath);
                if (norm !== safeRoot && !norm.startsWith(safeRoot + path.sep)) {
                    throw new Error('Access denied: path is outside the project root.');
                }
                if (!fs.existsSync(absolutePath)) throw new Error('File not found.');
                // Defence in depth: the textual check above can be defeated by a
                // symlink *inside* the project that points outside it. Resolve
                // symlinks on both the root and the target and re-check containment
                // so a tool call can never read a file outside the project root.
                let realRoot, realPath;
                try { realRoot = fs.realpathSync(safeRoot); } catch { realRoot = safeRoot; }
                try { realPath = fs.realpathSync(absolutePath); } catch { realPath = norm; }
                if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
                    throw new Error('Access denied: path resolves outside the project root.');
                }
                const content = fs.readFileSync(absolutePath, 'utf-8');
                const ext = path.extname(absolutePath);
                const parser = getParserForFile(ext);
                if (!parser) {
                    return response_format === 'json'
                        ? jsonResult({ file_path, language_supported: false, skeleton: null })
                        : { content: [{ type: 'text', text: 'Language not supported.' }] };
                }
                const tree = parser.parse((offset) => offset < content.length ? content.slice(offset, offset + 4096) : null);
                const skeleton = extractFileSkeleton(tree.rootNode, content);
                if (response_format === 'json') {
                    return jsonResult({ file_path, language_supported: true, skeleton: skeleton || '' });
                }
                return { content: [{ type: 'text', text: `# Skeleton: ${file_path}\n\n${skeleton || '_No semantic signatures found_'}` }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── get_call_graph ─────────────────────────────────────────────────────────
    server.tool(
        'get_call_graph',
        'Finds all chunks that call a specific function, split into high-confidence callers '
        + '(the real blast radius) and name-only matches (an ambiguous same-named symbol). '
        + 'CRITICAL for safe refactoring — call before changing any exported signature.',
        {
            target_function: z.string().describe("Exact function name (e.g. 'validateToken')."),
            target_class: z.string().optional().describe(
                "Optional class/type that owns the method (e.g. 'OrderService') — scopes the "
                + "blast radius to one class's method when several symbols share the name."
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed { high, name_only } caller arrays)."
            ),
        },
        async ({ target_function, target_class, response_format }) => {
            try {
                const { high, nameOnly, targetDefs, ambiguous, hasSiteData, classFiltered } =
                    classifyCallers(db, target_function, { targetClass: target_class || null });
                const total = high.length + nameOnly.length;
                const label = classFiltered ? `${target_class}.${target_function}` : target_function;
                const coChanges = coChangeFiles(gitSignals, [...new Set(targetDefs.map(d => d.file_path))]);
                const fresh = indexFreshness();
                const note = freshnessNote(fresh);

                if (response_format === 'json') {
                    return jsonResult({
                        target_function,
                        target_class: target_class || null,
                        ambiguous,
                        definition_count: targetDefs.length,
                        receiver_aware: hasSiteData,
                        caller_count: total,
                        high_confidence: high.map(h => refCard({ ...h, confidence: 'high' })),
                        name_only: nameOnly.map(n => refCard({ ...n, confidence: 'name-only' })),
                        co_changes: coChanges,
                        index: fresh,
                    });
                }

                if (total === 0) {
                    // A stale index makes "no callers" dangerously misleading — surface it.
                    const parts = [`✅ Safe to modify: no callers of \`${label}\` found.`];
                    if (coChanges.length) parts.push(coChangeLine(coChanges));
                    if (note) parts.push(note);
                    return { content: [{ type: 'text', text: parts.join('\n') }] };
                }

                const fmt = ({ chunk, recvHint }) =>
                    `- [${chunk.node_type}] \`${chunk.class_context ? chunk.class_context + '.' : ''}${chunk.name}\``
                    + ` in \`${chunk.file_path}\` (lines ${chunk.start_line}–${chunk.end_line})`
                    + (recvHint ? ` · via ${recvHint}` : '');

                const lines = [`# ⚠️ Call Graph: \`${label}\``];
                const split = ambiguous && !classFiltered;

                if (split) {
                    lines.push(`${total} name-match caller(s) · ⚠️ ${targetDefs.length}+ symbols named \`${target_function}\` — grouped by confidence:`);
                } else {
                    lines.push(`${total} caller(s) depend on this — review before changing signature:`);
                }

                if (high.length) {
                    if (split) lines.push('', `## ✅ High-confidence callers (${high.length})`);
                    for (const h of high) lines.push(fmt(h));
                }
                if (nameOnly.length) {
                    lines.push('', `## ❔ Name-only matches (${nameOnly.length}) — verify; may call a different \`${target_function}\``);
                    for (const n of nameOnly) lines.push(fmt(n));
                    if (!classFiltered) lines.push('', `> Pass \`target_class\` to scope the blast radius to one class's \`${target_function}\`.`);
                }
                if (!hasSiteData && ambiguous) {
                    lines.push('', `> ℹ️ This index predates receiver-aware call graphs — re-run \`npm run mcp:index\` for precise grouping.`);
                }
                if (coChanges.length) lines.push('', coChangeLine(coChanges));
                if (note) lines.push('', note);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── find_references ──────────────────────────────────────────────────────────
    server.tool(
        'find_references',
        'Every symbol that references a target symbol — symbol-level, not just file-level. '
        + 'Fuses three reference kinds: callers (the blast radius), subclasses/implementers '
        + '(extends), and type users (params, returns, fields). Each is split by confidence '
        + 'using receiver hints and the import graph. Broader than get_call_graph: use it before '
        + 'renaming or changing a class/interface/type, not just a function.',
        {
            symbol: z.string().describe("Exact symbol name (function, class, interface, or type)."),
            target_class: z.string().optional().describe(
                "Optional owning class/type to scope the call dimension when several symbols share the name."
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed { called_by, subclassed_by, used_as_type_by })."
            ),
        },
        async ({ symbol, target_class, response_format }) => {
            try {
                const { targetDefs, ambiguous, calls, inherits, types } =
                    findReferences(db, symbol, { targetClass: target_class || null });
                const callTotal = calls.high.length + calls.nameOnly.length;
                const total = callTotal + inherits.length + types.length;
                const coChanges = coChangeFiles(gitSignals, [...new Set(targetDefs.map(d => d.file_path))]);
                const fresh = indexFreshness();
                const note = freshnessNote(fresh);

                if (response_format === 'json') {
                    return jsonResult({
                        symbol,
                        target_class: target_class || null,
                        ambiguous,
                        definition_count: targetDefs.length,
                        reference_count: total,
                        called_by: {
                            high: calls.high.map(h => refCard({ ...h, confidence: 'high' })),
                            name_only: calls.nameOnly.map(n => refCard({ ...n, confidence: 'name-only' })),
                        },
                        subclassed_by: inherits.map(refCard),
                        used_as_type_by: types.map(refCard),
                        co_changes: coChanges,
                        index: fresh,
                    });
                }

                if (total === 0) {
                    const parts = [`✅ No references to \`${symbol}\` found in the index.`];
                    if (coChanges.length) parts.push(coChangeLine(coChanges));
                    if (note) parts.push(note);
                    return { content: [{ type: 'text', text: parts.join('\n') }] };
                }

                const fmt = ({ chunk, recvHint, confidence }) =>
                    `- [${chunk.node_type}] \`${chunk.class_context ? chunk.class_context + '.' : ''}${chunk.name}\``
                    + ` in \`${chunk.file_path}\` (lines ${chunk.start_line}–${chunk.end_line})`
                    + (recvHint ? ` · via ${recvHint}` : '')
                    + (confidence === 'name-only' ? ' · ⚠️ unverified' : '');

                const lines = [`# 🔗 References to \`${symbol}\` — ${total} total`];
                if (ambiguous) lines.push(`⚠️ ${targetDefs.length} symbols named \`${symbol}\` — name-only matches may target a different one.`);

                if (callTotal) {
                    lines.push('', `## 📞 Called by (${callTotal})`);
                    for (const h of calls.high) lines.push(fmt({ ...h, confidence: 'high' }));
                    for (const n of calls.nameOnly) lines.push(fmt({ ...n, confidence: 'name-only' }));
                }
                if (inherits.length) {
                    lines.push('', `## 🧬 Subclassed / implemented by (${inherits.length})`);
                    for (const it of inherits) lines.push(fmt(it));
                }
                if (types.length) {
                    lines.push('', `## 🏷  Used as a type by (${types.length})`);
                    for (const it of types) lines.push(fmt(it));
                }
                if (coChanges.length) lines.push('', coChangeLine(coChanges));
                if (note) lines.push('', note);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── find_routes ──────────────────────────────────────────────────────────────
    server.tool(
        'find_routes',
        'Map HTTP routes to their handler functions. Returns the handler chunk ID so '
        + 'you can call get_chunk or get_call_graph on the handler directly. Covers '
        + 'NestJS/Angular decorators, FastAPI/Flask, Spring annotations, and Express/Koa '
        + 'registration. Filter by method and/or path.',
        {
            method: z.string().optional().describe(
                "Optional HTTP method filter (GET, POST, PUT, DELETE, PATCH). Case-insensitive; omit for all methods."
            ),
            path: z.string().optional().describe(
                "Optional path filter. Starts with '/' → prefix match; otherwise (incl. pattern hints with '{' or ':') → substring contains-match."
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed { routes: [...] })."
            ),
        },
        async ({ method, path: pathArg, response_format }) => {
            try {
                const routes = findRoutes(db, { method: method || null, path: pathArg || null });
                const fresh = indexFreshness();
                const note = freshnessNote(fresh);

                if (response_format === 'json') {
                    return jsonResult({
                        method: method || null,
                        path: pathArg || null,
                        route_count: routes.length,
                        routes,
                        index: fresh,
                    });
                }

                if (routes.length === 0) {
                    const filt = [method ? method.toUpperCase() : null, pathArg].filter(Boolean).join(' ');
                    const parts = [`✅ No HTTP routes${filt ? ` matching \`${filt}\`` : ''} found in the index.`];
                    if (note) parts.push(note);
                    return { content: [{ type: 'text', text: parts.join('\n') }] };
                }

                const lines = [`# 🌐 HTTP routes — ${routes.length} total`];
                for (const r of routes) {
                    const handler = r.id
                        ? `\`${r.handler_name}\` [${r.node_type}] in \`${r.file_path}\` (lines ${r.start_line}–${r.end_line}) · id \`${r.id}\``
                        : `\`${r.handler_name}\` in \`${r.file_path}\`${r.line ? ` (line ${r.line})` : ''}`;
                    lines.push(`- **${r.method}** \`${r.path}\` → ${handler}`);
                }
                if (note) lines.push('', note);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── get_subgraph ─────────────────────────────────────────────────────────────
    server.tool(
        'get_subgraph',
        'Trace a flow across files in ONE call: returns a bounded connected subgraph around a '
        + 'seed symbol — what it calls, its high-confidence callers (precise blast radius), and '
        + 'its type/inheritance users — within a node and token budget. Use instead of chaining '
        + 'search_code → get_call_graph → find_references for cross-cutting "how does X flow" questions.',
        {
            symbol: z.string().describe('Seed symbol name (function, method, class, or type).'),
            depth: z.number().int().min(1).max(3).default(2).describe('Hops to traverse from the seed (1–3).'),
            max_nodes: z.number().int().min(1).max(40).default(12).describe('Max chunks in the subgraph.'),
            token_budget: z.number().int().min(100).optional().describe(
                'Token budget for the subgraph (1 token ≈ 4 chars). Omit for node-count-only bounding.'
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed { nodes, edges })."
            ),
        },
        async ({ symbol, depth, max_nodes, token_budget, response_format }) => {
            try {
                const g = buildSubgraph(db, symbol, { maxNodes: max_nodes, maxDepth: depth, tokenBudget: token_budget ?? null });
                const fresh = indexFreshness();
                const note = freshnessNote(fresh);
                if (!g.found) {
                    return response_format === 'json'
                        ? jsonResult({ symbol, found: false, nodes: [], edges: [], index: fresh })
                        : { content: [{ type: 'text', text: `Symbol '${symbol}' not in index. Try search_code(query="${symbol}").${note ? '\n' + note : ''}` }] };
                }
                if (response_format === 'json') return jsonResult({ ...g, index: fresh });

                const byId = new Map(g.nodes.map(n => [n.id, n]));
                const label = (id) => { const n = byId.get(id); return n ? `${n.class_context ? n.class_context + '.' : ''}${n.name}` : id; };
                const lines = [
                    `# 🕸  Subgraph around \`${symbol}\` — ${g.nodes.length} node(s), ${g.edges.length} edge(s)`
                    + (g.truncated ? ` · ⚠️ truncated at the budget (raise max_nodes / token_budget for more)` : ''),
                    '',
                    `## Nodes`,
                ];
                for (const n of g.nodes) {
                    lines.push(`- [d${n.depth}] [${n.node_type}] \`${n.class_context ? n.class_context + '.' : ''}${n.name}\` · \`${n.file_path}:${n.start_line}–${n.end_line}\``);
                }
                if (g.edges.length) {
                    lines.push('', `## Edges`);
                    for (const e of g.edges) {
                        lines.push(`- \`${label(e.from)}\` ${e.kind === 'calls' ? '→ calls →' : '⇢ references ⇢'} \`${label(e.to)}\``);
                    }
                }
                if (note) lines.push('', note);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── get_repo_map ───────────────────────────────────────────────────────────
    server.tool(
        'get_repo_map',
        'Returns a compact symbol map of the entire codebase grouped by file, ordered by importance (most-imported files first via PageRank). Use this FIRST to orient yourself in an unfamiliar codebase — ~1-2k tokens vs reading every file. Combine with path_filter to focus on a subsystem.',
        {
            path_filter: z.string().optional().describe(
                "Only include files whose path contains this string (e.g. 'auth', 'api/v2', 'src/core')."
            ),
            max_files: z.number().int().min(1).max(300).default(80).describe('Max files to include in the map.'),
            sort_by: z.enum(['importance', 'path']).default('importance').describe(
                "'importance' (default): most-imported files first (PageRank). 'path': alphabetical."
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed { files: [{ file_path, symbols }] })."
            ),
        },
        async ({ path_filter, max_files, sort_by, response_format }) => {
            try {
                const fileChunks = new Map();
                const filterLower = path_filter ? path_filter.toLowerCase() : null;
                for (const chunk of db.iterateChunks()) {
                    if (filterLower && !chunk.file_path.toLowerCase().includes(filterLower)) continue;
                    if (chunk.name === 'anonymous' || chunk.name === 'default_export') continue;
                    if (!fileChunks.has(chunk.file_path)) fileChunks.set(chunk.file_path, []);
                    fileChunks.get(chunk.file_path).push(chunk);
                }

                if (fileChunks.size === 0) {
                    return response_format === 'json'
                        ? jsonResult({ total_files: 0, total_symbols: 0, files: [] })
                        : {
                            content: [{
                                type: 'text', text: path_filter
                                    ? `No files found matching '${path_filter}'. Try a broader filter.`
                                    : 'Index is empty. Run `npm run mcp:index` first.'
                            }]
                        };
                }

                let sortedFiles = Array.from(fileChunks.keys());
                if (sort_by === 'importance') {
                    const pr = computePageRank(db.graph);
                    sortedFiles.sort((a, b) => (pr.get(b) ?? 0) - (pr.get(a) ?? 0));
                } else {
                    sortedFiles.sort();
                }
                sortedFiles = sortedFiles.slice(0, max_files);

                const totalFiles = fileChunks.size;
                const totalSymbols = Array.from(fileChunks.values()).reduce((s, a) => s + a.length, 0);

                if (response_format === 'json') {
                    const files = sortedFiles.map(filePath => {
                        const seen = new Set();
                        const symbols = [];
                        for (const c of fileChunks.get(filePath)) {
                            const key = c.name.toLowerCase();
                            if (seen.has(key)) continue;
                            seen.add(key);
                            symbols.push({
                                name: c.name, node_type: c.node_type,
                                params: c.params || [], return_type: c.return_type || null,
                                start_line: c.start_line, end_line: c.end_line,
                            });
                        }
                        return { file_path: filePath, symbol_count: symbols.length, symbols };
                    });
                    return jsonResult({
                        total_files: totalFiles, total_symbols: totalSymbols,
                        shown_files: sortedFiles.length, sort_by, path_filter: path_filter || null,
                        files,
                    });
                }

                const lines = [
                    `# Repo Map — ${totalSymbols} symbols across ${totalFiles} files`,
                    path_filter ? `(filtered to '${path_filter}')` : '',
                    sortedFiles.length < totalFiles ? `(showing top ${sortedFiles.length} by ${sort_by}; use path_filter to narrow)\n` : '',
                ].filter(Boolean);

                for (const filePath of sortedFiles) {
                    const chunks = fileChunks.get(filePath);
                    lines.push(`\n${filePath}`);
                    const seen = new Set();
                    const deduped = [];
                    for (const c of chunks) {
                        const key = c.name.toLowerCase();
                        if (seen.has(key)) continue;
                        seen.add(key);
                        deduped.push(c);
                    }
                    for (const c of deduped.slice(0, 8)) {
                        const kind = c.node_type.includes('class') ? 'class'
                            : c.node_type.includes('interface') ? 'interface'
                                : c.node_type.includes('enum') ? 'enum'
                                    : c.node_type.includes('struct') ? 'struct'
                                        : c.node_type.includes('trait') ? 'trait' : 'fn';
                        const params = c.params?.length
                            ? `(${c.params.slice(0, 3).join(', ')}${c.params.length > 3 ? ', …' : ''})` : '';
                        const ret = c.return_type ? ` → ${c.return_type.slice(0, 40)}` : '';
                        lines.push(`  ${kind} ${c.name}${params}${ret}`);
                    }
                    if (deduped.length > 8) lines.push(`  … (${deduped.length - 8} more)`);
                }
                if (totalFiles > max_files) {
                    lines.push(`\n… ${totalFiles - max_files} more files not shown. Use path_filter or increase max_files.`);
                }
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── list_index_stats ───────────────────────────────────────────────────────
    server.tool(
        'list_index_stats',
        'Returns index health: chunk count, embedding status, daemon status, search mode, storage backend, and index freshness.',
        {
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed health fields)."
            ),
        },
        async ({ response_format }) => {
            try {
                const s = db.stats();

                let indexAge = 'unknown';
                let ageSeconds = null;
                try {
                    ageSeconds = Math.floor((Date.now() - fs.statSync(artifactPath).mtimeMs) / 1000);
                    indexAge = ageSeconds < 60 ? `${ageSeconds}s ago` : ageSeconds < 3600 ? `${Math.floor(ageSeconds / 60)}m ago` : `${Math.floor(ageSeconds / 3600)}h ago`;
                } catch { }

                let daemonStatus = 'not running';
                let daemonRunning = false;
                try {
                    if (pidFile && fs.existsSync(pidFile)) {
                        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
                        process.kill(pid, 0);
                        daemonStatus = `running (PID: ${pid})`;
                        daemonRunning = true;
                    }
                } catch { daemonStatus = 'not running (stale PID)'; }

                const embedLabel = embedder ? describeEmbedder(embedder) : '🔤 Lexical only';
                const searchModeText = !embeddingsEnabled ? 'lexical-only' : s.hasVectors ? 'hybrid' : 'lexical-only';
                const searchMode = !embeddingsEnabled
                    ? '🔤 Lexical only (embeddings disabled)'
                    : s.hasVectors
                        ? `🧠 Hybrid (semantic + lexical RRF) · ${embedLabel} — vectors: ${s.vectorSource}`
                        : '🔤 Lexical only (no vectors indexed yet)';

                const fresh = indexFreshness();

                if (response_format === 'json') {
                    return jsonResult({
                        backend: s.backend,
                        chunks: s.chunks,
                        files: s.files,
                        symbols: s.symbols,
                        vectors: s.vectors,
                        has_vectors: s.hasVectors,
                        search_mode: searchModeText,
                        embeddings_enabled: Boolean(embeddingsEnabled),
                        embedder: embedder ? { provider: embedder.provider, model: embedder.model, dim: embedder.dim ?? null } : null,
                        lazy_mode: s.lazyMode,
                        daemon_running: daemonRunning,
                        index_age_seconds: ageSeconds,
                        freshness: {
                            indexed_commit: fresh.indexedCommit,
                            current_commit: fresh.currentCommit,
                            pending_changes: fresh.pendingChanges,
                            stale: fresh.stale,
                            syncing: fresh.syncing,
                        },
                        ext_counts: Object.fromEntries(s.extCounts),
                    });
                }

                const lines = [
                    `# 📊 graph-indexer Index Stats`, '',
                    `| Metric | Value |`, `| :--- | :--- |`,
                    `| **Storage backend** | ${s.backend === 'sqlite' ? '🗄  SQLite (disk-backed)' : '⚡ In-memory'} |`,
                    `| **Chunks** | ${s.chunks} |`,
                    `| **Files indexed** | ${s.files} |`,
                    `| **Symbols in table** | ${s.symbols} |`,
                    `| **Vector entries** | ${s.vectors} |`,
                    `| **Search mode** | ${searchMode} |`,
                    `| **Lazy vec mode** | ${s.lazyMode ? '✅ Yes (enterprise scale)' : '❌ No (small corpus)'} |`,
                    `| **Daemon** | ${daemonStatus} |`,
                    `| **Index age** | ${indexAge} |`,
                    `| **Built at commit** | ${fresh.indexedCommit || '—'}${fresh.commitMoved ? ` (HEAD now ${fresh.currentCommit})` : ''} |`,
                    `| **Pending changes** | ${fresh.pendingChanges == null ? '—' : fresh.pendingChanges} |`,
                    `| **Freshness** | ${fresh.stale ? '⚠️ STALE — run `npm run mcp:index`' : fresh.syncing ? '🔄 daemon syncing' : '✅ fresh'} |`,
                    '', `## Extension Breakdown`,
                    ...Array.from(s.extCounts.entries()).sort((a, b) => b[1] - a[1]).map(([e, n]) => `- .${e}: ${n} chunks`),
                ];
                if (s.chunks === 0) lines.push('', `⚠️ Index empty. Run \`npm run mcp:index\`.`);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );
}
