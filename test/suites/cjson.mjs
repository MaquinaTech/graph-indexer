/**
 * test/suites/cjson.mjs
 *
 * Ground-truth query set for cJSON (C) — a subset of DaveGamble/cJSON.
 * Source: https://github.com/DaveGamble/cJSON
 *
 * Key source layout:
 *   cJSON.c        — the whole public API + internal parser/printer:
 *                      cJSON_Parse / cJSON_ParseWithOpts / cJSON_ParseWithLength,
 *                      parse_value / parse_string / parse_number / parse_hex4 /
 *                      utf16_literal_to_utf8, cJSON_Print / cJSON_PrintUnformatted /
 *                      cJSON_PrintBuffered, print_value, cJSON_Minify / minify_string /
 *                      skip_oneline_comment / skip_multiline_comment,
 *                      cJSON_CreateObject / cJSON_CreateArray / cJSON_CreateString,
 *                      cJSON_AddItemToObject / cJSON_AddStringToObject,
 *                      cJSON_GetObjectItem / cJSON_GetObjectItemCaseSensitive /
 *                      cJSON_GetArrayItem, cJSON_Delete, cJSON_Duplicate,
 *                      cJSON_Compare, cJSON_InitHooks, internal_malloc/internal_free
 *   cJSON.h        — struct cJSON, cJSON_Hooks
 *   cJSON_Utils.c  — JSON Pointer (RFC 6901) + JSON Patch (RFC 6902) helpers:
 *                      cJSONUtils_GetPointer, cJSONUtils_ApplyPatches,
 *                      cJSONUtils_MergePatch, cJSONUtils_GenerateMergePatch
 *   tests/         — Unity-based unit tests (not the public API)
 */

export const META = {
    id: 'cjson',
    displayName: 'cJSON',
    language: 'C',
    version: 'subset',
    url: 'https://github.com/DaveGamble/cJSON',
    expectedMinChunks: 200,
    expectedMinFiles: 30,
};

export const QUERIES = [
    // ── EASY (symbolic keyword lookup) ─────────────────────────────────────────

    {
        id: 'CJ01',
        query: 'cJSON_Minify',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'cJSON_Minify — strips whitespace and comments from a JSON string in place',
        expected_names: ['cJSON_Minify'],
        expected_files: ['cJSON.c'],
    },
    {
        id: 'CJ02',
        query: 'cJSON_Delete free item',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'cJSON_Delete — recursively frees a cJSON item and its children',
        expected_names: ['cJSON_Delete'],
        expected_files: ['cJSON.c'],
    },
    {
        id: 'CJ03',
        query: 'duplicate clone a JSON item recursively',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'cJSON_Duplicate — deep-copies a JSON item and its subtree (adapted from seed)',
        expected_names: ['cJSON_Duplicate'],
        expected_files: ['cJSON.c'],
    },
    {
        id: 'CJ04',
        query: 'get object item by key string lookup',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'cJSON_GetObjectItem — looks up a child of an object by its key',
        expected_names: ['cJSON_GetObjectItem', 'cJSON_GetObjectItemCaseSensitive'],
        expected_files: ['cJSON.c'],
    },

    // ── MEDIUM (keyword over a small cluster) ──────────────────────────────────

    {
        id: 'CJ05',
        query: 'print render JSON tree to string formatted unformatted',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'cJSON_Print / cJSON_PrintUnformatted — serialise a tree back to a JSON text string',
        expected_names: ['cJSON_Print', 'cJSON_PrintUnformatted', 'cJSON_PrintBuffered'],
        expected_files: ['cJSON.c'],
    },
    {
        id: 'CJ06',
        query: 'create object array string number node',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'cJSON_Create* constructors that allocate new typed value nodes',
        expected_names: ['cJSON_CreateObject', 'cJSON_CreateArray', 'cJSON_CreateString', 'cJSON_CreateNumber'],
        expected_files: ['cJSON.c'],
    },
    {
        id: 'CJ07',
        query: 'add item to object set key value pair',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'cJSON_AddItemToObject / cJSON_AddStringToObject — attach a child under a key',
        expected_names: ['cJSON_AddItemToObject', 'cJSON_AddStringToObject', 'add_item_to_object'],
        expected_files: ['cJSON.c'],
    },

    // ── NL / SEMANTIC (behavioural — never naming the symbol) ──────────────────

    {
        id: 'CJ08',
        query: 'parse a JSON text string into an in-memory tree of value nodes',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'cJSON_Parse — the top-level entry point that turns JSON text into a value tree (seed)',
        expected_names: ['cJSON_Parse', 'cJSON_ParseWithOpts', 'cJSON_ParseWithLength'],
        expected_files: ['cJSON.c'],
    },
    {
        id: 'CJ09',
        query: 'remove the whitespace and comments from a block of text so it becomes compact',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Behavioural search for the minifier (cJSON_Minify / minify_string and comment skippers)',
        expected_names: ['cJSON_Minify', 'minify_string', 'skip_oneline_comment', 'skip_multiline_comment'],
        expected_files: ['cJSON.c'],
    },
    {
        id: 'CJ10',
        query: 'decode an escaped unicode character sequence into its actual UTF-8 bytes',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Behavioural search for the \\uXXXX escape decoder (parse_hex4 / utf16_literal_to_utf8)',
        expected_names: ['utf16_literal_to_utf8', 'parse_hex4'],
        expected_files: ['cJSON.c'],
    },

    // ── XC (cross-cutting concerns, phrased behaviourally) ─────────────────────

    {
        id: 'CJ11',
        query: 'compare two JSON values for deep structural equality',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'cJSON_Compare — recursively checks two values for equality (seed)',
        expected_names: ['cJSON_Compare'],
        expected_files: ['cJSON.c'],
    },
    {
        id: 'CJ12',
        query: 'navigate into a nested document by following a slash-separated path expression',
        kind: 'xc',
        difficulty: 'semantic',
        topK: 10,
        description: 'JSON Pointer (RFC 6901) traversal — cJSONUtils_GetPointer / get_item_from_pointer',
        expected_names: ['cJSONUtils_GetPointer', 'get_item_from_pointer', 'cJSONUtils_GetPointerCaseSensitive'],
        expected_files: ['cJSON_Utils.c'],
    },

    // ── HELD-OUT (validation only — fresh, different targets, never tuned) ──────
    {
        id: 'HO-CJ1',
        query: 'override the default memory allocator with custom malloc and free hooks',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'cJSON_InitHooks — installs caller-provided malloc/free implementations',
        expected_names: ['cJSON_InitHooks'],
        expected_files: ['cJSON.c'],
        heldOut: true,
    },
    {
        id: 'HO-CJ2',
        query: 'apply a sequence of JSON patch operations to mutate a document',
        kind: 'xc',
        difficulty: 'semantic',
        topK: 10,
        description: 'cJSONUtils_ApplyPatches — applies an RFC 6902 patch array',
        expected_names: ['cJSONUtils_ApplyPatches', 'cJSONUtils_ApplyPatchesCaseSensitive'],
        expected_files: ['cJSON_Utils.c'],
        heldOut: true,
    },
    {
        id: 'HO-CJ3',
        query: 'cJSON_GetArrayItem',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'cJSON_GetArrayItem — returns the element of an array at a given index',
        expected_names: ['cJSON_GetArrayItem'],
        expected_files: ['cJSON.c'],
        heldOut: true,
    },
];
