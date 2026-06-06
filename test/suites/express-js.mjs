/**
 * test/suites/express-js.mjs
 *
 * Ground-truth query set for Express 4.18.2 (JavaScript).
 * Source: https://github.com/expressjs/express (tag 4.18.2)
 *
 * Key source layout:
 *   lib/application.js         — app.init, app.use, app.listen, app.handle
 *   lib/express.js             — createApplication
 *   lib/router/index.js        — proto.handle, proto.process_params, proto.route
 *   lib/router/layer.js        — Layer (constructor), Layer.match, Layer.handle_request
 *   lib/router/route.js        — Route (constructor), Route.dispatch, Route.all
 *   lib/request.js             — req.get, req.accepts, req.range
 *   lib/response.js            — res.send, res.json, res.render, res.redirect
 *   lib/view.js                — View (constructor), View.render, View.lookup
 *   lib/middleware/init.js     — init (initialisation middleware)
 *   lib/middleware/query.js    — query (query-string middleware)
 *   lib/utils.js               — setCharset, etag, etc.
 */

export const META = {
    id: 'express-js',
    displayName: 'Express 4.18.2',
    language: 'JavaScript',
    version: '4.18.2',
    url: 'https://github.com/expressjs/express',
    expectedMinChunks: 60,
    expectedMinFiles: 20,
};

export const QUERIES = [
    // ── EASY ──────────────────────────────────────────────────────────────────

    {
        id: 'EX01',
        query: 'createApplication',
        difficulty: 'easy',
        topK: 5,
        description: 'Factory that creates the top-level Express application object',
        expected_names: ['createApplication'],
        expected_files: ['lib/express'],
    },
    {
        id: 'EX02',
        query: 'Layer match path',
        difficulty: 'easy',
        topK: 5,
        description: 'Router layer that matches a URL path against a regexp',
        expected_names: ['Layer'],
        expected_files: ['router/layer'],
    },
    {
        id: 'EX03',
        query: 'Route dispatch method',
        difficulty: 'easy',
        topK: 5,
        description: 'Route object that dispatches an HTTP request to its handlers',
        expected_names: ['Route'],
        expected_files: ['router/route'],
    },

    // ── MEDIUM ────────────────────────────────────────────────────────────────

    {
        id: 'EX04',
        query: 'router handle request next',
        difficulty: 'medium',
        topK: 5,
        description: 'Main router dispatch function that chains through layers',
        expected_names: ['handle', 'proto.handle'],
        expected_files: ['router/index'],
    },
    {
        id: 'EX05',
        query: 'application listen port server',
        difficulty: 'medium',
        topK: 5,
        description: 'Starts the HTTP server and listens on a given port',
        expected_names: ['listen'],
        expected_files: ['lib/application'],
    },
    {
        id: 'EX06',
        query: 'response send body content type',
        difficulty: 'medium',
        topK: 5,
        description: 'res.send() — sends the HTTP response with auto content-type detection',
        expected_names: ['send'],
        expected_files: ['lib/response'],
    },
    {
        id: 'EX07',
        query: 'response json serialize object',
        difficulty: 'medium',
        topK: 5,
        description: 'res.json() — serialises an object to JSON and sends it',
        expected_names: ['json'],
        expected_files: ['lib/response'],
    },
    {
        id: 'EX08',
        query: 'view render template engine',
        difficulty: 'medium',
        topK: 5,
        description: 'View class that renders a template file using the chosen engine',
        expected_names: ['render', 'View'],
        expected_files: ['lib/view'],
    },
    {
        id: 'EX09',
        query: 'process params router middleware',
        difficulty: 'medium',
        topK: 5,
        description: 'Processes URL parameter callbacks registered with app.param()',
        expected_names: ['process_params'],
        expected_files: ['router/index'],
    },
    {
        id: 'EX10',
        query: 'request get header accept',
        difficulty: 'medium',
        topK: 5,
        description: 'req.get() / req.header() — retrieve a request header value',
        expected_names: ['req.get', 'req.header', 'req.accepts'],
        expected_files: ['lib/request'],
    },

    // ── HARD ──────────────────────────────────────────────────────────────────

    {
        id: 'EX11',
        query: 'redirect response permanent temporary',
        difficulty: 'hard',
        topK: 10,
        description: 'res.redirect() — issues an HTTP redirect with configurable status',
        expected_names: ['redirect'],
        expected_files: ['lib/response'],
    },
    {
        id: 'EX12',
        query: 'initialise request response locals app',
        difficulty: 'hard',
        topK: 10,
        description: 'Initialisation middleware that decorates req/res with Express extras',
        expected_names: ['exports.init', 'init'],
        expected_files: ['middleware/init'],
    },
    {
        id: 'EX13',
        query: 'mount sub application use path middleware stack',
        difficulty: 'hard',
        topK: 10,
        description: 'app.use() — mounts middleware or sub-apps at a path',
        expected_names: ['use'],
        expected_files: ['lib/application'],
    },
    {
        id: 'EX14',
        query: 'content negotiation accept header format',
        difficulty: 'hard',
        topK: 10,
        description: 'Content-type negotiation via Accept header (req.accepts / res.format)',
        expected_names: ['req.accepts', 'req.acceptsEncodings', 'req.acceptsCharsets', 'res.format', 'format'],
        expected_files: ['lib/request', 'lib/response'],
    },
];
