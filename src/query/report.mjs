/**
 * `graph-indexer report`: what a bug report needs about an index, without anything from the code.
 *
 * graph-indexer sends nothing anywhere. When an answer is wrong or slow, this summary — versions,
 * size, languages, how much of each language's references are bound, and latencies — is what the
 * user pastes into an issue. It carries no paths, names or source text, so it is safe to share.
 */
import os from 'node:os';
import { callTool } from '../mcp/tools.mjs';

const pct = (a, b) => (b ? `${Math.round((1000 * a) / b) / 10}%` : '–');

/** Median wall time of `fn` over `n` runs, in milliseconds. */
async function median(fn, n = 5) {
    const t = [];
    for (let i = 0; i < n; i++) { const s = process.hrtime.bigint(); await fn(); t.push(Number(process.hrtime.bigint() - s) / 1e6); }
    t.sort((a, b) => a - b);
    return Math.round(t[n >> 1] * 10) / 10;
}

export async function reportText(intel, { version }) {
    const st = intel.stats();
    const sync = intel.lastSyncStats ?? {};
    const byLang = intel.store.all(`SELECT f.lang, COUNT(DISTINCT f.id) AS files,
            SUM(CASE WHEN r.kind IN ('call', 'new') THEN 1 ELSE 0 END) AS calls,
            SUM(CASE WHEN r.kind IN ('call', 'new') AND r.dst_id IS NOT NULL THEN 1 ELSE 0 END) AS bound,
            SUM(CASE WHEN r.kind IN ('call', 'new') AND r.conf >= 0.9 THEN 1 ELSE 0 END) AS exact
        FROM files f LEFT JOIN refs r ON r.file_id = f.id GROUP BY f.lang ORDER BY files DESC`);
    const tests = intel.store.get('SELECT COUNT(*) AS n FROM files WHERE is_test = 1')?.n ?? 0;
    // latencies on the most referenced definition: the heaviest ordinary question
    const top = intel.store.get(`SELECT s.id, s.qname FROM symbols s JOIN refs r ON r.dst_id = s.id GROUP BY s.id ORDER BY COUNT(*) DESC LIMIT 1`);
    const lat = [];
    if (top) {
        const target = `${intel.sym(top.id).path}:${top.qname}`;
        lat.push(`find_references ${await median(() => callTool(intel, 'find_references', { symbol: target }))} ms`);
        lat.push(`read_code ${await median(() => callTool(intel, 'read_code', { targets: [target] }))} ms`);
        lat.push(`explore ${await median(() => callTool(intel, 'explore', { symbols: [target] }))} ms`);
    }
    const out = [
        '### graph-indexer report',
        `- graph-indexer ${version}, Node.js ${process.versions.node}, ${os.platform()} ${os.arch()}, ${os.cpus().length} CPUs`,
        `- index: ${st.files} files (${tests} test files), ${st.symbols} symbols, ${st.refs} references — ${pct(st.resolved, st.refs)} bound, ${pct(st.exact, st.refs)} exact`,
        `- last sync: ${sync.added ?? 0} added, ${sync.changed ?? 0} changed, ${sync.removed ?? 0} removed in ${sync.ms ?? '?'} ms`,
        `- warm latency (median of 5, most referenced definition): ${lat.join(', ') || 'no references indexed'}`,
        '',
        '| language | files | calls | bound | exact |',
        '|---|---|---|---|---|',
        ...byLang.map(l => `| ${l.lang} | ${l.files} | ${l.calls ?? 0} | ${pct(l.bound ?? 0, l.calls ?? 0)} | ${pct(l.exact ?? 0, l.calls ?? 0)} |`),
        '',
        'No paths, names or code are included. For a wrong answer, add the command you ran and what you expected.',
    ];
    return out.join('\n');
}
