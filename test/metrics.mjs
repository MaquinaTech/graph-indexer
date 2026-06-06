/**
 * test/metrics.mjs
 *
 * Shared metric computation and formatting utilities used by the harness
 * and the report renderer.
 */

import fs from 'fs';
import path from 'path';

// ─── Token approximation ──────────────────────────────────────────────────────

/**
 * Approximate token count using the OpenAI rule-of-thumb: ~4 chars per token.
 * Accurate within ±15% for typical source code.
 */
export function approxTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

// ─── Search quality metrics ───────────────────────────────────────────────────

/**
 * Returns 1 if any result in the top-k matches any expected name (substring,
 * case-insensitive) or any expected file pattern (substring of file_path).
 * Returns 0 otherwise.
 *
 * @param {Array}  results        - searchHybrid() output
 * @param {string[]} expectedNames - symbol names to look for
 * @param {string[]} expectedFiles - file path substrings to look for
 * @param {number} k
 */
export function recallAtK(results, expectedNames, expectedFiles, k) {
    const topK = results.slice(0, k);
    return topK.some(r => isRelevant(r, expectedNames, expectedFiles)) ? 1 : 0;
}

/**
 * Reciprocal rank of the first relevant result (0 if none found).
 */
export function reciprocalRank(results, expectedNames, expectedFiles) {
    for (let i = 0; i < results.length; i++) {
        if (isRelevant(results[i], expectedNames, expectedFiles)) return 1 / (i + 1);
    }
    return 0;
}

/**
 * 1-indexed rank of the first relevant result, or -1 if none found.
 */
export function firstRelevantRank(results, expectedNames, expectedFiles) {
    for (let i = 0; i < results.length; i++) {
        if (isRelevant(results[i], expectedNames, expectedFiles)) return i + 1;
    }
    return -1;
}

/**
 * nDCG@k — normalised discounted cumulative gain.
 * Assumes binary relevance: 1 if relevant, 0 otherwise.
 */
export function ndcgAtK(results, expectedNames, expectedFiles, k) {
    const topK = results.slice(0, k);
    let dcg = 0;
    let idcg = 0;

    for (let i = 0; i < k; i++) {
        const gain = i < topK.length && isRelevant(topK[i], expectedNames, expectedFiles) ? 1 : 0;
        dcg += gain / Math.log2(i + 2);
        // Ideal: assume one relevant doc exists, placed at rank 1
        if (i === 0) idcg = 1 / Math.log2(2);
    }

    return idcg > 0 ? dcg / idcg : 0;
}

function isRelevant(result, expectedNames, expectedFiles) {
    if (!result?.chunk) return false;
    const name = (result.chunk.name || '').toLowerCase();
    const filePath = (result.chunk.file_path || '').toLowerCase();
    const nameHit = (expectedNames || []).some(n => name.includes(n.toLowerCase()));
    const fileHit = (expectedFiles || []).some(f => filePath.includes(f.toLowerCase()));
    return nameHit || fileHit;
}

// ─── Token savings ────────────────────────────────────────────────────────────

/**
 * Given search results and the fixture root directory, compute:
 *   chunkTokens  — tokens in the code snippets of the returned chunks
 *   fileTokens   — tokens in the FULL source files those chunks come from
 *   savingsPct   — 100 × (1 − chunkTokens / fileTokens)
 *
 * This directly models the agent savings: instead of reading full files,
 * the agent only receives the relevant chunk excerpts.
 */
export function computeTokenSavings(results, fixtureDir) {
    let chunkTokens = 0;
    for (const r of results) {
        chunkTokens += approxTokens(r.chunk?.code_snippet);
    }

    const seenFiles = new Set();
    let fileTokens = 0;
    for (const r of results) {
        const relPath = r.chunk?.file_path;
        if (!relPath || seenFiles.has(relPath)) continue;
        seenFiles.add(relPath);
        try {
            const content = fs.readFileSync(path.join(fixtureDir, relPath), 'utf-8');
            fileTokens += approxTokens(content);
        } catch { /* file not accessible */ }
    }

    const savingsPct = fileTokens > 0
        ? Math.max(0, (1 - chunkTokens / fileTokens) * 100)
        : 0;

    return { chunkTokens, fileTokens, savingsPct };
}

/**
 * Count approximate total source tokens across all source files in a directory.
 * Excludes non-source files and common build/dependency directories.
 */
export function totalSourceTokens(dir) {
    const SKIP_DIRS = new Set([
        'node_modules', '.git', 'dist', 'build', '__pycache__',
        '.venv', 'vendor', 'target', '.next', 'coverage', 'venv',
    ]);
    const SRC_EXTS = new Set([
        '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
        '.py', '.go', '.rb', '.rs', '.java', '.kt', '.cs',
    ]);
    let total = 0;

    function walk(d) {
        let entries;
        try { entries = fs.readdirSync(d); } catch { return; }
        for (const entry of entries) {
            if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
            const full = path.join(d, entry);
            let stat;
            try { stat = fs.statSync(full); } catch { continue; }
            if (stat.isDirectory()) { walk(full); continue; }
            if (SRC_EXTS.has(path.extname(full))) {
                try { total += approxTokens(fs.readFileSync(full, 'utf-8')); } catch { /* skip */ }
            }
        }
    }

    walk(dir);
    return total;
}

// ─── Statistics helpers ───────────────────────────────────────────────────────

export function mean(arr) {
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function median(arr) {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

export function p95(arr) {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(0.95 * sorted.length);
    return sorted[Math.min(idx, sorted.length - 1)];
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

export function fmt(n, decimals = 2) {
    return Number(n).toFixed(decimals);
}

export function fmtPct(n) {
    return `${Number(n).toFixed(1)}%`;
}

export function fmtBytes(bytes) {
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
    return `${bytes} B`;
}

export function fmtMs(ms) {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
    return `${ms.toFixed(1)} ms`;
}

export function pad(str, width, right = false) {
    const s = String(str);
    if (s.length >= width) return s.slice(0, width);
    return right ? s.padStart(width) : s.padEnd(width);
}

// ─── ANSI colours ─────────────────────────────────────────────────────────────

export const c = {
    reset: (s) => `\x1b[0m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    blue: (s) => `\x1b[34m${s}\x1b[0m`,
    magenta: (s) => `\x1b[35m${s}\x1b[0m`,
};

/** Colourize a recall/MRR value: red < 0.5, yellow < 0.75, green >= 0.75 */
export function colourScore(n) {
    const s = fmt(n);
    if (n >= 0.75) return c.green(s);
    if (n >= 0.5) return c.yellow(s);
    return c.red(s);
}

/** Colourize a savings percent: dim < 50, yellow < 70, green >= 70 */
export function colourSavings(pct) {
    const s = fmtPct(pct);
    if (pct >= 70) return c.green(s);
    if (pct >= 50) return c.yellow(s);
    return c.dim(s);
}
