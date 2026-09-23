/**
 * How to run a set of test files in this repository: one command per test ecosystem, detected from
 * the project's own configuration (package.json scripts and dependencies, pytest/unittest layout,
 * go.mod, Cargo.toml, Maven/Gradle builds). Commands target only the given files, so an agent can
 * verify a change in seconds instead of running the whole suite.
 */
import fs from 'node:fs';
import path from 'node:path';

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

/** Nearest package.json above a file (monorepos have one per package). */
function nearestPackage(root, rel) {
    let dir = path.posix.dirname(rel);
    for (;;) {
        const p = path.join(root, dir === '.' ? '' : dir, 'package.json');
        if (fs.existsSync(p)) return { dir: dir === '.' ? '' : dir, pkg: readJson(p) ?? {} };
        if (dir === '.' || dir === '' || dir === '/') return null;
        dir = path.posix.dirname(dir);
    }
}

function jsRunner(root, rel) {
    const near = nearestPackage(root, rel);
    const top = readJson(path.join(root, 'package.json')) ?? {};
    const pkgs = [near?.pkg, top].filter(Boolean);
    const deps = Object.assign({}, ...pkgs.map(p => ({ ...p.dependencies, ...p.devDependencies })));
    const scripts = pkgs.map(p => p.scripts?.test ?? '').join(' ');
    if (deps.vitest || /\bvitest\b/.test(scripts)) return 'npx vitest run';
    if (deps.jest || /\bjest\b/.test(scripts)) return 'npx jest';
    if (deps.mocha || /\bmocha\b/.test(scripts) || exists(root, '.mocharc.js') || exists(root, '.mocharc.json') || exists(root, '.mocharc.yml')) return 'npx mocha';
    if (deps.ava || /\bava\b/.test(scripts)) return 'npx ava';
    if (deps.tap || /\btap\b/.test(scripts)) return 'npx tap';
    if (/node --test/.test(scripts)) return 'node --test';
    return 'npm test --';
}

function pyRunner(root) {
    if (exists(root, 'tests/runtests.py')) return { kind: 'django' };
    const pyproject = (() => { try { return fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8'); } catch { return ''; } })();
    if (exists(root, 'pytest.ini') || exists(root, 'conftest.py') || /\[tool\.pytest/.test(pyproject) || exists(root, 'tox.ini')) return { kind: 'pytest' };
    return { kind: 'unittest' };
}

/**
 * @param {string} root repository root
 * @param {string[]} files test files (repo-relative)
 * @returns {string[]} shell commands
 */
export function testCommands(root, files) {
    const groups = new Map();
    const add = (key, f) => (groups.get(key) ?? groups.set(key, []).get(key)).push(f);
    for (const f of files) {
        const ext = path.posix.extname(f);
        if (/\.[cm]?[jt]sx?$/.test(ext)) add(`js:${jsRunner(root, f)}`, f);
        else if (ext === '.py') add('py', f);
        else if (ext === '.go') add('go', f);
        else if (ext === '.rs') add('rs', f);
        else if (ext === '.java' || ext === '.kt' || ext === '.scala') add('jvm', f);
        else if (ext === '.rb') add('rb', f);
        else if (ext === '.php') add('php', f);
        else if (ext === '.cs') add('cs', f);
    }
    const out = [];
    for (const [key, fs_] of groups) {
        if (key.startsWith('js:')) out.push(`${key.slice(3)} ${fs_.join(' ')}`);
        else if (key === 'py') {
            const r = pyRunner(root);
            if (r.kind === 'django') out.push(`python tests/runtests.py ${[...new Set(fs_.map(f => f.replace(/^tests\//, '').replace(/\/[^/]*$/, '').replace(/\//g, '.')))].join(' ')}`);
            else if (r.kind === 'pytest') out.push(`python -m pytest -q ${fs_.join(' ')}`);
            else out.push(`python -m unittest ${fs_.map(f => f.replace(/\.py$/, '').replace(/\//g, '.')).join(' ')}`);
        } else if (key === 'go') out.push(`go test ${[...new Set(fs_.map(f => './' + path.posix.dirname(f)))].join(' ')}`);
        else if (key === 'rs') out.push('cargo test');
        else if (key === 'jvm') {
            const classes = [...new Set(fs_.map(f => path.posix.basename(f).replace(/\.\w+$/, '')))].join(',');
            out.push(exists(root, 'pom.xml') ? `mvn -q test -Dtest=${classes}` : `./gradlew test ${classes.split(',').map(c => `--tests '*${c}'`).join(' ')}`);
        } else if (key === 'rb') out.push(exists(root, '.rspec') || fs_.some(f => f.endsWith('_spec.rb')) ? `bundle exec rspec ${fs_.join(' ')}` : `bundle exec ruby -Itest ${fs_[0]}`);
        else if (key === 'php') out.push(`vendor/bin/phpunit ${fs_.join(' ')}`);
        else if (key === 'cs') out.push('dotnet test');
    }
    return out;
}

/**
 * Commands that run only the given test functions: [{ path, name, cls }] (cls: the enclosing test
 * class, if any). pytest, unittest and Django (Python), `go test -run`, Maven and Gradle; other
 * ecosystems name tests by strings the index does not see, so they get no command here.
 * @returns {string[]} shell commands
 */
export function testCaseCommands(root, cases) {
    const out = [];
    const py = cases.filter(c => c.path.endsWith('.py'));
    if (py.length) {
        const r = pyRunner(root);
        const mod = (p) => p.replace(/\.py$/, '').replace(/\//g, '.');
        if (r.kind === 'pytest') out.push(`python -m pytest -q ${py.map(c => `${c.path}::${c.cls ? `${c.cls}::` : ''}${c.name}`).join(' ')}`);
        else if (r.kind === 'django') {
            const withCls = py.filter(c => c.cls);
            if (withCls.length) out.push(`python tests/runtests.py ${withCls.map(c => `${mod(c.path.replace(/^tests\//, ''))}.${c.cls}.${c.name}`).join(' ')}`);
        } else {
            const withCls = py.filter(c => c.cls);
            if (withCls.length) out.push(`python -m unittest ${withCls.map(c => `${mod(c.path)}.${c.cls}.${c.name}`).join(' ')}`);
        }
    }
    const byDir = new Map();
    for (const c of cases.filter(c => c.path.endsWith('.go'))) (byDir.get(path.posix.dirname(c.path)) ?? byDir.set(path.posix.dirname(c.path), []).get(path.posix.dirname(c.path))).push(c.name);
    for (const [dir, names] of byDir) out.push(`go test ./${dir} -run '^(${[...new Set(names)].join('|')})$'`);
    const jvm = cases.filter(c => /\.(java|kt|scala)$/.test(c.path));
    if (jvm.length) {
        const cls = (c) => c.cls ?? path.posix.basename(c.path).replace(/\.\w+$/, '');
        if (exists(root, 'pom.xml')) {
            const by = new Map();
            for (const c of jvm) (by.get(cls(c)) ?? by.set(cls(c), []).get(cls(c))).push(c.name);
            out.push(`mvn -q test -Dtest=${[...by].map(([k, v]) => `${k}#${[...new Set(v)].join('+')}`).join(',')}`);
        } else out.push(`./gradlew test ${jvm.map(c => `--tests '*${cls(c)}.${c.name}'`).join(' ')}`);
    }
    return out;
}
