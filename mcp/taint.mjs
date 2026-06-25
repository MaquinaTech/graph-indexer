/**
 * @file mcp/taint.mjs
 * @description Taint analysis (C2): trace untrusted data from SOURCES (request bodies, argv/env,
 *              stdin, socket/file reads) to dangerous SINKS (eval/exec, SQL, fs/path, HTML, outbound
 *              requests) across the symbol graph, surfacing injection-class risks (rce/sqli/xss/
 *              path/ssrf) with a concrete source→sink path.
 *
 *              QUERY-TIME and read-only: it scans chunk source with the heuristic catalogs in
 *              parse/taint-patterns.mjs and walks the call graph (A4 getEdges when present, else
 *              chunk.calls). No index-time cost, no serialization, no parity surface — the default
 *              index is byte-identical and the tools cost nothing unless invoked. Air-gapped (pure
 *              regex + graph traversal; no model, no network).
 *
 *              HONESTY: this is a FINDER, not a verifier. It favours precision (direct same-function
 *              flows are 'high'; cross-function reachability is 'medium'; a sanitizer on the path
 *              lowers confidence) and will MISS flows through dynamic dispatch, reflection, ORM/
 *              query-builder indirection, and untyped collections. "0 findings" ≠ "no vulnerabilities."
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { SOURCES, SINKS, SANITIZERS, CATEGORY_SEVERITY, langKeyForExt } from '../parse/taint-patterns.mjs';

const extOf = (filePath) => { const i = String(filePath).lastIndexOf('.'); return i >= 0 ? filePath.slice(i) : ''; };

/**
 * Scan one chunk's source for source / sink / sanitizer hits. Returns null for unsupported
 * languages or chunks without source text.
 */
export function scanChunk(chunk) {
    const lang = langKeyForExt(extOf(chunk.file_path));
    if (!lang) return null;
    const src = chunk.code_snippet || '';
    if (!src) return null;
    const lines = src.split('\n');
    const base = chunk.start_line || 1;

    const sources = [];
    const sinks = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const s of SOURCES[lang]) if (s.re.test(line)) sources.push({ line: base + i, kind: s.kind, snippet: line.trim().slice(0, 160) });
        for (const k of SINKS[lang]) if (k.re.test(line)) sinks.push({ line: base + i, category: k.category, label: k.label, snippet: line.trim().slice(0, 160) });
    }
    const sanitized = SANITIZERS[lang].some(re => re.test(src));
    return { lang, sources, sinks, sanitized };
}

/** Forward callees of a chunk (what it calls): A4 edges when present, else resolved chunk.calls. */
function forwardCallees(db, chunk) {
    const out = [];
    const seen = new Set();
    const push = (c) => { if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); } };
    if (typeof db.hasSymbolGraph === 'function' && db.hasSymbolGraph()) {
        for (const e of db.getEdges(chunk.id, { direction: 'out', kind: 'calls' })) if (e.chunk) push(e.chunk);
        return out;
    }
    for (const name of (chunk.calls || [])) for (const def of (db.resolveSymbol(name) || [])) push(def);
    return out;
}

const confRank = { high: 3, medium: 2, low: 1 };
const sevRank = Object.fromEntries(CATEGORY_SEVERITY.map((c, i) => [c, CATEGORY_SEVERITY.length - i]));

function flowKey(f) { return `${f.source.chunk_id}|${f.sink.chunk_id}|${f.sink.category}|${f.sink.line}`; }

/** Deterministic order: worst category, then confidence, then source place, then sink place, then id. */
function flowOrder(a, b) {
    return (sevRank[b.sink.category] - sevRank[a.sink.category])
        || (confRank[b.confidence] - confRank[a.confidence])
        || a.source.file_path.localeCompare(b.source.file_path)
        || (a.source.line - b.source.line)
        || a.sink.file_path.localeCompare(b.sink.file_path)
        || (a.sink.line - b.sink.line)
        || (a.source.chunk_id < b.source.chunk_id ? -1 : a.source.chunk_id > b.source.chunk_id ? 1 : 0);
}

/**
 * Build the taint flow set: every source→sink flow the heuristics can find.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.maxDepth]   Cross-function call hops to follow from a source (default 4).
 * @param {number} [opts.maxFlows]   Cap on flows returned (default 200; truncation is reported).
 * @param {string} [opts.category]   Restrict to one sink category (rce|sqli|xss|path|ssrf).
 * @param {boolean}[opts.includeReachable]  Include cross-function reachability flows (default true).
 * @returns {{ flows: object[], truncated: boolean, scanned: number, sources: number, sinks: number }}
 */
