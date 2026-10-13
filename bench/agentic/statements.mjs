#!/usr/bin/env node
/**
 * Put reviewed problem statements into mined tasks (mine-fresh.mjs writes the commit message as a
 * placeholder and marks the task `needsStatement`).
 *
 *   node bench/agentic/statements.mjs --tasks fresh-sqlglot-r5.json --dir DIR [--prune]
 *
 * DIR/<task id>.md is the statement: an issue a user could have written, verified on the base
 * commit (reproduction) and on the real fix (expected behaviour), naming none of the files or
 * functions the fix changes. The commit message moves to `meta.commitMessage`, out of the agent's
 * view. With --prune, the tasks of the file that still have no statement are withdrawn (with their
 * test-id lists): a round holds only stated tasks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { argv, readJson, writeJson, HERE } from './lib.mjs';

const { opt, flag } = argv();
const file = path.join(HERE, 'tasks', opt('--tasks'));
const dir = path.resolve(opt('--dir'));
const tasks = readJson(file);
if (!tasks) throw new Error(`no task file ${file}`);
const kept = [];
for (const t of tasks) {
    const md = path.join(dir, `${t.id}.md`);
    if (fs.existsSync(md)) {
        const statement = fs.readFileSync(md, 'utf8').trim();
        if (t.needsStatement) t.meta.commitMessage = t.statement;
        t.statement = statement;
        delete t.needsStatement;
        console.log(`stated    ${t.id}`);
    }
    if (t.needsStatement && flag('--prune')) {
        for (const k of ['f2p', 'p2p', 'ripple']) fs.rmSync(path.join(HERE, 'tasks', 'fresh', `${t.id}.${k}.json`), { force: true });
        console.log(`withdrawn ${t.id}  ${t.meta.subject}`);
        continue;
    }
    if (t.needsStatement) console.log(`no statement yet: ${t.id}`);
    kept.push(t);
}
writeJson(file, kept);
console.log(`${kept.length} task(s) in ${path.relative(process.cwd(), file)}`);
