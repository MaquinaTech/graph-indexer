#!/usr/bin/env node
/**
 * Smoke test: spawn the MLX Python embed server under the dedicated venv, send one
 * batch, and verify the response shape (3 vectors × 384 dims). Skips cleanly when the
 * MLX venv is not provisioned or the platform is not macOS, so it is always safe to run.
 *
 * Run: node embedders/python/test_servers.mjs   (provision first: npm run embed:setup:mlx)
 */
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mlxVenvPython, mlxEnvReady } from '../setup-mlx.mjs';

const PYTHON_DIR = dirname(fileURLToPath(import.meta.url));

async function testMlxServer() {
    const proc = spawn(mlxVenvPython(), [join(PYTHON_DIR, 'mlx_embed_server.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stderr.on('data', d => process.stderr.write(`[mlx] ${d}`));

    const rl = createInterface({ input: proc.stdout });

    // Wait for READY (the first emitted line).
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => { proc.kill(); reject(new Error('timeout waiting for READY')); }, 60000);
        rl.once('line', l => { clearTimeout(t); l.trim() === 'READY' ? resolve() : reject(new Error(l)); });
        proc.on('error', reject);
    });

    // Send one batch of 3 texts and await its response line.
    const response = await new Promise((resolve, reject) => {
        const t = setTimeout(() => { proc.kill(); reject(new Error('timeout waiting for embeddings')); }, 30000);
        rl.once('line', l => { clearTimeout(t); try { resolve(JSON.parse(l)); } catch (e) { reject(e); } });
        proc.stdin.write(JSON.stringify({ texts: ['hello world', 'test code', 'function foo()'] }) + '\n');
    });

    if (response.error) throw new Error(`mlx: ${response.error}`);
    const embeddings = response.embeddings;
    console.assert(Array.isArray(embeddings), 'mlx: embeddings must be an array');
    console.assert(embeddings.length === 3, `mlx: expected 3 embeddings, got ${embeddings?.length}`);
    console.assert(embeddings[0].length === 384, `mlx: expected dim 384, got ${embeddings[0]?.length}`);

    proc.kill();
    console.log(`✓  mlx: 3 embeddings × ${embeddings[0].length}d returned correctly`);
}

console.log('=== MLX Embedder Python Server Smoke Test ===\n');

if (process.platform !== 'darwin') {
    console.log('⊘  MLX: macOS only, skipping on', process.platform);
} else if (!mlxEnvReady()) {
    console.log('⊘  MLX: venv not provisioned, skipping (run `npm run embed:setup:mlx`)');
} else {
    await testMlxServer();
}

console.log('\nDone.');
