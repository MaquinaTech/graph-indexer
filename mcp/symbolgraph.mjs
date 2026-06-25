/**
 * @file mcp/symbolgraph.mjs
 * @description Builds the persistent RESOLVED symbol graph (A4): one edge per resolved
 *              (referencing-chunk → definition-chunk) pair, tagged with `kind`
 *              ('calls' | 'extends' | 'type') and `confidence`. Confidence is `high` | `name_only`
 *              on the default `heuristic` path; the opt-in resolvers add a `resolved` tier — A1
 *              (`precise`) promotes provably-unambiguous edges, A2 (`scip`) confirms a cross-file
 *              binding AND suppresses the wrong-target fan-out a same-name ambiguity would emit.
 *
 *              It REUSES the query-time resolvers (classifyCallers / findReferences) over
 *              every defined symbol, so an edge's confidence is identical to what
 *              get_call_graph / find_references would report — no logic duplication, no
 *              drift. The result is serialized into the index so both backends expose the
 *              same graph through getEdges() (deterministically ordered → parity-free), and
 *              findCallers / findReferers can read it instead of scanning.
 *
 *              Opt-in and index-time only (see config.symbolGraph / indexer.mjs). It does
 *              not touch search ranking. This is the structural foundation for impact_of_edit
 *              (transitive getEdges), symbol-level PageRank (A5), and precise resolution (A1,
 *              which upgrades 'high' → 'resolved').
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { classifyCallers, findReferences } from './topology.mjs';
import { getResolver, strongerConfidence } from './resolver.mjs';

/** Deterministic total order on edges — required for memory↔sqlite parity. */
export function edgeOrder(a, b) {
    return (a.from_chunk_id < b.from_chunk_id ? -1 : a.from_chunk_id > b.from_chunk_id ? 1 : 0)
        || (a.to_chunk_id < b.to_chunk_id ? -1 : a.to_chunk_id > b.to_chunk_id ? 1 : 0)
        || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
        || (a.confidence < b.confidence ? -1 : a.confidence > b.confidence ? 1 : 0);
}

const normConfidence = (c) => (c === 'high' ? 'high' : 'name_only');

/**
 * Build the resolved edge list from a loaded store.
 *
 * @param {object} db  A loaded store (iterateChunks, resolveSymbol, findCallers,
 *                     findReferers, getDependencies — the same contract the resolvers use).
 * @param {object} [opts]
 * @param {number} [opts.maxPerName]  Safety cap on edges emitted for one symbol name
 *                                    (pathological ambiguous names). Excess is logged, not
 *                                    silently dropped.
 * @param {object} [opts.resolver]  A1 resolver provider (default `heuristic` → byte-identical
 *                                  { high, name_only }; `precise` → adds the `resolved` tier).
 * @returns {{ edges: Array<{from_chunk_id:string,to_chunk_id:string,kind:string,confidence:string}>,
 *             cappedNames: string[] }}
 */
export function buildSymbolGraph(db, { maxPerName = 20000, resolver = getResolver('heuristic') } = {}) {
    const edges = [];
    const cappedNames = [];

    const calleeNames = new Set();
    const refNames = new Set();
    for (const c of db.iterateChunks()) {
        for (const n of (c.calls || [])) calleeNames.add(n);
        for (const t of (c.extends || [])) refNames.add(t);
        for (const t of (c.type_refs || [])) refNames.add(t);
    }

    // ── 'calls' edges: every name-match caller → each definition of the callee name,
    //    bucketed high / name_only exactly as classifyCallers reports. ──────────────
    for (const name of [...calleeNames].sort()) {
        const defs = db.resolveSymbol(name);
        if (!defs.length) continue;            // undefined name → no edge (findCallers falls back to scan)
        const defIds = defs.map(d => d.id);
        const { high, nameOnly } = classifyCallers(db, name);
        let n = 0; let capped = false;
        const emit = (callers, baseConf) => {
            for (const { chunk, proven } of callers) {
                // A2 (calls edges only): a data-backed resolver (scip) may CONFIRM the exact binding
                // (→ `resolved`) and SUPPRESS the SCIP-known wrong-target siblings. A def SCIP never
                // saw is neither — it falls through to the heuristic confidence (sound under partial
                // coverage). No resolveEdges (heuristic/precise) → decision null → byte-identical.
                const decision = resolver.resolveEdges
                    ? resolver.resolveEdges({ fromId: chunk.id, defIds })
                    : null;
                const fallbackConf = resolver.confidenceFor(baseConf, Boolean(proven));
                for (const def of defs) {
                    if (n >= maxPerName) { capped = true; return; }
                    if (decision && decision.resolved.has(def.id)) {
                        edges.push({ from_chunk_id: chunk.id, to_chunk_id: def.id, kind: 'calls', confidence: 'resolved' });
                    } else if (decision && decision.suppressed.has(def.id)) {
                        continue;                                  // SCIP-confirmed wrong-target → suppress
                    } else {
                        edges.push({ from_chunk_id: chunk.id, to_chunk_id: def.id, kind: 'calls', confidence: fallbackConf });
                    }
                    n++;
                }
            }
        };
        emit(high, 'high');
        if (!capped) emit(nameOnly, 'name_only');
        if (capped) cappedNames.push(name);
    }

    // ── 'extends' / 'type' edges: subclasses/implementers and type users → each
    //    definition, with the per-reference confidence findReferences assigns. ──────
    for (const name of [...refNames].sort()) {
        const defs = db.resolveSymbol(name);
        if (!defs.length) continue;
        const { inherits, types } = findReferences(db, name);
        let n = 0; let capped = false;
        // A2 scopes SCIP resolution to `calls` edges only: the binding relation is kind-agnostic, so
        // applying it here would let a call-site binding suppress/relabel `extends`/`type` siblings of
        // a different kind. These edges therefore stay heuristic under every resolver (byte-identical).
        const emit = (refs, kind) => {
            for (const r of refs) {
                const confidence = resolver.confidenceFor(normConfidence(r.confidence), Boolean(r.proven));
                for (const def of defs) {
                    if (n >= maxPerName) { capped = true; return; }
                    edges.push({ from_chunk_id: r.chunk.id, to_chunk_id: def.id, kind, confidence });
                    n++;
                }
            }
        };
        emit(inherits, 'extends');
        if (!capped) emit(types, 'type');
        if (capped && !cappedNames.includes(name)) cappedNames.push(name);
    }

    // Dedupe by (from, to, kind) keeping the STRONGEST confidence (resolved > high > name_only),
    // then return in the deterministic parity order. (On the default `heuristic` path the only
    // values are high/name_only and high is strongest → identical to the prior keep-first dedupe.)
    const rep = new Map();
    for (const e of edges) {
        const k = `${e.from_chunk_id}|${e.to_chunk_id}|${e.kind}`;
        const cur = rep.get(k);
        if (!cur) rep.set(k, { from_chunk_id: e.from_chunk_id, to_chunk_id: e.to_chunk_id, kind: e.kind, confidence: e.confidence });
        else cur.confidence = strongerConfidence(cur.confidence, e.confidence);
    }
    const out = [...rep.values()].sort(edgeOrder);
    return { edges: out, cappedNames };
}
