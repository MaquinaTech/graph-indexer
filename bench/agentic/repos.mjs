/**
 * Repositories the agentic benchmark runs in. `source` is a local git repository (relative to the
 * graph-indexer root) holding every commit the tasks use; `setupWorktree` runs in each fresh
 * worktree of an edit task (dependencies are linked from a prepared environment, not reinstalled);
 * `testHint` tells the agent how to run tests, identically for every arm.
 */
export const REPOS = {
    nestjs: {
        source: 'test/fixtures/nestjs',
        fetch: 'node bench/fixtures.mjs',
        language: 'typescript',
    },
};
