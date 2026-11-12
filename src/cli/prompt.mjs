/**
 * `graph-indexer hook prompt` (UserPromptSubmit): before the agent's first turn, resolve the code
 * names a request mentions and put what the index knows about them into the context, so a "who
 * calls X" or "what does changing X affect" question can be answered without searching for it.
 *
 * A name counts when it is written as code (`in backticks`), qualified (`Type.member`), a type in
 * CamelCase or a snake_case function. A type and a member named in the same request are tried
 * together (`execute` of `RefreshPort` is `RefreshPort.execute`). A bare name that
 * several definitions share is left out: it would be a guess. For each name: where it is defined,
 * what implements it, its uses with the enclosing function of each, whether that list is complete,
 * and, when the request asks for paths or impact, who calls each of those functions in turn.
 * Silent when nothing resolves. Facts only, from the index.
 */

const SPAN = /`([^`\n]{2,160})`/g;
const QUALIFIED = /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\b/g;
const CAMEL = /\b([A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+)\b/g;
const SNAKE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;
const LOWER = /^[a-z_][\w]*$/;
// a request for chains of calls or for the effect of a change: show one more level of callers
const PATHS = /\b(camino|cadena|niveles?|indirect\w*|path|chain|callers? of callers|impact\w*|afect\w*|entry points?|puntos? de entrada|acaban? llamando|end up calling|reach(es)?|llega)\b/i;
const CALLABLE = new Set(['function', 'method', 'constructor']);
const TYPE = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'type', 'object']);
const MAX_TARGETS = 3;
const MAX_REFS = 12;

/** The code names a request mentions, in order of appearance, without duplicates. */
export function promptNames(prompt) {
    const text = String(prompt ?? '').slice(0, 20_000);
    const found = [];
    const add = (raw, at) => {
        let n = raw.trim().replace(/\(\)?$/, '').replace(/^[@#]/, '').replace(/[.,;:]+$/, '');
        if (!n || n.includes('/') || n.includes(' ') || /\.(py|ts|tsx|js|kt|java|go|rs|md|json|ya?ml)$/i.test(n)) return;
        if (!/^[A-Za-z_][\w.]*$/.test(n) || n.length < 3) return;
        found.push({ n, at });
    };
    for (const m of text.matchAll(SPAN)) add(m[1], m.index);
    const blank = (s) => ' '.repeat(s.length);
    const prose = text.replace(SPAN, blank);
    for (const m of prose.matchAll(QUALIFIED)) add(m[1], m.index);
    const bare = prose.replace(QUALIFIED, blank); // the parts of a qualified name are not names of their own
    for (const re of [CAMEL, SNAKE]) for (const m of bare.matchAll(re)) add(m[1], m.index);
    found.sort((a, b) => a.at - b.at);
    const seen = new Set();
    return found.filter(({ n }) => !seen.has(n) && seen.add(n)).map(({ n }) => n).slice(0, 12);
}

/** Resolve the names to at most MAX_TARGETS symbols: qualified first, then type + member pairs, then unique names. */
function targets(intel, names) {
    const out = [];
    const used = new Set();
    const take = (sym, ...consumed) => {
        if (!sym || out.some(s => s.id === sym.id) || out.length >= MAX_TARGETS) return;
        out.push(sym);
        for (const c of consumed) used.add(c);
    };
    const resolve = (name) => {
        try { return intel.findSymbols(name, { limit: 5 }); } catch { return { matches: [], how: 'none' }; }
    };
    for (const n of names.filter(n => n.includes('.'))) {
        const r = resolve(n);
        if (r.how === 'qualified' && r.matches.length >= 1) take(r.matches[0], n);
    }
    const types = names.filter(n => !n.includes('.') && /^[A-Z]/.test(n));
    const members = names.filter(n => !n.includes('.') && LOWER.test(n));
    for (const t of types) for (const m of members) {
        if (used.has(t) && used.has(m)) continue;
        const r = resolve(`${t}.${m}`);
        if (r.how === 'qualified' && r.matches.length >= 1) take(r.matches[0], t, m);
    }
    for (const n of names.filter(n => !n.includes('.') && !used.has(n))) {
        const r = resolve(n);
        const exact = r.matches.filter(s => s.name === n);
        if (exact.length === 1) take(exact[0], n);
    }
    return out;
}

const where = (s) => `${s.path}:${s.start_line}`;
// the file name only, for the lines the agent reads rather than opens (implementations, callers one level up)
const brief = (p, line) => `${String(p).split('/').pop()}:${line}`;
// the code on a line, so a call site can be judged without opening its file
const code = (intel, p, line) => {
    const text = intel.fileLines(p)?.[line - 1]?.trim();
    return text ? `: ${text.length > 100 ? text.slice(0, 99) + '…' : text}` : '';
};
// where a type is named in production code, imports aside: for a port, where it is injected, built and implemented
const typeUses = (intel, type) => {
    const r = intel.references(type.id, { family: false });
    return r ? [...r.groups.values()].flat().filter(x => !x.is_test && x.kind !== 'import') : [];
};

function describe(intel, sym, wantPaths) {
    const lines = [`${sym.qname} (${sym.kind}, ${where(sym)})`];
    if (TYPE.has(sym.kind)) {
        const subs = intel.store.all(`SELECT DISTINCT s.qname, f.path, s.start_line FROM refs r JOIN symbols s ON s.id = r.src_id JOIN files f ON f.id = s.file_id
            WHERE r.dst_id = ? AND r.kind = 'inherit' ORDER BY f.is_test, f.path LIMIT 8`, sym.id);
        if (subs.length) lines.push(`  implemented or extended by: ${subs.map(s => `${s.qname} (${brief(s.path, s.start_line)})`).join(', ')}`);
        // where the type is used: a port built by a lambda or a factory shows up here, not among its subtypes
        const uses = typeUses(intel, sym);
        lines.push(`  used in ${uses.length} place${uses.length === 1 ? '' : 's'} in production code${uses.length ? ':' : '.'}`);
        for (const x of uses.slice(0, 6)) lines.push(`    ${x.path}:${x.line} in ${x.src_qname ?? '(top level)'} (${x.kind})${code(intel, x.path, x.line)}`);
        if (uses.length > 6) lines.push(`    … ${uses.length - 6} more`);
        return lines;
    }
    if (!CALLABLE.has(sym.kind)) return lines;
    const impl = intel.inheritance(sym.id, { max: 12 });
    const runs = [...impl.override, ...impl.inherit];
    const real = runs.filter(s => !s.is_test), doubles = runs.length - real.length;
    if (runs.length) lines.push(`  implemented by: ${real.map(s => `${s.qname} (${brief(s.path, s.start_line)})`).join(', ') || 'only test doubles'}${doubles && real.length ? ` (+${doubles} test double${doubles === 1 ? '' : 's'})` : ''}`);
    const r = intel.references(sym.id, { kinds: ['call', 'new'] });
    if (!r) return lines;
    const all = [...r.groups.values()].flat();
    const prod = all.filter(x => !x.is_test);
    const tests = all.filter(x => x.is_test);
    const tag = (x) => (x.confidence === 'exact' ? '' : ` [${x.confidence}]`) + (x.via ? ' (via an implementation)' : '');
    lines.push(`  ${prod.length} call${prod.length === 1 ? '' : 's'} in production code${tests.length ? `, ${tests.length} in tests (${new Set(tests.map(t => t.path)).size} file(s))` : ''}:`);
    for (const x of prod.slice(0, MAX_REFS)) lines.push(`    ${x.path}:${x.line} in ${x.src_qname ?? '(top level)'}${tag(x)}${code(intel, x.path, x.line)}`);
    if (prod.length > MAX_REFS) lines.push(`    … ${prod.length - MAX_REFS} more`);
    const isTest = (p) => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.\w+$|Test\.\w+$/.test(p);
    const plausible = (r.unbound?.plausible ?? []).filter(p => !isTest(p.path));
    if (plausible.length) {
        lines.push(`  Possibly one of these too: same-name calls whose receiver type is unknown, in files that mention it (judge by the receiver):`);
        for (const p of plausible.slice(0, 4)) lines.push(`    ${p.path}:${p.line}${code(intel, p.path, p.line)}`);
    }
    lines.push(`  ${plausible.length ? 'Apart from those, this' : 'This'} list is complete and exact: calls through other types that share the name are already left out, so a text search would only add those.`);
    // a method of a port: the classes that hold the port and the wiring that builds it, which is what a check by its type name looks for
    const owner = intel.store.get('SELECT p.id, p.qname, p.kind FROM symbols s JOIN symbols p ON p.id = s.parent_id WHERE s.id = ?', sym.id);
    if (owner && TYPE.has(owner.kind)) {
        const uses = typeUses(intel, owner);
        if (uses.length) {
            lines.push(`  ${owner.qname} itself, every reference in production code apart from imports (where it is injected, built or implemented):`);
            for (const x of uses.slice(0, MAX_REFS)) lines.push(`    ${brief(x.path, x.line)} in ${x.src_qname ?? '(top level)'} (${x.kind})${code(intel, x.path, x.line)}`);
            if (uses.length > MAX_REFS) lines.push(`    … ${uses.length - MAX_REFS} more`);
        }
    }
    if (wantPaths && prod.length) {
        const seen = new Set();
        const hops = [];
        for (const x of prod) {
            if (!x.src_qname || seen.has(x.src_qname) || hops.length >= 8) continue;
            seen.add(x.src_qname);
            const enc = intel.store.get('SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.qname = ? AND f.path = ? AND s.start_line = ?', x.src_qname, x.path, x.src_line);
            if (!enc) continue;
            const up = intel.references(enc.id, { kinds: ['call', 'new'], includeTests: false });
            const callers = up ? [...up.groups.values()].flat() : [];
            const shown = [...new Map(callers.map(c => [`${c.src_qname}`, c])).values()].slice(0, 3);
            const others = shown.filter(c => c.src_qname !== x.src_qname); // a method calling an overload of itself is not a level up
            hops.push(`    ${x.src_qname} ← ${others.length ? others.map(c => `${c.src_qname ?? '(top level)'} (${brief(c.path, c.line)})`).join(', ') : 'no calls in the code (an entry point: framework, route or main)'}`);
        }
        if (hops.length) lines.push('  one level up (who calls each of those):', ...hops);
    }
    return lines;
}

/** The context for a request, or null when it names nothing the index resolves. */
export function promptContext(intel, prompt) {
    const names = promptNames(prompt);
    if (!names.length) return null;
    const found = targets(intel, names);
    if (!found.length) return null;
    const wantPaths = PATHS.test(String(prompt));
    const blocks = found.map(s => describe(intel, s, wantPaths).join('\n'));
    return `graph-indexer resolved the code this request names, from the parsed code (exact unless marked). Answer from it; search only for what it does not show:\n${blocks.join('\n')}`;
}
