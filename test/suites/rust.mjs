/**
 * test/suites/rust.mjs
 *
 * Ground-truth query set for a subset of serde-rs/json (Rust).
 * Source: https://github.com/serde-rs/json
 *
 * Key source layout:
 *   src/de.rs          — struct Deserializer, from_str/from_slice/from_reader,
 *                          StreamDeserializer, disable_recursion_limit
 *   src/ser.rs         — Serializer, to_string / to_string_pretty / to_writer,
 *                          PrettyFormatter, format_escaped_str
 *   src/error.rs       — struct Error, enum Category, classify()
 *   src/number.rs      — struct Number, is_i64/as_i64/as_f64
 *   src/map.rs         — struct Map (ordered), insert/get/entry/sort_keys, Entry
 *   src/raw.rs         — struct RawValue (unparsed JSON)
 *   src/read.rs        — parse_escape / parse_unicode_escape / decode_four_hex_digits
 *   src/value/mod.rs   — enum Value, pointer / pointer_mut, to_value / from_value
 *
 * Names below are drawn ONLY from bench/_chunks/rust.json (the indexed universe).
 */

export const META = {
    id: 'rust',
    displayName: 'serde_json (subset)',
    language: 'Rust',
    version: 'subset',
    url: 'https://github.com/serde-rs/json',
    expectedMinChunks: 80,
    expectedMinFiles: 20,
};

export const QUERIES = [
    // ── EASY (symbolic name lookup) ─────────────────────────────────────────────

    {
        id: 'RS01',
        query: 'Deserializer',
        difficulty: 'easy',
        topK: 5,
        description: 'Deserializer — drives parsing a JSON document from an input source',
        expected_names: ['Deserializer'],
        expected_files: ['de.rs'],
    },
    {
        id: 'RS02',
        query: 'Number is_i64 as_f64',
        difficulty: 'easy',
        topK: 5,
        description: 'Number type and its as_i64/as_f64 accessors for JSON numeric values',
        expected_names: ['Number', 'as_i64', 'as_f64', 'is_i64'],
        expected_files: ['number.rs'],
    },
    {
        id: 'RS03',
        query: 'RawValue',
        difficulty: 'easy',
        topK: 5,
        description: 'RawValue — a reference to a raw, not-yet-parsed piece of JSON',
        expected_names: ['RawValue'],
        expected_files: ['raw.rs'],
    },
    {
        id: 'RS04',
        query: 'PrettyFormatter pretty print indent',
        difficulty: 'easy',
        topK: 5,
        description: 'PrettyFormatter — formatter that emits indented, human-readable JSON',
        expected_names: ['PrettyFormatter'],
        expected_files: ['ser.rs'],
    },

    // ── MEDIUM (keyword lookup, multiple acceptable targets) ────────────────────

    {
        id: 'RS05',
        query: 'parse json from string slice reader',
        difficulty: 'medium',
        topK: 5,
        description: 'Top-level deserialize entry points reading from a &str, byte slice or reader',
        expected_names: ['from_str', 'from_slice', 'from_reader'],
        expected_files: ['de.rs'],
    },
    {
        id: 'RS06',
        query: 'serialize value to json string writer',
        difficulty: 'medium',
        topK: 5,
        description: 'Top-level serialize entry points producing a String or writing to a writer',
        expected_names: ['to_string', 'to_string_pretty', 'to_writer'],
        expected_files: ['ser.rs'],
    },
    {
        id: 'RS07',
        query: 'map insert get entry by key',
        difficulty: 'medium',
        topK: 5,
        description: 'Map of String keys to Values with insert / get / entry operations',
        expected_names: ['Map', 'insert', 'get', 'entry'],
        expected_files: ['map.rs'],
    },
    {
        id: 'RS08',
        query: 'error category classify io syntax data eof',
        difficulty: 'medium',
        topK: 5,
        description: 'Error type and its Category classification (Io / Syntax / Data / Eof)',
        expected_names: ['Error', 'Category', 'classify'],
        expected_files: ['error.rs'],
    },

    // ── HARD / SEMANTIC (cross-cutting + behavioural; target NOT named) ─────────

    {
        id: 'RS09',
        query: 'decode a backslash escape sequence and a \\u four-hex-digit unicode code point including surrogate pairs',
        difficulty: 'hard',
        topK: 10,
        description: 'String-escape handling while reading: parse \\n, \\t and \\uXXXX unicode escapes',
        expected_names: ['parse_escape', 'parse_unicode_escape', 'decode_four_hex_digits'],
        expected_files: ['read.rs'],
    },
    {
        id: 'RS10',
        query: 'look up a deeply nested value inside a document using a slash-separated path expression',
        difficulty: 'semantic',
        topK: 10,
        description: 'JSON Pointer (RFC 6901) lookup that walks nested objects/arrays by a "/a/b/0" path',
        expected_names: ['pointer', 'pointer_mut'],
        expected_files: ['value/mod.rs'],
    },
    {
        id: 'RS11',
        query: 'convert any serializable Rust data structure into an in-memory dynamic JSON value tree without going through text',
        difficulty: 'semantic',
        topK: 10,
        description: 'to_value — turn a T:Serialize into a Value enum directly',
        expected_names: ['to_value', 'from_value'],
        expected_files: ['value'],
    },
    {
        id: 'RS12',
        query: 'iterate over a stream of concatenated JSON documents one after another from a single input',
        difficulty: 'semantic',
        topK: 10,
        description: 'StreamDeserializer — yields successive JSON values from a continuous input',
        expected_names: ['StreamDeserializer'],
        expected_files: ['de.rs'],
    },

    // ── HELD-OUT (validation only — never used to tune ranking) ──
    {
        id: 'HO-RS1',
        query: 'sort_keys',
        difficulty: 'easy',
        topK: 5,
        description: 'Reorder a map so its keys are in sorted order',
        expected_names: ['sort_keys'],
        expected_files: ['map.rs'],
        heldOut: true,
    },
    {
        id: 'HO-RS2',
        query: 'turn off the maximum nesting depth guard that protects against stack overflow on deeply nested input',
        difficulty: 'semantic',
        topK: 10,
        description: 'disable_recursion_limit — removes the recursion-depth safety cap on the deserializer',
        expected_names: ['disable_recursion_limit'],
        expected_files: ['de.rs'],
        heldOut: true,
    },
    {
        id: 'HO-RS3',
        query: 'write a string field to the output while escaping characters that are not valid raw JSON',
        difficulty: 'semantic',
        topK: 10,
        description: 'format_escaped_str — emits a JSON string literal with proper escaping',
        expected_names: ['format_escaped_str'],
        expected_files: ['ser.rs'],
        heldOut: true,
    },
];
