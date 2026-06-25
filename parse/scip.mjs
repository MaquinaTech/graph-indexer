/**
 * @file parse/scip.mjs
 * @description A2 — SCIP ingestion for the precise resolver provider. Reads a LOCALLY-generated
 *              SCIP index (Sourcegraph's protocol; produced out-of-band by the user's own
 *              air-gapped toolchain — `scip-typescript`, `scip-python`, `scip-java`,
 *              `rust-analyzer --scip`) and aligns its symbol OCCURRENCES to our AST chunks by
 *              (file, line), yielding a genuinely cross-file binding relation:
 *
 *                  bindings: Map<fromChunkId, Set<defChunkId>>
 *
 *              i.e. "chunk F references a symbol whose definition lives in chunk D." The `scip`
 *              resolver (mcp/resolver.mjs) consumes this to (a) PROMOTE a heuristic edge to the
 *              `resolved` tier when SCIP confirms it, and (b) SUPPRESS the wrong-target edges a
 *              name-only fan-out would otherwise emit — the precision A1's heuristic cannot reach.
 *
 *              ZERO new runtime dependency: the `.scip` protobuf is decoded by a minimal,
 *              hand-rolled wire reader (only the four fields A2 needs — Index.documents,
 *              Document.relative_path / .occurrences, Occurrence.range / .symbol / .symbol_roles).
 *              A SCIP-shaped JSON file is also accepted (handy for hand-authored fixtures and for
 *              `scip print`-style dumps). Fully offline; pure parsing + graph alignment.
 *
 *              HONEST SCOPE: SCIP coverage is only as good as the indexer that produced the file
 *              and the (file, range) alignment to our chunks. Suppression is SOUND under partial
 *              coverage — a candidate def is dropped only if SCIP actually recorded it as a
 *              definition (`definedChunks`); a def SCIP never saw falls through to heuristic. v1
 *              applies SCIP resolution to `calls` edges only (the binding relation is kind-agnostic,
 *              so `extends`/`type` edges stay heuristic to avoid cross-kind contamination).
 *
 *              A2 v2 ADDS a second, kind-agnostic consumer that the same binding relation serves
 *              soundly precisely BECAUSE it is kind-agnostic: `buildScipReferers` inverts the
 *              bindings into a precise cross-file "referenced-by" map for find_references — no edge
 *              suppression, no cross-kind risk, just the binding-precise reference set serialized as
 *              an isolated index artifact (like centrality/taint), so it cannot perturb A4 edges or
 *              A5 centrality.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'node:fs';

// ── SCIP schema field numbers (scip.proto) — only what A2 reads ─────────────────────────────
//   Index.documents          = 2  (repeated Document)
//   Document.relative_path    = 1  (string)
//   Document.occurrences      = 2  (repeated Occurrence)
//   Occurrence.range          = 1  (repeated int32, packed)
//   Occurrence.symbol         = 2  (string)
//   Occurrence.symbol_roles   = 3  (int32 bitset; Definition = 0x1)
const F_INDEX_DOCUMENTS = 2;
const F_DOC_RELATIVE_PATH = 1;
const F_DOC_OCCURRENCES = 2;
const F_OCC_RANGE = 1;
const F_OCC_SYMBOL = 2;
const F_OCC_SYMBOL_ROLES = 3;
const ROLE_DEFINITION = 0x1;

// ── Minimal protobuf wire-format reader (zero deps) ─────────────────────────────────────────

/**
 * Read a base-128 varint as a JS Number. Uses multiplication (not bit-shift) so values up to
 * 2^53 decode correctly — proto lengths / line numbers never exceed that in practice.
 * @returns {[number, number]} [value, nextPos]
 */
function readVarint(buf, pos) {
    let result = 0;
    let mul = 1;
    let p = pos;
    for (;;) {
        if (p >= buf.length) throw new Error('SCIP: truncated varint');
        const b = buf[p++];
        result += (b & 0x7f) * mul;
        if ((b & 0x80) === 0) break;
        mul *= 128;
    }
    return [result, p];
}

/**
 * Iterate the fields of one protobuf message region [start, end). Yields, per field, either a
 * scalar `{ field, wire, value }` (varint / fixed) or a length-delimited `{ field, wire, start,
 * end }` slice. Unknown fields are yielded too (callers skip what they don't recognise).
 */
