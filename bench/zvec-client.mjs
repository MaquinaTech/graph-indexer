/**
 * zvec-grep (zg, https://github.com/zvec-ai/zvec-grep) as a system in the offline benchmarks
 * (bench/eval-localize.mjs --zvec, bench/eval-search.mjs --zvec). zg is driven through its own CLI
 * in direct mode, the way a user or agent runs it: `zg --index` builds or updates the workspace
 * index, `zg --hybrid <query>` is its default hybrid (BM25 + vector) search. The CLI has no JSON
 * output, so hits are read from `--preview none`, which prints one `#rank path:start-end` header
 * per hit.
 *
 * Install the 0.3.0 platform package without running its postinstall, e.g.
 *
 *   npm pack @zvec/zvec-grep-darwin-arm64@0.3.0 && tar -xzf zvec-zvec-grep-darwin-arm64-0.3.0.tgz
 *   # → package/bin/zg (checked against package/checksums.json)
 *
 * Embeddings. `--zvec-embedding` takes any model of `zg --help models` (default
 * local/qwen3-embedding-0.6b: zg downloads the GGUF and runs it with llama.cpp). With
 * `--zvec-upstream <url>` the same model is served by an OpenAI-compatible server instead: zg is
 * pointed at the catalog's remote slot (qwen/text-embedding-v4, 1024 dimensions, OpenAI wire
 * format) on a loopback proxy started here, which
 *   - renames the model to `--zvec-upstream-model` (default qwen3-embedding-0.6b),
 *   - formats inputs the way zg formats them for its local Qwen3 model (queries get
 *     "Instruct: Retrieve relevant documents for the given query\nQuery: …", documents nothing),
 *     since its remote slot sends raw text and Qwen3-Embedding needs the instruction on queries,
 *   - for an `http://` upstream, which must be on loopback (bench/embed-server.py serves
 *     Qwen3-Embedding-0.6B with MLX on this Mac: `python -I bench/embed-server.py --port 47812`),
 *     sends no key;
 *   - for an `https://` upstream, trusts the server's private CA (`--zvec-ca`) and adds the bearer
 *     key, read from the macOS Keychain (service `--zvec-key-service`, default MLXServer-API-key;
 *     account `--zvec-key-account`, default graph-indexer-bench). zg itself only ever sees a
 *     placeholder key, and the real one is never printed or logged.
 *
 * zg writes its index to <root>/.zvec-grep, so it is given its own copy or worktree of the
 * snapshot, never the fixture checkout or the directory graph-indexer indexes. zg runs as an async
 * child process (index() and search() return promises) so the proxy in this process can answer it.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const QWEN3_QUERY = (t) => `Instruct: Retrieve relevant documents for the given query\nQuery: ${t}`;

/** zvec options from the command line of a bench script (null without --zvec). */
export function zvecOptions(args, workDir) {
    const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
    const bin = opt('--zvec', null);
    if (!bin) return null;
    return {
        bin: path.resolve(bin),
        embedding: opt('--zvec-embedding', null),
        upstream: opt('--zvec-upstream', null),
        upstreamModel: opt('--zvec-upstream-model', 'qwen3-embedding-0.6b'),
        ca: opt('--zvec-ca', null),
        keyService: opt('--zvec-key-service', 'MLXServer-API-key'),
        keyAccount: opt('--zvec-key-account', 'graph-indexer-bench'),
        // fixed, because zg stores the endpoint in the workspace index and searches reuse it
        proxyPort: Number(opt('--zvec-proxy-port', 47811)),
        limit: Number(opt('--zvec-limit', 30)),
        codeOnly: args.includes('--zvec-code-only'),
        home: path.join(workDir, 'zvec-home'),
        cache: path.resolve(opt('--zvec-model-cache', path.join(workDir, 'zvec-models'))),
    };
}

