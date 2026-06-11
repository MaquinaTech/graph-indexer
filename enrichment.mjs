/**
 * @file enrichment.mjs
 * @description Optional LLM-assisted semantic enrichment. Standard embeddings
 *              match text proximity, not intent — a query like "payment webhook
 *              bottleneck" misses code that never uses those words. This module
 *              routes the codebase's most central chunks (top PageRank files)
 *              through a local LLM to produce two enrichment fields per chunk:
 *
 *              • chunk.summary  — one declarative sentence in developer vocabulary,
 *                added as the leading field of the embedding payload so the vector
 *                is anchored toward query vocabulary (not just code syntax).
 *
 *              • chunk.concepts — domain keyword array (e.g. ["authentication",
 *                "JWT", "middleware"]), joined into chunk.hyde for BM25 indexing.
 *
 *              Only the top-PageRank subset of chunks is enriched (hard-capped).
 *              Generation is injectable for deterministic testing without a live model.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import path from 'path';
import { computePageRank, truncateForEmbedding, TEST_FILE_RE, EXAMPLE_DIR_RE } from './search-core.mjs';

// ─── Persistent enrichment cache ───────────────────────────────────────────────
// Keyed by content_hash: the same code always yields the same (cached) summary
// and concepts, which makes enrichment INCREMENTAL — a re-index only sends new
// or changed chunks to the LLM, and the embedding cache (keyed by content_hash +
// enrichment digest, see search-core.embeddingKeyFor) keeps hitting too. Without
// this cache every index run re-enriched and re-embedded the full core set.

/** Load `code-index.enrichment.json` → Map<content_hash, {summary, concepts, model}>. */
export function loadEnrichmentCache(cachePath) {
    try {
        if (fs.existsSync(cachePath)) {
            const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            return new Map(Object.entries(data.entries || data));
        }
    } catch { /* corrupt cache → start fresh */ }
    return new Map();
}

/** Persist the enrichment cache (atomic write via tmp + rename). */
export function saveEnrichmentCache(cachePath, cache) {
    const payload = JSON.stringify({ version: 1, entries: Object.fromEntries(cache) });
    const tmp = `${cachePath}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, cachePath);
}

/** Attach a cached enrichment entry to a chunk (summary, concepts, hyde). */
export function attachEnrichment(chunk, entry) {
    if (!entry) return false;
    chunk.summary = entry.summary || '';
    chunk.concepts = Array.isArray(entry.concepts) ? entry.concepts : [];
    chunk.hyde = chunk.concepts.join(' ') || chunk.summary;
    return Boolean(chunk.summary || chunk.concepts.length);
}

// Two-line output format optimised for small (1.5B–3B) models:
//  • SUMMARY  — declarative sentence in developer vocabulary; goes into the vector
//               embedding as the leading field, aligned with nomic-embed-text's
//               search_document: training objective.
//  • TAGS     — comma-separated domain keywords; joined into chunk.hyde so BM25
//               receives high-IDF concept terms instead of question stopword noise.
//
// One-shot example is mandatory for 1.5B models to reliably follow the format.
export const buildEnrichPrompt = (chunk) => {
    const code = (chunk.code_snippet || '').slice(0, 700);
    const base = path.basename(chunk.file_path);
    const ctx = chunk.class_context ? ` (method of class ${chunk.class_context})` : '';
    const doc = chunk.docstring ? `Doc: ${chunk.docstring.slice(0, 200)}\n` : '';
    return (
        `Output exactly two lines for this ${chunk.node_type} "${chunk.name}"${ctx} in ${base}:\n`
        + `SUMMARY: one sentence describing what it DOES in plain developer vocabulary (the behavior, not the syntax)\n`
        + `TAGS: 5-8 comma-separated search keywords a developer would type to find this\n\n`
        + `Example:\n`
        + `SUMMARY: validates JWT tokens and refreshes expired authentication sessions\n`
        + `TAGS: authentication, JWT, token validation, session refresh, middleware\n\n`
        + doc
        + `Code:\n${code}\n`
        + `Output:`
    );
};

/**
 * Default generator: a single non-streaming Ollama /api/generate call. Returns the
 * response text, or null on any failure (enrichment is best-effort and never fatal).
 */
export async function ollamaGenerate(prompt, { model, ollamaHost, timeoutMs = 30000, options = null } = {}) {
    try {
        const res = await fetch(`${ollamaHost}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model, prompt, stream: false,
                options: options || { temperature: 0.1, num_predict: 150 },
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return (data.response || '').trim() || null;
    } catch {
        return null;
    }
}

