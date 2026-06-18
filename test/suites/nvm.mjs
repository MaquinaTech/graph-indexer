/**
 * test/suites/nvm.mjs
 *
 * Ground-truth query set for nvm (Bash) — a subset of nvm-sh/nvm.
 * Source: https://github.com/nvm-sh/nvm
 *
 * Key source layout (POSIX shell functions, all prefixed nvm_):
 *   nvm.sh      — the core script: install/use/ls implementations plus every
 *                   internal nvm_* helper (version resolution, path management,
 *                   downloads, checksums, aliases, shell detection, ...).
 *   install.sh  — the bootstrap installer: nvm_download, nvm_detect_profile,
 *                   install_nvm_from_git, install_nvm_as_script, nvm_do_install.
 *   rename_test.sh, test/common.sh, update_test_mocks.sh — test/dev helpers.
 *
 * Bash chunks carry no class_context and a single "unknown" type, so the
 * strict relevance predicate keys off the function name (and expected_files).
 */

export const META = {
    id: 'nvm',
    displayName: 'nvm (subset)',
    language: 'Bash',
    version: 'subset',
    url: 'https://github.com/nvm-sh/nvm',
    expectedMinChunks: 120,
    expectedMinFiles: 5,
};

export const QUERIES = [
    // ── EASY (symbolic name lookup) ─────────────────────────────────────────────

    {
        id: 'NV01',
        query: 'nvm_get_arch',
        difficulty: 'easy',
        topK: 5,
        description: 'Determines the system CPU architecture (x64, arm64, ...) for selecting a binary',
        expected_names: ['nvm_get_arch'],
        expected_files: ['nvm.sh'],
    },
    {
        id: 'NV02',
        query: 'nvm_get_os operating system',
        difficulty: 'easy',
        topK: 5,
        description: 'Maps uname output to an OS slug (linux, darwin, win, ...)',
        expected_names: ['nvm_get_os'],
        expected_files: ['nvm.sh'],
    },
    {
        id: 'NV03',
        query: 'nvm_ls_remote list available versions',
        difficulty: 'easy',
        topK: 5,
        description: 'Lists Node.js versions available for download from the remote index',
        expected_names: ['nvm_ls_remote', 'nvm_ls_remote_index_tab'],
        expected_files: ['nvm.sh'],
    },

    // ── MEDIUM (domain-keyword lookup) ──────────────────────────────────────────

    {
        id: 'NV04',
        query: 'is version installed check directory exists',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Checks whether a given Node version is already installed locally',
        expected_names: ['nvm_is_version_installed'],
        expected_files: ['nvm.sh'],
    },
    {
        id: 'NV05',
        query: 'resolve alias name to version number',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Resolves a named alias (default, stable, ...) to the version it points to',
        expected_names: ['nvm_resolve_alias', 'nvm_resolve_local_alias'],
        expected_files: ['nvm.sh'],
    },
    {
        id: 'NV06',
        query: 'compare two semantic version numbers greater',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Compares two dotted version strings to decide which is greater',
        expected_names: ['nvm_version_greater', 'nvm_version_greater_than_or_equal_to'],
        expected_files: ['nvm.sh'],
    },
    {
        id: 'NV07',
        query: 'detect shell profile file bashrc zshrc',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Locates the user shell profile to append nvm sourcing lines to',
        expected_names: ['nvm_detect_profile'],
        expected_files: ['install.sh'],
    },

    // ── NL / SEMANTIC (behavioural, no symbol name in the query) ────────────────

    {
        id: 'NV08',
        query: 'download a remote node binary tarball over the network for a version',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Generic network download helper that fetches a remote artifact',
        expected_names: ['nvm_download'],
        expected_files: ['nvm.sh', 'install.sh'],
    },
    {
        id: 'NV09',
        query: 'compute a cryptographic hash of a downloaded file to verify its integrity',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Computes a sha256/sha1 checksum of a file using whatever tool is available',
        expected_names: ['nvm_compute_checksum', 'nvm_compare_checksum', 'nvm_get_checksum'],
        expected_files: ['nvm.sh'],
    },
    {
        id: 'NV10',
        query: 'figure out which Node version to use from a .nvmrc file in the project tree',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Walks up the directory tree to find the nearest .nvmrc version file',
        expected_names: ['nvm_find_nvmrc', 'nvm_find_up', 'nvm_rc_version'],
        expected_files: ['nvm.sh'],
    },

    // ── XC (cross-cutting concern, phrased behaviourally) ───────────────────────

    {
        id: 'NV11',
        query: 'upgrade to the newest npm for the active node version',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'Installs the latest working npm release for the current Node version',
        expected_names: ['nvm_install_latest_npm'],
        expected_files: ['nvm.sh'],
    },
    {
        id: 'NV12',
        query: 'add and remove the active version directory from the PATH environment variable',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'Rewrites PATH so the chosen Node version is in front, stripping old nvm entries',
        expected_names: ['nvm_change_path', 'nvm_strip_path'],
        expected_files: ['nvm.sh'],
    },

    // ── HELD-OUT (validation only — never used to tune ranking) ──────────────────
    {
        id: 'HO-NV1',
        query: 'download and unpack a precompiled binary archive into the version directory',
        kind: 'xc',
        difficulty: 'semantic',
        topK: 10,
        expected_names: ['nvm_install_binary', 'nvm_extract_tarball'],
        expected_files: ['nvm.sh'],
        heldOut: true,
    },
    {
        id: 'HO-NV2',
        query: 'nvm_check_file_permissions',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        expected_names: ['nvm_check_file_permissions'],
        expected_files: ['nvm.sh'],
        heldOut: true,
    },
    {
        id: 'HO-NV3',
        query: 'compile node from source code with the platform make jobs',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        expected_names: ['nvm_install_source', 'nvm_get_make_jobs'],
        expected_files: ['nvm.sh'],
        heldOut: true,
    },
];
