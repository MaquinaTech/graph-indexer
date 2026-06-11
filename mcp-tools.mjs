/**
 * @file mcp-tools.mjs
 * @description MCP tool definitions for graph-indexer. Every tool is written
 *              against the storage contract (see storage.mjs) — never a concrete
 *              backend — so the identical surface serves both the in-memory engine
 *              and the disk-backed SQLite store. `registerTools(server, db, opts)`
 *              wires them onto an McpServer instance.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { z } from 'zod';
import fs from 'fs';
import path, { resolve } from 'path';
import { computePageRank, isNaturalLanguageQuery } from './search-core.mjs';
import { getLocalEmbedding, getParserForFile, extractFileSkeleton } from './parser-utils.mjs';
import { rerankResults, ollamaGenerate } from './enrichment.mjs';

// ─── Rendering helpers ──────────────────────────────────────────────────────────

/** Extract just the function signature (first lines up to the opening brace). */
export function extractSignatureLine(codeSnippet) {
    if (!codeSnippet) return '';
    const lines = codeSnippet.split('\n');
    const sigLines = [];
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
        sigLines.push(lines[i]);
        const l = lines[i];
        if (i > 0 && (l.trimEnd().endsWith('{') || l.includes('=>') || l.trimEnd().endsWith(':'))) break;
    }
    return sigLines.join('\n');
}

/**
 * Prune a function body: keep signature + query-relevant lines + tail.
 *
 * Semantic fallback: when no lexical token matches (the agent used a high-level
 * description like "authentication bottleneck" that isn't in the code verbatim),
 * preserve the structural skeleton — control-flow lines and calls — rather than
 * blindly truncating, so 'smart' detail always returns meaningful context.
 */
