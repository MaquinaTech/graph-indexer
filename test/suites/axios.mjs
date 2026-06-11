/**
 * test/suites/axios.mjs
 *
 * Ground-truth query set for Axios v1.6.0 (JavaScript).
 * Source: https://github.com/axios/axios (tag v1.6.0)
 *
 * Query categories:
 *   easy   — exact symbol name as query; lexical TF-IDF should score it #1
 *   medium — partial name or related technical terms
 *   hard   — semantic / conceptual description only, no symbol name in query
 *
 * expected_names: the chunk's `name` field must contain one of these (substring match)
 * expected_files: the chunk's `file_path` must contain one of these (substring match)
 * Either condition passing counts as a hit.
 */

export const META = {
    id: 'axios',
    displayName: 'Axios v1.6.0',
    language: 'JavaScript',
    version: 'v1.6.0',
    url: 'https://github.com/axios/axios',
    expectedMinChunks: 80,
    expectedMinFiles: 30,
};

export const QUERIES = [
    // ── EASY — exact class / function name ────────────────────────────────────

    {
        id: 'AX01',
        query: 'InterceptorManager',
        difficulty: 'easy',
        topK: 5,
        description: 'Axios interceptor manager class (request/response interceptors)',
        expected_names: ['InterceptorManager'],
        expected_files: ['InterceptorManager'],
    },
    {
        id: 'AX02',
        query: 'CancelToken',
        difficulty: 'easy',
        topK: 5,
        description: 'Cancel token class for aborting in-flight requests',
        expected_names: ['CancelToken'],
        expected_files: ['CancelToken'],
    },
    {
        id: 'AX03',
        query: 'dispatchRequest',
        difficulty: 'easy',
        topK: 5,
        description: 'Core function that dispatches an HTTP request via the adapter',
        expected_names: ['dispatchRequest'],
        expected_files: ['dispatchRequest'],
    },
    {
        id: 'AX04',
        query: 'mergeConfig',
        difficulty: 'easy',
        topK: 5,
        description: 'Merge two Axios config objects (defaults + request config)',
        expected_names: ['mergeConfig'],
        expected_files: ['mergeConfig'],
    },
    {
        id: 'AX05',
        query: 'CanceledError',
        difficulty: 'easy',
        topK: 5,
        description: 'Error subclass thrown when a request is cancelled',
        expected_names: ['CanceledError'],
        expected_files: ['CanceledError'],
    },

    // ── MEDIUM — partial name, related terms, or multi-token ─────────────────

    {
        id: 'AX06',
        query: 'createInstance axios defaults',
        difficulty: 'medium',
        topK: 5,
        description: 'Factory that creates an Axios instance bound to default config',
        expected_names: ['createInstance'],
        expected_files: ['lib/axios'],
    },
    {
        id: 'AX07',
        query: 'settle promise resolve reject response',
        difficulty: 'medium',
        topK: 5,
        description: 'Helper that resolves or rejects the promise based on response status',
        expected_names: ['settle'],
        expected_files: ['settle'],
    },
    {
        id: 'AX08',
        query: 'buildURL params serializer',
        difficulty: 'medium',
        topK: 5,
        description: 'Builds the full URL string by appending serialised query params',
        expected_names: ['buildURL'],
        expected_files: ['buildURL'],
    },
    {
        id: 'AX09',
        query: 'http adapter node request',
        difficulty: 'medium',
        topK: 5,
        description: 'Node.js HTTP adapter that makes the actual http.request() call',
        expected_names: ['httpAdapter'],
        expected_files: ['adapters/http'],
    },
    {
        id: 'AX10',
        query: 'xhr adapter XMLHttpRequest browser',
        difficulty: 'medium',
        topK: 5,
        description: 'Browser XHR adapter wrapping XMLHttpRequest',
        expected_names: ['xhrAdapter'],
        expected_files: ['adapters/xhr'],
    },

    // ── HARD — semantic / conceptual descriptions only ────────────────────────

    {
        id: 'AX11',
        query: 'transform response data pipeline',
        difficulty: 'hard',
        topK: 10,
        description: 'Data transformation applied to request/response (maps transformData)',
        expected_names: ['transformData', 'transformResponse', 'transformRequest'],
        expected_files: ['transformData', 'defaults'],
    },
    {
        id: 'AX12',
        query: 'cancel ongoing request abort controller',
        difficulty: 'hard',
        topK: 10,
        description: 'Mechanism to cancel an in-flight request (CancelToken or AbortController)',
        expected_names: ['CancelToken', 'isCancel', 'CanceledError'],
        expected_files: ['cancel/'],
    },
    {
        id: 'AX13',
        query: 'combine base url with relative path',
        difficulty: 'hard',
        topK: 10,
        description: 'Utility that joins a baseURL with a relative requestedURL',
        expected_names: ['combineURLs', 'buildFullPath'],
        expected_files: ['buildFullPath', 'combineURLs'],
    },
    {
        id: 'AX14',
        query: 'interceptor chain promise pipeline',
        difficulty: 'hard',
        topK: 10,
        description: 'The request promise chain that threads interceptors together',
        expected_names: ['Axios', 'request'],
        expected_files: ['core/Axios'],
    },
    {
        id: 'AX15',
        query: 'Intercepting and modifying HTTP requests globally before they leave the browser to add authentication headers',
        difficulty: 'semantic',
        topK: 10,
        description: 'Agent looking for the interceptor manager without using the class name',
        expected_names: ['InterceptorManager', 'request'],
        expected_files: ['InterceptorManager', 'core/Axios'],
    },
    {
        id: 'AX16',
        query: 'Stopping an HTTP network call that takes too long or is no longer needed by the user UI',
        difficulty: 'semantic',
        topK: 10,
        description: 'Agent describing request cancellation behavior',
        expected_names: ['CancelToken', 'CanceledError', 'isCancel'],
        expected_files: ['cancel/CancelToken', 'cancel/isCancel'],
    },
    {
        id: 'AX17',
        query: 'Converting raw JSON strings from the server into JavaScript objects automatically upon receiving a 200 OK',
        difficulty: 'semantic',
        topK: 10,
        description: 'Conceptual search for default response data transformation',
        expected_names: ['transformData', 'transformResponse', 'defaults'],
        expected_files: ['transformData', 'defaults'],
    },
    {
        id: 'AX18',
        query: 'The low-level layer that actually makes the network call using browser built-in APIs',
        difficulty: 'semantic',
        topK: 10,
        description: 'Searching for the browser XHR adapter conceptually',
        expected_names: ['xhrAdapter'],
        expected_files: ['adapters/xhr'],
    },
    {
        id: 'AX19',
        query: 'Combining default global configuration with user-provided settings for a specific API call',
        difficulty: 'semantic',
        topK: 10,
        description: 'Locating the config merging logic',
        expected_names: ['mergeConfig'],
        expected_files: ['core/mergeConfig'],
    },
];
