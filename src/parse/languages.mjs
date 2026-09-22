/**
 * Language registry: file extension → extraction spec.
 */
import path from 'node:path';
import { javascript, typescript, tsx } from './lang/ecma.mjs';
import { python } from './lang/python.mjs';
import { go } from './lang/go.mjs';
import { java } from './lang/jvm.mjs';
import { kotlin } from './lang/kotlin.mjs';
import { csharp } from './lang/csharp.mjs';
import { rust } from './lang/rust.mjs';
import { c, cpp } from './lang/native.mjs';
import { ruby, php, bash } from './lang/scripting.mjs';
import { scala, css } from './lang/misc.mjs';

export const LANGUAGES = [javascript, typescript, tsx, python, go, java, kotlin, scala, csharp, rust, c, cpp, ruby, php, bash, css];

const byExt = new Map();
for (const spec of LANGUAGES) for (const ext of spec.extensions) byExt.set(ext, spec);

/** Headers are ambiguous between C and C++; a sibling .cpp/.cc or C++ syntax decides at index time. */
export function specForPath(p) {
    const base = path.basename(p);
    const ext = path.extname(base).toLowerCase();
    if (base.endsWith('.d.ts')) return typescript;
    return byExt.get(ext) ?? null;
}

export function supportedExtensions() { return [...byExt.keys()]; }

export function languageById(id) { return LANGUAGES.find(l => l.id === id) ?? null; }
