/**
 * @file cli-ui.mjs
 * @description Tiny, dependency-free console styling shared by the `graph-indexer`
 *              CLIs (init + daemon control). ANSI colour with graceful degradation
 *              when stdout is not a TTY or NO_COLOR is set, plus a few drawing
 *              helpers (boxed banner, rules, status glyphs) for a consistent look.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */

export const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : `${s}`);

export const c = {
    bold: paint('1'),
    dim: paint('2'),
    red: paint('31'),
    green: paint('32'),
    yellow: paint('33'),
    blue: paint('34'),
    magenta: paint('35'),
    cyan: paint('36'),
};

export const glyph = {
    ok: c.green('✓'),
    upd: c.cyan('↻'),
    keep: c.dim('•'),
    move: c.yellow('↪'),
    skip: c.dim('–'),
    warn: c.yellow('⚠'),
    err: c.red('✗'),
    run: c.green('●'),
    stop: c.dim('○'),
    arrow: c.cyan('→'),
};

export const log = (msg = '') => process.stdout.write(msg + '\n');

/** A horizontal rule, capped to the terminal width so it never wraps. */
export const rule = (width = Math.min(60, (process.stdout.columns || 80))) => c.dim('─'.repeat(Math.max(1, width)));

const visibleLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

/** ANSI-aware truncate to `limit` visible columns; closes any open colour + adds an ellipsis. */
function clipVisible(s, limit) {
    if (limit < 1) return '';
    if (visibleLen(s) <= limit) return s;
    let out = '', w = 0, i = 0, ansi = false;
    while (i < s.length && w < limit - 1) {
        if (s[i] === '\x1b') {
            const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
            if (m) { out += m[0]; i += m[0].length; ansi = true; continue; }
        }
        out += s[i++]; w++;
    }
    return out + (ansi ? '\x1b[0m' : '') + '…';
}

/**
 * Draws a bordered box. ANSI escapes are stripped before measuring width so colour
 * never breaks alignment, and the box (plus each line) is capped to the terminal
 * width so the border stays intact on narrow terminals instead of wrapping.
 */
export function box(lines, { pad = 1, color = c.cyan } = {}) {
    const maxInner = Math.max(1, (process.stdout.columns || 80) - 2); // 2 border columns
    const shown = lines.map((line) => clipVisible(line, maxInner - pad * 2));
    const inner = Math.min(maxInner, Math.max(...shown.map(visibleLen)) + pad * 2);
    const top = color('╭' + '─'.repeat(inner) + '╮');
    const bot = color('╰' + '─'.repeat(inner) + '╯');
    const body = shown.map((line) => {
        const gap = ' '.repeat(Math.max(0, inner - visibleLen(line) - pad));
        return color('│') + ' '.repeat(pad) + line + gap + color('│');
    });
    return [top, ...body, bot].join('\n');
}
