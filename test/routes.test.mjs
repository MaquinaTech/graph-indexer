/** HTTP routes and their handlers, per framework, and explore following a route to its handler. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { routeShape } from '../src/query/routes.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const FILES = {
    'api/items.py': 'from fastapi import APIRouter\nrouter = APIRouter(prefix="/items")\n\n@router.get("/{item_id}")\ndef read_item(item_id: int):\n    return item_id\n',
    'web/views.py': 'from flask import Flask\napp = Flask(__name__)\n\n@app.route("/login", methods=["GET", "POST"])\ndef login():\n    return "ok"\n',
    'src/users.controller.ts': "import { Controller, Get, Post } from '@nestjs/common';\n@Controller('users')\nexport class UsersController {\n  @Get(':id')\n  findOne() { return 1; }\n  @Post()\n  create() { return 2; }\n}\n",
    'src/main/java/app/OrderController.java': 'package app;\n@RestController\n@RequestMapping("/orders")\npublic class OrderController {\n  @GetMapping("/{id}")\n  public String get() { return ""; }\n  @PostMapping\n  public String create() { return ""; }\n}\n',
    'server/app.js': "const express = require('express');\nconst { pay } = require('./pay');\nconst app = express();\napp.post('/checkout', auth, pay);\napp.get('/health', (req, res) => res.send('ok'));\n// app.get('/commented', x);\nfunction auth(req, res, next) { next(); }\n",
    'server/pay.js': 'function pay(req, res) { res.end(); }\nmodule.exports = { pay };\n',
    'cmd/main.go': 'package main\n\nfunc listPets(c *Context) {}\n\nfunc main() {\n\tr := New()\n\tr.GET("/pets/:id", listPets)\n}\n',
};

let root, intel;
test.before(async () => { root = makeRepo(FILES); intel = new CodeIntel({ root }); await intel.open(); });
test.after(() => { intel?.close(); rmrf(root); });

test('route shapes compare across parameter syntaxes', () => {
    assert.equal(routeShape('/users/{id}'), routeShape('users/:id'));
    assert.equal(routeShape('/a/<int:x>/b/'), '/a/*/b');
});

test('routes: method, full path (with router, controller and class prefixes) and handler', async () => {
    const text = await callTool(intel, 'routes', {});
    assert.match(text, /GET +\/items\/\{item_id\} +→ read_item {2}api\/items\.py:5/);
    assert.match(text, /GET +\/login +→ login/);
    assert.match(text, /POST +\/login +→ login/);
    assert.match(text, /GET +\/users\/:id +→ UsersController\.findOne/);
    assert.match(text, /POST +\/users +→ UsersController\.create/);
    assert.match(text, /GET +\/orders\/\{id\} +→ OrderController\.get/);
    assert.match(text, /POST +\/orders +→ OrderController\.create/);
    assert.match(text, /POST +\/checkout +→ pay {2}server\/pay\.js:1/, 'the last argument, bound through the import');
    assert.match(text, /GET +\/health +→ inline handler at server\/app\.js:5/);
    assert.match(text, /GET +\/pets\/:id +→ listPets {2}cmd\/main\.go:3/);
    assert.doesNotMatch(text, /commented/);
});

test('routes filter by path or METHOD /path', async () => {
    const one = await callTool(intel, 'routes', { filter: 'POST /orders' });
    assert.match(one, /^1 route matching/);
    assert.match(await callTool(intel, 'routes', { filter: '/users/7' }), /GET +\/users\/:id/);
});

test('explore follows a route named in the question to its handler', async () => {
    const text = await callTool(intel, 'explore', { query: 'why does GET /items/5 return a string' });
    assert.match(text, /## 1\. read_item — function.*\(handles GET \/items\/\{item_id\}\)/);
    assert.match(text, /called by: the web framework, for GET \/items\/\{item_id\}/);
});
