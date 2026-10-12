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
        // SQL fixtures and the test modules that read them
        fixtureTests: {
            '^tests/fixtures/optimizer/': 'tests/test_optimizer.py',
            '^tests/fixtures/(identity|pretty|partial)\\.sql$': 'tests/test_transpile.py',
        },
        testHint: 'from the repository root, `python3 -m unittest tests.test_parser` runs one test module (`tests/dialects/test_duckdb.py` → `tests.dialects.test_duckdb`); `python3 -m unittest discover -s tests -t .` runs everything (slow); duckdb, pandas and numpy, which some tests use, are installed.',
    },
    caddy: {
        source: path.join(WORK, 'go', 'caddy'),
        fetch: `git clone --depth 1 --branch v2.8.4 https://github.com/caddyserver/caddy.git ${path.join(WORK, 'go', 'caddy')} && (cd ${path.join(WORK, 'go', 'caddy')} && go mod download) && (cd bench/oracle-go && go build -o ${path.join(WORK, 'oracle-go')} .)`,
        language: 'go',
        testHint: 'Go is installed and the modules are downloaded: `go build ./...` compiles the module, `go vet ./...` also compiles the tests, and `go test ./modules/caddyhttp/...` runs the tests of one directory tree.',
    },
    // a product monorepo (NestJS server, React front, shared package), not a library; graded with
    // its own TypeScript program: GI_TSCONFIG=bench/agentic/tsconfig/twenty.json
    twenty: {
        source: path.join(WORK, 'repos', 'twenty'),
        fetch: `git clone --filter=blob:none https://github.com/twentyhq/twenty.git ${path.join(WORK, 'repos', 'twenty')}`,
        language: 'typescript',
    },
    networkx: {
        source: path.join(WORK, 'repos', 'networkx'),
        fetch: `git clone --filter=blob:none https://github.com/networkx/networkx.git ${path.join(WORK, 'repos', 'networkx')}`,
        language: 'python',
        runner: 'pytest',
        srcPrefix: 'networkx/',
        testRe: '/tests/',
        testHint: 'from the repository root, `pytest networkx/algorithms/tests/test_cycles.py` runs one test file (pytest and numpy are installed; scipy is not, so tests that need it are skipped).',
    },
    // a large pure-Python library (mpmath, plus hypothesis for its test suite, are installed in the test environment)
    sympy: {
        source: path.join(WORK, 'repos', 'sympy'),
        fetch: `git clone --filter=blob:none https://github.com/sympy/sympy.git ${path.join(WORK, 'repos', 'sympy')}`,
        language: 'python',
        runner: 'pytest',
        srcPrefix: 'sympy/',
        testRe: '/tests/',
        testHint: 'from the repository root, `pytest sympy/sets/tests/test_sets.py` runs one test file (pytest, mpmath and hypothesis are installed).',
    },
};
