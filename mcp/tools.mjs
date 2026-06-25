/**
 * @file mcp/tools.mjs
 * @description MCP tool registration: wires all graph-indexer tools onto an McpServer.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { z } from 'zod';
import fs from 'fs';
import path, { resolve } from 'path';
import { computePageRank, isNaturalLanguageQuery, TEST_FILE_RE, learnedRerank, DEFAULT_RANKER_MODEL } from '../search-core.mjs';
import { getParserForFile } from '../parse/languages.mjs';
import { extractFileSkeleton } from '../parse/extractor.mjs';
import { describeEmbedder } from '../embeddings.mjs';
import { rerankResults, rerankCrossEncoder, crossEncoderScore, ollamaGenerate, mlxLmGenerate } from '../enrichment.mjs';
import { coChangesFor, gitBoostScore, computeFreshness, currentGitState } from '../git-signals.mjs';
import { egressGuardActive } from '../seal.mjs';
import { extractSignatureLine, pruneBodyByQuery } from './format.mjs';
import {
    assessConfidence, hydeQueryVector, buildHydePrompt, detectRepoLanguage,
    classifyCallers, findReferences, findRoutes, buildSubgraph, buildImpact,
} from './topology.mjs';
import { traceTaint, findTaintedSinks } from './taint.mjs';
import { CATEGORY_SEVERITY } from '../parse/taint-patterns.mjs';

// ─── Structured (JSON) output helpers ────────────────────────────────────────────

/**
 * Wrap a structured payload as an MCP tool result. The JSON is emitted as a text
 * block (so every client can read it) AND as `structuredContent` (so SDK-aware
 * clients get typed fields without parsing prose). No outputSchema is declared,
 * so the SDK passes structuredContent through without validation.
 */
function jsonResult(payload) {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
    };
}

/** Typed projection of a chunk for JSON output (no code body unless asked). */
function chunkCard(chunk) {
    return {
        id: chunk.id,
        name: chunk.name,
        node_type: chunk.node_type,
        file_path: chunk.file_path,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        class_context: chunk.class_context || null,
        params: chunk.params || [],
        return_type: chunk.return_type || null,
        type_refs: chunk.type_refs || [],
        decorators: chunk.decorators || [],
        extends: chunk.extends || [],
        docstring: chunk.docstring || null,
        calls: chunk.calls || [],
    };
}

/**
 * Files that historically change together with the target's file(s) — a git
 * blast-radius hint. Aggregates co-change across all defining files, drops the
 * target's own files, and returns the strongest partners. Empty when no signals.
 */
function coChangeFiles(gitSignals, files, limit = 5) {
    if (!gitSignals) return [];
    const own = new Set(files);
    const agg = new Map();
    for (const f of files) {
        for (const { file, count } of coChangesFor(gitSignals, f, limit)) {
            if (own.has(file)) continue;
            agg.set(file, Math.max(agg.get(file) || 0, count));
        }
    }
    return [...agg.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([file, count]) => ({ file, count }));
}

