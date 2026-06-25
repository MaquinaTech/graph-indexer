/**
 * @file parse/taint-patterns.mjs
 * @description Source / sink / sanitizer catalogs for taint analysis (C2). Heuristic, line-scannable
 *              regexes per language family — the basis for a *finder*, not a verifier (see
 *              mcp/taint.mjs and docs/internals/PHASE3_TAINT_ANALYSIS.md for the honesty caveats).
 *
 *              SOURCES = untrusted input (request bodies, argv/env, stdin, file/socket reads).
 *              SINKS   = dangerous operations, grouped by category (rce | sqli | xss | path | ssrf).
 *              SANITIZERS = constructs that neutralise taint (escape/encode/parameterise/validate).
 *
 *              v1 covers the JS/TS family ('js') and Python ('py'); other languages return no
 *              patterns (the analysis simply finds nothing for them).
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */

/** Normalise a file extension to a pattern-catalog key, or null if unsupported. */
export function langKeyForExt(ext) {
    if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) return 'js';
    if (ext === '.py') return 'py';
    return null;
}

/** Untrusted-input sources: { re, kind }. */
export const SOURCES = {
    js: [
        { re: /\breq(uest)?\.(body|query|params|cookies|headers|url|originalUrl)\b/, kind: 'http-request' },
        { re: /\bctx\.(request|query|params|body)\b/, kind: 'http-request' },          // Koa
        { re: /\bprocess\.(argv|env)\b/, kind: 'process-input' },
        { re: /\.on\s*\(\s*['"]data['"]/, kind: 'socket-data' },
        { re: /\b(location\.(search|hash|href)|document\.(URL|cookie|referrer))\b/, kind: 'dom-input' },
    ],
    py: [
        { re: /\brequest\.(GET|POST|data|args|form|json|values|cookies|files|headers)\b/, kind: 'http-request' },
        { re: /\b(sys\.argv|os\.environ)\b/, kind: 'process-input' },
        { re: /\binput\s*\(/, kind: 'stdin' },
        { re: /\bflask\.request\b|\bself\.get_argument\s*\(/, kind: 'http-request' },
    ],
};

/** Dangerous sinks: { re, category, label }. Categories: rce | sqli | xss | path | ssrf. */
export const SINKS = {
    js: [
        { re: /\beval\s*\(/, category: 'rce', label: 'eval()' },
        { re: /\bnew\s+Function\s*\(/, category: 'rce', label: 'new Function()' },
        { re: /\b(child_process\b|\bexecSync\b|\bexecFile\b|\bexec\s*\(|\bspawn\s*\()/, category: 'rce', label: 'child_process exec/spawn' },
        { re: /\.(query|execute|raw)\s*\(/, category: 'sqli', label: 'db query/execute' },
        { re: /(\.innerHTML\s*=|dangerouslySetInnerHTML|\bres\.(send|write|end)\s*\()/, category: 'xss', label: 'html sink' },
        { re: /\b(fs\.(readFile|writeFile|unlink|createReadStream|createWriteStream|appendFile)(Sync)?|path\.join|res\.sendFile)\s*\(/, category: 'path', label: 'fs/path sink' },
        { re: /\b(fetch|axios|got|superagent)\s*\(|\bhttps?\.request\s*\(/, category: 'ssrf', label: 'outbound request' },
    ],
    py: [
        { re: /\b(eval|exec)\s*\(/, category: 'rce', label: 'eval/exec' },
        { re: /\bos\.system\s*\(|\bsubprocess\.(call|run|Popen|check_output)\s*\(|\bos\.popen\s*\(/, category: 'rce', label: 'os.system/subprocess' },
        { re: /\.execute(many)?\s*\(|\bcursor\.execute\s*\(|\.raw\s*\(/, category: 'sqli', label: 'cursor.execute' },
        { re: /\b(mark_safe|render_template_string|HttpResponse)\s*\(/, category: 'xss', label: 'html sink' },
        { re: /\b(open|send_file|os\.path\.join)\s*\(/, category: 'path', label: 'open/send_file' },
        { re: /\brequests\.(get|post|put|delete|request)\s*\(|\burllib\.|\burlopen\s*\(/, category: 'ssrf', label: 'outbound request' },
    ],
};

/** Taint-clearing constructs: any match in/around the flow lowers a finding's confidence. */
export const SANITIZERS = {
    js: [
        /\b(escape|encodeURI|encodeURIComponent|sanitize|DOMPurify|validator|xss)\b/i,
        /\b(parameteriz|prepared|placeholder)\b/i,
        /\b(Number|parseInt|parseFloat)\s*\(/,
    ],
    py: [
        /\b(shlex\.quote|escape|bleach|markupsafe|secure_filename|quote)\b/i,
        /\b(parameteriz|placeholder)\b/i,
        /\bint\s*\(|\bfloat\s*\(/,
    ],
};

/** Human-readable severity order for sink categories (worst first). */
export const CATEGORY_SEVERITY = ['rce', 'sqli', 'ssrf', 'path', 'xss'];
