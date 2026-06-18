/**
 * test/suites/react.mjs
 *
 * Ground-truth query set for a subset of react-bootstrap (TypeScript/React).
 * Source: https://github.com/react-bootstrap/react-bootstrap
 *
 * Key source layout (one component/util per .tsx/.ts file at the fixture root):
 *   Modal.tsx              — Modal overlay dialog (focus trap, backdrop, onHide)
 *   Overlay.tsx            — Overlay positioning wrapper over popper (wrapRefs,
 *                              clearPopperCache); OverlayTrigger.tsx adds
 *                              hover/focus triggers (normalizeDelay, handleMouseOverOut)
 *   Dropdown.tsx           — Dropdown + Toggle/Menu; DropdownMenu.tsx has
 *                              getDropdownMenuPlacement
 *   Button.tsx             — clickable button styled by variant/size props
 *   Carousel.tsx           — slideshow with prev/next; isVisible helper
 *   Collapse.tsx           — expand/collapse height/width transition
 *                              (MARGINS, getDefaultDimensionValue, collapseStyles)
 *   ProgressBar.tsx        — progress bar (getPercentage, renderProgressBar)
 *   ThemeProvider.tsx      — ThemeContext + useBootstrapPrefix / useBootstrapBreakpoints
 *                              / useBootstrapMinBreakpoint / useIsRTL / createBootstrapComponent
 *   createWithBsPrefix.tsx — HOC that resolves a bootstrap class prefix
 *   createChainedFunction.tsx — compose multiple callbacks into one
 *   useAccordionButton.ts  — hook returning the accordion toggle handler
 *   helpers.ts             — getOverlayDirection (placement → bs direction)
 */

export const META = {
    id: 'react',
    displayName: 'react-bootstrap (subset)',
    language: 'TypeScript/React',
    version: 'subset',
    url: 'https://github.com/react-bootstrap/react-bootstrap',
    expectedMinChunks: 200,
    expectedMinFiles: 100,
};

export const QUERIES = [
    // ── EASY (symbolic name lookup) ─────────────────────────────────────────────

    {
        id: 'RB01',
        query: 'Dropdown',
        difficulty: 'easy',
        topK: 5,
        description: 'Dropdown component — toggle button that reveals a menu',
        expected_names: ['Dropdown'],
        expected_files: ['Dropdown'],
    },
    {
        id: 'RB02',
        query: 'progress bar percentage now min max striped',
        difficulty: 'easy',
        topK: 5,
        description: 'ProgressBar component visualising completion as a filled bar',
        expected_names: ['ProgressBar'],
        expected_files: ['ProgressBar'],
    },

    // ── MEDIUM (keyword lookup) ─────────────────────────────────────────────────

    {
        id: 'RB04',
        query: 'dropdown toggle menu context show',
        difficulty: 'medium',
        topK: 5,
        description: 'Dropdown with its toggle and menu sub-components (seed: react/dropdown)',
        expected_names: ['Dropdown', 'DropdownToggle', 'DropdownMenu'],
        expected_files: ['Dropdown'],
    },
    {
        id: 'RB05',
        query: 'modal dialog backdrop show onHide focus',
        difficulty: 'medium',
        topK: 5,
        description: 'Modal component and its dialog/body sub-components',
        expected_names: ['Modal', 'ModalDialog', 'ModalBody'],
        expected_files: ['Modal'],
    },
    {
        id: 'RB06',
        query: 'overlay trigger tooltip popover placement',
        difficulty: 'medium',
        topK: 5,
        description: 'Overlay/OverlayTrigger that positions a tooltip or popover',
        expected_names: ['Overlay', 'OverlayTrigger', 'Tooltip', 'Popover'],
        expected_files: ['Overlay'],
    },

    // ── HARD / SEMANTIC (behavioural — target symbol NOT named) ──────────────────

    {
        id: 'RB08',
        query: 'render an overlay dialog that traps focus and can be dismissed by the user',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Behavioural search for the modal dialog (seed: react/modal-overlay)',
        expected_names: ['Modal'],
        expected_files: ['Modal'],
    },
    {
        id: 'RB09',
        query: 'a clickable element styled by a colour variant and a size prop',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Behavioural search for the button component (seed: react/button-variant)',
        expected_names: ['Button'],
        expected_files: ['Button'],
    },
    {
        id: 'RB10',
        query: 'animate an element expanding and shrinking by transitioning its height or width',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Behavioural search for the collapse transition component',
        expected_names: ['Collapse', 'getDefaultDimensionValue', 'collapseStyles'],
        expected_files: ['Collapse'],
    },
    {
        id: 'RB11',
        query: 'compose several optional callbacks into a single handler that invokes each one in order',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'Cross-cutting utility used by transitions to chain event handlers',
        expected_names: ['createChainedFunction'],
        expected_files: ['createChainedFunction'],
    },
    {
        id: 'RB12',
        query: 'resolve the css class prefix for a component, falling back to a theme-provided default',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'Cross-cutting bsPrefix resolution shared across components',
        expected_names: ['useBootstrapPrefix', 'createWithBsPrefix'],
        expected_files: ['ThemeProvider', 'createWithBsPrefix'],
    },

    // ── HELD-OUT (validation only — never used to tune ranking) ──
    {
        id: 'HO-RB1',
        query: 'a hook that returns the click handler which toggles which accordion panel is open',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Held-out: accordion toggle hook',
        expected_names: ['useAccordionButton'],
        expected_files: ['useAccordionButton'],
        heldOut: true,
    },
    {
        id: 'HO-RB2',
        query: 'getDropdownMenuPlacement',
        difficulty: 'easy',
        topK: 5,
        description: 'Held-out: compute the popper placement for a dropdown menu given drop/align direction',
        expected_names: ['getDropdownMenuPlacement'],
        expected_files: ['DropdownMenu'],
        heldOut: true,
    },
    {
        id: 'HO-RB3',
        query: 'convert a current value into a percentage between a minimum and maximum bound',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Held-out: progress percentage helper',
        expected_names: ['getPercentage'],
        expected_files: ['ProgressBar'],
        heldOut: true,
    },
];
