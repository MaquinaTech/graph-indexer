/**
 * @file embedders/setup-mlx.mjs
 * @description Lifecycle for the optional MLX (Apple Metal) embedder's dedicated Python
 *              virtualenv. graph-indexer runs the MLX server under `embedders/venv-mlx`
 *              rather than the system Python so its (large) deps never pollute the host
 *              and the interpreter is found by absolute path regardless of `$PATH`.
 *
 *              Exposes the venv interpreter path + a readiness probe to embeddings.mjs,
 *              and a one-shot `ensureMlxEnv()` that creates the venv and pip-installs
 *              requirements-mlx.txt into it. Runnable as a CLI (`npm run embed:setup:mlx`)
 *              so users can pre-provision the environment with a single command. This
 *              module intentionally does NOT import embeddings.mjs (avoids a cycle).
 *
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url)); // embedders/
export const mlxVenvDir = join(__dirname, 'venv-mlx');
const REQUIREMENTS = join(__dirname, 'python', 'requirements-mlx.txt');
// Candidate base interpreters to bootstrap the venv, newest first. MLX needs Python
// 3.9+; preferring a modern one avoids a stale system python (e.g. macOS 3.9).
const BASE_PYTHON_CANDIDATES = ['python3.12', 'python3.11', 'python3.10', 'python3'];

// venv layout is POSIX (bin/python3). MLX is macOS-only, so we never need Windows Scripts/.
function venvPythonPath() { return join(mlxVenvDir, 'bin', 'python3'); }

/** Absolute path to the venv interpreter, or bare 'python3' if the venv is absent. */
export function mlxVenvPython() {
    const p = venvPythonPath();
    return fs.existsSync(p) ? p : 'python3';
}

/** True iff the venv exists AND `import mlx, mlx_embeddings` succeeds under it. */
export function mlxEnvReady() {
    const p = venvPythonPath();
    if (!fs.existsSync(p)) return false;
    const r = spawnSync(p, ['-c', 'import mlx, mlx_embeddings'], { stdio: 'ignore', timeout: 30000 });
    return r.status === 0;
}

/** First base interpreter on PATH that runs, to seed the venv (newest preferred). */
function pickBasePython() {
    for (const c of BASE_PYTHON_CANDIDATES) {
        const r = spawnSync(c, ['--version'], { stdio: 'ignore' });
        if (r.status === 0) return c;
    }
    return null;
}

/**
 * Ensure the MLX embedder venv exists and its deps are importable.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.autoInstall=true]  When false, only report readiness (no side effects).
 * @param {(s:string)=>void} [opts.log]      Progress sink (defaults to no-op).
 * @returns {{ready:boolean, created:boolean, error:(string|null)}}
 */
export function ensureMlxEnv({ autoInstall = true, log = () => {} } = {}) {
    if (process.platform !== 'darwin') {
        return { ready: false, created: false, error: 'MLX requires macOS (Apple Silicon).' };
    }
    if (mlxEnvReady()) { log('MLX environment already present.'); return { ready: true, created: false, error: null }; }
    if (!autoInstall) {
        return { ready: false, created: false, error: 'MLX environment not ready — run `npm run embed:setup:mlx`.' };
    }

    let created = false;
    const venvPy = venvPythonPath();
    if (!fs.existsSync(venvPy)) {
        const base = pickBasePython();
        if (!base) return { ready: false, created: false, error: 'No python3 found on PATH to create the venv.' };
        log(`creating virtualenv  (${base} -m venv embedders/venv-mlx)`);
        const mk = spawnSync(base, ['-m', 'venv', mlxVenvDir], { stdio: 'inherit' });
        if (mk.status !== 0) return { ready: false, created: false, error: 'virtualenv creation failed.' };
        created = true;
    }

    log('installing MLX deps  (pip install -r embedders/python/requirements-mlx.txt)');
    // Upgrade pip first so wheels resolve cleanly on older venv seeds; ignore its exit
    // code (a failed upgrade is non-fatal — the install below is what matters).
    spawnSync(venvPy, ['-m', 'pip', 'install', '-q', '--upgrade', 'pip'], { stdio: 'inherit' });
    const pip = spawnSync(venvPy, ['-m', 'pip', 'install', '-r', REQUIREMENTS], { stdio: 'inherit' });
    if (pip.status !== 0) return { ready: false, created, error: 'pip install failed.' };

    const ready = mlxEnvReady();
    return { ready, created, error: ready ? null : 'deps installed but `import mlx` still fails.' };
}

// ── CLI: `node embedders/setup-mlx.mjs` (npm run embed:setup:mlx) ─────────────
const _invokedDirectly = process.argv[1]
    && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();

if (_invokedDirectly) {
    console.log('Setting up the MLX (Apple Metal) embedder…\n');
    const res = ensureMlxEnv({ autoInstall: true, log: (s) => console.log('  • ' + s) });
    if (res.ready) {
        console.log(`\n✓ MLX embedder ready — vectors will run under embedders/venv-mlx.`);
        console.log(`  Use it:  npx idx-index --repo . --embeddings --embed-provider mlx`);
        process.exit(0);
    }
    console.error(`\n✗ MLX setup failed: ${res.error}`);
    if (process.platform !== 'darwin') console.error('  MLX is macOS-only; use --embed-provider local or ollama instead.');
    process.exit(1);
}