/** Loopback proxy from zg's remote embedding slot to an OpenAI-compatible server (see header). */
export async function startProxy(o) {
    const target = new URL(o.upstream);
    // a plain-HTTP upstream must be on this Mac (bench/embed-server.py) and takes no key
    const local = target.protocol === 'http:';
    if (local && !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('a plain-HTTP upstream must be on loopback');
    let bearer = null;
    if (!local) {
        const key = spawnSync('security', ['find-generic-password', '-s', o.keyService, '-a', o.keyAccount, '-w'], { encoding: 'utf8' });
        if (key.status !== 0 || !key.stdout.trim()) throw new Error(`no Keychain item for service ${o.keyService}, account ${o.keyAccount} (store the server key there first)`);
        bearer = key.stdout.trim();
    }
    const ca = o.ca ? fs.readFileSync(o.ca) : undefined;
    const state = { mode: 'document', requests: 0, inputs: 0, errors: 0 };
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            // zg sends queries and documents alike, so the caller says which ones come next
            // (the agent bench: documents while it indexes a checkout, queries during the sessions)
            if (req.url === '/bench/mode') {
                const m = Buffer.concat(chunks).toString('utf8').trim();
                if (m === 'query' || m === 'document') { state.mode = m; res.writeHead(204).end(); } else res.writeHead(400).end();
                return;
            }
            let body;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
            const inputs = Array.isArray(body.input) ? body.input : [body.input];
            body.model = o.upstreamModel;
            body.input = state.mode === 'query' ? inputs.map(QWEN3_QUERY) : inputs;
            state.requests++; state.inputs += inputs.length;
            const payload = Buffer.from(JSON.stringify(body));
            const headers = { 'content-type': 'application/json', 'content-length': payload.length, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
            const up = (local ? http : https).request({
                hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || (local ? 80 : 443), path: target.pathname, method: 'POST', ca, timeout: 600_000, headers,
            }, (ur) => {
                if (ur.statusCode >= 400) state.errors++;
                res.writeHead(ur.statusCode, { 'content-type': ur.headers['content-type'] ?? 'application/json', ...(ur.headers['retry-after'] ? { 'retry-after': ur.headers['retry-after'] } : {}) });
                ur.pipe(res);
            });
            up.on('timeout', () => up.destroy(new Error('upstream timeout')));
            up.on('error', () => { state.errors++; if (!res.headersSent) res.writeHead(502); res.end(); });
            up.end(payload);
        });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(o.proxyPort ?? 47811, '127.0.0.1', resolve); });
    return { url: `http://127.0.0.1:${server.address().port}/v1/embeddings`, state, close: () => server.close() };
}

/**
 * A zg runner over one workspace root.
 *   index()      build or update the index (incremental: only changed files are re-embedded)
 *   search(q)    hits [{ rank, path, start, end }] of `zg --hybrid q`, best first
 */
