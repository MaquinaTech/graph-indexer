/**
 * @file mcp/format.mjs
 * @description MCP rendering helpers: signature extraction, body pruning.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */

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
