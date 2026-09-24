/**
 * Repositories the agentic benchmark runs in. `source` is a local git repository holding every
 * commit the tasks use (`fetch` says how to get it); `setupWorktree` runs in each fresh worktree
 * of an edit task; `testHint` tells the agent how to run tests, identically for every arm.
 * Python repositories without third-party dependencies run their tests offline.
 */
import path from 'node:path';
import { WORK } from './lib.mjs';

export const REPOS = {
    nestjs: {
        source: 'test/fixtures/nestjs',
        fetch: 'node bench/fixtures.mjs',
        language: 'typescript',
    },
    sqlglot: {
        source: path.join(WORK, 'repos', 'sqlglot'),
        fetch: `git clone --filter=blob:none https://github.com/tobymao/sqlglot.git ${path.join(WORK, 'repos', 'sqlglot')}`,
        language: 'python',
        runner: 'unittest',
        srcPrefix: 'sqlglot/',
        testRe: '^tests/',
        testHint: 'from the repository root, `python3 -m unittest tests.test_parser` runs one test module (`tests/dialects/test_duckdb.py` → `tests.dialects.test_duckdb`); `python3 -m unittest discover tests` runs everything (slow).',
    },
    caddy: {
        source: path.join(WORK, 'go', 'caddy'),
        fetch: `git clone --depth 1 --branch v2.8.4 https://github.com/caddyserver/caddy.git ${path.join(WORK, 'go', 'caddy')} && (cd ${path.join(WORK, 'go', 'caddy')} && go mod download) && (cd bench/oracle-go && go build -o ${path.join(WORK, 'oracle-go')} .)`,
        language: 'go',
        testHint: 'Go is installed and the modules are downloaded: `go build ./...` compiles the module, `go vet ./...` also compiles the tests, and `go test ./modules/caddyhttp/...` runs the tests of one directory tree.',
    },
    networkx: {
        source: path.join(WORK, 'repos', 'networkx'),
        fetch: `git clone --filter=blob:none https://github.com/networkx/networkx.git ${path.join(WORK, 'repos', 'networkx')}`,
        language: 'python',
        runner: 'pytest',
        srcPrefix: 'networkx/',
        testRe: '/tests/',
        testHint: 'from the repository root, `pytest networkx/algorithms/tests/test_cycles.py` runs one test file (pytest is installed; numpy/scipy are not, so tests that need them are skipped).',
    },
};