export async function startZvec(o) {
    fs.mkdirSync(o.home, { recursive: true });
    fs.mkdirSync(o.cache, { recursive: true });
    const proxy = o.upstream ? await startProxy(o) : null;
    const embedding = o.embedding ?? (proxy ? 'qwen/text-embedding-v4' : 'local/qwen3-embedding-0.6b');
    const remote = proxy ? ['--api-key', 'via-bench-proxy', '--allow-remote'] : []; // search takes the endpoint stored by --index
    const env = { ...process.env, ZVEC_GREP_HOME: o.home, ZVEC_GREP_MODEL_CACHE: o.cache, ZVEC_GREP_MODE: 'direct', NO_COLOR: '1' };
    for (const k of ['ZVEC_GREP_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'ZVEC_GREP_ENDPOINT', 'ZVEC_GREP_EMBEDDING', 'ZVEC_GREP_SERVER_URL']) delete env[k];
    const zg = (root, a, timeout) => new Promise((resolve, reject) => {
        const child = spawn(o.bin, a, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
        child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) resolve(out);
            else reject(new Error(`zg ${a.slice(0, 2).join(' ')} in ${root} failed (${code ?? signal}): ${(err || out).trim().slice(-600)}`));
        });
    });
    return {
        embedding,
        proxy: proxy?.state ?? null,
        async index(root) {
            if (proxy) proxy.state.mode = 'document';
            const t = Date.now();
            const out = await zg(root, ['--index', root, '--embedding', embedding, '--mode', 'direct', '--color', 'never', ...(proxy ? ['--endpoint', proxy.url] : []), ...remote], 7_200_000);
            return { ms: Date.now() - t, summary: out.match(/^files\t.*$/m)?.[0] ?? '' };
        },
        async search(root, query, limit = o.limit) {
            if (proxy) proxy.state.mode = 'query';
            const a = ['--mode', 'direct', '--refresh', 'off', '--preview', 'none', '--color', 'never', '--limit', String(limit), ...(o.codeOnly ? ['--category', 'code'] : []), ...remote, '--hybrid', query];
            const out = await zg(root, a, 600_000);
            const hits = [];
            // `#rank path:start-end`, or `#rank path:line` for a one-line hit
            for (const m of out.matchAll(/^#(\d+)\s+(.+?):(\d+)(?:-(\d+))?\s*$/gm)) hits.push({ rank: Number(m[1]), path: m[2], start: Number(m[3]), end: Number(m[4] ?? m[3]) });
            return hits.sort((a, b) => a.rank - b.rank);
        },
        stop() { proxy?.close(); },
    };
}

/** Lines of [a1,b1] inside [a2,b2]. */
const overlap = (a1, b1, a2, b2) => Math.max(0, Math.min(b1, b2) - Math.max(a1, a2) + 1);

/**
 * graph-indexer symbols a zg hit stands for, in the index of the same snapshot. A hit counts for
 * the symbols it spans (at least half of a symbol's lines inside the hit, like the chunks 2.x
 * returns); a hit inside one symbol counts for the innermost symbol that holds most of it.
 * `kinds` restricts the symbols (e.g. callables for function-level localization).
 */
export function symbolsOfHit(store, hit, kinds = null) {
    const rows = store.all(`SELECT s.id, s.kind, s.start_line, s.end_line FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.path = ? AND s.start_line <= ? AND s.end_line >= ?${kinds ? ` AND s.kind IN (${kinds.map(() => '?').join(',')})` : ''} ORDER BY s.start_line, s.end_line DESC`,
    hit.path, hit.end, hit.start, ...(kinds ?? []));
    const spanned = rows.filter(r => overlap(r.start_line, r.end_line, hit.start, hit.end) * 2 >= r.end_line - r.start_line + 1);
    // the hit is one symbol (same range, give or take a decorator or doc line): that symbol only
    const iou = (r) => overlap(r.start_line, r.end_line, hit.start, hit.end) / (Math.max(r.end_line, hit.end) - Math.min(r.start_line, hit.start) + 1);
    const best = [...rows].sort((x, y) => iou(y) - iou(x) || (x.end_line - x.start_line) - (y.end_line - y.start_line))[0];
    if (best && iou(best) >= 0.8) return [best.id];
    if (spanned.length) return spanned.map(r => r.id);
    // a fragment inside a symbol: the innermost one holding most of it
    const holders = rows.filter(r => overlap(r.start_line, r.end_line, hit.start, hit.end) * 2 >= hit.end - hit.start + 1)
        .sort((x, y) => (x.end_line - x.start_line) - (y.end_line - y.start_line));
    return holders.length ? [holders[0].id] : [];
}

/** Ranked distinct files and symbols of a zg answer. */
export function rankHits(store, hits, kinds = null) {
    const files = [], ids = [];
    for (const h of hits) {
        if (!files.includes(h.path)) files.push(h.path);
        for (const id of symbolsOfHit(store, h, kinds)) if (!ids.includes(id)) ids.push(id);
    }
    return { files, ids };
}

/**
 * The proxy on its own, for agent sessions (bench/agentic, arm cc+zvec), whose zg MCP server embeds
 * queries through it while it runs. It formats inputs as queries unless told otherwise; the agent
 * bench switches it to documents (POST /bench/mode) while it indexes a checkout:
 *
 *   node bench/zvec-client.mjs proxy --zvec-upstream http://127.0.0.1:47812/v1/embeddings [--zvec-proxy-port 47811]
 *   node bench/zvec-client.mjs proxy --zvec-upstream https://HOST:PORT/v1/embeddings --zvec-ca CA.crt [--mode query|document]
 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname) && process.argv[2] === 'proxy') {
    const args = process.argv.slice(3);
    const o = zvecOptions(['--zvec', process.execPath, ...args], process.cwd());
    if (!o.upstream) throw new Error('--zvec-upstream is required');
    const p = await startProxy(o);
    const i = args.indexOf('--mode');
    p.state.mode = i >= 0 ? args[i + 1] : 'query';
    process.stderr.write(`zvec embedding proxy on ${p.url} (${p.state.mode} inputs) -> ${o.upstream}\n`);
    setInterval(() => process.stderr.write(`proxy: ${p.state.requests} requests, ${p.state.inputs} inputs, ${p.state.errors} errors\n`), 300_000).unref?.();
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { p.close(); process.exit(0); });
}
