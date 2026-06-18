/**
 * test/suites/css.mjs
 *
 * Ground-truth query set for a SCSS subset of Bootstrap.
 * Source: https://github.com/twbs/bootstrap
 *
 * Indexed symbols are SCSS @mixin / @function definitions plus one
 * `<file>_rule_set` chunk per selector block. Names come straight from the
 * fixture's symbol universe (bench/_chunks/css.json) — no invented symbols.
 *
 * Key source layout:
 *   _functions.scss             — to-rgb, color-contrast, contrast-ratio,
 *                                   tint-color, shade-color, shift-color,
 *                                   escape-svg, str-replace, divide, add, subtract
 *   mixins/_breakpoints.scss    — breakpoint-min/max/next/infix,
 *                                   media-breakpoint-up/down/between/only
 *   mixins/_buttons.scss        — button-variant, button-outline-variant, button-size
 *   mixins/_gradients.scss      — gradient-bg, gradient-x/y, gradient-radial, ...
 *   mixins/_border-radius.scss  — valid-radius, border-radius, border-top-radius, ...
 *   mixins/_caret.scss          — caret, caret-down/up/end/start
 *   mixins/_visually-hidden.scss— visually-hidden, visually-hidden-focusable
 *   mixins/_text-truncate.scss  — text-truncate
 *   mixins/_deprecate.scss      — deprecate
 *   mixins/_table-variants.scss — table-variant
 */

export const META = {
    id: 'css',
    displayName: 'Bootstrap SCSS (subset)',
    language: 'SCSS',
    version: 'subset',
    url: 'https://github.com/twbs/bootstrap',
    expectedMinChunks: 200,
    expectedMinFiles: 40,
};

export const QUERIES = [
    // ── EASY (kw — symbolic name / keyword lookup) ──────────────────────────────

    {
        id: 'CSS01',
        query: 'button variant background border color mixin',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'button-variant mixin — emits the CSS custom properties for a coloured button (seed case btn-variant)',
        expected_names: ['button-variant'],
        expected_files: ['mixins/_buttons.scss'],
    },
    {
        id: 'CSS02',
        query: 'media breakpoint min width responsive',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'media-breakpoint-up — generates a min-width media query for a named breakpoint (seed case breakpoint)',
        expected_names: ['media-breakpoint-up'],
        expected_files: ['mixins/_breakpoints.scss'],
    },
    {
        id: 'CSS03',
        query: 'color contrast ratio function',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'color-contrast function — picks a readable foreground colour for a background (seed case contrast-fn)',
        expected_names: ['color-contrast'],
        expected_files: ['_functions.scss'],
    },

    // ── MEDIUM (kw) ─────────────────────────────────────────────────────────────

    {
        id: 'CSS04',
        query: 'linear gradient background image color stops mixin',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Gradient mixins that set a linear/radial gradient background-image',
        expected_names: ['gradient-x', 'gradient-y', 'gradient-bg', 'gradient-radial'],
        expected_files: ['mixins/_gradients.scss'],
    },
    {
        id: 'CSS05',
        query: 'border radius rounded corners mixin',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Border-radius mixins that round one or more corners of an element',
        expected_names: ['border-radius', 'border-top-radius', 'border-bottom-radius'],
        expected_files: ['mixins/_border-radius.scss'],
    },
    {
        id: 'CSS06',
        query: 'caret dropdown triangle arrow indicator',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Caret mixins that draw the little triangle used by dropdown toggles',
        expected_names: ['caret', 'caret-down', 'caret-up'],
        expected_files: ['mixins/_caret.scss'],
    },

    // ── NL / SEMANTIC (describe behaviour without naming the symbol) ────────────

    {
        id: 'CSS07',
        query: 'Hide an element on screen while keeping it readable by screen readers and assistive technology',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Accessibility helper that visually hides content but leaves it in the accessibility tree',
        expected_names: ['visually-hidden', 'visually-hidden-focusable'],
        expected_files: ['mixins/_visually-hidden.scss', 'helpers/_visually-hidden.scss'],
    },
    {
        id: 'CSS08',
        query: 'Clip a single line of overflowing text and end it with an ellipsis',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Truncation helper using overflow hidden, text-overflow ellipsis and nowrap',
        expected_names: ['text-truncate'],
        expected_files: ['mixins/_text-truncate.scss', 'helpers/_text-truncation.scss'],
    },
    {
        id: 'CSS09',
        query: 'Lighten or darken a colour by blending it with white or black by a percentage',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Colour functions that tint (mix with white) or shade (mix with black) a colour',
        expected_names: ['tint-color', 'shade-color', 'shift-color'],
        expected_files: ['_functions.scss'],
    },

    // ── XC (cross-cutting, phrased behaviourally) ───────────────────────────────

    {
        id: 'CSS10',
        query: 'Perform division with a fixed precision to avoid Sass losing units',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'Custom divide function implementing long division so units are preserved',
        expected_names: ['divide'],
        expected_files: ['_functions.scss'],
    },
    {
        id: 'CSS11',
        query: 'Compute the relative luminance ratio between a background and a foreground colour',
        kind: 'xc',
        difficulty: 'semantic',
        topK: 10,
        description: 'Function returning the WCAG contrast ratio of two colours',
        expected_names: ['contrast-ratio'],
        expected_files: ['_functions.scss'],
    },

    // ── HELD-OUT (validation only — never used to tune ranking) ─────────────────

    {
        id: 'HO-CSS1',
        query: 'escape svg data uri characters for use in a css background',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'Held-out: escape-svg encodes reserved characters inside an inline SVG data URI',
        expected_names: ['escape-svg'],
        expected_files: ['_functions.scss'],
        heldOut: true,
    },
    {
        id: 'HO-CSS2',
        query: 'Emit a warning that a mixin or function is obsolete and will be removed in a future release',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Held-out: deprecation helper that @warns about a symbol being removed',
        expected_names: ['deprecate'],
        expected_files: ['mixins/_deprecate.scss'],
        heldOut: true,
    },
    {
        id: 'HO-CSS3',
        query: 'Generate the coloured background and border styles for a contextual table row state',
        kind: 'xc',
        difficulty: 'semantic',
        topK: 10,
        description: 'Held-out: mixin that builds the .table-<state> variant custom properties',
        expected_names: ['table-variant'],
        expected_files: ['mixins/_table-variants.scss'],
        heldOut: true,
    },
];
