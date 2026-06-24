/**
 * @file parse/interprocedural.mjs
 * @description Bounded, deterministic INTER-procedural return-type fixpoint (opt-in).
 *
 *              The intra-procedural inference in parse/metadata.mjs already resolves a
 *              call-site receiver one hop: `const r = makeRepo(); r.save()` records
 *              `recv_via_call = 'makeRepo'`, and classifyCallers reads makeRepo's recorded
 *              `return_type` at query time. That misses MULTI-hop factory chains and
 *              unannotated factories: `makeRepoIndirect()` returns `makeRepo()` returns
 *              `new OrderRepo()` — the indirect factory has no return type to read.
 *
 *              This pass propagates return types along factory return-call edges with a
 *              monotone worklist fixpoint, so `makeRepoIndirect` resolves transitively to
 *              `OrderRepo`. It runs ONCE at index time over all chunks and writes the result
 *              into each call site as `recv_resolved_type`; because call_sites is serialized
 *              identically by both backends, the resolved data is parity-free. classifyCallers
 *              prefers `recv_resolved_type` and keeps the 1-hop `recv_via_call` fallback, so an
 *              index built without this pass (or a per-file daemon update) is never worse.
 *
 *              Determinism: iteration is over SORTED symbol/edge keys and the lattice is
 *              monotone (each step only adds the single concrete type or transitions to an
 *              absorbing CONFLICT), so the result is independent of map insertion order — a
 *              hard requirement for memory↔sqlite parity.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */

// Hard safety net against pathological/cyclic graphs. Each iteration propagates types one
// extra hop; real factory chains are 1–3 hops, so the `changed` flag normally converges well
// before this — the bound only guarantees termination, it is not the expected stop condition.
const MAX_ITERS = 8;

// Absorbing "two distinct concrete types" state — contributes nothing (conservative DROP,
// mirroring _inferLocalBindings' conflict handling in parse/metadata.mjs).
const CONFLICT = Symbol('conflict');

/**
 * The single concrete type NAME a string denotes, or null when it is not exactly one
 * type identifier (generics / unions / primitives are ambiguous → conservatively dropped).
 * 'OrderRepo' → 'OrderRepo'; 'Promise<Order>' → null; 'number' → null.
 */
function singleTypeName(str) {
    if (!str) return null;
    const ids = String(str).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
    const types = ids.filter(t => /^[A-Z]/.test(t)); // PascalCase = a type (matches _typeMatchTokens)
    return types.length === 1 ? types[0] : null;
}

/**
 * Resolve, per function symbol (lowercased name), the single concrete return TYPE it
 * yields — directly (annotation or `return new X()`) or transitively through factory
 * return-call edges. Symbols whose chain yields ≥2 distinct types (or stays unresolved)
 * are omitted.
 *
 * @param {object[]} chunks  Chunks carrying `name`, `return_type`, and the transient
 *                           `_return_via` ({type}|{viaCall}) from extractReturnVia.
 * @returns {Map<string,string>} nameLower → resolved type name.
 */
export function resolveReturnTypes(chunks) {
    const symRet = new Map();   // nameLower → typeName | CONFLICT
    const edges = new Map();    // nameLower → Set<calleeLower>  (only for symbols with no direct type)

    const seed = (nm, type) => {
        const prev = symRet.get(nm);
        if (prev === CONFLICT) return;
        if (prev === undefined) symRet.set(nm, type);
        else if (prev !== type) symRet.set(nm, CONFLICT);
    };

    for (const c of chunks) {
        if (!c.name || c.name === 'anonymous') continue;
        const nm = c.name.toLowerCase();
        const via = c._return_via;
        const annot = singleTypeName(c.return_type);
        // Direct type wins over the edge: annotation and/or `return new X()`.
        let directType = annot || (via && via.type) || null;
        if (annot && via && via.type && annot !== via.type) { symRet.set(nm, CONFLICT); directType = null; }
        if (directType) {
            seed(nm, directType);
        } else if (via && via.viaCall) {
            const callee = via.viaCall.toLowerCase();
            if (!edges.has(nm)) edges.set(nm, new Set());
            edges.get(nm).add(callee);
        }
    }

    const sortedEdgeKeys = [...edges.keys()].sort();
    for (let iter = 0; iter < MAX_ITERS; iter++) {
        let changed = false;
        for (const sym of sortedEdgeKeys) {
            if (symRet.has(sym)) continue; // already resolved (or conflict)
            let resolved = null, conflict = false;
            for (const callee of [...edges.get(sym)].sort()) {
                const ct = symRet.get(callee);
                if (ct === undefined || ct === CONFLICT) continue;
                if (resolved === null) resolved = ct;
                else if (resolved !== ct) conflict = true;
            }
            if (conflict) { symRet.set(sym, CONFLICT); changed = true; }
            else if (resolved !== null) { symRet.set(sym, resolved); changed = true; }
        }
        if (!changed) break;
    }

    const out = new Map();
    for (const [nm, t] of symRet) if (t !== CONFLICT && typeof t === 'string') out.set(nm, t);
    return out;
}

/**
 * Run the fixpoint over a chunk list and annotate each factory-receiver call site with the
 * resolved `recv_resolved_type`; strip the transient `_return_via` so it never serializes.
 * Mutates chunks in place and returns them.
 *
 * @param {object[]} chunks
 * @returns {object[]} the same array
 */
export function applyInterprocedural(chunks) {
    const symRet = resolveReturnTypes(chunks);
    for (const c of chunks) {
        if (Array.isArray(c.call_sites)) {
            for (const s of c.call_sites) {
                // Only fill in what intra-procedural inference left unresolved.
                if (s && !s.recv_type && s.recv_via_call) {
                    const t = symRet.get(String(s.recv_via_call).toLowerCase());
                    if (t) s.recv_resolved_type = t;
                }
            }
        }
        if ('_return_via' in c) delete c._return_via;
    }
    return chunks;
}
