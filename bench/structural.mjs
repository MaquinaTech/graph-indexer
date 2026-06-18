#!/usr/bin/env node
/**
 * bench/structural.mjs <fixture...> — per-language structural-channel coverage.
 *
 * The structural fields (calls / call_sites / type_refs / extends) are parse-time,
 * config-independent, so this reads whatever index exists. Reports, per fixture:
 *   - call-graph:   % chunks with >=1 outbound call edge, avg calls/chunk,
 *                   % call_sites resolved (receiver-typed) vs name-only
 *   - find_references type-ref channel: % chunks carrying type_refs and/or extends
 *     (this is the empirical test of the C#/Ruby "empty type-refs" finding and the
 *      middle-tier languages Java/Kotlin/Go/Rust/Swift/C/PHP)
 *   - dynamic-receiver: call_sites with a null/empty receiver type → name-only callers
 *
 * Writes bench/results/structural.json (merged across fixtures passed).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { artifactPaths } from '../layout.mjs';
import { MemoryGraphIndex } from '../core-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(__dirname, 'results', 'structural.json');

const fixtures = process.argv.slice(2);
const prior = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, 'utf8')) : {};

for (const fx of fixtures) {
    const A = artifactPaths(path.join(ROOT, 'test', 'fixtures', fx));
    if (!fs.existsSync(A.indexPath)) { console.log(`${fx}: no index — skip`); continue; }
    const db = new MemoryGraphIndex(A.indexPath); db.load();
    const chunks = Array.from(db.iterateChunks());
    const n = chunks.length || 1;

    // node_type distribution (the real chunk-kind signal: function/method/class/...).
    const nodeTypes = {};
    for (const c of chunks) { const t = c.node_type || '∅'; nodeTypes[t] = (nodeTypes[t] || 0) + 1; }

    const withCalls = chunks.filter(c => c.calls && c.calls.length).length;
    const totalCalls = chunks.reduce((s, c) => s + (c.calls?.length || 0), 0);
    const withTypeRefs = chunks.filter(c => c.type_refs && c.type_refs.length).length;
    const withExtends = chunks.filter(c => c.extends && c.extends.length).length;
    const withEither = chunks.filter(c => (c.type_refs && c.type_refs.length) || (c.extends && c.extends.length)).length;

    // call_sites carry { name, recv } where `recv` is the receiver expression (e.g.
    // `this`, a variable, or a type). A present receiver is what lets the query-time
    // classifyCallers split high-confidence (receiver-qualified) from name-only
    // callers — the actual high/low classification is computed at query time, not
    // stored, so we report receiver PRESENCE here, not the final classification.
    let csTotal = 0, csRecv = 0;
    for (const c of chunks) {
        for (const cs of (c.call_sites || [])) {
            csTotal++;
            if (cs.recv && String(cs.recv).trim()) csRecv++;
        }
    }

    prior[fx] = {
        chunkCount: chunks.length,
        nodeTypes,
        callGraph: {
            chunksWithCallsPct: +(withCalls / n * 100).toFixed(1),
            avgCallsPerChunk: +(totalCalls / n).toFixed(2),
            totalCallEdges: totalCalls,
        },
        callSites: {
            total: csTotal,
            withReceiverPct: csTotal ? +(csRecv / csTotal * 100).toFixed(1) : null,
        },
        typeRefChannel: {
            // find_references fuses callers + `extends` (inheritance) + `type_refs`
            // (type-usage). Report the two non-call dimensions SEPARATELY: several
            // extractors populate `extends` but not `type_refs` (C#, Ruby), so an
            // "either" number would hide that the type-usage dimension is empty.
            typeRefsPct: +(withTypeRefs / n * 100).toFixed(1),
            extendsPct: +(withExtends / n * 100).toFixed(1),
            present: withEither > 0,
            typeRefsEmpty: withTypeRefs === 0,
        },
    };
    const t = prior[fx];
    console.log(`${fx.padEnd(12)} calls=${t.callGraph.chunksWithCallsPct}% (${t.callGraph.avgCallsPerChunk}/chunk)  type_refs=${t.typeRefChannel.typeRefsPct}%${t.typeRefChannel.typeRefsEmpty ? '⚠' : ''} extends=${t.typeRefChannel.extendsPct}%  call_sites=${csTotal}${csTotal ? ` (${t.callSites.withReceiverPct}% w/receiver)` : ''}`);
}

fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
fs.writeFileSync(RESULTS, JSON.stringify(prior, null, 2));