export function buildTaintGraph(db, { maxDepth = 4, maxFlows = 200, category = null, includeReachable = true } = {}) {
    // Scan every chunk once (sorted by id for deterministic, backend-stable output).
    const chunks = [...db.iterateChunks()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const scans = new Map();
    const sourceChunks = [];
    const sinkChunkIds = new Set();
    let sourceCount = 0, sinkCount = 0;
    for (const c of chunks) {
        const sc = scanChunk(c);
        if (!sc) continue;
        scans.set(c.id, sc);
        if (sc.sources.length) { sourceChunks.push(c); sourceCount += sc.sources.length; }
        if (sc.sinks.length) { sinkChunkIds.add(c.id); sinkCount += sc.sinks.length; }
    }

    const sinkMatches = (sk) => !category || sk.category === category;
    const card = (chunk) => ({ chunk_id: chunk.id, name: chunk.name, file_path: chunk.file_path });

    const flows = new Map();
    const addFlow = (srcChunk, srcHit, sinkChunk, sinkHit, path, depth, via, sanitized) => {
        const confidence = via === 'direct' ? (sanitized ? 'low' : 'high') : (sanitized ? 'low' : 'medium');
        const f = {
            source: { ...card(srcChunk), line: srcHit.line, kind: srcHit.kind, snippet: srcHit.snippet },
            sink: { ...card(sinkChunk), line: sinkHit.line, category: sinkHit.category, label: sinkHit.label, snippet: sinkHit.snippet },
            path, depth, via, sanitized, confidence,
        };
        const k = flowKey(f);
        const prev = flows.get(k);
        if (!prev || confRank[f.confidence] > confRank[prev.confidence] || f.depth < prev.depth) flows.set(k, f);
    };

    // ── Direct: a single function that both takes untrusted input AND performs a dangerous op. ──
    for (const c of sourceChunks) {
        const sc = scans.get(c.id);
        if (!sc.sinks.length) continue;
        const srcHit = sc.sources[0];                 // representative source
        for (const sinkHit of sc.sinks) if (sinkMatches(sinkHit)) addFlow(c, srcHit, c, sinkHit, [c.id], 0, 'direct', sc.sanitized);
    }

    // ── Reachable: a source function transitively calls a sink function. ─────────────────────────
    if (includeReachable) {
        for (const start of sourceChunks) {
            const startScan = scans.get(start.id);
            const srcHit = startScan.sources[0];
            const visited = new Set([start.id]);
            let frontier = [{ chunk: start, path: [start.id], pathSanitized: startScan.sanitized }];
            for (let depth = 1; depth <= maxDepth; depth++) {
                const next = [];
                for (const { chunk, path, pathSanitized } of frontier) {
                    for (const callee of forwardCallees(db, chunk)) {
                        if (visited.has(callee.id)) continue;
                        visited.add(callee.id);
                        const calleeScan = scans.get(callee.id);
                        const sanitizedPath = pathSanitized || (calleeScan ? calleeScan.sanitized : false);
                        if (sinkChunkIds.has(callee.id) && calleeScan) {
                            for (const sinkHit of calleeScan.sinks) if (sinkMatches(sinkHit)) addFlow(start, srcHit, callee, sinkHit, [...path, callee.id], depth, 'reachable', sanitizedPath);
                        }
                        next.push({ chunk: callee, path: [...path, callee.id], pathSanitized: sanitizedPath });
                    }
                }
                if (!next.length) break;
                frontier = next;
            }
        }
    }

    const all = [...flows.values()].sort(flowOrder);
    const truncated = all.length > maxFlows;
    return { flows: truncated ? all.slice(0, maxFlows) : all, truncated, scanned: scans.size, sources: sourceCount, sinks: sinkCount };
}

/** Flows filtered by source kind and/or sink category (a thin filter over buildTaintGraph). */
export function traceTaint(db, { sourceKind = null, sinkCategory = null, maxDepth = 4, maxFlows = 200 } = {}) {
    const { flows, truncated, scanned } = buildTaintGraph(db, { maxDepth, maxFlows, category: sinkCategory });
    const filtered = sourceKind ? flows.filter(f => f.source.kind === sourceKind) : flows;
    return { flows: filtered, truncated, scanned };
}

/**
 * Every dangerous sink, grouped by category, each annotated with whether any untrusted source
 * reaches it. The orientation tool: "where are my dangerous operations, and which are reachable
 * from untrusted input?"
 */
export function findTaintedSinks(db, { category = null, reachableOnly = false, maxDepth = 4 } = {}) {
    const { flows, scanned } = buildTaintGraph(db, { maxDepth, maxFlows: 100000, category });
    const reachedKey = new Set(flows.map(f => `${f.sink.chunk_id}|${f.sink.line}|${f.sink.category}`));

    const chunks = [...db.iterateChunks()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const byCategory = {};
    for (const c of chunks) {
        const sc = scanChunk(c);
        if (!sc || !sc.sinks.length) continue;
        for (const sk of sc.sinks) {
            if (category && sk.category !== category) continue;
            const reached = reachedKey.has(`${c.id}|${sk.line}|${sk.category}`);
            if (reachableOnly && !reached) continue;
            (byCategory[sk.category] ||= []).push({
                chunk_id: c.id, name: c.name, file_path: c.file_path, line: sk.line,
                label: sk.label, snippet: sk.snippet, reached_by_source: reached,
            });
        }
    }
    for (const cat of Object.keys(byCategory)) {
        byCategory[cat].sort((a, b) => (Number(b.reached_by_source) - Number(a.reached_by_source))
            || a.file_path.localeCompare(b.file_path) || (a.line - b.line));
    }
    return { byCategory, scanned, flowCount: flows.length };
}