export function pruneBodyByQuery(codeSnippet, queryTokens, maxLines = 40) {
    if (!codeSnippet) return '';
    const lines = codeSnippet.split('\n');
    if (lines.length <= maxLines) return codeSnippet;

    const querySet = new Set(queryTokens.filter(t => t.length >= 3).map(t => t.toLowerCase()));
    if (querySet.size === 0) return lines.slice(0, maxLines).join('\n') + '\n// …';

    const SIG_LINES = Math.min(5, lines.length);
    const TAIL_LINES = Math.min(3, lines.length);
    const sigBlock = lines.slice(0, SIG_LINES);
    const tailBlock = lines.slice(Math.max(lines.length - TAIL_LINES, SIG_LINES));

    const bodyLines = lines.slice(SIG_LINES, lines.length - TAIL_LINES);
    const relevant = bodyLines.filter(line => {
        const ll = line.toLowerCase();
        if (/^\s*(return|throw|raise|yield)\b/.test(ll)) return true;
        return [...querySet].some(token => ll.includes(token));
    });

    if (relevant.length === 0) {
        const budget = Math.max(4, maxLines - SIG_LINES - TAIL_LINES);
        const structural = bodyLines.filter(line => {
            const ll = line.trimStart().toLowerCase();
            if (/^(if |else |for |while |switch |try |catch |finally |return |throw |raise |yield |await )/.test(ll)) return true;
            if (/[a-zA-Z_]\w*\s*\(/.test(line) && line.trim().length > 4) return true;
            return false;
        }).slice(0, budget);
        if (structural.length > 0) return [...sigBlock, ...structural, ...tailBlock].join('\n');
        return lines.slice(0, maxLines).join('\n') + '\n// …';
    }
    return [...sigBlock, ...relevant, ...tailBlock].join('\n');
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
 * @param {string} [opts.ollamaHost]      Resolved Ollama endpoint for query embedding.
 * @param {string} [opts.embedModel]      Embedding model (must match the index).
 * @param {{enabled:boolean, model:string, topM:number}} [opts.rerank] LLM rerank config.
 */
export function registerTools(server, db, { projectRoot, artifactPath, pidFile, embeddingsEnabled, ollamaHost, embedModel, rerank }) {

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
        },
        async ({ query, exact_tokens, include_topology, min_score, top_k, token_budget, detail, rerank: rerankParam }) => {
            try {
                const fullQuery = exact_tokens ? `${query} ${exact_tokens}` : query;
                let queryVector = null;
                try { queryVector = await getLocalEmbedding(fullQuery, true, { ollamaHost, model: embedModel }); }
                catch { /* lexical fallback */ }

                let matches = db.searchHybrid(fullQuery, queryVector, top_k, min_score, exact_tokens || null);

                // Opt-in LLM rerank: only for natural-language queries (symbol
                // lookups are already rank-1-dominant), never when the caller
                // pinned an exact symbol. Best-effort — order is preserved on
                // any model failure.
                const wantRerank = rerankParam ?? Boolean(rerank?.enabled);
                if (wantRerank && !exact_tokens && matches.length > 1 && isNaturalLanguageQuery(fullQuery)) {
                    matches = await rerankResults(fullQuery, matches, {
                        topM: rerank?.topM ?? 8,
                        generate: (prompt) => ollamaGenerate(prompt, {
                            model: rerank?.model || 'qwen2.5-coder:7b',
                            ollamaHost, timeoutMs: 20000,
                            options: { temperature: 0, num_predict: 40 },
                        }),
                    });
                }
                if (matches.length === 0) return { content: [{ type: 'text', text: 'No results found.' }] };

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
        },
        async ({ chunk_id, view }) => {
            try {
                const chunk = db.getChunk(chunk_id);
                if (!chunk) return { content: [{ type: 'text', text: `Chunk '${chunk_id}' not found. Run search_code to get valid IDs.` }] };

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
        { symbol: z.string().describe("Exact symbol name (e.g. 'validateToken', 'User', 'PaymentService').") },
        async ({ symbol }) => {
            try {
                const defs = db.resolveSymbol(symbol);
                if (defs.length === 0) {
                    return { content: [{ type: 'text', text: `Symbol '${symbol}' not in index. Try search_code(query="${symbol}") for fuzzy search.` }] };
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
        },
        async ({ chunk_id, expand_calls }) => {
            try {
                const chunk = db.getChunk(chunk_id);
                if (!chunk) return { content: [{ type: 'text', text: `Chunk '${chunk_id}' not found.` }] };

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
        { file_path: z.string().describe("Relative path (e.g. 'src/app.ts').") },
        async ({ file_path }) => {
            try {
                const absolutePath = resolve(projectRoot, file_path);
                const safeRoot = path.normalize(projectRoot);
                if (!path.normalize(absolutePath).startsWith(safeRoot + path.sep) &&
                    path.normalize(absolutePath) !== safeRoot) {
                    throw new Error('Access denied: path is outside the project root.');
                }
                if (!fs.existsSync(absolutePath)) throw new Error('File not found.');
                const content = fs.readFileSync(absolutePath, 'utf-8');
                const ext = path.extname(absolutePath);
                const parser = getParserForFile(ext);
                if (!parser) return { content: [{ type: 'text', text: 'Language not supported.' }] };
                const tree = parser.parse((offset) => offset < content.length ? content.slice(offset, offset + 4096) : null);
                const skeleton = extractFileSkeleton(tree.rootNode, content);
                return { content: [{ type: 'text', text: `# Skeleton: ${file_path}\n\n${skeleton || '_No semantic signatures found_'}` }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );

    // ─── get_call_graph ─────────────────────────────────────────────────────────
    server.tool(
        'get_call_graph',
        'Finds all chunks that call a specific function. CRITICAL for safe refactoring.',
        { target_function: z.string().describe("Exact function name (e.g. 'validateToken').") },
        async ({ target_function }) => {
            try {
                const callers = db.findCallers(target_function).map(chunk =>
                    `- [${chunk.node_type}] \`${chunk.name}\` in \`${chunk.file_path}\` (lines ${chunk.start_line}–${chunk.end_line})`
                );
                if (callers.length === 0) {
                    return { content: [{ type: 'text', text: `✅ Safe to modify: no callers of '${target_function}' found.` }] };
                }
                return {
                    content: [{
                        type: 'text', text: [
                            `# ⚠️ Call Graph: \`${target_function}\``,
                            `${callers.length} caller(s) depend on this — review before changing signature:`,
                            ...callers,
                        ].join('\n')
                    }]
                };
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
        },
        async ({ path_filter, max_files, sort_by }) => {
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
                    return {
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
                const lines = [
                    `# Repo Map — ${totalSymbols} symbols across ${totalFiles} files`,
                    path_filter ? `(filtered to '${path_filter}')` : '',
                    sortedFiles.length < totalFiles ? `(showing top ${sortedFiles.length} by ${sort_by}; use path_filter to narrow)\n` : '',
                ].filter(Boolean);

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
        {},
        async () => {
            try {
                const s = db.stats();

                let indexAge = 'unknown';
                try {
                    const ageSec = Math.floor((Date.now() - fs.statSync(artifactPath).mtimeMs) / 1000);
                    indexAge = ageSec < 60 ? `${ageSec}s ago` : ageSec < 3600 ? `${Math.floor(ageSec / 60)}m ago` : `${Math.floor(ageSec / 3600)}h ago`;
                } catch { }

                let daemonStatus = 'not running';
                try {
                    if (pidFile && fs.existsSync(pidFile)) {
                        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
                        process.kill(pid, 0);
                        daemonStatus = `running (PID: ${pid})`;
                    }
                } catch { daemonStatus = 'not running (stale PID)'; }

                const searchMode = !embeddingsEnabled
                    ? '🔤 Lexical only (INDEXER_EMBEDDINGS=off)'
                    : s.hasVectors
                        ? `🧠 Hybrid (semantic + lexical RRF) — vectors: ${s.vectorSource}`
                        : '🔤 Lexical only (Ollama unavailable or not yet indexed)';

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
                    `| **Daemon** | ${daemonStatus} |`,
                    `| **Index age** | ${indexAge} |`,
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
}
