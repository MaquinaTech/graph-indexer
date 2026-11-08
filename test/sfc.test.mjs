/**
 * Single-file components (Vue, Svelte): the template's component tags are uses of the components
 * the script imports, bound like calls; and the default-export resolution they rely on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const uses = (intel, file) => intel.store.all(`SELECT r.name, r.line, s.qname, f2.path AS target FROM refs r JOIN files f ON f.id = r.file_id
    LEFT JOIN symbols s ON s.id = r.dst_id LEFT JOIN files f2 ON f2.id = s.file_id WHERE f.path = ? AND r.kind = 'call' ORDER BY r.line, r.col`, file)
    .map(r => `${r.line} ${r.name} → ${r.target ?? '?'}`);

test('Vue and Svelte: template tags are uses of the imported components', async (t) => {
    const root = makeRepo({
        'package.json': '{"name":"app","imports":{"#/*":"./src/*"}}\n',
        'svelte.config.js': "export default { kit: { alias: { '$ui': 'src/ui' } } };\n",
        'src/util.ts': 'export function formatName(n: string) { return n.trim(); }\n',
        'src/components/UserCard.vue': [
            '<script setup lang="ts">',
            "import { formatName } from '../util'",
            'const props = defineProps<{ name: string }>()',
            'const label = formatName(props.name)',
            '</script>',
            '',
            '<template>',
            '  <div class="card">{{ label }}</div>',
            '</template>',
            '',
        ].join('\n'),
        'src/components/user-list.vue': [
            '<template>',
            '  <ul>',
            '    <!-- <UserCard /> -->',
            '    <user-card v-for="u in users" :name="u" />',                 // 4
            '    <Transition><Card name="x"/></Transition>',                    // 5
            '    <ExternalButton />',
            '  </ul>',
            '</template>',
            '',
            '<script>',
            "import Card from '#/components/UserCard.vue'",
            "import UserCard from './UserCard.vue'",
            "import { ExternalButton } from 'some-ui-kit'",
            'export default {',
            '  components: { UserCard, Card, ExternalButton },',
            '}',
            '</script>',
            '',
        ].join('\n'),
        'src/components/index.ts': "export { default as ProfileCard } from './UserCard.vue';\n",
        'src/pages/Profile.vue': "<script setup>\nimport { ProfileCard } from '../components'\n</script>\n<template>\n  <ProfileCard name=\"me\" />\n</template>\n",
        'src/lib/Badge.svelte': '<script>export let kind;</script><span>{kind}</span>\n',
        'src/ui/Valves.svelte': '<script>export let v;</script><b>{v}</b>\n',
        'src/routes/Valves.svelte': [
            '<script lang="ts">',
            "  import Badge from '$lib/Badge.svelte';",
            "  import Valves from '$ui/Valves.svelte';",
            "  import UserCard from '../components/UserCard.vue';",
            '  export let title = \'\';',
            '</script>',
            '',
            '<h1>{title}</h1>',
            '<Badge kind="new" /><UserCard name="a" />',                        // 9
            '<Valves v={1} />',                                                 // 10
            '',
            '<style>',
            '  h1 { color: red; }',
            '</style>',
            '',
        ].join('\n'),
    });
    const intel = new CodeIntel({ root });
    await intel.open();
    t.after(() => { intel.close(); rmrf(root); });

    assert.deepEqual(uses(intel, 'src/components/user-list.vue'), [
        '4 UserCard → src/components/UserCard.vue',
        '5 Card → src/components/UserCard.vue',
    ], 'kebab-case tag, a package.json #-import, no commented-out tag, no built-in, no library component');
    assert.deepEqual(uses(intel, 'src/components/UserCard.vue'), ['4 formatName → src/util.ts'], 'the script is extracted as TypeScript');
    assert.deepEqual(uses(intel, 'src/pages/Profile.vue'), ['5 ProfileCard → src/components/UserCard.vue'], '`export { default as X }` follows to the component');
    assert.deepEqual(uses(intel, 'src/routes/Valves.svelte'), [
        '9 Badge → src/lib/Badge.svelte',
        '9 UserCard → src/components/UserCard.vue',
        '10 Valves → src/ui/Valves.svelte',
    ], 'SvelteKit $lib and kit.alias; a component using another of its own name');

    const refs = await callTool(intel, 'find_references', { symbol: 'UserCard' });
    assert.match(refs, /References to UserCard \(function\) src\/components\/UserCard\.vue:7-9/);
    assert.match(refs, /src\/routes\/Valves\.svelte[\s\S]*9 {2}call {6}in ValvesComponent/);
    assert.match(refs, /src\/components\/user-list\.vue[\s\S]*4 {2}call {6}in render/, 'Options API: the template is `render`');
});

test('TypeScript default exports: anonymous ones are exported; a default import is the default export', async (t) => {
    const root = makeRepo({
        'src/greet.ts': "import { greet } from './other';\nexport default function () { return greet(); }\n",
        'src/other.ts': 'export function greet() { return 1; }\n',
        'src/main.ts': "import greet from './greet';\nexport const x = greet();\n",
    });
    const intel = new CodeIntel({ root });
    await intel.open();
    t.after(() => { intel.close(); rmrf(root); });
    assert.deepEqual(uses(intel, 'src/main.ts'), ['2 greet → src/greet.ts'], 'not the `greet` that greet.ts imports');
});
