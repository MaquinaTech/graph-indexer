#!/usr/bin/env node
/**
 * Structural checks for TypeScript refactor tasks (run in the agent's checkout):
 *   - the target method has the expected name and parameter list afterwards;
 *   - methods that only share the old name (decoys) were left alone.
 *
 *   node bench/agentic/tsstruct.mjs --spec '<json>'
 * spec = { target: { file, cls, name, newName?, params? , lastParam? }, decoys: [{ file, cls, name, params }] }
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { argv } from './lib.mjs';

const ts = createRequire(import.meta.url)(process.env.TYPESCRIPT_PATH ?? '/opt/node22/lib/node_modules/typescript');

/** Methods of a class in a file: name → [parameter names] (overload signatures included). */
export function classMethods(root, file, cls) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) return null;
    const sf = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
    let found = null;
    const visit = (n) => {
        if (found) return;
        if ((ts.isClassDeclaration(n) || ts.isClassExpression(n)) && n.name?.text === cls) {
            found = new Map();
            for (const m of n.members) {
                if (!(ts.isMethodDeclaration(m) || ts.isMethodSignature?.(m)) || !m.name) continue;
                const nm = m.name.getText(sf);
                (found.get(nm) ?? found.set(nm, []).get(nm)).push(m.parameters.map(p => p.name.getText(sf)));
            }
            return;
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
}

export function checkStructure(root, spec) {
    const problems = [];
    const t = spec.target;
    const methods = classMethods(root, t.file, t.cls);
    if (!methods) problems.push(`class ${t.cls} not found in ${t.file}`);
    else {
        const name = t.newName ?? t.name;
        const sigs = methods.get(name);
        if (!sigs) problems.push(`${t.cls}.${name} not found`);
        if (t.newName && methods.has(t.name)) problems.push(`${t.cls}.${t.name} still exists`);
        if (sigs && t.params != null && !sigs.some(p => p.length === t.params)) problems.push(`${t.cls}.${name} has ${sigs.map(p => p.length).join('/')} parameters, expected ${t.params}`);
        if (sigs && t.lastParam && !sigs.some(p => p[p.length - 1] === t.lastParam)) problems.push(`${t.cls}.${name}: last parameter is not ${t.lastParam}`);
    }
    for (const d of spec.decoys ?? []) {
        const m = classMethods(root, d.file, d.cls);
        const sigs = m?.get(d.name);
        if (!sigs) problems.push(`decoy ${d.cls}.${d.name} (${d.file}) was renamed or removed`);
        else if (d.params != null && !sigs.some(p => p.length === d.params)) problems.push(`decoy ${d.cls}.${d.name} (${d.file}) changed its parameters`);
    }
    return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { opt } = argv();
    const spec = JSON.parse(opt('--spec') ?? fs.readFileSync(opt('--spec-file'), 'utf8'));
    const problems = checkStructure(process.cwd(), spec);
    console.log(problems.length ? problems.join('\n') : 'structure ok');
    process.exitCode = problems.length ? 1 : 0;
}
