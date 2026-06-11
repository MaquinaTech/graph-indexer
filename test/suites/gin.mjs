/**
 * test/suites/gin.mjs
 *
 * Ground-truth query set for Gin v1.9.1 (Go).
 * Source: https://github.com/gin-gonic/gin (tag v1.9.1)
 *
 * Key source layout (Go files in repo root):
 *   gin.go           — type Engine struct, New(), Default(), Run(), RunTLS()
 *   routergroup.go   — type RouterGroup struct, GET, POST, PUT, DELETE, Use,
 *                        Group, calculateAbsolutePath
 *   context.go       — type Context struct, JSON, String, HTML, Redirect, Abort,
 *                        BindJSON, ShouldBindJSON, Param, Query, PostForm, ...
 *   tree.go          — type methodTree / node, addRoute, getValue (radix tree)
 *   middleware.go    — Logger(), LoggerWithConfig(), Recovery()
 *   auth.go          — BasicAuth(), BasicAuthForProxy()
 *   errors.go        — type Error struct, Error.Error()
 *   utils.go         — joinPaths, lastChar, parseAccept, ...
 *   render/
 *     json.go        — type JSON / SecureJSON render
 *     html.go        — type HTML render
 */

export const META = {
    id: 'gin',
    displayName: 'Gin v1.9.1',
    language: 'Go',
    version: 'v1.9.1',
    url: 'https://github.com/gin-gonic/gin',
    expectedMinChunks: 80,
    expectedMinFiles: 20,
};

export const QUERIES = [
    // ── EASY ──────────────────────────────────────────────────────────────────

    {
        id: 'GN01',
        query: 'Engine',
        difficulty: 'easy',
        topK: 5,
        description: 'Gin Engine struct — the top-level HTTP engine and router',
        expected_names: ['Engine', 'New', 'Default'],
        expected_files: ['gin.go'],
    },
    {
        id: 'GN02',
        query: 'RouterGroup',
        difficulty: 'easy',
        topK: 5,
        description: 'RouterGroup — groups routes under a common path prefix',
        expected_names: ['RouterGroup'],
        expected_files: ['routergroup'],
    },
    {
        id: 'GN03',
        query: 'Recovery panic',
        difficulty: 'easy',
        topK: 5,
        description: 'Recovery middleware that catches panics and returns 500',
        expected_names: ['Recovery'],
        expected_files: ['middleware'],
    },
    {
        id: 'GN04',
        query: 'BasicAuth',
        difficulty: 'easy',
        topK: 5,
        description: 'Built-in HTTP Basic Authentication middleware',
        expected_names: ['BasicAuth'],
        expected_files: ['auth'],
    },

    // ── MEDIUM ────────────────────────────────────────────────────────────────

    {
        id: 'GN05',
        query: 'Context JSON response write',
        difficulty: 'medium',
        topK: 5,
        description: 'Context.JSON() — serialises a struct and writes a JSON response; WriteJSON is the underlying renderer',
        expected_names: ['JSON', 'WriteJSON'],
        expected_files: ['context', 'render/json'],
    },
    {
        id: 'GN06',
        query: 'ShouldBindJSON bind request body',
        difficulty: 'medium',
        topK: 5,
        description: 'Context.ShouldBindJSON() — decodes the JSON request body into a struct',
        expected_names: ['ShouldBindJSON', 'ShouldBind', 'BindJSON'],
        expected_files: ['context'],
    },
    {
        id: 'GN07',
        query: 'Logger middleware request log',
        difficulty: 'medium',
        topK: 5,
        description: 'Logger middleware that prints a structured access log for each request',
        expected_names: ['Logger', 'LoggerWithConfig', 'LoggerWithWriter'],
        expected_files: ['middleware'],
    },
    {
        id: 'GN08',
        query: 'GET POST route handler register',
        difficulty: 'medium',
        topK: 5,
        description: 'RouterGroup methods (GET, POST, etc.) that register route handlers',
        expected_names: ['GET', 'POST', 'Handle', 'handle', 'Any'],
        expected_files: ['routergroup'],
    },
    {
        id: 'GN09',
        query: 'Run listen address port',
        difficulty: 'medium',
        topK: 5,
        description: 'Engine.Run() — starts the HTTP server on the given address',
        expected_names: ['Run'],
        expected_files: ['gin.go'],
    },

    // ── HARD ──────────────────────────────────────────────────────────────────

    {
        id: 'GN10',
        query: 'radix tree route insertion node',
        difficulty: 'hard',
        topK: 10,
        description: 'Internal radix tree that stores and resolves URL routes',
        expected_names: ['addRoute', 'insertChild', 'getValue', 'node'],
        expected_files: ['tree'],
    },
    {
        id: 'GN11',
        query: 'path parameter url segment extract',
        difficulty: 'hard',
        topK: 10,
        description: 'Extracting named parameters (e.g. :id) from the URL path',
        expected_names: ['Param', 'Params', 'getValue'],
        expected_files: ['context', 'tree'],
    },
    {
        id: 'GN12',
        query: 'abort request middleware chain stop',
        difficulty: 'hard',
        topK: 10,
        description: 'Stops execution of remaining handlers in the middleware chain',
        expected_names: ['Abort', 'AbortWithStatus', 'AbortWithError'],
        expected_files: ['context'],
    },
    {
        id: 'GN13',
        query: 'group route prefix middleware use',
        difficulty: 'hard',
        topK: 10,
        description: 'Creates a route group with shared prefix and middleware',
        expected_names: ['Group', 'Use'],
        expected_files: ['routergroup'],
    },
    {
        id: 'GN14',
        query: 'Extracting string data submitted via an HTML form POST request safely',
        difficulty: 'semantic',
        topK: 10,
        description: 'Conceptual search for form parsing methods',
        expected_names: ['PostForm', 'DefaultPostForm'],
        expected_files: ['context'],
    },
    {
        id: 'GN15',
        query: 'Safely recovering from a runtime crash to prevent the entire web server process from dying',
        difficulty: 'semantic',
        topK: 10,
        description: 'Agent looking for the panic recovery middleware',
        expected_names: ['Recovery', 'RecoveryWithWriter'],
        expected_files: ['middleware'],
    },
    {
        id: 'GN16',
        query: 'Writing an HTTP response containing HTML rendered from a predefined template file',
        difficulty: 'semantic',
        topK: 10,
        description: 'Searching for HTML rendering engine integration',
        expected_names: ['HTML'],
        expected_files: ['context', 'render/html'],
    },
    {
        id: 'GN17',
        query: 'Creating the central application object that holds all route definitions and global settings',
        difficulty: 'semantic',
        topK: 10,
        description: 'Finding the Engine factory',
        expected_names: ['New', 'Default', 'Engine'],
        expected_files: ['gin.go'],
    },
    {
        id: 'GN18',
        query: 'Grouping multiple API endpoints under a shared version path to apply middleware to all of them',
        difficulty: 'semantic',
        topK: 10,
        description: 'Looking for routing group abstraction',
        expected_names: ['Group', 'RouterGroup'],
        expected_files: ['routergroup'],
    },
];
