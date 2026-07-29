#!/usr/bin/env node
/**
 * @file indexer.mjs
 * @description Bootstrap indexer. Walks a repository, extracts Tree-sitter AST
 *              chunks + cross-file topology, generates local embeddings (Ollama),
 *              optionally enriches the most central chunks with an LLM, and writes
 *              the index to the configured backend — the default in-memory JSON
 *              artifacts, or a disk-backed SQLite database (--use-sqlite).
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import path from 'path';
import { MAX_FILE_SIZE_BYTES, buildIgnoreFilter, extractImportsFromAST, extractSemanticChunks } from './parse/extractor.mjs';
import { EXTENSIONS, getParserForFile, ensureLanguagesReady } from './parse/languages.mjs';
import { extractRoutes } from './parse/routes.mjs';
import { resolveLocalImports, buildEmbeddingPayload, fullBodyForEmbedding } from './parse/imports.mjs';
import { readEmbeddingBinary, writeEmbeddingBinary } from './engine/binary.mjs';
import { embeddingKeyFor, summaryEmbeddingText, SUMMARY_VEC_SUFFIX, WINDOW_VEC_SUFFIX, embeddingWindows } from './search-core.mjs';
import { createEmbedder, describeEmbedder, readEmbedMeta, writeEmbedMeta, embedModelChanged, _resetSubprocesses } from './embeddings.mjs';
import { resolveConfig, describeConfig, configNotices } from './config.mjs';
import { AUTO_SQLITE_CHUNK_THRESHOLD } from './storage.mjs';
import { ensureDataDir, migrateLegacyLayout } from './layout.mjs';
import { enrichCoreChunks } from './enrichment.mjs';
import { collectGitSignals, writeGitSignals } from './git-signals.mjs';
import {
    installEgressGuard, sealManifest, signManifest, verifySignedManifest,
    generateAttestationKeyPair, canonicalJson, SealViolation,
} from './seal.mjs';

/** Value following `--flag` in argv, or undefined. */
function argVal(flag) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

// resolveConfig fail-closes on a sealed-incompatible config (throws SealViolation); surface it
// as a clean exit rather than an unhandled rejection.
let config;
try {
    config = resolveConfig();
} catch (err) {
    if (err && err.name === 'SealViolation') { console.error(`🔒 ${err.message}`); process.exit(2); }
    throw err;
}

// `idx-index --gen-attestation-key <prefix>`: write an Ed25519 keypair (<prefix>.key / <prefix>.pub)
// and exit. The private key is the signing key (keep safe); the public key is shared for verification.
{
    const prefix = argVal('--gen-attestation-key');
    if (prefix) {
        const { publicKey, privateKey } = generateAttestationKeyPair();
        fs.writeFileSync(`${prefix}.key`, privateKey, { mode: 0o600 });
        fs.writeFileSync(`${prefix}.pub`, publicKey);
        console.log(`🔑 Attestation keypair written: ${prefix}.key (private — keep safe) + ${prefix}.pub (share to verify).`);
        process.exit(0);
    }
}

// `idx-index --verify-attestation <file> --pub-key <path>`: verify a signed manifest's signature and,
// if authentic, report whether it MATCHES the current effective config. Exit 0 = valid + matching.
{
    const verifyFile = argVal('--verify-attestation');
    if (verifyFile) {
        let envelope;
        try { envelope = JSON.parse(fs.readFileSync(verifyFile, 'utf8')); }
        catch (e) { console.error(`❌ cannot read attestation ${verifyFile}: ${e.message}`); process.exit(3); }
        const pubPath = argVal('--pub-key');
        if (!pubPath) { console.error('❌ --verify-attestation requires --pub-key <path>'); process.exit(3); }
        let pubPem;
        try { pubPem = fs.readFileSync(pubPath, 'utf8'); }
        catch (e) { console.error(`❌ cannot read public key ${pubPath}: ${e.message}`); process.exit(3); }
        const res = verifySignedManifest(envelope, pubPem);
        if (!res.valid) { console.error(`❌ attestation INVALID: ${res.reason}`); process.exit(3); }
        console.log(`✅ attestation signature VALID (key ${res.publicKeyFingerprint}).`);
        const matches = canonicalJson(sealManifest(config)) === canonicalJson(envelope.manifest);
        if (matches) { console.log('✅ attested manifest MATCHES the current effective config.'); process.exit(0); }
        console.log('⚠️  attested manifest DIFFERS from the current effective config (policy drift):');
        console.log(`   attested: ${canonicalJson(envelope.manifest)}`);
        console.log(`   current : ${canonicalJson(sealManifest(config))}`);
        process.exit(3);
    }
}

