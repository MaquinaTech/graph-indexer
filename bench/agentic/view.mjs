#!/usr/bin/env node
/**
 * The Read tool plus graph-indexer's post-read hook, as one shell command, for benchmark arms whose
 * harness runs no hooks (sub-agents): prints the lines the way Read does (`     N\tcode`, first 2000
 * lines by default), then the additional context the hook would give the agent after that Read — the
 * same hook code (`graph-indexer hook post-tool`), the same payload, one hook session per run.
 *
 *   node view.mjs --gi BIN --repo DIR --session ID FILE [OFFSET] [LIMIT]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const take = (k) => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const gi = take('--gi'), repo = take('--repo'), session = take('--session');
const [file, offArg, limArg] = args;
if (!gi || !repo || !file) { console.error('usage: view FILE [OFFSET] [LIMIT]'); process.exit(2); }
const abs = path.isAbsolute(file) ? file : path.join(repo, file);
let text;
try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { console.error(`view: cannot read ${file}: ${e.code ?? e.message}`); process.exit(1); }
const lines = text.split('\n');
if (lines.length && lines[lines.length - 1] === '') lines.pop();
const offset = Math.max(1, Number(offArg) || 1), limit = Math.max(1, Number(limArg) || 2000);
const end = Math.min(lines.length, offset + limit - 1);
const out = [];
for (let n = offset; n <= end; n++) out.push(`${String(n).padStart(6)}\t${lines[n - 1].length > 2000 ? lines[n - 1].slice(0, 2000) + '…' : lines[n - 1]}`);
if (!out.length) out.push(`<file has ${lines.length} lines; nothing at line ${offset}>`);
process.stdout.write(out.join('\n') + '\n');

const input = { hook_event_name: 'PostToolUse', session_id: session ?? 'view', cwd: repo, tool_name: 'Read',
    tool_input: { file_path: abs, ...(offArg ? { offset } : {}), ...(limArg ? { limit } : {}) }, tool_response: { type: 'text' } };
const r = spawnSync(process.execPath, [gi, 'hook', 'post-tool', '--repo', repo], { input: JSON.stringify(input), encoding: 'utf8', cwd: repo, timeout: 20_000 });
let ctx = null;
try { ctx = JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext ?? null; } catch { }
if (ctx) process.stdout.write(`\n${ctx}\n`);
