#!/usr/bin/env node
/**
 * test/agent/search-eval.mjs
 *
 * Deterministic, LLM-free evaluation of the `search_code` tool across every
 * benchmark fixture, in BOTH retrieval modes:
 *
 *   - LEXICAL  — Ollama unreachable → queryVector is null → pure BM25 ranking.
 *   - SEMANTIC — Ollama on $OLLAMA_SEMANTIC_HOST → hybrid RRF (vectors + BM25).
 *
 * For each case in search-cases.mjs we run the real tool handler and record the
 * rank at which the expected target chunk first appears. This is the objective
 * answer to "does search_code actually find the right code, lexically and
 * semantically?" — the gap the agent-trace benchmark alone could not measure.
 *
 * Usage:
 *   node test/agent/search-eval.mjs                 # all fixtures with cases
 *   node test/agent/search-eval.mjs gin rust        # selected fixtures
 *   node test/agent/search-eval.mjs --json
 */
import { createBridge } from './tool-bridge.mjs';
import { SEARCH_CASES } from './search-cases.mjs';

const SEMANTIC_HOST = process.env.OLLAMA_SEMANTIC_HOST || 'http://localhost:11435';
const DEAD_HOST = 'http://127.0.0.1:1';          // guaranteed connection-refused → lexical
const TOP_K = 12;

/** Parse rendered search_code cards → ordered [{rank,name,type,file}]. */
function parseCards(text) {
    const cards = [];
    const lines = text.split('\n');
    let cur = null;
    for (const line of lines) {
        const m = line.match(/^#(\d+) · \*\*(.+?)\*\*(?: \[(.+?)\])?/);
        if (m) {
            cur = { rank: Number(m[1]), name: m[2], type: m[3] || '', file: '' };
            cards.push(cur);
            continue;
        }
        const f = line.match(/^📄 (.+?):\d/);
        if (f && cur && !cur.file) cur.file = f[1];
    }
    return cards;
}

/** Does a card satisfy an expectation? expect = { name?, file?, type? } (all substrings, case-insensitive). */
function matches(card, expect) {
    const lc = (s) => (s || '').toLowerCase();
    if (expect.name && !lc(card.name).includes(lc(expect.name))) return false;
    if (expect.file && !lc(card.file).includes(lc(expect.file))) return false;
    if (expect.type && !lc(card.type).includes(lc(expect.type))) return false;
    return true;
}

/** First rank at which ANY acceptable expectation is satisfied; 0 = miss. */
function firstHitRank(cards, expectList) {
    for (const card of cards) {
        for (const e of expectList) if (matches(card, e)) return card.rank;
    }
    return 0;
}

async function runFixture(fixture, host) {
    process.env.OLLAMA_HOST = host;
    const bridge = await createBridge({ fixture });
    const cases = SEARCH_CASES[fixture] || [];
    const out = [];
    for (const c of cases) {
        const args = { query: c.query, detail: 'signatures', top_k: TOP_K };
        if (c.exact_tokens) args.exact_tokens = c.exact_tokens;
        const r = await bridge.callTool('search_code', args);
        const cards = parseCards(r.text);
        const expectList = Array.isArray(c.expect) ? c.expect : [c.expect];
        out.push({ id: c.id, kind: c.kind, rank: firstHitRank(cards, expectList), tokens: r.tokens, top: cards[0]?.name || '—' });
    }
    return out;
}

function mrr(ranks) {
    const r = ranks.filter(x => x > 0);
    if (!ranks.length) return 0;
    return ranks.reduce((s, x) => s + (x > 0 ? 1 / x : 0), 0) / ranks.length;
}
const hitAt = (ranks, k) => ranks.filter(x => x > 0 && x <= k).length;

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const wanted = argv.filter(a => !a.startsWith('--'));
const fixtures = (wanted.length ? wanted : Object.keys(SEARCH_CASES));

const report = [];
for (const fx of fixtures) {
    const lex = await runFixture(fx, DEAD_HOST);
    const sem = await runFixture(fx, SEMANTIC_HOST);
    report.push({ fixture: fx, lex, sem });
}

if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(0);
}

let allLex = [], allSem = [];
for (const { fixture, lex, sem } of report) {
    console.log(`\n━━━ ${fixture} ━━━`);
    console.log('  case                kind   lexical   semantic');
    for (let i = 0; i < lex.length; i++) {
        const L = lex[i], S = sem[i];
        const fmt = (r) => (r > 0 ? `@${r}`.padEnd(6) : 'MISS  ');
        const flag = (S.rank && (!L.rank || S.rank < L.rank)) ? ' ◀ sem wins'
                   : (L.rank && (!S.rank || L.rank < S.rank)) ? ' ◀ lex wins' : '';
        console.log(`  ${L.id.padEnd(18)} ${(L.kind||'').padEnd(5)}  ${fmt(L.rank)}    ${fmt(S.rank)}${flag}`);
        allLex.push(L.rank); allSem.push(S.rank);
    }
}
console.log(`\n${'═'.repeat(58)}`);
console.log(`OVERALL (${allLex.length} cases):`);
console.log(`  LEXICAL   hit@1=${hitAt(allLex,1)} hit@3=${hitAt(allLex,3)} hit@12=${hitAt(allLex,12)}  MRR=${mrr(allLex).toFixed(3)}`);
console.log(`  SEMANTIC  hit@1=${hitAt(allSem,1)} hit@3=${hitAt(allSem,3)} hit@12=${hitAt(allSem,12)}  MRR=${mrr(allSem).toFixed(3)}`);