/**
 * Parse the SUMMARY + TAGS response into { summary, concepts, hyde }.
 *
 * hyde = concepts.join(' ') — a space-separated keyword string fed to BM25.
 * Concepts are domain terms only (stopwords scrubbed), so every token has
 * meaningful IDF weight. Falls back to extracting non-stopword keywords from
 * the summary when the model omits the TAGS line (graceful degradation).
 */
export function parseEnrichResponse(text) {
    if (!text) return null;
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let summary = '';
    const concepts = [];

    const _stop = new Set([
        'the', 'a', 'an', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be',
        'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
        'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'it', 'its', 'and', 'or',
        'not', 'no', 'so', 'if', 'but', 'how', 'what', 'when', 'where', 'which', 'who',
    ]);

    for (const line of lines) {
        const sm = line.match(/^SUMMARY:\s*(.+)$/i);
        if (sm) { summary = sm[1].trim(); continue; }
        const tm = line.match(/^TAGS?:\s*(.+)$/i);
        if (tm) {
            tm[1].split(',').forEach(t => {
                const tok = t.trim().toLowerCase();
                if (tok.length >= 2 && tok.length <= 40 && !_stop.has(tok)) concepts.push(tok);
            });
        }
    }

    if (!summary && lines.length) summary = lines[0].replace(/^SUMMARY:\s*/i, '').trim();

    // Fallback: derive concepts from the summary when TAGS line is absent or empty.
    if (concepts.length === 0 && summary) {
        const words = summary.toLowerCase().match(/\b[a-z][a-z-]{2,}\b/g) || [];
        concepts.push(...words.filter(w => !_stop.has(w)).slice(0, 8));
    }

    if (!summary && concepts.length === 0) return null;
    const hyde = concepts.join(' ') || summary;
    return { summary, concepts, hyde };
}

// ─── LLM reranking (query time, opt-in) ─────────────────────────────────────────
// Fusion resolves most queries, but natural-language queries can end in near-ties
// between the semantically right chunk and a lexically similar neighbour — a gap
// no static boost can close. Reranking shows the fused top-M to a local LLM with
// one line of context per candidate and lets it order them. One generation call
// per query (~0.5–2 s with a 1.5B model), so it is opt-in and only fires for
// natural-language queries.

/** One-line description of a chunk for the rerank prompt. (A/B-tested against a
 *  richer 3-line variant with signature + a wider window: the compact form wins —
 *  extra context and extra candidates both ADD noise for a small judge model.) */
function rerankCandidateLine(i, chunk) {
    const desc = chunk.summary
        || (chunk.docstring || '').split('\n')[0].slice(0, 110)
        || (chunk.code_snippet || '').split('\n')[0].slice(0, 110);
    const ctx = chunk.class_context ? `${chunk.class_context}.` : '';
    return `${i + 1}. ${ctx}${chunk.name} [${chunk.node_type}] in ${chunk.file_path} — ${desc}`;
}

export function buildRerankPrompt(queryText, chunks) {
    return (
        `A developer searches a codebase for:\n"${queryText}"\n\n`
        + `Candidates:\n${chunks.map((c, i) => rerankCandidateLine(i, c)).join('\n')}\n\n`
        + `Order the candidates from best to worst match for the search. `
        + `Output ONLY the numbers, comma-separated (e.g. 3,1,2). No other text.\n`
        + `Answer:`
    );
}

