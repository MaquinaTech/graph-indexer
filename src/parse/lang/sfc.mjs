/**
 * Single-file components: Vue (`.vue`) and Svelte (`.svelte`). The `<script>` blocks are TypeScript
 * or JavaScript, extracted as such; the template is where a component uses others, the edge that
 * "find the uses of this component" needs.
 *
 * The source is rewritten before parsing, every line kept where it is: the script blocks stay as
 * they are, everything else becomes blank, and the template becomes a function — the component's
 * default export, named in PascalCase after its file (`…Component` when the script imports another
 * component of that name; `render` when the script has
 * its own `export default {…}`, the Options API) — in which each tag of a component the script
 * imports or declares is a call at the tag's line: `<UserCard :user="u" />` and
 * `<user-card>` are calls to `UserCard`, bound through the script's import like any other.
 * Tags of components registered globally (`app.component(…)`) and not named in the script are left
 * out, as are HTML elements and the frameworks' own (`<Transition>`, `<svelte:self>`).
 */
import { typescript } from './ecma.mjs';

const BUILTIN = new Set(['Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense', 'Component', 'Slot', 'Template', 'RouterView', 'RouterLink']);

const pascal = (tag) => tag.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());

/** [start, end) offsets of the content of each `<name …>…</name>` block at the top level. */
function blocks(source, name) {
    const out = [];
    const open = new RegExp(`<${name}(\\s[^>]*)?>`, 'gi');
    let m;
    while ((m = open.exec(source))) {
        const start = m.index + m[0].length;
        const close = source.toLowerCase().indexOf(`</${name}>`, start);
        if (close < 0) break;
        out.push([start, close, m.index]);
        open.lastIndex = close + name.length + 3;
    }
    return out;
}

/** Vue's template: from its opening tag to the last `</template>` (templates nest, for slots). */
function vueTemplate(source) {
    const m = /<template(\s[^>]*)?>/i.exec(source);
    if (!m) return null;
    const end = source.toLowerCase().lastIndexOf('</template>');
    return end > m.index ? [m.index + m[0].length, end, m.index] : null;
}

function rewrite(source, kind) {
    const scripts = blocks(source, 'script');
    const scriptText = scripts.map(([a, b]) => source.slice(a, b)).join('\n');
    // keep the scripts' characters, blank the rest (newlines kept, so every position stays)
    const keep = new Uint8Array(source.length);
    for (const [a, b] of scripts) keep.fill(1, a, b);
    let blanked = '';
    for (let i = 0; i < source.length; i++) blanked += keep[i] || source[i] === '\n' ? source[i] : (source[i] === '\t' ? '\t' : ' ');
    const lines = blanked.split('\n');
    const lineOf = (off) => { let n = 0; for (let i = 0; i < off; i++) if (source[i] === '\n') n++; return n; };

    // the markup: Vue's <template>, or for Svelte everything outside <script> and <style>
    let ranges;
    if (kind === 'vue') { const t = vueTemplate(source); ranges = t ? [t] : []; }
    else {
        const skip = [...scripts, ...blocks(source, 'style')].map(([a, b, tag]) => [tag, source.indexOf('>', b) + 1]).sort((x, y) => x[0] - y[0]);
        ranges = [];
        let at = 0;
        for (const [a, b] of skip) { if (a > at) ranges.push([at, a, at]); at = Math.max(at, b); }
        if (at < source.length) ranges.push([at, source.length, at]);
        ranges = ranges.filter(([a, b]) => source.slice(a, b).trim());
    }
    if (!ranges.length) return lines.join('\n');
    const known = (name) => !BUILTIN.has(name) && new RegExp(`\\b${name}\\b`).test(scriptText);
    const tags = [];
    for (const [a, b] of ranges) {
        const markup = source.slice(a, b).replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
        for (const m of markup.matchAll(/<([A-Za-z][\w-]*)/g)) {
            const raw = m[1];
            const name = kind === 'vue' && raw.includes('-') ? pascal(raw) : raw;
            if (!/^[A-Z]/.test(name) || !known(name)) continue;
            const off = a + m.index;
            const line = lineOf(off);
            tags.push({ name, line, col: off - (source.lastIndexOf('\n', off - 1) + 1) + 1 });
        }
    }
    // write `name` at `col` of a line, past what was written there already; a line grows if it must
    const cursor = new Map();
    const put = (line, col, text) => {
        let l = lines[line];
        const at = Math.max(col, cursor.get(line) ?? 0);
        if (l.length < at + text.length) l = l.padEnd(at + text.length, ' ');
        lines[line] = l.slice(0, at) + text + l.slice(at + text.length);
        cursor.set(line, at + text.length + 1);
    };
    const first = lineOf(ranges[0][2]), last = lineOf(ranges[ranges.length - 1][1]);
    const optionsApi = kind === 'vue' && /^\s*export\s+default\b/m.test(scriptText);
    put(first, 0, optionsApi ? 'function render() {' : 'export default function () {');
    for (const t of tags) put(t.line, t.col, `${t.name}();`);
    put(last, 0, '}');
    return lines.join('\n');
}

// compiler macros of `<script setup>` (Vue) and runes (Svelte 5): not functions anyone defines
const MACROS = {
    vue: ['defineProps', 'defineEmits', 'defineExpose', 'defineSlots', 'defineModel', 'defineOptions', 'withDefaults'],
    svelte: ['$state', '$derived', '$effect', '$props', '$bindable', '$inspect', '$host'],
};

const sfc = (id, extensions) => ({
    ...typescript,
    id,
    extensions,
    builtinCalls: new Set([...typescript.builtinCalls, ...MACROS[id]]),
    // the component is named in PascalCase after its file (`user-card.vue` → UserCard), as importers name it
    normalizeName: (name, d, relPath) => {
        const n = typescript.normalizeName(name, d, relPath);
        if (d.node.type !== 'export_statement' || !n) return n;
        const comp = n[0].toUpperCase() + n.slice(1);
        // a component that imports another of its own name (`Valves.svelte` using common/Valves):
        // its template's tags are that import, so the component itself takes another name
        const root = d.node.tree?.rootNode ?? d.node.parent;
        const imports = (root?.namedChildren ?? []).filter(c => c.type === 'import_statement').map(c => c.text).join('\n');
        return new RegExp(`\\b${comp}\\b`).test(imports) ? `${comp}Component` : comp;
    },
    rewriteSource: (source) => rewrite(source, id),
    testFile: /(^|\/)(__tests__|tests?|spec|e2e)\//,
});

export const vue = sfc('vue', ['.vue']);
export const svelte = sfc('svelte', ['.svelte']);
