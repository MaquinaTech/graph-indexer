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

export const rule = (width = 60) => c.dim('─'.repeat(width));

/** ANSI escape codes are stripped before measuring line width so colour never breaks box alignment. */
export function box(lines, { pad = 1, color = c.cyan } = {}) {
    const visibleLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
    const inner = Math.max(...lines.map(visibleLen)) + pad * 2;
    const top = color('╭' + '─'.repeat(inner) + '╮');
    const bot = color('╰' + '─'.repeat(inner) + '╯');
    const body = lines.map((line) => {
        const gap = ' '.repeat(inner - visibleLen(line) - pad);
        return color('│') + ' '.repeat(pad) + line + gap + color('│');
    });
    return [top, ...body, bot].join('\n');
}