/** Parse "3, 1,2 ..." → unique 0-based indices < n, or null when unusable. */
export function parseRerankResponse(text, n) {
    if (!text) return null;
    const seen = new Set();
    const order = [];
    for (const m of String(text).matchAll(/\d+/g)) {
        const idx = Number(m[0]) - 1;
        if (idx >= 0 && idx < n && !seen.has(idx)) { seen.add(idx); order.push(idx); }
        if (order.length >= n) break;
    }
    return order.length > 0 ? order : null;
}

/**
 * Rerank the fused top-M results with a local LLM. Best-effort: any failure
 * (model unreachable, unparseable output) returns the original order.
 *
 * @param {string} queryText
 * @param {Array<{score:number, chunk:object}>} results  Fused results (mutated copy returned).
 * @param {object} opts
 * @param {(prompt:string)=>Promise<string|null>} opts.generate
 * @param {number} [opts.topM]  How many leading results to rerank (default 8).
 * @returns {Promise<Array<{score:number, chunk:object}>>}
 */
export async function rerankResults(queryText, results, { generate, topM = 8 } = {}) {
    const head = results.slice(0, topM);
    if (head.length < 2) return results;
    const raw = await generate(buildRerankPrompt(queryText, head.map(r => r.chunk)));
    const order = parseRerankResponse(raw, head.length);
    if (!order) return results;
    const picked = order.map(i => head[i]);
    const rest = head.filter((_, i) => !order.includes(i));
    return [...picked, ...rest, ...results.slice(topM)];
}

/**
 * Select the chunks worth enriching.
 *
 * v1 selected the top-PageRank files only — and measured terribly: PageRank
 * rewards the most-IMPORTED files, which are generic leaf utilities (utils.js,
 * bind.js), while the behavioural code agents actually search for conceptually
 * (request dispatchers, interceptor managers, adapters) sits mid-graph and was
 * never enriched. v2 selects ALL substantive chunks in production source —
 * tests, specs and example/docs trees are excluded, since agents search for
 * implementations — and uses PageRank only to ORDER the queue, so the per-run
 * `maxChunks` cap eats the most central files first. Combined with the
 * persistent cache, coverage converges over a few index runs at a bounded
 * per-run cost.
 *
 * `coreRatio` (default 1.0 = all production files) is kept for installs that
 * want to bound enrichment to the most central share of files.
 */
export function selectCoreChunks(chunks, graph, { coreRatio = 1.0, maxChunks = 500 } = {}) {
    const pr = computePageRank(graph);
    let coreFiles = null;
    if (coreRatio > 0 && coreRatio < 1) {
        const files = Array.from(pr.keys()).sort((a, b) => (pr.get(b) ?? 0) - (pr.get(a) ?? 0));
        coreFiles = new Set(files.slice(0, Math.max(1, Math.ceil(files.length * coreRatio))));
    }

    const selected = chunks.filter(c =>
        c.name && c.name !== 'anonymous' && c.name !== 'default_export'
        && (c.end_line - c.start_line) >= 4  // skip trivial stubs (too little code for useful enrichment)
        && !TEST_FILE_RE.test(c.file_path)   // agents search implementations, not test bodies
        && !EXAMPLE_DIR_RE.test(c.file_path)
        && (!coreFiles || coreFiles.has(c.file_path))
    );
    selected.sort((a, b) => (pr.get(b.file_path) ?? 0) - (pr.get(a.file_path) ?? 0));
    return selected.slice(0, maxChunks);
}

/**
 * Enrich the core chunks in place, attaching `chunk.hyde` and `chunk.summary`.
 *
 * Uses a true sliding-window pool: each worker immediately picks the next task
 * when done, so concurrency is always saturated rather than waiting for the
 * slowest request in a batch before advancing.
 *
 * @param {object[]} chunks   All extracted chunks (mutated in place).
 * @param {object}   graph    { dependencies, importedBy }.
 * @param {object}   config   Resolved config (uses config.enrichment + config.ollamaHost).
 * @param {object}   [deps]
 * @param {(prompt:string)=>Promise<string|null>} [deps.generate] Override generator (tests).
 * @param {number}   [deps.concurrency]  Defaults to config.enrichment.concurrency.
 * @param {string}   [deps.cachePath]    Defaults to config.enrichmentCachePath. Pass false to disable.
 * @returns {Promise<{enriched:number, attempted:number, cached:number}>}
 */
