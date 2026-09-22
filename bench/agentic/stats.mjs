/**
 * Paired statistics for comparing agent configurations on the same tasks.
 *
 * Every comparison is paired by task: per-task values are first averaged over repeated runs,
 * then differences are taken task by task. Intervals come from a percentile bootstrap over tasks,
 * p-values from a paired sign-flip randomization test (continuous metrics) or an exact McNemar
 * test (binary success), and Holm's method adjusts a family of p-values.
 */

export function rng(seed = 12345) {
    let s = seed >>> 0;
    return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
export function median(xs) {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Wilson score interval for k successes out of n. */
export function wilson(k, n, z = 1.96) {
    if (!n) return [NaN, NaN];
    const p = k / n, d = 1 + z * z / n;
    const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return [Math.max(0, c - h), Math.min(1, c + h)];
}

function logChoose(n, k) {
    let s = 0;
    for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
    return s;
}
/** Exact two-sided McNemar test on discordant pairs: b = A wins, c = B wins. */
export function mcnemarExact(b, c) {
    const n = b + c;
    if (!n) return 1;
    const k = Math.min(b, c);
    let p = 0;
    for (let i = 0; i <= k; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2);
    return Math.min(1, 2 * p);
}

/** Paired sign-flip randomization test for the mean of per-task differences. */
export function signFlipTest(diffs, { B = 20000, seed = 7 } = {}) {
    const d = diffs.filter(x => Number.isFinite(x));
    if (!d.length) return 1;
    const obs = Math.abs(mean(d));
    const r = rng(seed);
    let hits = 0;
    for (let b = 0; b < B; b++) {
        let s = 0;
        for (const x of d) s += r() < 0.5 ? -x : x;
        if (Math.abs(s / d.length) >= obs - 1e-12) hits++;
    }
    return (hits + 1) / (B + 1);
}

/**
 * Percentile bootstrap over tasks for a statistic of paired per-task values.
 * pairs: [{a, b}] (per-task means for the two arms); stat: (pairs) => number.
 */
export function bootstrap(pairs, stat, { B = 10000, seed = 11, alpha = 0.05 } = {}) {
    const n = pairs.length;
    if (!n) return { est: NaN, lo: NaN, hi: NaN };
    const r = rng(seed);
    const vals = [];
    for (let b = 0; b < B; b++) {
        const sample = new Array(n);
        for (let i = 0; i < n; i++) sample[i] = pairs[Math.floor(r() * n)];
        const v = stat(sample);
        if (Number.isFinite(v)) vals.push(v);
    }
    vals.sort((x, y) => x - y);
    return { est: stat(pairs), lo: quantile(vals, alpha / 2), hi: quantile(vals, 1 - alpha / 2) };
}

export const diffOfMeans = (pairs) => mean(pairs.map(p => p.b - p.a));
export const ratioOfMeans = (pairs) => mean(pairs.map(p => p.b)) / mean(pairs.map(p => p.a));

/** Holm–Bonferroni adjusted p-values (same order as the input). */
export function holm(ps) {
    const idx = ps.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0]);
    const adj = new Array(ps.length);
    let running = 0;
    idx.forEach(([p, i], rank) => { running = Math.max(running, Math.min(1, (ps.length - rank) * p)); adj[i] = running; });
    return adj;
}

/**
 * Compare arm B with arm A on per-task values.
 * a, b: Map(taskId → array of run values). Tasks missing in either arm are skipped.
 * kind: 'binary' (success) or 'continuous' (cost, tokens, calls…).
 */
export function compare(a, b, { kind = 'continuous', ratio = false } = {}) {
    const pairs = [];
    for (const [task, va] of a) {
        const vb = b.get(task);
        if (!vb?.length || !va?.length) continue;
        pairs.push({ task, a: mean(va), b: mean(vb) });
    }
    const out = { n: pairs.length, meanA: mean(pairs.map(p => p.a)), meanB: mean(pairs.map(p => p.b)) };
    out.diff = bootstrap(pairs, diffOfMeans);
    if (ratio) out.ratio = bootstrap(pairs, ratioOfMeans);
    if (kind === 'binary') {
        // discordance on per-task majority outcome (ties count as failure)
        let bw = 0, aw = 0;
        for (const p of pairs) { const x = p.a > 0.5, y = p.b > 0.5; if (y && !x) bw++; if (x && !y) aw++; }
        out.discordant = { aOnly: aw, bOnly: bw };
        out.p = mcnemarExact(aw, bw);
        out.pRandomization = signFlipTest(pairs.map(p => p.b - p.a));
    } else {
        out.p = signFlipTest(pairs.map(p => p.b - p.a));
    }
    return out;
}