function* iterFields(buf, start, end) {
    let p = start;
    while (p < end) {
        let tag;
        [tag, p] = readVarint(buf, p);
        const field = Math.floor(tag / 8);
        const wire = tag % 8;
        if (wire === 0) {
            let value;
            [value, p] = readVarint(buf, p);
            yield { field, wire, value };
        } else if (wire === 2) {
            let len;
            [len, p] = readVarint(buf, p);
            const s = p;
            p += len;
            if (p > end) throw new Error('SCIP: length-delimited field overruns message');
            yield { field, wire, start: s, end: p };
        } else if (wire === 5) {
            if (p + 4 > end) throw new Error('SCIP: fixed32 field overruns message');
            const value = buf.readUInt32LE(p);
            p += 4;
            yield { field, wire, value };
        } else if (wire === 1) {
            if (p + 8 > end) throw new Error('SCIP: fixed64 field overruns message');
            const lo = buf.readUInt32LE(p);
            const hi = buf.readUInt32LE(p + 4);
            p += 8;
            yield { field, wire, value: hi * 4294967296 + lo };
        } else {
            throw new Error(`SCIP: unsupported wire type ${wire}`);
        }
    }
}

/** Read all packed varints in [start, end) into an array (Occurrence.range is packed int32). */
function readPackedVarints(buf, start, end) {
    const out = [];
    let p = start;
    while (p < end) {
        let v;
        [v, p] = readVarint(buf, p);
        out.push(v);
    }
    return out;
}

/**
 * SCIP `range` → 0-based start line. Length-3 ranges are [startLine, startChar, endChar]
 * (single line); length-4 are [startLine, startChar, endLine, endChar]. We key alignment on the
 * start line only.
 */
function rangeStartLine(range) {
    return Array.isArray(range) && range.length >= 1 ? range[0] : null;
}

function parseOccurrence(buf, start, end) {
    let range = [];
    let symbol = '';
    let roles = 0;
    for (const f of iterFields(buf, start, end)) {
        if (f.field === F_OCC_RANGE) {
            if (f.wire === 2) range = range.concat(readPackedVarints(buf, f.start, f.end)); // packed
            else if (f.wire === 0) range.push(f.value); // unpacked fallback
        } else if (f.field === F_OCC_SYMBOL && f.wire === 2) {
            symbol = buf.toString('utf8', f.start, f.end);
        } else if (f.field === F_OCC_SYMBOL_ROLES && f.wire === 0) {
            roles = f.value;
        }
    }
    const startLine = rangeStartLine(range);
    if (startLine === null || !symbol) return null;
    return { startLine, symbol, isDefinition: (roles & ROLE_DEFINITION) === ROLE_DEFINITION };
}

function parseDocument(buf, start, end) {
    let relativePath = '';
    const occurrences = [];
    for (const f of iterFields(buf, start, end)) {
        if (f.field === F_DOC_RELATIVE_PATH && f.wire === 2) {
            relativePath = buf.toString('utf8', f.start, f.end);
        } else if (f.field === F_DOC_OCCURRENCES && f.wire === 2) {
            const occ = parseOccurrence(buf, f.start, f.end);
            if (occ) occurrences.push(occ);
        }
    }
    return { relativePath, occurrences };
}

/** Decode a `.scip` protobuf buffer into `{ documents: [{ relativePath, occurrences }] }`. */
function decodeScipProtobuf(buf) {
    const documents = [];
    for (const f of iterFields(buf, 0, buf.length)) {
        if (f.field === F_INDEX_DOCUMENTS && f.wire === 2) {
            documents.push(parseDocument(buf, f.start, f.end));
        }
    }
    return { documents };
}

// ── JSON-shaped SCIP (convenience: hand-authored fixtures, `scip print` dumps) ──────────────

function normalizeJsonScip(obj) {
    const rawDocs = obj.documents || obj.Documents || [];
    const documents = [];
    for (const d of rawDocs) {
        const relativePath = d.relative_path || d.relativePath || d.path || '';
        const occurrences = [];
        for (const o of (d.occurrences || d.Occurrences || [])) {
            const range = o.range || o.Range || [];
            const symbol = o.symbol || o.Symbol || '';
            const roles = o.symbol_roles || o.symbolRoles || o.roles || 0;
            const startLine = rangeStartLine(range);
            if (startLine === null || !symbol) continue;
            occurrences.push({ startLine, symbol, isDefinition: (roles & ROLE_DEFINITION) === ROLE_DEFINITION });
        }
        documents.push({ relativePath, occurrences });
    }
    return { documents };
}