export async function enrichCoreChunks(chunks, graph, config, { generate, concurrency, cachePath } = {}) {
    const { model, coreRatio, maxChunks } = config.enrichment;
    const ollamaHost = config.ollamaHost;
    const gen = generate || ((prompt) => ollamaGenerate(prompt, { model, ollamaHost, timeoutMs: 20000 }));
    const slots = concurrency ?? config.enrichment.concurrency ?? 12;
    const cacheFile = cachePath === false ? null : (cachePath || config.enrichmentCachePath || null);
    const cache = cacheFile ? loadEnrichmentCache(cacheFile) : new Map();

    // Cache pass FIRST, over ALL chunks — not just the current selection. The
    // selection rules (test/example filters, coreRatio, caps) evolve between
    // versions and runs; if cached enrichment were only attached to selected
    // chunks, the same code would carry an enriched embedding key in one build
    // and a plain one in the next, silently desynchronising the JSON and SQLite
    // artifacts that share one embeddings bin. Cache membership is the single
    // deterministic source of truth for "is this chunk enriched"; selection only
    // decides which NEW chunks get LLM calls.
    let cached = 0;
    for (const chunk of chunks) {
        if (chunk.content_hash && attachEnrichment(chunk, cache.get(chunk.content_hash))) cached++;
    }

    const core = selectCoreChunks(chunks, graph, { coreRatio, maxChunks });
    if (core.length === 0 && cached === 0) {
        console.log('🧠 LLM enrichment: no core chunks selected (empty graph) — skipping.');
        return { enriched: 0, attempted: 0, cached: 0 };
    }
    const pending = core.filter(c => !c.summary && !(c.concepts?.length > 0));

    if (pending.length === 0) {
        console.log(`🧠 LLM enrichment: all ${cached} core chunks served from cache.`);
        return { enriched: cached, attempted: 0, cached };
    }

    console.log(`🧠 LLM enrichment: ${pending.length} chunks via ${model} (${cached} from cache, concurrency: ${slots}) …`);
    let enriched = 0, attempted = 0, failures = 0;
    let aborted = false;

    // Sliding-window pool: `slots` workers each drain the queue independently.
    // No batch boundaries — a worker immediately takes the next item when done.
    let cursor = 0;
    async function runWorker() {
        while (cursor < pending.length && !aborted) {
            const chunk = pending[cursor++];
            attempted++;
            const raw = await gen(buildEnrichPrompt(chunk));
            const parsed = parseEnrichResponse(raw);
            if (parsed) {
                chunk.summary = parsed.summary;
                chunk.concepts = parsed.concepts;
                chunk.hyde = parsed.hyde;  // = concepts.join(' ') — domain keywords for BM25
                if (chunk.content_hash) {
                    cache.set(chunk.content_hash, { summary: parsed.summary, concepts: parsed.concepts, model });
                }
                enriched++;
            } else {
                failures++;
            }
            process.stdout.write(`\r   enriched ${enriched}/${pending.length} (failures: ${failures})        `);
            // Bail early if the model is clearly unreachable.
            if (attempted >= slots * 2 && enriched === 0) {
                aborted = true;
                console.log(`\n⚠️  LLM enrichment: generator unreachable (${failures} failures) — continuing without enrichment.`);
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(slots, pending.length) }, runWorker));

    if (cacheFile && enriched > 0) {
        try { saveEnrichmentCache(cacheFile, cache); }
        catch (err) { console.log(`⚠️  enrichment cache save failed: ${err.message}`); }
    }

    console.log(`\n   ✓ enrichment complete: ${enriched} enriched, ${cached} cached, ${failures} failed.`);
    return { enriched: enriched + cached, attempted, cached };
}
