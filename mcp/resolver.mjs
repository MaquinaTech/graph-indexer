/**
 * @file mcp/resolver.mjs
 * @description Resolver providers (A1): pluggable confidence assignment for the A4 symbol
 *              graph. The DEFAULT `heuristic` provider preserves today's two-tier confidence
 *              ({ high, name_only }) exactly. The opt-in `precise` provider lifts the subset of
 *              edges whose binding is provably UNAMBIGUOUS into a third, stronger tier,
 *              `resolved` — a reference is `resolved` when there is no question *which*
 *              definition it binds to:
 *                • the symbol has a single definition in the repo (no same-named rival), or
 *                • the receiver's TYPE matches the defining class (typed receiver, the A3
 *                  inter-procedural fixpoint result, `this.m()` inside the class, or an explicit
 *                  target class) — type-resolved, so immune to name shadowing.
 *              `high` then means "ambiguous name, disambiguated by import/proximity" and
 *              `name_only` means "ambiguous name, no evidence."
 *
 *              The provider only changes the `confidence` STRING on edges that already exist —
 *              it never adds, drops, or reorders edges — so it is parity-free (confidence is
 *              already serialized) and `findCallers`/`findReferers` set-equivalence is preserved.
 *              It runs at index time inside buildSymbolGraph and is inert without --symbol-graph.
 *
 *              SCOPE (honest): v1 exposes the unambiguous-binding tier the engine can already
 *              prove from index-time signals. Detecting a LOCAL variable that *shadows* an import
 *              (and refuting that edge), and cross-file precise resolution via stack-graphs, are
 *              the documented next layers — both require per-language AST/scope analysis.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */

/** Total order on confidence — strongest first. Used by the symbol-graph dedupe. */
export const CONFIDENCE_RANK = { resolved: 3, high: 2, name_only: 1 };

/** The stronger of two confidence strings (ties → `a`). */
export function strongerConfidence(a, b) {
    return (CONFIDENCE_RANK[b] || 0) > (CONFIDENCE_RANK[a] || 0) ? b : a;
}

/**
 * Default provider: identity. Edge confidence stays exactly { high, name_only } — the index is
 * byte-identical to a pre-A1 build.
 */
const HEURISTIC = {
    name: 'heuristic',
    /** @param {string} base 'high' | 'name_only' @param {boolean} _proven */
    confidenceFor(base /* , proven */) { return base; },
};

/**
 * Precise provider: promote a `high` edge to `resolved` when its binding is provably
 * unambiguous (the `proven` flag set by classifyCallers / findReferences). Never touches
 * `name_only` (no evidence stays no evidence) and never downgrades.
 */
const PRECISE = {
    name: 'precise',
    /** @param {string} base @param {boolean} proven */
    confidenceFor(base, proven) { return base === 'high' && proven ? 'resolved' : base; },
};

const PROVIDERS = { heuristic: HEURISTIC, precise: PRECISE };

/** Resolve a provider by name; unknown names fall back to the default heuristic. */
export function getResolver(name) { return PROVIDERS[name] || HEURISTIC; }

/**
 * SCIP provider (A2): a DATA-BACKED resolver built from a cross-file binding relation
 * (`bindings: Map<fromChunkId, Set<defChunkId>>`) and the set of defs SCIP actually saw
 * (`definedChunks`), both produced from a locally-generated SCIP index (see parse/scip.mjs
 * `buildScipBindings`). Unlike heuristic/precise — which only RELABEL a fixed edge set — the SCIP
 * provider can also SUPPRESS edges, because SCIP knows the *exact* binding among several same-named
 * definitions. For a caller `fromId` and the candidate defs `defIds` of one name:
 *
 *   • no SCIP target for `fromId` at all, OR none of `defIds` is a target → return null: the
 *     builder falls through to the heuristic confidence (absence ≠ refutation for this name).
 *   • SCIP confirms `fromId` binds to ≥1 of `defIds` → `resolved` = those confirmed def(s);
 *     `suppressed` = the OTHER candidate defs **that SCIP actually saw as definitions**
 *     (`def ∈ definedChunks`). A candidate def SCIP NEVER recorded — an uncovered file in a
 *     polyglot / partial run, a stale `.scip`, a missed occurrence — is neither resolved nor
 *     suppressed: it falls through to heuristic, so a covered caller referencing an *uncovered* def
 *     is never wrongly dropped. This is the soundness gate the partial-coverage case needs.
 *
 * It refines the heuristic's CANDIDATE edges (promote + suppress); it does not synthesize edges the
 * AST call-extraction missed (a v2 recall concern). The symbol-graph builder applies this to `calls`
 * edges only — the binding relation is kind-agnostic, so `extends`/`type` edges stay heuristic.
 * `confidenceFor` is identity, so any edge SCIP does not cover keeps its base confidence.
 *
 * @param {Map<string, Set<string>>} bindings  fromChunkId → set of def chunk ids SCIP confirms.
 * @param {Set<string>} [definedChunks]  every chunk SCIP recorded as a definition (suppression gate).
 * @returns {{ name:string, confidenceFor:Function, resolveEdges:Function }}
 */
export function createScipResolver(bindings, definedChunks) {
    const rel = bindings instanceof Map ? bindings : new Map();
    const defined = definedChunks instanceof Set ? definedChunks : new Set();
    return {
        name: 'scip',
        /** Uncovered edges keep their base confidence (no promotion without SCIP evidence). */
        confidenceFor(base /* , proven */) { return base; },
        /**
         * @param {{ fromId:string, defIds:string[] }} q
         * @returns {{ resolved: Set<string>, suppressed: Set<string> } | null}  null → no SCIP info.
         */
        resolveEdges({ fromId, defIds }) {
            const targets = rel.get(fromId);
            if (!targets || !targets.size) return null;          // caller uncovered → no opinion
            const resolved = new Set();
            for (const id of defIds) if (targets.has(id)) resolved.add(id);
            if (!resolved.size) return null;                     // binds none of THIS name's defs → fall through
            const suppressed = new Set();
            for (const id of defIds) {
                if (resolved.has(id)) continue;
                if (defined.has(id)) suppressed.add(id);          // SCIP saw this def but bound elsewhere → wrong-target
                // else: def uncovered by SCIP → keep heuristic (sound under partial coverage)
            }
            return { resolved, suppressed };
        },
    };
}