/**
 * Load a SCIP index from disk. Accepts the `.scip` protobuf OR a SCIP-shaped JSON file
 * (auto-detected: a leading `{` / `.json` extension → JSON). Returns the decoded documents and a
 * loud-on-failure shape (throws with an actionable message; the caller decides whether a missing
 * file is fatal or a warning).
 *
 * @param {string} filePath
 * @returns {{ documents: Array<{ relativePath: string, occurrences: Array<{ startLine:number, symbol:string, isDefinition:boolean }> }> }}
 */
export function loadScip(filePath) {
    let buf;
    try {
        buf = fs.readFileSync(filePath);
    } catch (e) {
        throw new Error(`SCIP index not readable at ${filePath}: ${e.message}`);
    }
    const looksJson = filePath.endsWith('.json') || (buf.length > 0 && (buf[0] === 0x7b /* { */ || buf[0] === 0x5b /* [ */));
    if (looksJson) {
        try {
            return normalizeJsonScip(JSON.parse(buf.toString('utf8')));
        } catch (e) {
            throw new Error(`SCIP JSON parse failed at ${filePath}: ${e.message}`);
        }
    }
    try {
        return decodeScipProtobuf(buf);
    } catch (e) {
        throw new Error(`SCIP protobuf decode failed at ${filePath}: ${e.message}`);
    }
}

// ── Alignment: SCIP occurrences → our chunk ids ─────────────────────────────────────────────