/** One-line git co-change blast-radius hint for markdown output. */
function coChangeLine(coChanges) {
    return `🔄 Historically changes with: ${coChanges.map(c => `\`${c.file}\` (${c.count}×)`).join(', ')}`;
}

/** Typed projection of a referencing chunk (caller / subclass / type user). */
function refCard({ chunk, recvHint, reason, confidence }) {
    return {
        id: chunk.id,
        name: chunk.name,
        node_type: chunk.node_type,
        class_context: chunk.class_context || null,
        file_path: chunk.file_path,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        via: recvHint || null,
        confidence: confidence || (reason ? 'high' : 'name-only'),
        reason: reason || null,
    };
}

// ─── Tool registration ──────────────────────────────────────────────────────────

/**
 * Register every graph-indexer tool on an MCP server.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {object} db    A loaded store implementing the storage contract.
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.artifactPath      Index file whose mtime represents freshness.
 * @param {string} opts.pidFile           Watch-daemon PID file (may not exist).
 * @param {boolean} opts.embeddingsEnabled
 * @param {object} [opts.embedder]        Query embedder (embeddings.createEmbedder); its
 *                                        provider/model must match the index that was built.
 * @param {{enabled:boolean, model:string, topM:number}} [opts.rerank] LLM rerank config.
 * @param {string} [opts.ollamaHost]      Ollama endpoint for the rerank judge.
 * @param {object|null} [opts.gitSignals] Loaded git-signals sidecar (churn/recency/co-change), or null.
 * @param {number} [opts.gitRankBoost]    0..1 opt-in recency/churn weight in search_code (0 = ranking unchanged).
 */
export function registerTools(server, db, { projectRoot, artifactPath, pidFile, embeddingsEnabled, embedder, rerank, hyde, ollamaHost = 'http://localhost:11434', llmProvider = 'ollama', mlxLmHost = 'http://localhost:8080', gitSignals = null, gitRankBoost = 0, sealed = 'off', ranker = 'rrf' }) {

    // Scoped here (not module-level) so multiple servers in one process don't cross-contaminate.
    // `undefined` = not yet detected; `null` = unknown (→ generic prompt).
    let _repoLang;

    // ── Index-freshness contract ──────────────────────────────────────────────
    // A stale call graph silently misleads the agent, so tool responses carry a
    // freshness signal. The markdown footer is shown ONLY when the index is NOT
    // fresh — confident, up-to-date cards stay lean (no per-call token bloat).
    const isDaemonAlive = () => {
        try {
            if (!pidFile || !fs.existsSync(pidFile)) return false;
            process.kill(parseInt(fs.readFileSync(pidFile, 'utf-8'), 10), 0);
            return true;
        } catch { return false; }
    };
    const indexFreshness = () => {
        let ageSeconds = null;
        try { ageSeconds = Math.floor((Date.now() - fs.statSync(artifactPath).mtimeMs) / 1000); } catch { /* no index file */ }
        return computeFreshness({
            ageSeconds,
            indexedCommit: gitSignals?.head ?? null,
            current: currentGitState(projectRoot),
            daemonRunning: isDaemonAlive(),
        });
    };
    /** Compact one-line freshness footer, or null when the index is fresh (keep cards lean). */
    const freshnessNote = (f) => {
        if (!f.stale && !f.syncing && !(f.pendingChanges > 0) && !f.commitMoved) return null;
        const bits = [`🕰 index ${f.ageLabel} old`];
        if (f.indexedCommit) bits.push(`built @ ${f.indexedCommit}`);
        if (f.pendingChanges > 0) bits.push(`${f.pendingChanges} uncommitted source change(s)`);
        if (f.commitMoved) bits.push(`HEAD now ${f.currentCommit}`);
        bits.push(f.stale
            ? '⚠️ STALE — results may miss recent edits; run `npm run mcp:index`'
            : 'daemon syncing…');
        return bits.join(' · ');
    };

    // ── test → code mapping (C5) ──────────────────────────────────────────────
    // The test chunks that exercise a symbol: a test/spec chunk (TEST_FILE_RE) that
    // either CALLS the symbol or REFERENCES it (type/inheritance). Deduped by id,
    // deterministically ordered (file, line, id). Shared by tests_for + explain_symbol.
    const testsForSymbol = (symbol) => {
        const seen = new Set();
        const out = [];
        for (const c of [...db.findCallers(symbol), ...db.findReferers(symbol)]) {
            if (!c || !TEST_FILE_RE.test(c.file_path) || seen.has(c.id)) continue;
            seen.add(c.id);
            out.push(c);
        }
        out.sort((a, b) =>
            (a.file_path < b.file_path ? -1 : a.file_path > b.file_path ? 1 : 0)
            || (a.start_line - b.start_line)
            || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return out;
    };

    // ─── search_code ────────────────────────────────────────────────────────────
    server.tool(
        'search_code',
        'CRITICAL: ALWAYS USE THIS TOOL FIRST to find code. High-precision AST hybrid search returning exact chunks and cross-file topology.',
        {
            query: z.string().describe('Natural language description of the logic to find.'),
            exact_tokens: z.string().optional().describe('Exact symbol name for guaranteed rank-1 placement.'),
            include_topology: z.boolean().default(true),
            min_score: z.number().min(0).max(1).default(0.3),
            top_k: z.number().int().min(1).max(20).default(5),
            token_budget: z.number().int().min(100).optional().describe(
                'Token budget for code bodies (1 token ≈ 4 chars). Omit to use smart default.'
            ),
            detail: z.enum(['signatures', 'smart', 'full']).default('smart').describe(
                "'signatures': compact cards only (~20 tok each, no bodies) — fastest. "
                + "'smart' (default): signatures + query-relevant body snippets. "
                + "'full': signatures + complete bodies."
            ),
            rerank: z.boolean().optional().describe(
                'Rerank the top results with a local LLM judge (+50% rank-1 on '
                + 'natural-language queries, ~1–2 s extra). Defaults to the '
                + '`rerank.enabled` project config; only fires on NL queries.'
            ),
            hyde: z.boolean().optional().describe(
                'Query-side HyDE: generate a hypothetical code snippet for the query, '
                + 'embed it and blend with the query vector to bridge vocabulary gaps on '
                + 'behavioural queries (~1 s extra). Defaults to the `hyde.enabled` project '
                + 'config; only fires on NL queries with a vector channel.'
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default): token-efficient cards for an LLM to read. "
                + "'json': typed structured fields (id, file, lines, signature, topology, body) "
                + 'for programmatic clients — avoids parsing prose.'
            ),
        },
        async ({ query, exact_tokens, include_topology, min_score, top_k, token_budget, detail, rerank: rerankParam, hyde: hydeParam, response_format }) => {
            try {
                const fullQuery = exact_tokens ? `${query} ${exact_tokens}` : query;
                let queryVector = null;
                if (embedder) {
                    try { queryVector = await embedder.embedQuery(fullQuery); }
                    catch { /* lexical fallback */ }
                }

                // HyDE is suppressed when an exact symbol is pinned: the symbolic
                // query vector is already precise, and HyDE's hypothetical snippet
                // would only blur it. Off → queryVector is untouched (byte-identical search).
                const wantHyde = hydeParam ?? Boolean(hyde?.enabled);
                if (wantHyde && queryVector && !exact_tokens && isNaturalLanguageQuery(fullQuery)) {
                    if (_repoLang === undefined) {
                        try { _repoLang = detectRepoLanguage(db.stats().extCounts, db.iterateChunks()); }
                        catch { _repoLang = null; }
                    }
                    queryVector = await hydeQueryVector(fullQuery, queryVector, {
                        embedder,
                        generate: llmProvider === 'mlx'
                            ? (prompt) => mlxLmGenerate(prompt, { mlxLmHost, timeoutMs: 20000 })
                            : (prompt) => ollamaGenerate(prompt, {
                                model: hyde?.model || 'qwen2.5-coder:1.5b',
                                ollamaHost, timeoutMs: 20000,
                                options: { temperature: 0.2, num_predict: 220 },
                            }),
                        lang: _repoLang,
                    });
                }

                // Rerank is suppressed for exact-token queries: symbol lookups are
                // already rank-1-dominant and re-ordering them wastes the judge call.
                // Best-effort — order is preserved on any model failure.
                const wantRerank = rerankParam ?? Boolean(rerank?.enabled);
                const willRerank = wantRerank && !exact_tokens && isNaturalLanguageQuery(fullQuery);

                // Over-fetch for rerank: without a deeper candidate pool the judge
                // can reorder but never RESCUE a correct-but-deep hit into top_k.
                // Git boost also over-fetches for the same rescue reason, and lives
                // in the tool layer — never in db.searchHybrid — so measured
                // retrieval ranking and backend parity are unchanged unless enabled.
                const applyGitBoost = gitRankBoost > 0 && gitSignals;
                // D3: the learned re-rank also needs a deeper pool to RESCUE a structurally-strong
                // but lexically-deep hit into top_k (same rationale as rerank / git boost).
                const wantLearned = ranker === 'learned' && !exact_tokens;
                const poolSize = willRerank
                    ? Math.min(Math.max(top_k, rerank?.poolSize ?? 15), 25)
                    : (applyGitBoost || wantLearned) ? Math.min(Math.max(top_k * 2, 12), 25) : top_k;
                let matches = db.searchHybrid(fullQuery, queryVector, poolSize, min_score, exact_tokens || null);

                // D3: post-fusion learned re-rank (opt-in). Reorders the fused pool by a zero-dep
                // linear model over RRF score + centrality + resolved/SCIP in-degree + git, BEFORE the
                // optional LLM judge / git nudge. Accessors are null when the layer is absent, so the
                // model degrades to RRF + git + node-type (≈neutral) on a plain index.
                if (wantLearned && matches.length > 1) {
                    matches = learnedRerank(matches, {
                        getCentrality: db.hasCentrality?.() ? (id) => db.getCentrality(id) : null,
                        getInEdges: db.hasSymbolGraph?.() ? (id) => db.getEdges(id, { direction: 'in' }) : null,
                        gitScoreFor: gitSignals ? (file) => gitBoostScore(gitSignals, file) : null,
                    }, DEFAULT_RANKER_MODEL);
                }

                let rerankFailed = false;
                if (willRerank && matches.length > 1) {
                    try {
                        if (rerank?.provider === 'cross-encoder') {
                            // Local air-gapped cross-encoder: scores (query, candidate) pairs and
                            // sorts. Reuses the same over-fetched pool; deterministic; no LLM call.
                            matches = await rerankCrossEncoder(fullQuery, matches, {
                                topM: Math.min(rerank?.topM ?? 12, matches.length),
                                scorer: (q, texts) => crossEncoderScore(q, texts, { model: rerank?.crossEncoderModel }),
                            });
                        } else {
                            matches = await rerankResults(fullQuery, matches, {
                                topM: Math.min(rerank?.topM ?? 12, matches.length),
                                generate: llmProvider === 'mlx'
                                    ? (prompt) => mlxLmGenerate(prompt, { mlxLmHost, timeoutMs: 60000 })
                                    : (prompt) => ollamaGenerate(prompt, {
                                        model: rerank?.model || 'qwen2.5-coder:7b',
                                        ollamaHost, timeoutMs: 60000,
                                        options: { temperature: 0, num_predict: 40 },
                                    }),
                            });
                        }
                    } catch {
                        // An unreachable or slow reranker must degrade gracefully — never
                        // turn the whole search into an error. `matches` retains its
                        // pre-rerank order because the throwing await never reassigned it.
                        rerankFailed = true;
                    }
                }
                if (applyGitBoost && matches.length > 1) {
                    if (willRerank && !rerankFailed) {
                        // The LLM judge has already set the order, and rerank leaves each
                        // result's fused `score` untouched (still in pre-rerank descending
                        // order). Re-sorting by that score would REVERT the judge, so here
                        // git only NUDGES: boost a rank surrogate and keep the displayed
                        // score intact. A strong git signal can still lift a recently-changed
                        // file a few places, but it no longer cancels the rerank.
                        matches = matches
                            .map((m, i) => ({ m, key: (matches.length - i) * (1 + gitRankBoost * gitBoostScore(gitSignals, m.chunk.file_path)) }))
                            .sort((a, b) => b.key - a.key)
                            .map(({ m }) => m);
                    } else {
                        matches = matches
                            .map(m => ({ ...m, score: m.score * (1 + gitRankBoost * gitBoostScore(gitSignals, m.chunk.file_path)) }))
                            .sort((a, b) => b.score - a.score);
                    }
                }
                matches = matches.slice(0, top_k);
                if (matches.length === 0) {
                    const indexEmpty = db.chunkCount() === 0;
                    const emptyHint = 'Index is empty — run `npm run mcp:index` (or `idx-index --repo <path>`) to build it.';
                    return response_format === 'json'
                        ? jsonResult({ query: fullQuery, count: 0, ...(indexEmpty ? { index_status: 'empty', hint: emptyHint } : {}), results: [] })
                        : { content: [{ type: 'text', text: indexEmpty ? `⚠️ ${emptyHint}` : 'No results found.' }] };
                }

                const { lowConfidence, candidateFiles } = assessConfidence(matches, fullQuery, Boolean(exact_tokens));
                const fresh = indexFreshness();

                if (response_format === 'json') {
                    const qTokens = fullQuery.toLowerCase().split(/[\s\W_]+/).filter(t => t.length >= 3);
                    const results = matches.map(({ score, chunk }, i) => {
                        const result = { rank: i + 1, score: Number(score.toFixed(4)), ...chunkCard(chunk) };
                        if (include_topology) {
                            result.topology = {
                                dependencies: db.getDependencies(chunk.file_path),
                                used_by: db.getImportedBy(chunk.file_path),
                            };
                        }
                        if (detail !== 'signatures' && chunk.code_snippet) {
                            result.body = detail === 'full'
                                ? chunk.code_snippet
                                : pruneBodyByQuery(chunk.code_snippet, qTokens);
                        }
                        return result;
                    });
                    return jsonResult({
                        query: fullQuery, count: results.length, reranked: willRerank && !rerankFailed, detail,
                        ...(rerankFailed ? { rerank_failed: true } : {}),
                        low_confidence: lowConfidence,
                        ...(lowConfidence ? { candidate_files: candidateFiles } : {}),
                        index: fresh,
                        results,
                    });
                }

                const depSignature = (depPath) => {
                    const syms = [];
                    for (const c of db.getChunksByFile(depPath)) {
                        if (c.name && c.node_type !== 'expression_statement') {
                            syms.push(c.name);
                            if (syms.length >= 4) break;
                        }
                    }
                    return syms.length ? `${depPath} [${syms.join(', ')}]` : depPath;
                };

                const lines = [`🔍 QUERY: "${fullQuery}" — ${matches.length} result(s)\n`];

                for (let i = 0; i < matches.length; i++) {
                    const { score, chunk } = matches[i];
                    lines.push(`${'─'.repeat(50)}`);
                    lines.push(`#${i + 1} · **${chunk.name}** [${chunk.node_type}]`);
                    lines.push(`📄 ${chunk.file_path}:${chunk.start_line}–${chunk.end_line} · ID: \`${chunk.id}\` · RRF: ${score.toFixed(4)}`);

                    const sig = [];
                    if (chunk.params?.length) sig.push(`(${chunk.params.slice(0, 4).join(', ')})`);
                    if (chunk.return_type) sig.push(`→ ${chunk.return_type}`);
                    if (chunk.type_refs?.length) sig.push(`types: ${chunk.type_refs.slice(0, 4).join(', ')}`);
                    if (sig.length) lines.push(`🔤 ${sig.join('  ')}`);

                    if (chunk.decorators?.length) lines.push(`🏷  ${chunk.decorators.slice(0, 6).map(d => '@' + d).join(' ')}`);
                    if (chunk.extends?.length) lines.push(`🧬 extends/implements: ${chunk.extends.slice(0, 5).join(', ')}`);
                    if (chunk.docstring) lines.push(`💬 ${chunk.docstring.slice(0, 140).replace(/\n/g, ' ')}`);

                    if (include_topology) {
                        const deps = db.getDependencies(chunk.file_path).slice(0, 3);
                        const usedBy = db.getImportedBy(chunk.file_path).slice(0, 3);
                        if (deps.length) lines.push(`⬇️  Deps:    ${deps.map(depSignature).join(' | ')}`);
                        if (usedBy.length) lines.push(`⬆️  Used by: ${usedBy.join(', ')}`);
                        if (chunk.calls?.length) lines.push(`🔗 Calls:   ${chunk.calls.slice(0, 6).join(', ')}`);
                    }
                    lines.push(`↩️  Expand: get_chunk("${chunk.id}")`);
                }

                if (detail !== 'signatures') {
                    const CHARS_PER_TOKEN = 4;
                    const defaultBudget = detail === 'full' ? 6000 : 2000;
                    let remainingChars = token_budget != null ? token_budget * CHARS_PER_TOKEN : defaultBudget;

                    lines.push(`\n${'═'.repeat(50)}`);
                    lines.push(`CODE BODIES (detail: ${detail}, budget: ~${Math.round(remainingChars / CHARS_PER_TOKEN)} tok)\n`);

                    const queryTokens = fullQuery.toLowerCase().split(/[\s\W_]+/).filter(t => t.length >= 3);

                    for (const { chunk } of matches) {
                        if (remainingChars <= 0) break;
                        const raw = chunk.code_snippet || '';
                        if (!raw) continue;
                        const snippet = detail === 'full'
                            ? raw.slice(0, remainingChars)
                            : pruneBodyByQuery(raw, queryTokens).slice(0, remainingChars);
                        lines.push(`### ${chunk.name} — ${chunk.file_path}`);
                        lines.push('```\n' + snippet + '\n```\n');
                        remainingChars -= snippet.length;
                    }
                }

                // Low-confidence: surface candidate files so the agent can
                // call get_file_skeleton rather than issuing another vague search.
                if (lowConfidence) {
                    lines.push(`\n${'─'.repeat(50)}`);
                    lines.push(`⚠️ Low confidence — no dominant match. Candidate files (top distinct): ${candidateFiles.map(f => `\`${f}\``).join(', ')}`);
                    lines.push(`→ Try \`get_file_skeleton\` on these, or refine with a symbol name / \`exact_tokens\`.`);
                }

                if (rerankFailed) lines.push('', '⚠️ Rerank was requested but the judge model was unreachable — results are in raw fused order (not reranked).');
                const _note = freshnessNote(fresh);
                if (_note) lines.push('', _note);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── get_chunk ────────────────────────────────────────────────────────────────
    server.tool(
        'get_chunk',
        'CRITICAL: Use this INSTEAD of reading full files. Returns the complete body of a function/class by its chunk_id from search_code results.',
        {
            chunk_id: z.string().describe('The chunk ID shown in search_code results.'),
            view: z.enum(['full', 'signature']).default('full').describe(
                "'full': complete source body. 'signature': just the function signature line (~5 tokens)."
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed fields + topology + code)."
            ),
        },
        async ({ chunk_id, view, response_format }) => {
            try {
                const chunk = db.getChunk(chunk_id);
                if (!chunk) {
                    return response_format === 'json'
                        ? jsonResult({ chunk_id, found: false })
                        : { content: [{ type: 'text', text: `Chunk '${chunk_id}' not found. Run search_code to get valid IDs.` }] };
                }

                if (response_format === 'json') {
                    return jsonResult({
                        ...chunkCard(chunk),
                        topology: {
                            dependencies: db.getDependencies(chunk.file_path),
                            used_by: db.getImportedBy(chunk.file_path),
                        },
                        code: view === 'signature' ? extractSignatureLine(chunk.code_snippet) : chunk.code_snippet,
                    });
                }

                const parts = [
                    `# ${chunk.name}`,
                    `**File:** \`${chunk.file_path}\` · **Lines:** ${chunk.start_line}–${chunk.end_line} · **Type:** ${chunk.node_type}`,
                ];
                if (chunk.params?.length) parts.push(`**Params:** ${chunk.params.join(', ')}`);
                if (chunk.return_type) parts.push(`**Returns:** ${chunk.return_type}`);
                if (chunk.type_refs?.length) parts.push(`**Type refs:** ${chunk.type_refs.join(', ')}`);
                if (chunk.decorators?.length) parts.push(`**Decorators:** ${chunk.decorators.map(d => '@' + d).join(', ')}`);
                if (chunk.extends?.length) parts.push(`**Inherits:** ${chunk.extends.join(', ')}`);
                if (chunk.docstring) parts.push(`**Doc:** ${chunk.docstring}`);

                const deps = db.getDependencies(chunk.file_path);
                const usedBy = db.getImportedBy(chunk.file_path);
                if (deps.length) parts.push(`⬇️ Imports: ${deps.join(', ')}`);
                if (usedBy.length) parts.push(`⬆️ Used by: ${usedBy.join(', ')}`);
                if (chunk.calls?.length) parts.push(`🔗 Calls: ${chunk.calls.join(', ')}`);

                if (view === 'signature') parts.push('', '```', extractSignatureLine(chunk.code_snippet), '```');
                else parts.push('', '```', chunk.code_snippet, '```');
                return { content: [{ type: 'text', text: parts.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── resolve_symbol ─────────────────────────────────────────────────────────
    server.tool(
        'resolve_symbol',
        'Instantly finds the definition of any symbol (function, class, type, variable) by exact name — O(1) lookup, no search needed. Returns the defining chunk and cross-file topology.',
        {
            symbol: z.string().describe("Exact symbol name (e.g. 'validateToken', 'User', 'PaymentService')."),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed definition list + topology)."
            ),
        },
        async ({ symbol, response_format }) => {
            try {
                const defs = db.resolveSymbol(symbol);
                if (defs.length === 0) {
                    const indexEmpty = db.chunkCount() === 0;
                    const emptyHint = 'Index is empty — run `npm run mcp:index` (or `idx-index --repo <path>`) to build it.';
                    return response_format === 'json'
                        ? jsonResult({ symbol, count: 0, ...(indexEmpty ? { index_status: 'empty', hint: emptyHint } : {}), definitions: [] })
                        : { content: [{ type: 'text', text: indexEmpty ? `⚠️ ${emptyHint}` : `Symbol '${symbol}' not in index. Try search_code(query="${symbol}") for fuzzy search.` }] };
                }
                if (response_format === 'json') {
                    return jsonResult({
                        symbol,
                        count: defs.length,
                        definitions: defs.map(chunk => ({
                            ...chunkCard(chunk),
                            topology: {
                                dependencies: db.getDependencies(chunk.file_path),
                                used_by: db.getImportedBy(chunk.file_path),
                            },
                            signature: extractSignatureLine(chunk.code_snippet),
                        })),
                    });
                }
                const lines = [`# Symbol: \`${symbol}\` — ${defs.length} definition(s)\n`];
                for (const chunk of defs) {
                    lines.push(`${'─'.repeat(50)}`);
                    lines.push(`**${chunk.name}** [${chunk.node_type}]`);
                    lines.push(`📄 ${chunk.file_path}:${chunk.start_line}–${chunk.end_line} · ID: \`${chunk.id}\``);
                    if (chunk.params?.length) lines.push(`🔤 Params: ${chunk.params.join(', ')}`);
                    if (chunk.return_type) lines.push(`🔤 Returns: ${chunk.return_type}`);
                    if (chunk.type_refs?.length) lines.push(`🔗 Type refs: ${chunk.type_refs.join(', ')}`);
                    if (chunk.decorators?.length) lines.push(`🏷  ${chunk.decorators.slice(0, 6).map(d => '@' + d).join(' ')}`);
                    if (chunk.docstring) lines.push(`💬 ${chunk.docstring.slice(0, 160).replace(/\n/g, ' ')}`);
                    const deps = db.getDependencies(chunk.file_path).slice(0, 4);
                    const usedBy = db.getImportedBy(chunk.file_path).slice(0, 4);
                    if (deps.length) lines.push(`⬇️  Imports: ${deps.join(', ')}`);
                    if (usedBy.length) lines.push(`⬆️  Used by: ${usedBy.join(', ')}`);
                    if (chunk.calls?.length) lines.push(`🔗 Calls: ${chunk.calls.slice(0, 8).join(', ')}`);
                    lines.push(`\n\`\`\`\n${extractSignatureLine(chunk.code_snippet)}\n\`\`\``);
                    lines.push(`↩️  Full body: get_chunk("${chunk.id}")`);
                }
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── get_chunk_summary ──────────────────────────────────────────────────────
    server.tool(
        'get_chunk_summary',
        'Returns the function/class signature + docstring + called functions — no full body. ~50 tokens vs ~300 for full body. Use when you only need to understand the interface, not the implementation.',
        {
            chunk_id: z.string().describe('The chunk ID from search_code results.'),
            expand_calls: z.boolean().default(false).describe(
                'When true, resolves the signatures of outgoing dependencies inline (~150 tok vs ~50 tok). '
                + 'Use when you need to understand the interfaces of called functions in a single shot, '
                + 'without issuing a separate tool call per dependency.'
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed signature + docstring + resolved calls)."
            ),
        },
        async ({ chunk_id, expand_calls, response_format }) => {
            try {
                const chunk = db.getChunk(chunk_id);
                if (!chunk) {
                    return response_format === 'json'
                        ? jsonResult({ chunk_id, found: false })
                        : { content: [{ type: 'text', text: `Chunk '${chunk_id}' not found.` }] };
                }

                const resolveCalls = () => {
                    const out = [];
                    const seen = new Set();
                    for (const callName of (chunk.calls || [])) {
                        if (seen.size >= 6) break;
                        const key = callName.toLowerCase();
                        if (seen.has(key)) continue;
                        seen.add(key);
                        const target = db.resolveSymbol(callName)[0];
                        if (!target?.code_snippet) continue;
                        out.push({
                            name: callName,
                            file_path: target.file_path,
                            start_line: target.start_line,
                            signature: extractSignatureLine(target.code_snippet).split('\n')[0].trim().slice(0, 120),
                        });
                    }
                    return out;
                };

                if (response_format === 'json') {
                    return jsonResult({
                        id: chunk.id,
                        name: chunk.name,
                        node_type: chunk.node_type,
                        file_path: chunk.file_path,
                        start_line: chunk.start_line,
                        end_line: chunk.end_line,
                        params: chunk.params || [],
                        return_type: chunk.return_type || null,
                        type_refs: chunk.type_refs || [],
                        decorators: chunk.decorators || [],
                        docstring: chunk.docstring || null,
                        signature: extractSignatureLine(chunk.code_snippet),
                        calls: chunk.calls || [],
                        resolved_calls: expand_calls ? resolveCalls() : undefined,
                    });
                }

                const lines = [
                    `# ${chunk.name} · ${chunk.file_path}:${chunk.start_line}–${chunk.end_line}`,
                    `**Type:** ${chunk.node_type}`,
                ];
                if (chunk.params?.length) lines.push(`**Params:** ${chunk.params.join(', ')}`);
                if (chunk.return_type) lines.push(`**Returns:** ${chunk.return_type}`);
                if (chunk.type_refs?.length) lines.push(`**Type refs:** ${chunk.type_refs.join(', ')}`);
                if (chunk.decorators?.length) lines.push(`**Decorators:** ${chunk.decorators.map(d => '@' + d).join(', ')}`);
                if (chunk.docstring) lines.push(`\n**Doc:** ${chunk.docstring.slice(0, 300)}`);

                if (chunk.calls?.length) {
                    if (!expand_calls) {
                        lines.push(`**Calls:** ${chunk.calls.join(', ')}`);
                    } else {
                        const expanded = [];
                        const seen = new Set();
                        const SIG_BUDGET = 6;
                        for (const callName of chunk.calls) {
                            if (seen.size >= SIG_BUDGET) break;
                            const key = callName.toLowerCase();
                            if (seen.has(key)) continue;
                            seen.add(key);
                            const target = db.resolveSymbol(callName)[0];
                            if (!target?.code_snippet) continue;
                            const sig = extractSignatureLine(target.code_snippet).split('\n')[0].trim().slice(0, 120);
                            expanded.push(
                                `  **${callName}** → \`${target.file_path}:${target.start_line}\``
                                + `\n  \`\`\`\n  ${sig}\n  \`\`\``
                            );
                        }
                        const unresolved = chunk.calls.length - expanded.length;
                        lines.push(`\n**Calls (${expanded.length} resolved${unresolved > 0 ? `, ${unresolved} unindexed` : ''}):**`);
                        if (expanded.length > 0) lines.push(...expanded);
                        else lines.push('  _(none resolved in index)_');
                    }
                }

                lines.push('', '```', extractSignatureLine(chunk.code_snippet), '```');
                lines.push(`\n↩️  Full body: get_chunk("${chunk.id}")`);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── get_file_skeleton ──────────────────────────────────────────────────────
    server.tool(
        'get_file_skeleton',
        'Returns all top-level exports and definitions in a file with line numbers — no code bodies (~50 tokens vs 5000).',
        {
            file_path: z.string().describe("Relative path (e.g. 'src/app.ts')."),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' ({ file_path, skeleton } string fields)."
            ),
        },
        async ({ file_path, response_format }) => {
            try {
                const absolutePath = resolve(projectRoot, file_path);
                const safeRoot = path.normalize(projectRoot);
                const norm = path.normalize(absolutePath);
                if (norm !== safeRoot && !norm.startsWith(safeRoot + path.sep)) {
                    throw new Error('Access denied: path is outside the project root.');
                }
                if (!fs.existsSync(absolutePath)) throw new Error('File not found.');
                // Defence in depth: the textual check above can be defeated by a
                // symlink inside the project that points outside it. Resolve symlinks
                // on both sides and re-check containment to block that escape path.
                let realRoot, realPath;
                try { realRoot = fs.realpathSync(safeRoot); } catch { realRoot = safeRoot; }
                try { realPath = fs.realpathSync(absolutePath); } catch { realPath = norm; }
                if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
                    throw new Error('Access denied: path resolves outside the project root.');
                }
                const content = fs.readFileSync(absolutePath, 'utf-8');
                const ext = path.extname(absolutePath);
                const parser = getParserForFile(ext);
                if (!parser) {
                    return response_format === 'json'
                        ? jsonResult({ file_path, language_supported: false, skeleton: null })
                        : { content: [{ type: 'text', text: 'Language not supported.' }] };
                }
                const tree = parser.parse((offset) => offset < content.length ? content.slice(offset, offset + 4096) : null);
                const skeleton = extractFileSkeleton(tree.rootNode, content);
                if (response_format === 'json') {
                    return jsonResult({ file_path, language_supported: true, skeleton: skeleton || '' });
                }
                return { content: [{ type: 'text', text: `# Skeleton: ${file_path}\n\n${skeleton || '_No semantic signatures found_'}` }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── get_call_graph ─────────────────────────────────────────────────────────
    server.tool(
        'get_call_graph',
        'Finds all chunks that call a specific function, split into high-confidence callers '
        + '(the real blast radius) and name-only matches (an ambiguous same-named symbol). '
        + 'CRITICAL for safe refactoring — call before changing any exported signature.',
        {
            target_function: z.string().describe("Exact function name (e.g. 'validateToken')."),
            target_class: z.string().optional().describe(
                "Optional class/type that owns the method (e.g. 'OrderService') — scopes the "
                + "blast radius to one class's method when several symbols share the name."
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed { high, name_only } caller arrays)."
            ),
        },
        async ({ target_function, target_class, response_format }) => {
            try {
                const { high, nameOnly, targetDefs, ambiguous, hasSiteData, classFiltered } =
                    classifyCallers(db, target_function, { targetClass: target_class || null });
                const total = high.length + nameOnly.length;
                const label = classFiltered ? `${target_class}.${target_function}` : target_function;
                const coChanges = coChangeFiles(gitSignals, [...new Set(targetDefs.map(d => d.file_path))]);
                const fresh = indexFreshness();
                const note = freshnessNote(fresh);

                if (response_format === 'json') {
                    return jsonResult({
                        target_function,
                        target_class: target_class || null,
                        ambiguous,
                        definition_count: targetDefs.length,
                        receiver_aware: hasSiteData,
                        caller_count: total,
                        high_confidence: high.map(h => refCard({ ...h, confidence: 'high' })),
                        name_only: nameOnly.map(n => refCard({ ...n, confidence: 'name-only' })),
                        co_changes: coChanges,
                        index: fresh,
                    });
                }

                if (total === 0) {
                    // "No callers" from a stale index is dangerously misleading — always surface freshness here.
                    const parts = [`✅ Safe to modify: no callers of \`${label}\` found.`];
                    if (coChanges.length) parts.push(coChangeLine(coChanges));
                    if (note) parts.push(note);
                    return { content: [{ type: 'text', text: parts.join('\n') }] };
                }

                const fmt = ({ chunk, recvHint }) =>
                    `- [${chunk.node_type}] \`${chunk.class_context ? chunk.class_context + '.' : ''}${chunk.name}\``
                    + ` in \`${chunk.file_path}\` (lines ${chunk.start_line}–${chunk.end_line})`
                    + (recvHint ? ` · via ${recvHint}` : '');

                const lines = [`# ⚠️ Call Graph: \`${label}\``];
                const split = ambiguous && !classFiltered;

                if (split) {
                    lines.push(`${total} name-match caller(s) · ⚠️ ${targetDefs.length}+ symbols named \`${target_function}\` — grouped by confidence:`);
                } else {
                    lines.push(`${total} caller(s) depend on this — review before changing signature:`);
                }

                if (high.length) {
                    if (split) lines.push('', `## ✅ High-confidence callers (${high.length})`);
                    for (const h of high) lines.push(fmt(h));
                }
                if (nameOnly.length) {
                    lines.push('', `## ❔ Name-only matches (${nameOnly.length}) — verify; may call a different \`${target_function}\``);
                    for (const n of nameOnly) lines.push(fmt(n));
                    if (!classFiltered) lines.push('', `> Pass \`target_class\` to scope the blast radius to one class's \`${target_function}\`.`);
                }
                if (!hasSiteData && ambiguous) {
                    lines.push('', `> ℹ️ This index predates receiver-aware call graphs — re-run \`npm run mcp:index\` for precise grouping.`);
                }
                if (coChanges.length) lines.push('', coChangeLine(coChanges));
                if (note) lines.push('', note);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── find_references ──────────────────────────────────────────────────────────
    server.tool(
        'find_references',
        'Every symbol that references a target symbol — symbol-level, not just file-level. '
        + 'Fuses three reference kinds: callers (the blast radius), subclasses/implementers '
        + '(extends), and type users (params, returns, fields). Each is split by confidence '
        + 'using receiver hints and the import graph. Broader than get_call_graph: use it before '
        + 'renaming or changing a class/interface/type, not just a function.',
        {
            symbol: z.string().describe("Exact symbol name (function, class, interface, or type)."),
            target_class: z.string().optional().describe(
                "Optional owning class/type to scope the call dimension when several symbols share the name."
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed { called_by, subclassed_by, used_as_type_by })."
            ),
        },
        async ({ symbol, target_class, response_format }) => {
            try {
                const { targetDefs, ambiguous, calls, inherits, types, references } =
                    findReferences(db, symbol, { targetClass: target_class || null });
                const callTotal = calls.high.length + calls.nameOnly.length;
                const total = callTotal + inherits.length + types.length;
                const scipRefs = references || [];
                const coChanges = coChangeFiles(gitSignals, [...new Set(targetDefs.map(d => d.file_path))]);
                const fresh = indexFreshness();
                const note = freshnessNote(fresh);

                if (response_format === 'json') {
                    return jsonResult({
                        symbol,
                        target_class: target_class || null,
                        ambiguous,
                        definition_count: targetDefs.length,
                        reference_count: total,
                        called_by: {
                            high: calls.high.map(h => refCard({ ...h, confidence: 'high' })),
                            name_only: calls.nameOnly.map(n => refCard({ ...n, confidence: 'name-only' })),
                        },
                        subclassed_by: inherits.map(refCard),
                        used_as_type_by: types.map(refCard),
                        // A2 v2: binding-precise cross-file references from a SCIP index (resolved tier).
                        referenced_by_resolved: scipRefs.map(refCard),
                        resolved_reference_count: scipRefs.length,
                        co_changes: coChanges,
                        index: fresh,
                    });
                }

                if (total === 0 && scipRefs.length === 0) {
                    const parts = [`✅ No references to \`${symbol}\` found in the index.`];
                    if (coChanges.length) parts.push(coChangeLine(coChanges));
                    if (note) parts.push(note);
                    return { content: [{ type: 'text', text: parts.join('\n') }] };
                }

                const fmt = ({ chunk, recvHint, confidence }) =>
                    `- [${chunk.node_type}] \`${chunk.class_context ? chunk.class_context + '.' : ''}${chunk.name}\``
                    + ` in \`${chunk.file_path}\` (lines ${chunk.start_line}–${chunk.end_line})`
                    + (recvHint ? ` · via ${recvHint}` : '')
                    + (confidence === 'name-only' ? ' · ⚠️ unverified' : '');

                const lines = [`# 🔗 References to \`${symbol}\` — ${total} total`
                    + (scipRefs.length ? ` · ${scipRefs.length} SCIP-resolved` : '')];
                if (ambiguous) lines.push(`⚠️ ${targetDefs.length} symbols named \`${symbol}\` — name-only matches may target a different one.`);

                if (callTotal) {
                    lines.push('', `## 📞 Called by (${callTotal})`);
                    for (const h of calls.high) lines.push(fmt({ ...h, confidence: 'high' }));
                    for (const n of calls.nameOnly) lines.push(fmt({ ...n, confidence: 'name-only' }));
                }
                if (inherits.length) {
                    lines.push('', `## 🧬 Subclassed / implemented by (${inherits.length})`);
                    for (const it of inherits) lines.push(fmt(it));
                }
                if (types.length) {
                    lines.push('', `## 🏷  Used as a type by (${types.length})`);
                    for (const it of types) lines.push(fmt(it));
                }
                if (scipRefs.length) {
                    lines.push('', `## 🎯 Referenced by — SCIP-resolved (${scipRefs.length})`,
                        '_Binding-precise cross-file references from your SCIP index (kind-agnostic): disambiguates'
                        + ' same-named symbols and catches uses the name heuristics above can miss._');
                    for (const it of scipRefs) lines.push(fmt(it));
                }
                if (coChanges.length) lines.push('', coChangeLine(coChanges));
                if (note) lines.push('', note);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── find_routes ──────────────────────────────────────────────────────────────
    server.tool(
        'find_routes',
        'Map HTTP routes to their handler functions. Returns the handler chunk ID so '
        + 'you can call get_chunk or get_call_graph on the handler directly. Covers '
        + 'NestJS decorators, FastAPI/Flask, Spring (Java) annotations, and Express/Koa '
        + 'registration. Filter by method and/or path.',
        {
            method: z.string().optional().describe(
                "Optional HTTP method filter (GET, POST, PUT, DELETE, PATCH). Case-insensitive; omit for all methods."
            ),
            path: z.string().optional().describe(
                "Optional path filter. Starts with '/' → prefix match; otherwise (incl. pattern hints with '{' or ':') → substring contains-match."
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed { routes: [...] })."
            ),
        },
        async ({ method, path: pathArg, response_format }) => {
            try {
                const routes = findRoutes(db, { method: method || null, path: pathArg || null });
                const fresh = indexFreshness();
                const note = freshnessNote(fresh);

                if (response_format === 'json') {
                    return jsonResult({
                        method: method || null,
                        path: pathArg || null,
                        route_count: routes.length,
                        routes,
                        index: fresh,
                    });
                }

                if (routes.length === 0) {
                    const filt = [method ? method.toUpperCase() : null, pathArg].filter(Boolean).join(' ');
                    const parts = [`✅ No HTTP routes${filt ? ` matching \`${filt}\`` : ''} found in the index.`];
                    if (note) parts.push(note);
                    return { content: [{ type: 'text', text: parts.join('\n') }] };
                }

                const lines = [`# 🌐 HTTP routes — ${routes.length} total`];
                for (const r of routes) {
                    const handler = r.id
                        ? `\`${r.handler_name}\` [${r.node_type}] in \`${r.file_path}\` (lines ${r.start_line}–${r.end_line}) · id \`${r.id}\``
                        : `\`${r.handler_name}\` in \`${r.file_path}\`${r.line ? ` (line ${r.line})` : ''}`;
                    lines.push(`- **${r.method}** \`${r.path}\` → ${handler}`);
                }
                if (note) lines.push('', note);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── get_subgraph ─────────────────────────────────────────────────────────────
    server.tool(
        'get_subgraph',
        'Trace a flow across files in ONE call: returns a bounded connected subgraph around a '
        + 'seed symbol — what it calls, its high-confidence callers (precise blast radius), and '
        + 'its type/inheritance users — within a node and token budget. Use instead of chaining '
        + 'search_code → get_call_graph → find_references for cross-cutting "how does X flow" questions.',
        {
            symbol: z.string().describe('Seed symbol name (function, method, class, or type).'),
            depth: z.number().int().min(1).max(3).default(2).describe('Hops to traverse from the seed (1–3).'),
            max_nodes: z.number().int().min(1).max(40).default(12).describe('Max chunks in the subgraph.'),
            token_budget: z.number().int().min(100).optional().describe(
                'Token budget for the subgraph (1 token ≈ 4 chars). Omit for node-count-only bounding.'
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed { nodes, edges })."
            ),
        },
        async ({ symbol, depth, max_nodes, token_budget, response_format }) => {
            try {
                const g = buildSubgraph(db, symbol, { maxNodes: max_nodes, maxDepth: depth, tokenBudget: token_budget ?? null });
                const fresh = indexFreshness();
                const note = freshnessNote(fresh);
                if (!g.found) {
                    return response_format === 'json'
                        ? jsonResult({ symbol, found: false, nodes: [], edges: [], index: fresh })
                        : { content: [{ type: 'text', text: `Symbol '${symbol}' not in index. Try search_code(query="${symbol}").${note ? '\n' + note : ''}` }] };
                }
                if (response_format === 'json') return jsonResult({ ...g, index: fresh });

                const byId = new Map(g.nodes.map(n => [n.id, n]));
                const label = (id) => { const n = byId.get(id); return n ? `${n.class_context ? n.class_context + '.' : ''}${n.name}` : id; };
                const lines = [
                    `# 🕸  Subgraph around \`${symbol}\` — ${g.nodes.length} node(s), ${g.edges.length} edge(s)`
                    + (g.truncated ? ` · ⚠️ truncated at the budget (raise max_nodes / token_budget for more)` : ''),
                    '',
                    `## Nodes`,
                ];
                for (const n of g.nodes) {
                    lines.push(`- [d${n.depth}] [${n.node_type}] \`${n.class_context ? n.class_context + '.' : ''}${n.name}\` · \`${n.file_path}:${n.start_line}–${n.end_line}\``);
                }
                if (g.edges.length) {
                    lines.push('', `## Edges`);
                    for (const e of g.edges) {
                        lines.push(`- \`${label(e.from)}\` ${e.kind === 'calls' ? '→ calls →' : '⇢ references ⇢'} \`${label(e.to)}\``);
                    }
                }
                if (note) lines.push('', note);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── get_repo_map ───────────────────────────────────────────────────────────
    server.tool(
        'get_repo_map',
        'Returns a compact symbol map of the entire codebase grouped by file, ordered by importance (most-imported files first via PageRank). Use this FIRST to orient yourself in an unfamiliar codebase — ~1-2k tokens vs reading every file. Combine with path_filter to focus on a subsystem.',
        {
            path_filter: z.string().optional().describe(
                "Only include files whose path contains this string (e.g. 'auth', 'api/v2', 'src/core')."
            ),
            max_files: z.number().int().min(1).max(300).default(80).describe('Max files to include in the map.'),
            sort_by: z.enum(['importance', 'path']).default('importance').describe(
                "'importance' (default): most-imported files first (PageRank). 'path': alphabetical."
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed { files: [{ file_path, symbols }] })."
            ),
        },
        async ({ path_filter, max_files, sort_by, response_format }) => {
            try {
                const fileChunks = new Map();
                const filterLower = path_filter ? path_filter.toLowerCase() : null;
                for (const chunk of db.iterateChunks()) {
                    if (filterLower && !chunk.file_path.toLowerCase().includes(filterLower)) continue;
                    if (chunk.name === 'anonymous' || chunk.name === 'default_export') continue;
                    if (!fileChunks.has(chunk.file_path)) fileChunks.set(chunk.file_path, []);
                    fileChunks.get(chunk.file_path).push(chunk);
                }

                if (fileChunks.size === 0) {
                    return response_format === 'json'
                        ? jsonResult({ total_files: 0, total_symbols: 0, files: [] })
                        : {
                            content: [{
                                type: 'text', text: path_filter
                                    ? `No files found matching '${path_filter}'. Try a broader filter.`
                                    : 'Index is empty. Run `npm run mcp:index` first.'
                            }]
                        };
                }

                let sortedFiles = Array.from(fileChunks.keys());
                if (sort_by === 'importance') {
                    const pr = computePageRank(db.graph);
                    sortedFiles.sort((a, b) => (pr.get(b) ?? 0) - (pr.get(a) ?? 0));
                } else {
                    sortedFiles.sort();
                }
                sortedFiles = sortedFiles.slice(0, max_files);

                const totalFiles = fileChunks.size;
                const totalSymbols = Array.from(fileChunks.values()).reduce((s, a) => s + a.length, 0);

                // A5: most-central symbols (PageRank over the resolved symbol graph), shown only
                // on the unfiltered orientation view and only when --symbol-graph built it.
                // Absent on the default path → output byte-identical.
                const central = (db.hasCentrality?.() && !path_filter) ? db.topCentral(12) : [];

                if (response_format === 'json') {
                    const files = sortedFiles.map(filePath => {
                        const seen = new Set();
                        const symbols = [];
                        for (const c of fileChunks.get(filePath)) {
                            const key = c.name.toLowerCase();
                            if (seen.has(key)) continue;
                            seen.add(key);
                            symbols.push({
                                name: c.name, node_type: c.node_type,
                                params: c.params || [], return_type: c.return_type || null,
                                start_line: c.start_line, end_line: c.end_line,
                            });
                        }
                        return { file_path: filePath, symbol_count: symbols.length, symbols };
                    });
                    return jsonResult({
                        total_files: totalFiles, total_symbols: totalSymbols,
                        shown_files: sortedFiles.length, sort_by, path_filter: path_filter || null,
                        ...(central.length ? {
                            central_total: db.getCentrality(central[0].chunk.id)?.total ?? central.length,
                            central_symbols: central.map(({ chunk, score, rank }) => ({
                                name: chunk.name, class_context: chunk.class_context || null,
                                file_path: chunk.file_path, node_type: chunk.node_type,
                                rank, score,
                            })),
                        } : {}),
                        files,
                    });
                }

                const lines = [
                    `# Repo Map — ${totalSymbols} symbols across ${totalFiles} files`,
                    path_filter ? `(filtered to '${path_filter}')` : '',
                    sortedFiles.length < totalFiles ? `(showing top ${sortedFiles.length} by ${sort_by}; use path_filter to narrow)\n` : '',
                ].filter(Boolean);

                if (central.length) {
                    const cenTotal = db.getCentrality(central[0].chunk.id)?.total ?? central.length;
                    lines.push(`**Most central symbols** (PageRank over the resolved symbol graph, top ${central.length} of ${cenTotal}):`);
                    for (const { chunk, rank } of central) {
                        const nm = `${chunk.class_context ? chunk.class_context + '.' : ''}${chunk.name}`;
                        lines.push(`  ${rank}. \`${nm}\` — \`${chunk.file_path}\``);
                    }
                    lines.push('');
                }

                for (const filePath of sortedFiles) {
                    const chunks = fileChunks.get(filePath);
                    lines.push(`\n${filePath}`);
                    const seen = new Set();
                    const deduped = [];
                    for (const c of chunks) {
                        const key = c.name.toLowerCase();
                        if (seen.has(key)) continue;
                        seen.add(key);
                        deduped.push(c);
                    }
                    for (const c of deduped.slice(0, 8)) {
                        const kind = c.node_type.includes('class') ? 'class'
                            : c.node_type.includes('interface') ? 'interface'
                                : c.node_type.includes('enum') ? 'enum'
                                    : c.node_type.includes('struct') ? 'struct'
                                        : c.node_type.includes('trait') ? 'trait' : 'fn';
                        const params = c.params?.length
                            ? `(${c.params.slice(0, 3).join(', ')}${c.params.length > 3 ? ', …' : ''})` : '';
                        const ret = c.return_type ? ` → ${c.return_type.slice(0, 40)}` : '';
                        lines.push(`  ${kind} ${c.name}${params}${ret}`);
                    }
                    if (deduped.length > 8) lines.push(`  … (${deduped.length - 8} more)`);
                }
                if (totalFiles > max_files) {
                    lines.push(`\n… ${totalFiles - max_files} more files not shown. Use path_filter or increase max_files.`);
                }
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── list_index_stats ───────────────────────────────────────────────────────
    server.tool(
        'list_index_stats',
        'Returns index health: chunk count, embedding status, daemon status, search mode, storage backend, and index freshness.',
        {
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed health fields)."
            ),
        },
        async ({ response_format }) => {
            try {
                const s = db.stats();

                let indexAge = 'unknown';
                let ageSeconds = null;
                try {
                    ageSeconds = Math.floor((Date.now() - fs.statSync(artifactPath).mtimeMs) / 1000);
                    indexAge = ageSeconds < 60 ? `${ageSeconds}s ago` : ageSeconds < 3600 ? `${Math.floor(ageSeconds / 60)}m ago` : `${Math.floor(ageSeconds / 3600)}h ago`;
                } catch { }

                let daemonStatus = 'not running';
                let daemonRunning = false;
                try {
                    if (pidFile && fs.existsSync(pidFile)) {
                        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
                        process.kill(pid, 0);
                        daemonStatus = `running (PID: ${pid})`;
                        daemonRunning = true;
                    }
                } catch { daemonStatus = 'not running (stale PID)'; }

                const embedLabel = embedder ? describeEmbedder(embedder) : '🔤 Lexical only';
                const searchModeText = !embeddingsEnabled ? 'lexical-only' : s.hasVectors ? 'hybrid' : 'lexical-only';
                const searchMode = !embeddingsEnabled
                    ? '🔤 Lexical only (embeddings disabled)'
                    : s.hasVectors
                        ? `🧠 Hybrid (semantic + lexical RRF) · ${embedLabel} — vectors: ${s.vectorSource}`
                        : '🔤 Lexical only (no vectors indexed yet)';

                const fresh = indexFreshness();

                if (response_format === 'json') {
                    return jsonResult({
                        backend: s.backend,
                        chunks: s.chunks,
                        files: s.files,
                        symbols: s.symbols,
                        vectors: s.vectors,
                        has_vectors: s.hasVectors,
                        search_mode: searchModeText,
                        embeddings_enabled: Boolean(embeddingsEnabled),
                        embedder: embedder ? { provider: embedder.provider, model: embedder.model, dim: embedder.dim ?? null } : null,
                        lazy_mode: s.lazyMode,
                        sealed: sealed,
                        egress_guard: sealed === 'off' ? 'off' : (egressGuardActive() ? 'active' : 'requested'),
                        taint_flows: db.hasTaint?.() ? (db.getTaintFlows()?.flows?.length ?? 0) : null,
                        scip_references: db.hasScipRefs?.() ? (db.scipRefCount?.() ?? null) : null,
                        daemon_running: daemonRunning,
                        index_age_seconds: ageSeconds,
                        freshness: {
                            indexed_commit: fresh.indexedCommit,
                            current_commit: fresh.currentCommit,
                            pending_changes: fresh.pendingChanges,
                            stale: fresh.stale,
                            syncing: fresh.syncing,
                        },
                        ext_counts: Object.fromEntries(s.extCounts),
                    });
                }

                const lines = [
                    `# 📊 graph-indexer Index Stats`, '',
                    `| Metric | Value |`, `| :--- | :--- |`,
                    `| **Storage backend** | ${s.backend === 'sqlite' ? '🗄  SQLite (disk-backed)' : '⚡ In-memory'} |`,
                    `| **Chunks** | ${s.chunks} |`,
                    `| **Files indexed** | ${s.files} |`,
                    `| **Symbols in table** | ${s.symbols} |`,
                    `| **Vector entries** | ${s.vectors} |`,
                    `| **Search mode** | ${searchMode} |`,
                    `| **Lazy vec mode** | ${s.lazyMode ? '✅ Yes (enterprise scale)' : '❌ No (small corpus)'} |`,
                    ...(sealed !== 'off' ? [`| **Sealed mode** | 🔒 ${sealed} · egress guard ${egressGuardActive() ? 'active' : 'requested'} |`] : []),
                    ...(db.hasTaint?.() ? [`| **Taint flows** | 🧪 ${db.getTaintFlows()?.flows?.length ?? 0} precomputed |`] : []),
                    ...(db.hasScipRefs?.() ? [`| **SCIP references** | 🎯 ${db.scipRefCount?.() ?? 0} definitions (precise cross-file) |`] : []),
                    `| **Daemon** | ${daemonStatus} |`,
                    `| **Index age** | ${indexAge} |`,
                    `| **Built at commit** | ${fresh.indexedCommit || '—'}${fresh.commitMoved ? ` (HEAD now ${fresh.currentCommit})` : ''} |`,
                    `| **Pending changes** | ${fresh.pendingChanges == null ? '—' : fresh.pendingChanges} |`,
                    `| **Freshness** | ${fresh.stale ? '⚠️ STALE — run `npm run mcp:index`' : fresh.syncing ? '🔄 daemon syncing' : '✅ fresh'} |`,
                    '', `## Extension Breakdown`,
                    ...Array.from(s.extCounts.entries()).sort((a, b) => b[1] - a[1]).map(([e, n]) => `- .${e}: ${n} chunks`),
                ];
                if (s.chunks === 0) lines.push('', `⚠️ Index empty. Run \`npm run mcp:index\`.`);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── tests_for ────────────────────────────────────────────────────────────────
    server.tool(
        'tests_for',
        'Find the tests that exercise a symbol — the test/spec chunks that call or reference it. '
        + 'Use it to see how a function/class is meant to behave, or which tests to run (or update) '
        + 'before changing it. Returns each test chunk + id (call get_chunk for the body).',
        {
            symbol: z.string().describe("Exact symbol name (function, class, method) to find tests for."),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed { tests: [...] })."
            ),
        },
        async ({ symbol, response_format }) => {
            try {
                const tests = testsForSymbol(symbol);
                const fresh = indexFreshness();
                const note = freshnessNote(fresh);

                if (response_format === 'json') {
                    return jsonResult({ symbol, test_count: tests.length, tests: tests.map(chunkCard), index: fresh });
                }
                if (tests.length === 0) {
                    const known = db.resolveSymbol(symbol).length > 0;
                    const parts = [known
                        ? `🧪 No tests found that reference \`${symbol}\`. It may be untested, or its tests are dynamic/indirect (the test calls a wrapper, not the symbol directly).`
                        : `Symbol \`${symbol}\` is not in the index. Try search_code(query="${symbol}").`];
                    if (note) parts.push(note);
                    return { content: [{ type: 'text', text: parts.join('\n') }] };
                }
                const lines = [`# 🧪 Tests for \`${symbol}\` — ${tests.length}`];
                for (const t of tests) {
                    lines.push(`- \`${t.class_context ? t.class_context + '.' : ''}${t.name}\` [${t.node_type}]`
                        + ` in \`${t.file_path}\` (lines ${t.start_line}–${t.end_line}) · id \`${t.id}\``);
                }
                if (note) lines.push('', note);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── explain_symbol ─────────────────────────────────────────────────────────────
    server.tool(
        'explain_symbol',
        'One-call overview of a symbol before you edit it: its signature(s), what it calls (callees), '
        + 'who calls it (callers / blast radius), subclasses and type users, the HTTP routes it handles, '
        + 'the tests that exercise it, and git recency/co-change. Composes resolve_symbol + '
        + 'find_references + find_routes + tests_for + git signals so an agent gets the full context in '
        + 'a single round-trip instead of four.',
        {
            symbol: z.string().describe("Exact symbol name (function, class, interface, method)."),
            target_class: z.string().optional().describe(
                "Optional owning class/type to scope the caller/reference dimensions when several symbols share the name."
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed { definitions, callees, called_by, subclassed_by, used_as_type_by, routes, tests, recent_changes, co_changes })."
            ),
        },
        async ({ symbol, target_class, response_format }) => {
            try {
                const defs = db.resolveSymbol(symbol);
                if (defs.length === 0) {
                    const indexEmpty = db.chunkCount() === 0;
                    const emptyHint = 'Index is empty — run `npm run mcp:index` (or `idx-index --repo <path>`) to build it.';
                    return response_format === 'json'
                        ? jsonResult({ symbol, found: false, ...(indexEmpty ? { index_status: 'empty', hint: emptyHint } : {}), definitions: [] })
                        : { content: [{ type: 'text', text: indexEmpty ? `⚠️ ${emptyHint}` : `Symbol \`${symbol}\` not in index. Try search_code(query="${symbol}").` }] };
                }

                const { targetDefs, ambiguous, calls, inherits, types, references } =
                    findReferences(db, symbol, { targetClass: target_class || null });
                const scipRefs = references || [];
                const callees = [...new Set(defs.flatMap(d => d.calls || []))].sort();
                const tests = testsForSymbol(symbol);
                const defIds = new Set(defs.map(d => d.id));
                const routes = findRoutes(db, {}).filter(r => r.handler_name === symbol || (r.id && defIds.has(r.id)));
                const files = [...new Set(targetDefs.map(d => d.file_path))];
                const coChanges = coChangeFiles(gitSignals, files);
                const recentChanges = files
                    .map(f => ({ file: f, hotness: Number(gitBoostScore(gitSignals, f).toFixed(3)) }))
                    .filter(r => r.hotness > 0)
                    .sort((a, b) => b.hotness - a.hotness || a.file.localeCompare(b.file));
                const fresh = indexFreshness();
                const note = freshnessNote(fresh);

                if (response_format === 'json') {
                    return jsonResult({
                        symbol,
                        target_class: target_class || null,
                        ambiguous,
                        definition_count: defs.length,
                        definitions: defs.map(d => {
                            const cen = db.getCentrality?.(d.id);
                            return { ...chunkCard(d), signature: extractSignatureLine(d.code_snippet), ...(cen ? { centrality: cen } : {}) };
                        }),
                        callees,
                        called_by: {
                            high: calls.high.map(h => refCard({ ...h, confidence: 'high' })),
                            name_only: calls.nameOnly.map(n => refCard({ ...n, confidence: 'name-only' })),
                        },
                        subclassed_by: inherits.map(refCard),
                        used_as_type_by: types.map(refCard),
                        referenced_by_resolved: scipRefs.map(refCard),
                        routes,
                        tests: tests.map(chunkCard),
                        recent_changes: recentChanges,
                        co_changes: coChanges,
                        index: fresh,
                    });
                }

                const callerTotal = calls.high.length + calls.nameOnly.length;
                const lines = [`# 🔎 \`${target_class ? target_class + '.' : ''}${symbol}\``];
                if (ambiguous) lines.push(`> ⚠️ ${defs.length} symbols named \`${symbol}\`${target_class ? '' : ' — pass target_class to scope callers/references'}.`);
                for (const d of defs) {
                    const cen = db.getCentrality?.(d.id);
                    const cenTag = cen ? ` · 🎯 centrality #${cen.rank}/${cen.total}${cen.rank <= Math.ceil(cen.total * 0.1) ? ' (hub)' : ''}` : '';
                    lines.push('', `**${d.class_context ? d.class_context + '.' : ''}${d.name}** [${d.node_type}] · \`${d.file_path}\`:${d.start_line}–${d.end_line} · id \`${d.id}\`${cenTag}`);
                    lines.push('```', extractSignatureLine(d.code_snippet), '```');
                }
                if (callees.length) lines.push('', `**Calls (${callees.length}):** ${callees.slice(0, 20).join(', ')}${callees.length > 20 ? ' …' : ''}`);
                lines.push('', `**Called by (${callerTotal}):** ${calls.high.length} high-confidence` + (calls.nameOnly.length ? `, ${calls.nameOnly.length} name-only` : ''));
                for (const h of calls.high.slice(0, 10)) lines.push(`  - ✅ \`${h.chunk.class_context ? h.chunk.class_context + '.' : ''}${h.chunk.name}\` in \`${h.chunk.file_path}\`${h.recvHint ? ` · via ${h.recvHint}` : ''}`);
                if (inherits.length) lines.push('', `**Subclassed/implemented by (${inherits.length}):** ` + inherits.slice(0, 10).map(r => `\`${r.chunk.name}\``).join(', '));
                if (types.length) lines.push('', `**Used as a type by (${types.length}):** ` + types.slice(0, 10).map(r => `\`${r.chunk.name}\``).join(', '));
                if (scipRefs.length) lines.push('', `**🎯 SCIP-resolved references (${scipRefs.length}):** ` + scipRefs.slice(0, 10).map(r => `\`${r.chunk.name}\``).join(', '));
                if (routes.length) {
                    lines.push('', `**Routes (${routes.length}):**`);
                    for (const r of routes) lines.push(`  - **${r.method}** \`${r.path}\``);
                }
                lines.push('', tests.length ? `**Tests (${tests.length}):**` : `**Tests:** none found`);
                for (const t of tests.slice(0, 10)) lines.push(`  - 🧪 \`${t.name}\` in \`${t.file_path}\` · id \`${t.id}\``);
                if (recentChanges.length) lines.push('', `**Recent activity:** ` + recentChanges.map(r => `\`${r.file}\` (hotness ${r.hotness})`).join(', '));
                if (coChanges.length) lines.push('', coChangeLine(coChanges));
                if (note) lines.push('', note);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── impact_of_edit ─────────────────────────────────────────────────────────────
    server.tool(
        'impact_of_edit',
        'The precise BLAST RADIUS of a change before you make it: pass the symbols and/or files '
        + 'you are about to edit and get the transitively-affected code (callers, subclasses, type '
        + 'users), the HTTP routes that reach them, the tests to run, and the files that '
        + 'historically change together. Follows high-confidence edges transitively (precise, no '
        + 'name collisions); direct ambiguous referrers are listed separately to verify. Most '
        + 'precise on an index built with --symbol-graph; otherwise resolves at query time.',
        {
            symbols: z.array(z.string()).optional().describe('Symbol names about to change (functions, classes, methods).'),
            files: z.array(z.string()).optional().describe('Repo-relative file paths about to change (every defined symbol in them seeds the impact).'),
            max_depth: z.number().int().min(1).max(6).default(3).describe('Transitive caller hops to follow (default 3).'),
            max_nodes: z.number().int().min(1).max(1000).default(200).describe('Cap on affected chunks returned.'),
            precision: z.enum(['standard', 'strict']).default('standard').describe(
                "'standard' (default): follow the high-confidence closure (resolved + import/proximity). "
                + "'strict': follow ONLY provably-unambiguous bindings (sole definition or type-pinned receiver) "
                + 'for a false-positive-free blast radius — most useful on a --symbol-graph --resolver precise index.'
            ),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe(
                "'markdown' (default) or 'json' (typed { changed, impacted, ambiguous, routes, tests, co_changes })."
            ),
        },
        async ({ symbols = [], files = [], max_depth, max_nodes, precision = 'standard', response_format }) => {
            try {
                // Seed: every definition of each symbol + every chunk in each named file.
                const seedMap = new Map();
                for (const s of symbols) for (const c of db.resolveSymbol(s)) seedMap.set(c.id, c);
                for (const f of files) for (const c of db.getChunksByFile(f)) seedMap.set(c.id, c);
                const seed = [...seedMap.values()];

                if (seed.length === 0) {
                    const msg = (symbols.length || files.length)
                        ? `No indexed symbols matched ${JSON.stringify([...symbols, ...files])}. Check the names/paths, or run search_code.`
                        : 'Pass `symbols` and/or `files` you are about to change.';
                    return response_format === 'json'
                        ? jsonResult({ changed: [], impacted: [], ambiguous: [], routes: [], tests: [], co_changes: [], note: msg })
                        : { content: [{ type: 'text', text: msg }] };
                }

                const { impacted, ambiguous, truncated, usedGraph } = buildImpact(db, seed, { maxDepth: max_depth, maxNodes: max_nodes, precision });

                // Affected = seed ∪ impacted. Split tests out from production code.
                const affected = [...seed.map(c => ({ chunk: c, depth: 0, kind: 'seed' })), ...impacted];
                const affectedIds = new Set(affected.map(a => a.chunk.id));
                const isTest = (c) => TEST_FILE_RE.test(c.file_path);
                const impactedCode = impacted.filter(a => !isTest(a.chunk));
                const tests = affected.filter(a => isTest(a.chunk)).map(a => a.chunk);

                // Routes whose handler chunk is in the affected set.
                const routes = findRoutes(db, {}).filter(r => r.id && affectedIds.has(r.id));
                const seedFiles = [...new Set(seed.map(c => c.file_path))];
                const coChanges = coChangeFiles(gitSignals, seedFiles);
                const fresh = indexFreshness();
                const note = freshnessNote(fresh);

                if (response_format === 'json') {
                    return jsonResult({
                        seed_symbols: symbols, seed_files: files,
                        resolution: usedGraph ? 'symbol-graph' : 'query-time',
                        precision,
                        changed: seed.map(chunkCard),
                        impacted: impactedCode.map(a => ({ ...chunkCard(a.chunk), depth: a.depth, via: a.kind })),
                        ambiguous: ambiguous.map(a => ({ ...chunkCard(a.chunk), via: a.kind })),
                        routes,
                        tests: tests.map(chunkCard),
                        co_changes: coChanges,
                        truncated,
                        index: fresh,
                    });
                }

                const ref = (c) => `\`${c.class_context ? c.class_context + '.' : ''}${c.name}\` in \`${c.file_path}\`:${c.start_line}`;
                const lines = [`# 💥 Impact of editing ${seed.map(c => `\`${c.name}\``).slice(0, 8).join(', ')}`];
                lines.push(`> resolution: ${usedGraph ? 'symbol-graph (precise)' : 'query-time'} · precision: ${precision}${truncated ? ` · ⚠️ truncated at ${max_nodes} nodes` : ''}`);
                lines.push('', `**Changed (${seed.length}):** ${seed.map(c => `\`${c.name}\``).join(', ')}`);
                lines.push('', `**Impacted code (${impactedCode.length})** — transitive high-confidence callers/users:`);
                for (const a of impactedCode.slice(0, 40)) lines.push(`  - [d${a.depth}·${a.kind}] ${ref(a.chunk)}`);
                if (impactedCode.length > 40) lines.push(`  …and ${impactedCode.length - 40} more`);
                lines.push('', tests.length ? `**Tests to run (${tests.length}):**` : `**Tests to run:** none found`);
                for (const t of tests.slice(0, 20)) lines.push(`  - 🧪 ${ref(t)} · id \`${t.id}\``);
                if (routes.length) {
                    lines.push('', `**Affected routes (${routes.length}):**`);
                    for (const r of routes) lines.push(`  - **${r.method}** \`${r.path}\` → \`${r.handler_name}\``);
                }
                if (ambiguous.length) {
                    lines.push('', `**Ambiguous (${ambiguous.length}) — verify (same-named symbol, not expanded):**`);
                    for (const a of ambiguous.slice(0, 15)) lines.push(`  - ❔ ${ref(a.chunk)}`);
                }
                if (coChanges.length) lines.push('', coChangeLine(coChanges));
                if (!usedGraph) lines.push('', '> ℹ️ Build the index with `--symbol-graph` for a precomputed, chunk-precise blast radius.');
                if (note) lines.push('', note);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── trace_taint ─────────────────────────────────────────────────────────────────
    server.tool(
        'trace_taint',
        'Security: trace UNTRUSTED data from a source (request body/query/params, argv/env, stdin, '
        + 'socket/file reads) to a dangerous SINK (eval/exec, SQL, fs/path, HTML, outbound request) '
        + 'across the call graph — surfacing injection-class risks (rce/sqli/xss/path/ssrf) with the '
        + 'concrete source→sink path. Same-function flows are high-confidence; cross-function '
        + 'reachability is medium; a sanitizer on the path lowers it. FINDER, not a verifier — it '
        + 'misses dynamic dispatch / reflection / ORM indirection, so "no flows" ≠ "safe". '
        + 'JS/TS + Python. Most precise on a `--symbol-graph` index.',
        {
            source_kind: z.string().optional().describe("Restrict to one source kind (e.g. 'http-request', 'process-input', 'stdin')."),
            category: z.enum(['rce', 'sqli', 'xss', 'path', 'ssrf']).optional().describe('Restrict to one sink category.'),
            max_depth: z.number().int().min(1).max(8).default(4).describe('Cross-function call hops to follow from a source (default 4).'),
            max_flows: z.number().int().min(1).max(500).default(100).describe('Cap on flows returned (default 100).'),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe("'markdown' (default) or 'json' (typed { flows: [{ source, sink, path, via, confidence, sanitized }] })."),
        },
        async ({ source_kind, category, max_depth, max_flows, response_format }) => {
            try {
                const { flows, truncated, scanned } = traceTaint(db, {
                    sourceKind: source_kind || null, sinkCategory: category || null, maxDepth: max_depth, maxFlows: max_flows,
                });
                if (response_format === 'json') {
                    return jsonResult({ source_kind: source_kind || null, category: category || null, scanned, flow_count: flows.length, truncated, flows });
                }
                const lines = [`# 🧪 Taint flows — ${flows.length}${truncated ? '+' : ''} found (scanned ${scanned} chunks)`, ''];
                if (!flows.length) lines.push('No source→sink flows matched. ⚠️ This is a finder, not a verifier — absence of a flow is not proof of safety.');
                for (const f of flows.slice(0, 40)) {
                    lines.push(`- **${f.sink.category.toUpperCase()}** [${f.confidence}${f.sanitized ? ' · sanitizer on path' : ''}] — \`${f.source.kind}\` → \`${f.sink.label}\``);
                    lines.push(`  - source \`${f.source.name}\` in \`${f.source.file_path}\`:${f.source.line}`);
                    lines.push(`  - sink   \`${f.sink.name}\` in \`${f.sink.file_path}\`:${f.sink.line}  (${f.via}, depth ${f.depth})`);
                }
                if (flows.length > 40) lines.push(`\n…and ${flows.length - 40} more.`);
                lines.push('', '> Heuristic finder (JS/TS + Python). Triage each flow against its path; it can over- and under-report.');
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── find_tainted_sinks ──────────────────────────────────────────────────────────
    server.tool(
        'find_tainted_sinks',
        'Security orientation: list every dangerous SINK in the codebase (eval/exec, SQL, fs/path, '
        + 'HTML, outbound requests) grouped by category, each flagged with whether an untrusted '
        + 'SOURCE reaches it. Use it FIRST to map the attack surface, then trace_taint a specific '
        + 'one. JS/TS + Python; same heuristic-finder caveats as trace_taint.',
        {
            category: z.enum(['rce', 'sqli', 'xss', 'path', 'ssrf']).optional().describe('Restrict to one sink category.'),
            reachable_only: z.boolean().default(false).describe('Only sinks reachable from an untrusted source.'),
            max_depth: z.number().int().min(1).max(8).default(4).describe('Reachability hops to consider (default 4).'),
            response_format: z.enum(['markdown', 'json']).default('markdown').describe("'markdown' (default) or 'json' (typed { sinks_by_category })."),
        },
        async ({ category, reachable_only, max_depth, response_format }) => {
            try {
                const { byCategory, scanned, flowCount } = findTaintedSinks(db, {
                    category: category || null, reachableOnly: reachable_only, maxDepth: max_depth,
                });
                const total = Object.values(byCategory).reduce((s, a) => s + a.length, 0);
                if (response_format === 'json') {
                    return jsonResult({ category: category || null, reachable_only, scanned, sink_count: total, reachable_flow_count: flowCount, sinks_by_category: byCategory });
                }
                const lines = [`# 🎯 Dangerous sinks — ${total} (scanned ${scanned} chunks)`, ''];
                if (!total) lines.push('No sinks matched these filters.');
                for (const cat of CATEGORY_SEVERITY) {
                    const list = byCategory[cat];
                    if (!list || !list.length) continue;
                    const reached = list.filter(s => s.reached_by_source).length;
                    lines.push(`## ${cat.toUpperCase()} — ${list.length}${reached ? ` (${reached} reachable from untrusted input ⚠️)` : ''}`);
                    for (const s of list.slice(0, 25)) {
                        lines.push(`  - ${s.reached_by_source ? '⚠️ ' : ''}\`${s.label}\` in \`${s.file_path}\`:${s.line} — \`${s.name}\``);
                    }
                    if (list.length > 25) lines.push(`  …and ${list.length - 25} more`);
                    lines.push('');
                }
                lines.push('> Heuristic finder (JS/TS + Python). A flagged sink is a place to look, not a confirmed bug.');
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );
}
