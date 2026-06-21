#!/usr/bin/env node
/**
 * bench/verify-structural.mjs — confirm the "none" / "empty" structural verdicts
 * by ACTUALLY INVOKING the engine tools on each fixture's real index, not by
 * reading a field count (which once produced false positives: macOS grep treating
 * mcp/tools.mjs as binary; the `recv` vs `receiver_type` field mismatch).
 *
 *   • call-graph: for every uniquely-named defined symbol, run classifyCallers and
 *     count how many resolve ≥1 caller. A language with no call edges returns 0 for
 *     ALL symbols; a positive-control language returns many — proving the harness
 *     works and the zero is real.
 *   • type_refs: for sampled type/class symbols, run findReferences and report the
 *     `types` dimension (from chunk.type_refs) vs `inherits` (from chunk.extends).
 *     An "empty type_refs" language returns types=0 while inherits can be >0 — i.e.
 *     find_references degrades to inheritance/callers, exactly as documented.
 *
 * Read-only. Loads whatever index exists. Writes bench/results/verify-structural.json.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { artifactPaths } from '../layout.mjs';
import { MemoryGraphIndex } from '../engine/memory.mjs';
import { classifyCallers, findReferences } from '../mcp/topology.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(__dirname, 'results', 'verify-structural.json');

const fixtures = process.argv.slice(2);
if (!fixtures.length) { console.error('usage: node bench/verify-structural.mjs <fixture...>'); process.exit(1); }

function loadDb(fx) {
    const A = artifactPaths(path.join(ROOT, 'test', 'fixtures', fx));
    if (!fs.existsSync(A.indexPath)) return null;
    const db = new MemoryGraphIndex(A.indexPath); db.load();
    return db;
}

// Merge with existing results so running for a subset doesn't wipe other fixtures.
const out = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, 'utf8')) : {};
for (const fx of fixtures) {
    const db = loadDb(fx);
    if (!db) { console.log(`${fx}: no index — skip`); continue; }
    const chunks = Array.from(db.iterateChunks());

    // ── Call-graph invocation, two ways, because the answer differs by chunk
    //    granularity and we must not under- or over-state it:
    //   (a) over indexed DEFINITION names (does get_call_graph find callers of a
    //       symbol that IS a chunk — the navigable case);
    //   (b) over CALLEE names harvested from chunks' `calls` arrays (what a user
    //       actually passes to get_call_graph — reachable even when the callee is
    //       not its own chunk, e.g. Java methods inside a class chunk).
    //   "none" requires BOTH to be empty (truly no call edges, e.g. C#/PHP). A
    //   language with (b)>0 but (a)≈0 is call-graphed but at coarse granularity. ──
    const defNames = [...new Set(chunks.map(c => c.name).filter(Boolean))];
    let symbolsWithCallers = 0, totalCallerEdges = 0;
    const examples = [];
    for (const name of defNames) {
        const { high, nameOnly } = classifyCallers(db, name);
        const n = high.length + nameOnly.length;
        if (n > 0) {
            symbolsWithCallers++;
            totalCallerEdges += n;
            if (examples.length < 3) examples.push({ symbol: name, callers: n, sample: (high[0] || nameOnly[0])?.chunk?.name });
        }
    }
    const calleeNames = [...new Set(chunks.flatMap(c => c.calls || []))];
    let calleesResolvingCallers = 0, calleesThatAreDefs = 0, calleeCallerEdges = 0;
    for (const name of calleeNames) {
        const { high, nameOnly } = classifyCallers(db, name);
        const n = high.length + nameOnly.length;
        if (n > 0) { calleesResolvingCallers++; calleeCallerEdges += n; }
        if (db.resolveSymbol(name).length > 0) calleesThatAreDefs++;
    }
    const trulyEmpty = calleeNames.length === 0;

    // ── find_references invocation. The DEFINITIVE empty-test is whether ANY chunk
    //    carries a non-empty type_refs array (a full scan — no sampling luck; a
    //    sampled findReferences can falsely read "empty" on a low-density language
    //    like fastapi at 17.8%). We then ALSO invoke findReferences on sampled
    //    type/class symbols for live examples of the `types` vs `inherits` split. ──
    const anyTypeRefs = chunks.some(c => c.type_refs && c.type_refs.length);
    const chunksWithTypeRefs = chunks.filter(c => c.type_refs && c.type_refs.length).length;
    const typeish = chunks.filter(c => /class|interface|struct|type|protocol|trait|enum/i.test(c.node_type || '')).map(c => c.name).filter(Boolean);
    const sample = [...new Set(typeish)].slice(0, 20);
    let sumTypes = 0, sumInherits = 0, sumCallRefs = 0;
    const refExamples = [];
    for (const sym of sample) {
        const r = findReferences(db, sym);
        const t = r.types.length, inh = r.inherits.length, cr = r.calls.high.length + r.calls.nameOnly.length;
        sumTypes += t; sumInherits += inh; sumCallRefs += cr;
        if ((t || inh) && refExamples.length < 3) refExamples.push({ symbol: sym, types: t, inherits: inh });
    }

    out[fx] = {
        chunkCount: chunks.length,
        callGraph: {
            category: trulyEmpty ? 'none' : symbolsWithCallers === 0 ? 'degraded' : 'yes',
            definedSymbols: defNames.length,
            symbolsWithAtLeastOneCaller: symbolsWithCallers,
            totalCallerEdges,
            distinctCallees: calleeNames.length,
            calleesResolvingCallers,
            calleesThatAreIndexedDefs: calleesThatAreDefs,
            calleeCallerEdges,
            verdict: trulyEmpty ? 'NONE — index has zero call edges; get_call_graph returns nothing for any symbol (verified by invocation)'
                : symbolsWithCallers === 0 ? `degraded — ${calleeNames.length} callee names resolve callers (${calleeCallerEdges} edges) but only ${calleesThatAreDefs} callee is its own indexed chunk (coarse/class granularity)`
                    : `present — ${symbolsWithCallers}/${defNames.length} indexed symbols resolve ≥1 caller; ${calleesResolvingCallers}/${calleeNames.length} callee names reachable`,
            examples,
        },
        findReferences: {
            category: anyTypeRefs ? 'populated' : 'empty',
            chunksCarryingTypeRefs: chunksWithTypeRefs,
            typeRefsEmpty: !anyTypeRefs,
            sampledTypeSymbols: sample.length,
            sumTypeRefsInSample: sumTypes,
            sumInheritsInSample: sumInherits,
            sumCallRefsInSample: sumCallRefs,
            verdict: !anyTypeRefs ? 'type_refs EMPTY — no chunk carries any type_refs; find_references returns no type-usage refs for any symbol (verified by full scan + invocation)'
                : `type_refs populated — ${chunksWithTypeRefs} chunks carry type_refs (sample surfaced ${sumTypes} type-usage refs over ${sample.length} symbols)`,
            inheritsNote: sumInherits > 0 ? `inheritance still works (${sumInherits} extends-refs in sample) — graceful degradation` : 'no inheritance refs in sample',
            refExamples,
        },
    };
    const cg = out[fx].callGraph, fr = out[fx].findReferences;
    console.log(`\n${fx} (${chunks.length} chunks)`);
    console.log(`  call-graph: ${cg.verdict}`);
    if (cg.examples.length) console.log(`     e.g. ${cg.examples.map(e => `${e.symbol}←${e.callers}`).join(', ')}`);
    console.log(`  find_references: ${fr.verdict}; ${fr.inheritsNote}`);
}

// Stable fixture order for the JSON artifact.
{
    const FIX_ORDER = ['axios', 'express-js', 'nestjs', 'react', 'fastapi', 'django', 'gin', 'rust', 'spring', 'android', 'aspnet', 'rails', 'laravel', 'symfony', 'css', 'cjson', 'nvm', 'alamofire'];
    const ordered = {};
    for (const k of FIX_ORDER) if (out[k]) ordered[k] = out[k];
    for (const k of Object.keys(out)) if (!ordered[k]) ordered[k] = out[k];
    for (const k of Object.keys(out)) delete out[k];
    Object.assign(out, ordered);
}

fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2));
console.log(`\nwrote ${path.relative(ROOT, RESULTS)}`);
