/**
 * Markdown documentation: one `section` definition per heading, spanning the text up to the next
 * heading of the same or a higher level, nested like the headings. Sections are searchable
 * (search_code, explore) and readable by name (read_code "docs/ARCHITECTURE.md:Storage"), so a
 * question about why or how something is designed finds the design notes next to the code.
 * No grammar: headings are read line by line, skipping fenced code blocks.
 */

const ATX = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Heading text without inline markup: `code`, **bold**, [links](…), <tags>. */
function plain(s) {
    return s.replace(/<[^>]+>/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim();
}

export function extractMarkdown(source) {
    const lines = source.split('\n');
    const heads = []; // { level, text, line }
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const f = FENCE.exec(l);
        if (f) {
            if (!fence) fence = f[1][0];
            else if (f[1][0] === fence) fence = null;
            continue;
        }
        if (fence) continue;
        const m = ATX.exec(l);
        if (m) { const text = plain(m[2]); if (text) heads.push({ level: m[1].length, text, line: i + 1 }); continue; }
        // setext: a non-blank paragraph line underlined with === or ---
        if (i + 1 < lines.length && SETEXT.test(lines[i + 1]) && l.trim() && !/^ {0,3}([-*+>]|\d+[.)]|\|)/.test(l) && (i === 0 || !lines[i - 1].trim())) {
            const text = plain(l);
            if (text) { heads.push({ level: lines[i + 1].trim()[0] === '=' ? 1 : 2, text, line: i + 1 }); i++; }
        }
    }
    const symbols = [];
    const stack = []; // indices into symbols, by nesting
    for (let h = 0; h < heads.length; h++) {
        const { level, text, line } = heads[h];
        let end = lines.length;
        for (let k = h + 1; k < heads.length; k++) if (heads[k].level <= level) { end = heads[k].line - 1; break; }
        while (end > line && !lines[end - 1].trim()) end--;
        while (stack.length && symbols[stack[stack.length - 1]].level >= level) stack.pop();
        const parentIdx = stack.length ? stack[stack.length - 1] : -1;
        const parent = parentIdx >= 0 ? symbols[parentIdx] : null;
        // first paragraph under the heading, as its doc line
        let doc = '';
        for (let k = line; k < Math.min(end, line + 30); k++) {
            const t = lines[k].trim();
            if (!t) { if (doc) break; continue; }
            if (ATX.test(lines[k]) || FENCE.test(lines[k]) || /^[|<]/.test(t)) { if (doc) break; continue; }
            doc += (doc ? ' ' : '') + plain(t.replace(/^([-*+>]|\d+[.)])\s+/, ''));
            if (doc.length > 240) break;
        }
        symbols.push({
            name: text,
            qname: parent ? `${parent.qname} › ${text}` : text,
            kind: 'section',
            level,
            parentIdx,
            lexParent: parentIdx,
            owner: null,
            startLine: line, startCol: 0,
            endLine: Math.max(line, end), endCol: (lines[Math.max(line, end) - 1] ?? '').length,
            nameLine: line, nameCol: lines[line - 1].indexOf(text[0]) >= 0 ? lines[line - 1].indexOf(text[0]) : 0,
            sig: `${'#'.repeat(level)} ${text}`,
            doc: doc.slice(0, 300) || null,
            exported: true,
            visibility: null,
            decorators: [],
            bases: [],
            type: null,
            isStatic: false,
        });
        stack.push(symbols.length - 1);
    }
    for (const s of symbols) delete s.level;
    return { symbols, refs: [], imports: [], fields: [], fileInfo: null, errors: 0 };
}

export const markdown = {
    id: 'markdown',
    docs: true,                       // prose: indexed for search and reading, never parsed as code
    extensions: ['.md', '.mdx', '.markdown'],
    testFile: null,
    extract: (source) => extractMarkdown(source),
};