// `idx-index --attest [--sign-key <path>]`: print the deterministic seal manifest (signed if a key
// is given) and exit (no indexing).
if (process.argv.includes('--attest')) {
    const manifest = sealManifest(config);
    const signKey = argVal('--sign-key');
    if (signKey) {
        let keyPem;
        try { keyPem = fs.readFileSync(signKey, 'utf8'); }
        catch (e) { console.error(`❌ cannot read signing key ${signKey}: ${e.message}`); process.exit(2); }
        try { console.log(JSON.stringify(signManifest(manifest, keyPem), null, 2)); }
        catch (e) { console.error(`❌ signing failed: ${e.message}`); process.exit(2); }
    } else {
        console.log(JSON.stringify(manifest, null, 2));
    }
    process.exit(0);
}

// F1: install the deny-by-default egress guard BEFORE any provider (embedder/enricher) loads, so
// even provider initialisation cannot reach the network under a sealed tier.
if (config.sealed !== 'off') {
    installEgressGuard({ allow: config.sealed === 'local' ? ['loopback'] : [] });
}

const PROJECT_ROOT = config.projectRoot;
const INDEX_PATH = config.indexPath;
const EMBEDDINGS_PATH = config.embeddingPath;

// Artifacts are written under <root>/.graph-indexer/ — make sure it exists and
// relocate any artifacts left at the root by a pre-v1.4 install.
ensureDataDir(PROJECT_ROOT);
migrateLegacyLayout(PROJECT_ROOT);

function walkRepo(dir, root, ig, files = []) {
    for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith('.')) continue;
        const fullPath = path.join(dir, entry);
        const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
        if (ig.ignores(relPath)) continue;
        if (fs.statSync(fullPath).isDirectory()) {
            walkRepo(fullPath, root, ig, files);
        } else if (EXTENSIONS.has(path.extname(fullPath))) {
            files.push(fullPath);
        }
    }
    return files;
}

