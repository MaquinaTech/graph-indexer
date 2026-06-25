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
