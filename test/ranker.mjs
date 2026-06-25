/**
 * @file test/ranker.mjs
 * @description Tests the D3 learned re-ranker (search-core.mjs): feature extraction, the linear
 *              score, deterministic re-ordering with id tie-break, graceful degradation when the
 *              symbol-graph features are absent, and that an empty/short pool is returned unchanged
 *              (so the default RRF path is untouched). Pure — no store, no parser.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    RANKER_FEATURES, DEFAULT_RANKER_MODEL, extractRankerFeatures, scoreLearned, learnedRerank,
} from '../search-core.mjs';

const R = (id, name, score, node_type = 'function_declaration', file_path = 'src/a.ts') =>
    ({ score, chunk: { id, name, node_type, file_path } });

test('ranker: model shape — every feature has a weight', () => {
    for (const f of RANKER_FEATURES) assert.equal(typeof DEFAULT_RANKER_MODEL.weights[f], 'number', f);
    assert.ok(DEFAULT_RANKER_MODEL.weights.is_test < 0, 'is_test is a penalty');
});

test('ranker: extractRankerFeatures normalizes + reads the accessors', () => {
    const ctx = {
        maxScore: 2,
        getCentrality: (id) => (id === 'a' ? { score: 0.9, rank: 1, total: 10 } : null),
        getInEdges: (id) => (id === 'a' ? [{ confidence: 'resolved' }, { confidence: 'high' }] : []),
        gitScoreFor: () => 0.5,
    };
    const f = extractRankerFeatures(R('a', 'foo', 1), 0, ctx);
    assert.equal(f.rrf, 0.5, 'rrf = score/maxScore');
    assert.equal(f.rank, 1, '1/(1+0)');
    assert.equal(f.centrality, 0.9);
    assert.equal(f.in_degree, 0.2, '2/10 squashed');
    assert.equal(f.resolved_in, 0.2, '1/5 squashed');
    assert.equal(f.git, 0.5);
    assert.equal(f.is_def, 1, 'function_declaration is a def');
    assert.equal(f.is_test, 0);
    // a test-file expression chunk: is_def 0, is_test 1
    const t = extractRankerFeatures(R('b', 'spec', 1, 'expression_statement', 'src/a.test.ts'), 3, { maxScore: 1 });
    assert.equal(t.is_def, 0);
    assert.equal(t.is_test, 1);
    assert.equal(t.centrality, 0, 'no accessor → 0 (degrades without --symbol-graph)');
});

test('ranker: scoreLearned is a deterministic dot product', () => {
    const feats = { rrf: 1, rank: 1, centrality: 0, in_degree: 0, resolved_in: 0, git: 0, is_def: 1, is_test: 0 };
    const m = { bias: 0.1, weights: { rrf: 2, rank: 0.5, is_def: 0.3 } };
    assert.equal(scoreLearned(feats, m), 0.1 + 2 * 1 + 0.5 * 1 + 0.3 * 1);
    assert.equal(scoreLearned(feats, m), scoreLearned(feats, m), 'deterministic');
});

test('ranker: learnedRerank USES centrality/resolved-in-degree when the model weights them', () => {
    // Mechanism test: with a model that weights the structure features, a central, resolved-callers
    // hit overtakes a bare lexical one. (The SHIPPED default is intentionally RRF-dominant and would
    // NOT do this — that conservatism is verified by the byte-identical-to-RRF benchmark, not here.)
    const results = [R('b', 'helper', 1.0), R('a', 'Core', 0.95)];
    const ctx = {
        getCentrality: (id) => (id === 'a' ? { score: 1.0, rank: 1, total: 50 } : { score: 0.0, rank: 50, total: 50 }),
        getInEdges: (id) => (id === 'a' ? Array(8).fill({ confidence: 'resolved' }) : []),
        gitScoreFor: null,
    };
    const structureModel = { bias: 0, weights: { rrf: 1, centrality: 0.5, resolved_in: 0.5 } };
    const out = learnedRerank(results, ctx, structureModel);
    assert.equal(out[0].chunk.id, 'a', 'the central, resolved-in-degree symbol is lifted to rank-1');
    assert.equal(out.length, 2);
});

test('ranker: degrades to ≈RRF order when no graph features are present', () => {
    // Without centrality/in-degree accessors, ordering is driven by rrf + rank + is_def — a strictly
    // higher RRF (and same node type) keeps rank-1.
    const results = [R('x', 'Top', 2.0), R('y', 'Low', 0.5)];
    const out = learnedRerank(results, { getCentrality: null, getInEdges: null, gitScoreFor: null });
    assert.equal(out[0].chunk.id, 'x', 'higher RRF stays on top with no graph signal');
});

test('ranker: deterministic tie-break on id; short pools returned unchanged', () => {
    // Force a genuine tie: an rrf-only model (no position-dependent `rank` term) over two
    // equal-score candidates → equal learned score → tie broken by id ascending.
    const tied = [R('z', 'n', 1.0), R('a', 'n', 1.0)];
    const out = learnedRerank(tied, {}, { bias: 0, weights: { rrf: 1 } });
    assert.equal(out[0].chunk.id, 'a', 'tie-break id asc');
    // ≤1 result untouched (default-path guarantee for a single hit)
    const one = [R('solo', 'n', 1.0)];
    assert.equal(learnedRerank(one, {}), one, 'single result returned as-is');
    assert.deepEqual(learnedRerank([], {}), [], 'empty unchanged');
});
