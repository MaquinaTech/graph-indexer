/**
 * @file parse/languages.mjs
 * @description Language registry: dynamic Tree-sitter grammar loading, LANGUAGE_MAP,
 *              EXTENSIONS, and getParserForFile.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import path from 'path';
import ignore from 'ignore';
import Parser from 'tree-sitter';

export const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

// ─── Dynamic Language Loading ─────────────────────────────────────────────────

function _loadProjectConfig() {
    const configPath = path.join(process.env.MCP_PROJECT_ROOT || process.cwd(), '.graph-indexer.json');
    try {
        if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch { /* ignore */ }
    return null;
}

async function _tryLang(pkg, enabledLangs, key) {
    if (enabledLangs && !enabledLangs.includes(key)) return null;
    try {
        return (await import(pkg)).default;
    } catch {
        process.stderr.write(`[graph-indexer] WARNING: ${pkg} not installed — ${key} files will be skipped\n`);
        return null;
    }
}

const _cfg = _loadProjectConfig();
const _enabled = _cfg?.languages ?? null; // null = all languages

const [
    TypeScript, JavaScript, CSS, SCSS, Python, Rust,
    Go, PHP, Java, Kotlin, CSharp, Ruby, C, Bash, Swift
] = await Promise.all([
    _tryLang('tree-sitter-typescript', _enabled, 'typescript'),
    _tryLang('tree-sitter-javascript', _enabled, 'javascript'),
    _tryLang('tree-sitter-css', _enabled, 'css'),
    // SCSS shares the 'css' enable-key — init records .css and .scss under one
    // 'css' language, so the SCSS grammar must load whenever CSS is enabled.
    _tryLang('tree-sitter-scss', _enabled, (_enabled && _enabled.includes('css')) ? 'css' : 'scss'),
    _tryLang('tree-sitter-python', _enabled, 'python'),
    _tryLang('tree-sitter-rust', _enabled, 'rust'),
    _tryLang('tree-sitter-go', _enabled, 'go'),
    _tryLang('tree-sitter-php', _enabled, 'php'),
    _tryLang('tree-sitter-java', _enabled, 'java'),
    _tryLang('tree-sitter-kotlin', _enabled, 'kotlin'),
    _tryLang('tree-sitter-c-sharp', _enabled, 'csharp'),
    _tryLang('tree-sitter-ruby', _enabled, 'ruby'),
    _tryLang('tree-sitter-c', _enabled, 'c'),
    _tryLang('tree-sitter-bash', _enabled, 'bash'),
    _tryLang('tree-sitter-swift', _enabled, 'swift'),
]);

export const LANGUAGE_MAP = {
    ...(TypeScript ? { '.ts': TypeScript.typescript, '.tsx': TypeScript.tsx } : {}),
    ...(JavaScript ? { '.js': JavaScript, '.jsx': JavaScript, '.mjs': JavaScript, '.cjs': JavaScript } : {}),
    ...(CSS ? { '.css': CSS } : {}),
    ...(SCSS ? { '.scss': SCSS } : (CSS ? { '.scss': CSS } : {})),
    ...(Python ? { '.py': Python } : {}),
    ...(Rust ? { '.rs': Rust } : {}),
    ...(Go ? { '.go': Go } : {}),
    ...(PHP ? { '.php': PHP.php } : {}),
    ...(Java ? { '.java': Java } : {}),
    ...(Kotlin ? { '.kt': Kotlin, '.kts': Kotlin } : {}),
    ...(CSharp ? { '.cs': CSharp } : {}),
    ...(Ruby ? { '.rb': Ruby } : {}),
    // C maps .c sources and .h headers (structs/typedefs/macros live in headers).
    ...(C ? { '.c': C, '.h': C } : {}),
    // Bash maps .sh and .bash; shebang-only extensionless scripts are not keyed.
    ...(Bash ? { '.sh': Bash, '.bash': Bash } : {}),
    ...(Swift ? { '.swift': Swift } : {}),
};

export const EXTENSIONS = new Set(Object.keys(LANGUAGE_MAP));

export function getParserForFile(ext) {
    const language = LANGUAGE_MAP[ext];
    if (!language) return null;
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
}
