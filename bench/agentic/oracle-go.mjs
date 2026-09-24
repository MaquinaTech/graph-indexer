/**
 * The Go type checker's answers for the Go tasks (bench/oracle-go; see its main.go for the output).
 * The binary is built once: (cd bench/oracle-go && go build -o ~/.gi-agentic/oracle-go .)
 */
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ORACLE_GO = process.env.GI_ORACLE_GO ?? path.join(os.homedir(), '.gi-agentic', 'oracle-go');

/** @param {{ path: string, line: number, col: number }[]} queries  col 1-based */
export function goRefs(root, queries) {
    const r = spawnSync(ORACLE_GO, ['-dir', root], { input: JSON.stringify(queries), encoding: 'utf8', maxBuffer: 1 << 30 });
    if (r.status !== 0) throw new Error(`oracle-go failed: ${(r.stderr || r.error?.message || '').slice(-2000)}`);
    return JSON.parse(r.stdout);
}

/** Type errors of the module, tests included ("rel:line:col: message"). */
export function goTypeErrors(root) {
    const r = spawnSync(ORACLE_GO, ['-mode', 'typecheck', '-dir', root], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0 && r.status !== 1) throw new Error(`oracle-go failed: ${(r.stderr || r.error?.message || '').slice(-2000)}`);
    return r.stdout.split('\n').filter(Boolean);
}

/** Parameter count of a Go signature as the index stores it (`func (s *S) Name(a, b int, c string) error` → 3). */
export function goParamCount(sig, name) {
    const m = new RegExp(`(?:^|[\\s)])${name}\\s*\\(`).exec(sig ?? '');
    if (!m) return null;
    let depth = 0, cur = '', n = 0;
    for (let i = m.index + m[0].length; i < sig.length; i++) {
        const ch = sig[i];
        if (ch === ')' && depth === 0) return n + (cur.trim() ? 1 : 0);
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        if (ch === ',' && depth === 0) { n++; cur = ''; } else cur += ch;
    }
    return null;
}