/** Normalize a SCIP document path to our chunk `file_path` form: repo-root-relative, POSIX, no `./`. */
export function normalizeScipPath(p) {
    if (!p) return '';
    let s = String(p).replace(/\\/g, '/');
    s = s.replace(/^file:\/\//, '');     // tolerate a file:// URI prefix
    s = s.replace(/^\.?\//, '');          // strip a leading './' or '/'
    return s;
}

function addToSetMap(map, key, value) {
    let s = map.get(key);
    if (!s) { s = new Set(); map.set(key, s); }
    s.add(value);
}

/**
 * Find the MOST SPECIFIC chunk (smallest line span) whose 1-based [start_line, end_line] range
 * contains `line1`. Deterministic tie-break: larger start_line (innermost), then smaller id.
 * `arr` is the file's chunk list (any order — we scan it fully; files have few chunks).
 */
function chunkContaining(arr, line1) {
    let best = null;
    let bestSpan = Infinity;
    for (const c of arr) {
        if (c.start_line <= line1 && line1 <= c.end_line) {
            const span = c.end_line - c.start_line;
            if (span < bestSpan
                || (span === bestSpan && best && (c.start_line > best.start_line
                    || (c.start_line === best.start_line && c.id < best.id)))) {
                best = c;
                bestSpan = span;
            }
        }
    }
    return best;
}

/**
 * Align a decoded SCIP index to a loaded store's chunks and derive the cross-file binding
 * relation the `scip` resolver consumes:
 *
 *     bindings: Map<fromChunkId, Set<defChunkId>>   // "chunk F references a symbol defined in D"
 *
 * Built by: (1) bucket chunks by file; (2) for each SCIP occurrence, locate its containing chunk
 * by 1-based line range (SCIP lines are 0-based → +1); (3) split occurrences into per-symbol
 * DEFINITIONS (symbol_roles & Definition) and per-chunk REFERENCES; (4) join references to the
 * chunk(s) that define each referenced symbol. Self-references are dropped (a def referencing
 * itself is not an inbound edge). Fully deterministic; pure graph alignment, no network.
 *
 * Also returns `definedChunks` — every chunk SCIP recorded a DEFINITION occurrence for. This is the
 * SOUNDNESS gate for suppression: a candidate def may be dropped as a wrong-target only if SCIP
 * actually *saw* it as a definition (`def ∈ definedChunks`). A def SCIP never covered (an uncovered
 * file in a polyglot / partial run, a stale `.scip`, a missed occurrence) is NEVER suppressed — it
 * falls through to heuristic confidence, honouring "files the SCIP index does not cover are never
 * worse" even when the *caller* is covered but the *def* is not.
 *
 * @param {object} db  A loaded store exposing iterateChunks() (chunks carry file_path/start_line/end_line/id).
 * @param {{documents: Array}} scip  The result of loadScip().
 * @returns {{ bindings: Map<string, Set<string>>, definedChunks: Set<string>, stats: object }}
 */
export function buildScipBindings(db, scip) {
    const documents = (scip && scip.documents) || [];

    // (1) one pass over chunks → Map<file_path, chunk[]>
    const byFile = new Map();
    for (const c of db.iterateChunks()) {
        let arr = byFile.get(c.file_path);
        if (!arr) { arr = []; byFile.set(c.file_path, arr); }
        arr.push(c);
    }

    const defChunkBySymbol = new Map(); // symbol → Set<chunkId> (definition occurrences)
    const refSymbolsByChunk = new Map(); // chunkId → Set<symbol> (reference occurrences)
    let matchedDocs = 0;
    let placedOcc = 0;
    let totalOcc = 0;

    // (2)+(3) place occurrences into chunks
    for (const doc of documents) {
        const fp = normalizeScipPath(doc.relativePath);
        const arr = byFile.get(fp);
        if (!arr) continue;               // SCIP doc not in our index (path mismatch or uncovered)
        matchedDocs++;
        for (const occ of (doc.occurrences || [])) {
            totalOcc++;
            const line1 = occ.startLine + 1; // SCIP 0-based → our 1-based
            const c = chunkContaining(arr, line1);
            if (!c) continue;
            placedOcc++;
            if (occ.isDefinition) addToSetMap(defChunkBySymbol, occ.symbol, c.id);
            else addToSetMap(refSymbolsByChunk, c.id, occ.symbol);
        }
    }

    // (4) derive fromChunk → Set<defChunk>
    const bindings = new Map();
    let pairCount = 0;
    for (const [fromId, symbols] of refSymbolsByChunk) {
        for (const sym of symbols) {
            const defChunks = defChunkBySymbol.get(sym);
            if (!defChunks) continue;
            for (const defId of defChunks) {
                if (defId === fromId) continue; // self-reference is not an inbound edge
                const before = bindings.get(fromId)?.size || 0;
                addToSetMap(bindings, fromId, defId);
                if ((bindings.get(fromId)?.size || 0) > before) pairCount++;
            }
        }
    }

    // The set of chunks SCIP recorded as a definition — the suppression soundness gate.
    const definedChunks = new Set();
    for (const ids of defChunkBySymbol.values()) for (const id of ids) definedChunks.add(id);

    const stats = {
        docs: documents.length,
        matchedDocs,
        occurrences: totalOcc,
        placedOccurrences: placedOcc,
        definedSymbols: defChunkBySymbol.size,
        definedChunks: definedChunks.size,
        boundChunks: bindings.size,
        bindingPairs: pairCount,
    };
    return { bindings, definedChunks, stats };
}

/**
 * A2 v2 — invert the cross-file binding relation into the precise "referenced-by" map that
 * find_references consumes:
 *
 *     scipRefs: { defChunkId: [refererChunkId, ...] }   // "this definition is referenced by …"
 *
 * SCIP occurrences are kind-AGNOSTIC — a Reference occurrence is "symbol X is used here," with no
 * call/type-use/inheritance distinction — which is exactly the question find_references answers
 * ("what references this symbol?"). So the inverse of `bindings` is a genuinely cross-file,
 * binding-precise reference set: it (a) DISAMBIGUATES same-named symbols (a referer is attached to
 * the one definition SCIP bound it to, not every same-named def the name heuristic would match), and
 * (b) RECOVERS references the AST/name heuristic misses entirely (the v1 "recall concern"), e.g.
 * type usages in languages whose `type_refs` channel is empty. Serialized deterministically (sorted
 * def ids, sorted referer ids) so both backends round-trip byte-identically. Self-references were
 * already dropped upstream in buildScipBindings.
 *
 * @param {Map<string, Set<string>>} bindings  fromChunkId → set of def chunk ids (buildScipBindings).
 * @returns {Record<string, string[]>}  defChunkId → sorted referer chunk ids (empty object when none).
 */
export function buildScipReferers(bindings) {
    const rel = bindings instanceof Map ? bindings : new Map();
    const inv = new Map();                       // defChunkId → Set<refererChunkId>
    for (const [refererId, defIds] of rel) {
        for (const defId of defIds) addToSetMap(inv, defId, refererId);
    }
    const out = {};
    for (const defId of [...inv.keys()].sort()) out[defId] = [...inv.get(defId)].sort();
    return out;
}
