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

// constructors named by the language rather than declared as such: a method called `initialize` is
// Ruby's constructor (`Foo.new`) but an ordinary method in TypeScript or Python
const CONSTRUCTOR_NAMES = {
    javascript: ['constructor'], typescript: ['constructor'], tsx: ['constructor'],
    python: ['__init__', '__new__'], ruby: ['initialize'], php: ['__construct'],
};

/**
 * Is this definition a constructor, invoked through its class (`new Foo()`, `Foo()`, `Foo.new`)?
 * `sym`: { name, kind, lang } — a language id, as the index stores it.
 */
export function isConstructor(sym) {
    if (!sym) return false;
    if (sym.kind === 'constructor') return true;
    return CONSTRUCTOR_NAMES[sym.lang]?.includes(sym.name) ?? false;
}