async function main() {
    console.log(`\n🚀 Starting Optimized Indexer\n📂 Directory: ${PROJECT_ROOT}`);
    console.log('⚙️  Effective configuration:');
    for (const line of describeConfig(config)) console.log(`     ${line}`);
    for (const notice of configNotices(config)) console.log(`⚠️  ${notice}`);
    console.log('');

    // Grammar packages are installed on demand (not bundled) — resolve/install
    // whatever the configured languages need BEFORE walking the repo. Sealed mode
    // never reaches the network for this: installEgressGuard can't stop a child
    // `npm install` process, so autoInstall is explicitly off rather than relying
    // on the guard — and, matching the fail-closed egress checks elsewhere in
    // sealed mode, an unresolvable grammar refuses the run instead of silently
    // shipping a partial index.
    const { missing: missingGrammars } = await ensureLanguagesReady({
        projectRoot: PROJECT_ROOT,
        enabledLangs: config.languages,
        autoInstall: config.sealed === 'off',
        log: (msg) => console.log(msg),
    });
    if (config.sealed !== 'off' && missingGrammars.length > 0) {
        const detail = missingGrammars.map(m => `  • ${m.key} (${m.pkg}@${m.version})`).join('\n');
        throw new SealViolation(
            `--sealed ${config.sealed} refuses to start — ${missingGrammars.length} language grammar(s) `
            + `are not installed and sealed mode won't fetch them:\n${detail}\n`
            + `  remedy: pre-install before sealing, e.g. npm install --prefix ${path.join(PROJECT_ROOT, '.graph-indexer')} `
            + `${missingGrammars.map(m => `${m.pkg}@${m.version}`).join(' ')}`
            + ` — or drop the language from your .graph-indexer.json "languages" selection`
        );
    }

    const ig = buildIgnoreFilter(PROJECT_ROOT);
    const files = walkRepo(PROJECT_ROOT, PROJECT_ROOT, ig);
    console.log(`Found ${files.length} files to analyse.\n`);

    // Resolve the embedding provider for this run (Ollama → in-process local →
    // lexical, unless forced). Index time and query time must share the model.
    const embedder = await createEmbedder(config);
    console.log(`🔎 Embeddings: ${describeEmbedder(embedder)}`);
    // Make the `auto` fallback ladder observable — never silently lexical-only.
    if (config.embedProvider === 'auto') {
        if (embedder.provider === 'local') {
            console.log(`   ↪ Ollama not reachable at ${config.ollamaHost}; using the bundled in-process model (no daemon required).`);
        } else if (embedder.provider === 'off') {
            console.log(`   ↪ No Ollama and no in-process model installed (\`npm run embed:setup:local\`) — indexing lexical-only.`);
        }
    }
    console.log('');

    let existingCache = readEmbeddingBinary(EMBEDDINGS_PATH);
    // A model switch invalidates the cached vectors — vectors of different models
    // (and dims) must never be mixed in one bin. Re-embed from scratch. (e.g. switching
    // `--embed-provider local` → `code-local`: 384-dim MiniLM → 768-dim jina-code.)
    const prevMeta = readEmbedMeta(EMBEDDINGS_PATH);
    if (embedModelChanged(prevMeta, embedder.model)) {
        console.log(`⚠️  Embedding model changed (${prevMeta.model} → ${embedder.model}); re-embedding from scratch.`);
        existingCache = new Map();
    }
    console.log(`📦 Loaded ${existingCache.size} cached embeddings from previous runs.\n`);

    const indexData = { chunks: [], graph: { dependencies: {}, importedBy: {}, routes: [] }, embeddingCache: {} };
    const pendingChunks = [];
    // Full bodies of oversized chunks (snippet was truncated by the 3000-char cap),
    // captured here while we still hold the source so the dense channel can window the
    // WHOLE definition. Kept out of the chunk/JSON — transient, dropped after embedding.
    const fullBodies = new Map();
    let totalCheckedFiles = 0;

    for (const absolutePath of files) {
        totalCheckedFiles++;
        const relPath = path.relative(PROJECT_ROOT, absolutePath).replace(/\\/g, '/');
        process.stdout.write(`\r⚡ Parsing AST: [${totalCheckedFiles}/${files.length}] Processing: ${relPath.slice(-40)}                 `);

        if (relPath.includes('.bundle.') || relPath.includes('.min.')) continue;

        try {
            const stats = await fs.promises.stat(absolutePath);
            if (stats.size > MAX_FILE_SIZE_BYTES) continue;

            const content = await fs.promises.readFile(absolutePath, 'utf-8');
            if (!content.trim()) continue;

            const ext = path.extname(absolutePath);
            const parser = getParserForFile(ext);
            if (!parser) continue;

            const tree = parser.parse((offset) => offset < content.length ? content.slice(offset, offset + 4096) : null);
            const rawImports = extractImportsFromAST(tree.rootNode, ext);
            const imports = resolveLocalImports(rawImports, relPath, PROJECT_ROOT);
            indexData.graph.dependencies[relPath] = imports;

                    const fileChunks = extractSemanticChunks(tree.rootNode, relPath, content, ext, { interprocedural: config.interprocedural });
            for (const chunk of fileChunks) {
                const fullBody = fullBodyForEmbedding(chunk, content);
                if (fullBody) fullBodies.set(chunk.id, fullBody);
                pendingChunks.push(chunk);
            }

            for (const route of extractRoutes(tree.rootNode, relPath, fileChunks, ext)) {
                indexData.graph.routes.push(route);
            }
        } catch (err) {
            console.error(`\n💥 Error in ${relPath}: ${err.message}`);
        }
    }

    // Opt-in inter-procedural receiver-type fixpoint (--interprocedural): propagate return
    // types along factory call chains so multi-hop receivers resolve. Runs ONCE over the whole
    // program here, while every chunk's return_via / call_sites are known, and writes
    // recv_resolved_type into call_sites (serialized identically by both backends). Strips the
    // transient _return_via. Off by default → chunks/index byte-identical.
    if (config.interprocedural) {
        const { applyInterprocedural } = await import('./parse/interprocedural.mjs');
        applyInterprocedural(pendingChunks);
        console.log('🔗 Inter-procedural receiver types resolved (factory return-type propagation).');
    }

    // Enrichment runs before embedding so hypothetical questions share the same vector space.
    if (config.enrichment.enabled) {
        await enrichCoreChunks(pendingChunks, indexData.graph, config);
    }

    // ── Embedding generation (cache-aware) ────────────────────────────────────────
    // Vectors are keyed by embeddingKeyFor(chunk), which includes an enrichment
    // digest so enriched chunks hit the cache on re-runs (previously they were
    // re-embedded on every run).
    const toEmbed = [];
    for (const chunk of pendingChunks) {
        const vecKey = embeddingKeyFor(chunk);
        const sKey = vecKey + SUMMARY_VEC_SUFFIX;
        // Compute the payload once here and reuse it in the worker to avoid a second build.
        const payload = buildEmbeddingPayload(chunk, indexData.graph.dependencies[chunk.file_path] || [], fullBodies.get(chunk.id) || null);
        const windows = embeddingWindows(payload);
        // Indexes built before dual/window vectors only have the base key, so we must
        // check that summary and window keys are also cached before skipping embedding.
        const summaryMissing = summaryEmbeddingText(chunk) && !existingCache.has(sKey);
        let windowsMissing = false;
        for (let i = 1; i < windows.length; i++) if (!existingCache.has(vecKey + WINDOW_VEC_SUFFIX + i)) { windowsMissing = true; break; }
        if (existingCache.has(vecKey) && !summaryMissing && !windowsMissing) {
            indexData.embeddingCache[vecKey] = Array.from(existingCache.get(vecKey));
            if (existingCache.has(sKey)) indexData.embeddingCache[sKey] = Array.from(existingCache.get(sKey));
            for (let i = 1; i < windows.length; i++) {
                const wk = vecKey + WINDOW_VEC_SUFFIX + i;
                if (existingCache.has(wk)) indexData.embeddingCache[wk] = Array.from(existingCache.get(wk));
            }
            indexData.chunks.push(chunk);
        } else {
            toEmbed.push({ chunk, payload, windows });
        }
    }

    console.log(`\n\n🧠 Embedding Generation — ${describeEmbedder(embedder)}`);
    console.log(`Chunks reused from cache: ${indexData.chunks.length}`);
    console.log(`New chunks to process: ${toEmbed.length}`);

    if (toEmbed.length > 0) {
        const BATCH_SIZE = 64;
        // Embedding concurrency. A single local Ollama model serves requests
        // serially, so a high fan-out just queues batches and risks per-request
        // timeouts (a large model like qwen3-embedding:4b made every queued batch
        // breach the old cap). Default 4 (fast on small models / when
        // OLLAMA_NUM_PARALLEL is set); lower it (e.g. 1) for big models on modest
        // hardware via INDEXER_EMBED_CONCURRENCY.
        const CONCURRENCY = Number(process.env.INDEXER_EMBED_CONCURRENCY) > 0
            ? Number(process.env.INDEXER_EMBED_CONCURRENCY) : 4;
        const batches = [];
        for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) batches.push(toEmbed.slice(i, i + BATCH_SIZE));

        let completed = 0, vectorBatches = 0, failedBatches = 0;
        console.time('Embedding Generation Duration');
        const worker = async (batch) => {
            // Oversized chunks need window vectors so semantic search can reach
            // their tail (the embedder truncates the base text to window 0 only).
            // Enriched chunks also get a compact summary vector whose vocabulary
            // matches natural-language queries.
            const entries = [];
            for (const { chunk: c, payload, windows } of batch) {
                const baseKey = embeddingKeyFor(c);
                entries.push({ key: baseKey, text: payload });
                for (let i = 1; i < windows.length; i++) entries.push({ key: baseKey + WINDOW_VEC_SUFFIX + i, text: windows[i] });
                const sText = summaryEmbeddingText(c);
                if (sText) entries.push({ key: baseKey + SUMMARY_VEC_SUFFIX, text: sText });
            }
            // Per-batch graceful degradation: a slow/failed embedding batch (e.g. a
            // timeout on a big model) must NOT abort the whole index. Those chunks
            // are still indexed lexically — they just miss their vector until the
            // next run re-tries them (the cache only stores what succeeded).
            let matrix = null;
            try { matrix = await embedder.embedDocuments(entries.map(e => e.text)); }
            catch (e) { failedBatches++; process.stderr.write(`\n⚠️  embedding batch failed (${e.message}); indexing ${batch.length} chunks lexical-only this run.\n`); }
            if (matrix && matrix.length === entries.length) {
                for (let j = 0; j < entries.length; j++) {
                    indexData.embeddingCache[entries[j].key] = matrix[j];
                }
                vectorBatches++;
            }
            for (const { chunk } of batch) indexData.chunks.push(chunk);
            completed += batch.length;
            process.stdout.write(`\r🤖 Embedding Progress: [${completed}/${toEmbed.length}] Chunks processed...`);
        };
        for (let i = 0; i < batches.length; i += CONCURRENCY) {
            await Promise.all(batches.slice(i, i + CONCURRENCY).map(worker));
        }
        console.timeEnd('Embedding Generation Duration');
        if (failedBatches > 0) {
            console.log(`⚠️  ${failedBatches}/${batches.length} embedding batches failed (lexical-only for those chunks); re-run to fill them in. `
                + `Tip: a large embed model on modest hardware wants INDEXER_EMBED_CONCURRENCY=1 and/or a higher INDEXER_EMBED_TIMEOUT_MS.`);
        }
    }

    for (const [filePath, imports] of Object.entries(indexData.graph.dependencies)) {
        for (const dep of imports) {
            if (!indexData.graph.importedBy[dep]) indexData.graph.importedBy[dep] = [];
            if (!indexData.graph.importedBy[dep].includes(filePath)) indexData.graph.importedBy[dep].push(filePath);
        }
    }

    // Opt-in resolved symbol graph (--symbol-graph): build the chunk→chunk edge set ONCE
    // over the finalized chunks (reusing the query-time resolvers, so confidence matches
    // get_call_graph). Serialized into the index for both backends → getEdges. Built via a
    // throwaway in-memory store so it sees the same resolution the MCP server will.
    let symbolEdges = null;
    let centrality = null;
    let scipReferers = null;     // A2 v2: SCIP precise cross-file references for find_references
    if (config.symbolGraph) {
        const tmpSg = path.join(config.dataDir, '_symbolgraph-build.json');
        try {
            fs.writeFileSync(tmpSg, JSON.stringify({ chunks: indexData.chunks, graph: indexData.graph }));
            const { MemoryGraphIndex } = await import('./engine/memory.mjs');
            const { buildSymbolGraph } = await import('./mcp/symbolgraph.mjs');
            const { getResolver, createScipResolver } = await import('./mcp/resolver.mjs');
            const { computeSymbolCentrality } = await import('./mcp/centrality.mjs');
            const sgIdx = new MemoryGraphIndex(tmpSg, { cacheEmbeddings: false });
            sgIdx.load();
            // A2: a 'scip' resolver ingests a locally-generated SCIP index and resolves edges by
            // real cross-file bindings (promote confirmed → `resolved`, suppress wrong-target
            // fan-out). Missing/unreadable index → fall back to heuristic (never worse, loud).
            let resolver = getResolver(config.resolver);
            let scipStats = null;
            if (config.resolver === 'scip') {
                if (!config.scipIndex) {
                    console.warn('⚠️  --resolver scip without --scip-index — no SCIP index to read; '
                        + 'falling back to heuristic resolver.');
                    resolver = getResolver('heuristic');
                } else {
                    try {
                        const { loadScip, buildScipBindings, buildScipReferers } = await import('./parse/scip.mjs');
                        const aligned = buildScipBindings(sgIdx, loadScip(config.scipIndex));
                        scipStats = aligned.stats;
                        resolver = createScipResolver(aligned.bindings, aligned.definedChunks);
                        // A2 v2: invert the same bindings into the precise cross-file "referenced-by"
                        // map find_references consumes (kind-agnostic, sound, isolated artifact).
                        const refs = buildScipReferers(aligned.bindings);
                        if (Object.keys(refs).length) scipReferers = refs;
                        if (scipStats.matchedDocs === 0) {
                            console.warn(`⚠️  SCIP index matched 0 of ${scipStats.docs} document(s) to indexed `
                                + `files (${config.scipIndex}) — check the path / project_root. Resolver is `
                                + 'effectively inert (edges stay heuristic { high, name_only }).');
                        }
                    } catch (e) {
                        console.warn(`⚠️  SCIP load failed (${e.message}); falling back to heuristic resolver.`);
                        resolver = getResolver('heuristic');
                    }
                }
            }
            const res = buildSymbolGraph(sgIdx, { resolver });
            symbolEdges = res.edges;
            sgIdx.close?.();
            const isPreciseTier = config.resolver === 'precise' || (config.resolver === 'scip' && scipStats);
            const resolvedCount = isPreciseTier
                ? symbolEdges.filter(e => e.confidence === 'resolved').length : 0;
            console.log(`🕸  Symbol graph: ${symbolEdges.length} resolved edges`
                + `${config.resolver === 'precise' ? ` · resolver=precise (${resolvedCount} resolved-tier)` : ''}`
                + `${(config.resolver === 'scip' && scipStats) ? ` · resolver=scip (${resolvedCount} resolved-tier; `
                    + `${scipStats.matchedDocs}/${scipStats.docs} docs matched, ${scipStats.bindingPairs} bindings)` : ''}`
                + `${res.cappedNames.length ? ` (⚠️ ${res.cappedNames.length} high-degree name(s) capped: ${res.cappedNames.slice(0, 5).join(', ')})` : ''}.`);
            // A5: confidence-weighted PageRank over those edges (computed once → serialized →
            // parity-free). Surfaced by explain_symbol / get_repo_map; does not touch ranking.
            const cen = computeSymbolCentrality(symbolEdges);
            centrality = cen.total ? cen.centrality : null;
            if (centrality) console.log(`📊 Centrality: ranked ${cen.total} connected symbols (PageRank, ${cen.iters} iters).`);
            // A2 v2: precise cross-file references (find_references `resolved` tier), serialized
            // as an isolated artifact alongside the graph.
            if (scipReferers) {
                const pairs = Object.values(scipReferers).reduce((s, a) => s + a.length, 0);
                console.log(`🎯 SCIP references: ${Object.keys(scipReferers).length} definitions referenced (${pairs} precise referer pairs).`);
            }
        } finally {
            try { fs.unlinkSync(tmpSg); } catch { /* none */ }
        }
    }

    // C2: opt-in index-time taint serialization. Compute the full flow set once — against the
    // symbol-graph edges when present (cross-function precision), else chunk.calls — and serialize
    // it so trace_taint / find_tainted_sinks answer instantly. Like edges/centrality: computed once
    // → both backends serve byte-identical flows (parity-free).
    let taintPayload = null;
    if (config.taint) {
        const tmpT = path.join(config.dataDir, '_taint-build.json');
        try {
            fs.writeFileSync(tmpT, JSON.stringify({
                chunks: indexData.chunks, graph: indexData.graph,
                ...(symbolEdges ? { edges: symbolEdges } : {}),
            }));
            const { MemoryGraphIndex } = await import('./engine/memory.mjs');
            const { computeTaintCache } = await import('./mcp/taint.mjs');
            const tIdx = new MemoryGraphIndex(tmpT, { cacheEmbeddings: false });
            tIdx.load();
            taintPayload = computeTaintCache(tIdx, { maxDepth: 4 });
            tIdx.close?.();
            console.log(`🧪 Taint: ${taintPayload.flows.length} flows precomputed `
                + `(${taintPayload.meta.sources} sources, ${taintPayload.meta.sinks} sinks, depth ${taintPayload.meta.maxDepth}).`);
        } finally {
            try { fs.unlinkSync(tmpT); } catch { /* none */ }
        }
    }

    // B3: opt-in learned-sparse model. Learn the corpus co-occurrence (PMI) association model once
    // and serialize it (isolated artifact, like centrality/taint); searchHybrid then adds an NL-only
    // vocabulary-expansion channel. Zero new dependency, fully air-gapped; default index
    // byte-identical (no model unless --learned-sparse).
    let sparseModel = null;
    if (config.learnedSparse) {
        const { buildSparseModel } = await import('./search-sparse.mjs');
        sparseModel = buildSparseModel(indexData.chunks);
        if (sparseModel) {
            console.log(`🧩 Learned-sparse: ${sparseModel.meta.terms} terms · ${sparseModel.meta.pairs} associations `
                + `(PMI over ${sparseModel.meta.docs} chunks).`);
        } else {
            console.log('🧩 Learned-sparse: no association signal in this corpus — model omitted (channel inert).');
        }
    }

    // Resolve 'auto' now that the true chunk count is known — the threshold is only
    // meaningful after all chunks have been extracted.
    const backend = config.storage === 'auto'
        ? (indexData.chunks.length >= AUTO_SQLITE_CHUNK_THRESHOLD ? 'sqlite' : 'memory')
        : config.storage;
    if (config.storage === 'auto') {
        console.log(`🗄  Storage: auto → ${backend} (${indexData.chunks.length} chunks, threshold ${AUTO_SQLITE_CHUNK_THRESHOLD}).`);
    }

    if (backend === 'sqlite') {
        const { SqliteGraphStore } = await import('./engine/sqlite.mjs');
        const store = new SqliteGraphStore(config.sqlitePath, { embeddingPath: EMBEDDINGS_PATH });
        const res = store.buildFrom({
            chunks: indexData.chunks, graph: indexData.graph, embeddingCache: indexData.embeddingCache,
            edges: symbolEdges, centrality, taint: taintPayload, scipRefs: scipReferers,
            sparseModel,
        });
        store.close?.();
        for (const p of [INDEX_PATH, `${INDEX_PATH}.tmp`]) { try { fs.unlinkSync(p); } catch { /* none */ } }
        console.log(`\n🎉 SQLite index built: ${res.chunks} chunks · ${res.terms} terms · dim ${res.dim}`);
        console.log(`   → ${config.sqlitePath}\n`);
    } else {
        const tmpPath = `${INDEX_PATH}.tmp`;
        const tmpBinPath = `${EMBEDDINGS_PATH}.tmp`;
        await Promise.all([
            fs.promises.writeFile(tmpPath, JSON.stringify({
                chunks: indexData.chunks, graph: indexData.graph,
                ...(symbolEdges ? { edges: symbolEdges } : {}),
                ...(centrality ? { centrality } : {}),
                ...(taintPayload ? { taint: taintPayload } : {}),
                ...(scipReferers ? { scip_refs: scipReferers } : {}),
                ...(sparseModel ? { sparse_model: sparseModel } : {}),
            })),
            fs.promises.writeFile(tmpBinPath, writeEmbeddingBinary(indexData.embeddingCache)),
        ]);
        await Promise.all([
            fs.promises.rename(tmpPath, INDEX_PATH),
            fs.promises.rename(tmpBinPath, EMBEDDINGS_PATH),
        ]);
        for (const p of [config.sqlitePath, `${config.sqlitePath}-wal`, `${config.sqlitePath}-shm`]) {
            try { fs.unlinkSync(p); } catch { /* none */ }
        }
        if (indexData.chunks.length === 0) {
            console.log(`\n⚠️  Indexing finished but produced 0 chunks — no indexable definitions found under ${PROJECT_ROOT}.`);
            console.log(`   Check the --repo path is correct and contains supported languages (see README), and note that trivial one-line definitions are intentionally skipped.\n`);
        } else {
            console.log(`\n🎉 Indexing complete. Total fragments: ${indexData.chunks.length}\n`);
        }
    }

    // Stamp which model produced the shared embeddings bin, so the server queries
    // with the same provider and the next index run detects a model switch.
    writeEmbedMeta(EMBEDDINGS_PATH, {
        provider: embedder.provider,
        model: embedder.model,
        dim: embedder.dim ?? prevMeta?.dim ?? null,
    });

    // Git signals are a sidecar kept out of the main index so they don't affect
    // measured retrieval ranking — only opt-in tools consume them.
    if (config.gitSignals) {
        const signals = collectGitSignals(PROJECT_ROOT);
        if (signals) {
            writeGitSignals(config.gitSignalsPath, signals);
            console.log(`🔄 Git signals: ${signals.commits} commits · ${Object.keys(signals.churn).length} files (churn/recency/co-change).\n`);
        } else {
            // Drop any stale sidecar so signals from a previous run don't linger.
            try { fs.unlinkSync(config.gitSignalsPath); } catch { /* none to remove */ }
        }
    }

    // Kill any subprocess-based embedder (MLX) so the event loop can drain.
    // Without this the readline interface on proc.stdout keeps Node alive indefinitely.
    _resetSubprocesses();
}

main().catch((err) => {
    if (err && err.name === 'SealViolation') { console.error(`🔒 ${err.message}`); process.exit(2); }
    console.error(err);
    process.exit(1);
});
