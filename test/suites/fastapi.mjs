/**
 * test/suites/fastapi.mjs
 *
 * Ground-truth query set for FastAPI 0.103.0 (Python).
 * Source: https://github.com/tiangolo/fastapi (tag 0.103.0)
 *
 * Key source layout (all in fastapi/):
 *   applications.py            — class FastAPI(Starlette)
 *   routing.py                 — class APIRouter, class APIRoute
 *   dependencies/utils.py      — get_dependant, solve_dependencies
 *   security/http.py           — HTTPBearer, HTTPBasic, HTTPAuthorizationCredentials
 *   security/oauth2.py         — OAuth2PasswordBearer, OAuth2PasswordRequestForm
 *   security/api_key.py        — APIKeyHeader, APIKeyCookie, APIKeyQuery
 *   params.py                  — Query, Path, Body, Header, Cookie, Form, File
 *   exceptions.py              — HTTPException, RequestValidationError
 *   encoders.py                — jsonable_encoder
 *   background.py              — BackgroundTask, BackgroundTasks
 *   middleware/cors.py         — CORSMiddleware
 *   openapi/utils.py           — get_openapi
 *   testclient.py              — TestClient
 */

export const META = {
    id: 'fastapi',
    displayName: 'FastAPI 0.103.0',
    language: 'Python',
    version: '0.103.0',
    url: 'https://github.com/tiangolo/fastapi',
    expectedMinChunks: 150,
    expectedMinFiles: 40,
};

export const QUERIES = [
    // ── EASY ──────────────────────────────────────────────────────────────────

    {
        id: 'FA01',
        query: 'FastAPI',
        difficulty: 'easy',
        topK: 5,
        description: 'Main FastAPI application class extending Starlette',
        expected_names: ['FastAPI'],
        expected_files: ['applications'],
    },
    {
        id: 'FA02',
        query: 'APIRouter',
        difficulty: 'easy',
        topK: 5,
        description: 'Router class for grouping routes and dependencies',
        expected_names: ['APIRouter'],
        expected_files: ['routing'],
    },
    {
        id: 'FA03',
        query: 'HTTPException',
        difficulty: 'easy',
        topK: 5,
        description: 'HTTP exception class with status code and detail',
        expected_names: ['HTTPException'],
        expected_files: ['exceptions'],
    },
    {
        id: 'FA04',
        query: 'jsonable_encoder',
        difficulty: 'easy',
        topK: 5,
        description: 'Encodes Python objects to JSON-compatible structures',
        expected_names: ['jsonable_encoder'],
        expected_files: ['encoders'],
    },
    {
        id: 'FA05',
        query: 'OAuth2PasswordBearer',
        difficulty: 'easy',
        topK: 5,
        description: 'OAuth2 password bearer token dependency',
        expected_names: ['OAuth2PasswordBearer'],
        expected_files: ['security/oauth2'],
    },

    // ── MEDIUM ────────────────────────────────────────────────────────────────

    {
        id: 'FA06',
        query: 'get_dependant parameters function',
        difficulty: 'medium',
        topK: 5,
        description: 'Inspects a function and builds a Dependant object with its params',
        expected_names: ['get_dependant'],
        expected_files: ['dependencies/utils'],
    },
    {
        id: 'FA07',
        query: 'solve_dependencies injection request',
        difficulty: 'medium',
        topK: 5,
        description: 'Resolves all dependencies for a route handler at request time',
        expected_names: ['solve_dependencies'],
        expected_files: ['dependencies/utils'],
    },
    {
        id: 'FA08',
        query: 'HTTPBearer authorization header',
        difficulty: 'medium',
        topK: 5,
        description: 'HTTP Bearer token security scheme extracting Authorization header',
        expected_names: ['HTTPBearer', 'HTTPAuthorizationCredentials'],
        expected_files: ['security/http'],
    },
    {
        id: 'FA09',
        query: 'BackgroundTask async after response',
        difficulty: 'medium',
        topK: 10,
        description: 'Runs a task asynchronously after the response is sent; solve_dependencies collects them, get_request_handler executes them',
        expected_names: ['BackgroundTask', 'BackgroundTasks', 'send_notification', 'solve_dependencies', 'get_request_handler'],
        expected_files: ['background', 'fastapi/routing', 'fastapi/dependencies'],
    },
    {
        id: 'FA10',
        query: 'APIRoute endpoint path method',
        difficulty: 'medium',
        topK: 5,
        description: 'Individual route definition with path, method, and endpoint handler',
        expected_names: ['APIRoute'],
        expected_files: ['routing'],
    },

    // ── HARD ──────────────────────────────────────────────────────────────────

    {
        id: 'FA11',
        query: 'validate request body schema pydantic',
        difficulty: 'hard',
        topK: 10,
        description: 'Request body validation using Pydantic model schemas',
        expected_names: ['Body', 'get_dependant', 'solve_dependencies'],
        expected_files: ['params', 'dependencies'],
    },
    {
        id: 'FA12',
        query: 'generate OpenAPI schema documentation',
        difficulty: 'hard',
        topK: 10,
        description: 'Generates the OpenAPI JSON schema from the registered routes',
        expected_names: ['get_openapi', 'openapi'],
        expected_files: ['openapi', 'applications'],
    },
    {
        id: 'FA13',
        query: 'API key header cookie query authentication',
        difficulty: 'hard',
        topK: 10,
        description: 'Security dependencies that extract API keys from headers, cookies, or query params',
        expected_names: ['APIKeyHeader', 'APIKeyCookie', 'APIKeyQuery'],
        expected_files: ['security/api_key'],
    },
    {
        id: 'FA14',
        query: 'path operation decorator route registration',
        difficulty: 'hard',
        topK: 10,
        description: 'The mechanism that registers a path operation (GET/POST/etc.) handler',
        expected_names: ['add_api_route', 'get', 'post'],
        expected_files: ['routing', 'applications'],
    },
];
