/**
 * test/suites/express-ts.mjs
 *
 * Ground-truth query set for microsoft/TypeScript-Node-Starter (TypeScript + Express).
 * Source: https://github.com/microsoft/TypeScript-Node-Starter (master branch, archived)
 *
 * This project is a canonical Express + TypeScript starter maintained by Microsoft.
 * It exercises TypeScript-specific AST extraction:
 *   - TypeScript function declarations with typed parameters
 *   - Mongoose schema / model definitions
 *   - Passport.js authentication strategy configuration
 *   - Express route handlers typed with Request/Response
 *
 * Key source layout:
 *   src/app.ts                    — Express app setup, session, passport, mongoose
 *   src/server.ts                 — normalizePort, onError, onListening (HTTP server)
 *   src/controllers/user.ts       — getLogin, postLogin, getSignup, postSignup,
 *                                    getAccount, postUpdateProfile, postDeleteAccount,
 *                                    getOauthUnlink, getResetPassword, ...
 *   src/controllers/home.ts       — index (home page handler)
 *   src/models/User.ts            — UserDocument interface, userSchema, User model
 *   src/config/passport.ts        — Passport local strategy, GitHub OAuth strategy
 *   src/util/secrets.ts           — environment variable helpers
 *   src/util/logger.ts            — Winston logger
 */

export const META = {
    id: 'express-ts',
    displayName: 'TypeScript-Node-Starter (Express + TypeScript)',
    language: 'TypeScript',
    version: 'master',
    url: 'https://github.com/microsoft/TypeScript-Node-Starter',
    expectedMinChunks: 20,
    expectedMinFiles: 8,
};

export const QUERIES = [
    // ── EASY ──────────────────────────────────────────────────────────────────

    {
        id: 'TS01',
        query: 'UserDocument',
        difficulty: 'easy',
        topK: 5,
        description: 'TypeScript interface describing a Mongoose User document',
        expected_names: ['UserDocument'],
        expected_files: ['models/User'],
    },
    {
        id: 'TS02',
        query: 'userSchema',
        difficulty: 'easy',
        topK: 5,
        description: 'Mongoose schema definition for the User model',
        expected_names: ['userSchema'],
        expected_files: ['models/User'],
    },
    {
        id: 'TS03',
        query: 'postLogin',
        difficulty: 'easy',
        topK: 5,
        description: 'POST /login request handler — validates credentials and signs in',
        expected_names: ['postLogin'],
        expected_files: ['controllers/user'],
    },

    // ── MEDIUM ────────────────────────────────────────────────────────────────

    {
        id: 'TS04',
        query: 'passport local strategy authenticate',
        difficulty: 'medium',
        topK: 5,
        description: 'Passport local strategy that authenticates via email + password',
        expected_names: ['LocalStrategy', 'passportConfig'],
        expected_files: ['config/passport'],
    },
    {
        id: 'TS05',
        query: 'postSignup register account',
        difficulty: 'medium',
        topK: 5,
        description: 'POST /signup handler that creates a new user account',
        expected_names: ['postSignup'],
        expected_files: ['controllers/user'],
    },
    {
        id: 'TS06',
        query: 'getAccount profile settings',
        difficulty: 'medium',
        topK: 5,
        description: 'GET /account handler that renders the user profile page',
        expected_names: ['getAccount'],
        expected_files: ['controllers/user'],
    },
    {
        id: 'TS07',
        query: 'normalizePort server listen',
        difficulty: 'medium',
        topK: 5,
        description: 'Normalises the PORT value before starting the HTTP server',
        expected_names: ['normalizePort'],
        expected_files: ['server'],
    },
    {
        id: 'TS08',
        query: 'express session middleware configuration',
        difficulty: 'medium',
        topK: 5,
        description: 'Session middleware setup (express-session) in the Express app',
        expected_names: [],
        expected_files: ['app.ts', 'src/app'],
    },

    // ── HARD ──────────────────────────────────────────────────────────────────

    {
        id: 'TS09',
        query: 'update password reset token email',
        difficulty: 'hard',
        topK: 10,
        description: 'Password-reset flow: generate token, send email, update user',
        expected_names: ['postForgot', 'postReset', 'getForgot', 'getReset'],
        expected_files: ['controllers/user'],
    },
    {
        id: 'TS10',
        query: 'mongoose connect database uri',
        difficulty: 'hard',
        topK: 10,
        description: 'MongoDB connection setup via Mongoose',
        expected_names: [],
        expected_files: ['app.ts', 'src/app', 'secrets'],
    },
];
