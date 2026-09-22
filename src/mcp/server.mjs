/**
 * Minimal, dependency-free MCP server over stdio (newline-delimited JSON-RPC 2.0).
 *
 * Supports both protocol generations:
 *   - handshake-based (2024-11-05 … 2025-11-25): initialize → notifications/initialized → requests
 *   - stateless 2026-07-28: every request carries `_meta["io.modelcontextprotocol/protocolVersion"]`
 *     and `server/discover` advertises versions, capabilities and instructions.
 * Only tools are exposed (all read-only). stdout carries protocol messages exclusively; logs go to stderr.
 */
import readline from 'node:readline';
import { TOOLS, SERVER_INSTRUCTIONS, callTool } from './tools.mjs';

export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_HANDSHAKE = '2025-11-25';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

export class McpServer {
    constructor({ intel, name = 'graph-indexer', version = '0.0.0', log = () => {}, ready = Promise.resolve() }) {
        this.intel = intel;
        this.info = { name, version };
        this.log = log;
        this.ready = ready;            // resolves when the initial index is usable
        this.negotiated = null;
        this.cancelled = new Set();
        this.inflight = 0;
        this.out = process.stdout;
    }

    listen(input = process.stdin, output = process.stdout) {
        this.out = output;
        const rl = readline.createInterface({ input, crlfDelay: Infinity });
        rl.on('line', (line) => {
            const text = line.trim();
            if (!text) return;
            let msg;
            try { msg = JSON.parse(text); } catch { this.#send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
            if (Array.isArray(msg)) { for (const m of msg) this.#handle(m); } else this.#handle(msg);
        });
        rl.on('close', () => this.onClose?.());
        return this;
    }

    #send(obj) { this.out.write(JSON.stringify(obj) + '\n'); }
    #result(id, result) { if (id !== undefined && id !== null && !this.cancelled.has(id)) this.#send({ jsonrpc: '2.0', id, result }); this.cancelled.delete(id); }
    #error(id, code, message, data) { if (id !== undefined) this.#send({ jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } }); }

    #requestVersion(params) {
        return params?._meta?.[META_VERSION] ?? this.negotiated ?? null;
    }

    async #handle(msg) {
        if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
            if (msg && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) return; // response to us (unused)
            this.#error(msg?.id ?? null, -32600, 'Invalid Request');
            return;
        }
        const { id, method, params } = msg;
        const isNotification = id === undefined;
        if (method === 'notifications/cancelled') { if (params?.requestId !== undefined) this.cancelled.add(params.requestId); return; }
        if (isNotification) return; // initialized, progress, roots/list_changed, …

        const reqVersion = params?._meta?.[META_VERSION];
        if (reqVersion && !SUPPORTED_VERSIONS.includes(reqVersion) && method !== 'initialize') {
            this.#error(id, -32022, `Unsupported protocol version: ${reqVersion}`, { supported: SUPPORTED_VERSIONS, requested: reqVersion });
            return;
        }
        try {
            switch (method) {
                case 'initialize': {
                    const requested = params?.protocolVersion;
                    const version = SUPPORTED_VERSIONS.includes(requested) && requested !== '2026-07-28' ? requested : LATEST_HANDSHAKE;
                    this.negotiated = version;
                    this.#result(id, {
                        protocolVersion: version,
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: { ...this.info, title: 'graph-indexer — code graph & search' },
                        instructions: SERVER_INSTRUCTIONS,
                    });
                    return;
                }
                case 'server/discover':
                    this.#result(id, {
                        supportedVersions: SUPPORTED_VERSIONS,
                        capabilities: { tools: { listChanged: false } },
                        instructions: SERVER_INSTRUCTIONS,
                        ttlMs: 3_600_000,
                        cacheScope: 'private',
                        _meta: { 'io.modelcontextprotocol/serverInfo': this.info },
                    });
                    return;
                case 'ping':
                    this.#result(id, {});
                    return;
                case 'tools/list': {
                    const res = { tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) };
                    if (this.#requestVersion(params) === '2026-07-28') Object.assign(res, { ttlMs: 3_600_000, cacheScope: 'private' });
                    this.#result(id, res);
                    return;
                }
                case 'tools/call': {
                    const name = params?.name;
                    const tool = TOOLS.find(t => t.name === name);
                    if (!tool) { this.#error(id, -32602, `Unknown tool: ${name}`); return; }
                    const args = params?.arguments ?? {};
                    const missing = (tool.inputSchema.required ?? []).filter(k => args[k] === undefined || args[k] === null || args[k] === '');
                    if (missing.length) {
                        this.#result(id, { content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}.` }], isError: true });
                        return;
                    }
                    this.inflight++;
                    try {
                        const note = await this.#awaitReady();
                        await this.intel.ensureFresh();
                        const text = await callTool(this.intel, name, args);
                        this.#result(id, { content: [{ type: 'text', text: note ? `${note}\n${text}` : text }] });
                    } catch (err) {
                        this.log(`tool ${name} failed: ${err.stack || err.message}`);
                        this.#result(id, { content: [{ type: 'text', text: `graph-indexer error in ${name}: ${err.message}` }], isError: true });
                    } finally { this.inflight--; }
                    return;
                }
                case 'resources/list': this.#result(id, { resources: [] }); return;
                case 'resources/templates/list': this.#result(id, { resourceTemplates: [] }); return;
                case 'prompts/list': this.#result(id, { prompts: [] }); return;
                case 'logging/setLevel': this.#result(id, {}); return;
                case 'completion/complete': this.#result(id, { completion: { values: [], hasMore: false } }); return;
                default:
                    this.#error(id, -32601, `Method not found: ${method}`);
            }
        } catch (err) {
            this.log(`request ${method} failed: ${err.stack || err.message}`);
            this.#error(id, -32603, `Internal error: ${err.message}`);
        }
    }

    /** Wait for the initial index; on very large repos answer from the partial index after a while. */
    async #awaitReady() {
        let done = false;
        const t = new Promise(r => setTimeout(() => r('timeout'), 45_000));
        const res = await Promise.race([this.ready.then(() => { done = true; return 'ready'; }), t]);
        if (res === 'timeout' && !done) {
            const p = this.intel.progress;
            return `note: the initial index is still being built${p ? ` (${p.done}/${p.total} files)` : ''}; results may be incomplete.`;
        }
        return null;
    }
}
