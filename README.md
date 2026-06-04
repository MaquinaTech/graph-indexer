# 🧠 Secure Graph-Local Code Indexer MCP

An ultra-high-performance Model Context Protocol (MCP) server for hybrid code search (Dense + Sparse) and topological analysis. Designed to run 100% in-memory, with no external databases (Zero-DB) and absolute privacy guarantee through local embeddings (Air-gapped).

This engine does not use fragile regular expressions. It uses Tree-sitter (AST) to extract code deterministically and tracks a bidirectional dependency graph (what this file imports and who imports this file).

## ✨ Key Features

🚀 In-Memory Engine: Native cosine similarity in V8 with Float32Array. Sub-millisecond searches.

🔐 Absolute Privacy: Direct integration with a local Ollama instance (nomic-embed-text). Your code never leaves your machine.

🧬 Hybrid RRF Search: Combines vector semantic search (Dense) with a lexical TF-IDF inverted index (Sparse) using Reciprocal Rank Fusion. Find abstract concepts and exact business tokens.

🌳 AST Precision: Surgical extraction of functions and dependencies using Tree-sitter. Immune to commented imports or nested strings.

🔄 Real-Time Synchronization: A local daemon (fs.watch) with debouncing that updates the graph and snippets instantly every time you save, without rebuilding the entire cache.

📦 Installation
This package is designed to integrate easily into any workflow.
Global Usage or Independent Projects
Add the indexer as a development dependency in your repository:
```Bash
npm install graph-indexer-mcp --save-dev
In your package.json, add the execution shortcuts:
JSON
"scripts": {
  "mcp:index": "sg-index --repo .",
  "mcp:watch": "sg-watch",
  "mcp:start": "sg-mcp"
}
```

## System Requirements
Node.js: v18 or higher (with ES Modules support).
Ollama: Running at http://localhost:11434 with the nomic-embed-text model downloaded (ollama pull nomic-embed-text).

### 🛠 System Usage
The architecture is decoupled into three phases to avoid resource overload:
Bootstrap (Initial Indexing):
Scans the repository and builds the index for the first time.
```Bash
npm run mcp:index
```
#### Daemon (Synchronization):
Leave it running in a secondary terminal. Listens for changes and mutates the code-index.json file atomically.

```Bash
npm run mcp:watch
```
#### MCP Server:
Point your MCP client (Claude Desktop, VSCode Copilot Agent, Cursor) to this startup command. The server loads RAM in O(1) and communicates via stdio.
```Bash
npm run mcp:start
```

### 🌍 Extensibility Guide: Adding a New Language (E.g: Python)
The engine is polyglot by design. Since vector mathematics, the MCP server, and TF-IDF operate on plain text, the core (core-engine.mjs) doesn't need to be touched. You only need to adapt the AST extractors (indexer.mjs and watch-daemon.mjs).
Here's the exact flow to add Python:

#### Step 1: Install Tree-sitter Grammar
Install the official C++ binary for the target language:
```Bash
npm install tree-sitter-python
```
#### Step 2: Import and Map the Language
In the header of indexer.mjs and watch-daemon.mjs, import the module and add it to the routing map:
```JavaScript
import Python from 'tree-sitter-python';

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.php', '.scss', '.css', '.py']); // Add .py

const LANGUAGE_MAP = {
    // ... previous languages
    '.py': Python
};
```

#### Step 3: Register Semantic Nodes
Tell the snippet extractor which parts of the AST you consider "isolated logical units" to index. For Python, we look for functions and classes:
```JavaScript
const SEMANTIC_NODES = new Set([
    // ... previous languages
    
    // Python
    "function_definition", "class_definition"
]);
````

#### Step 4: Adapt the Dependency Tracker
Open the extractImportsFromAST(rootNode, ext) function and teach the engine how "imports" look in this new language. For Python:
```JavaScript
function extractImportsFromAST(rootNode, ext) {
    const imports = new Set();

    function walk(node) {
        // ... JS/TS, PHP, CSS logic ...

        // Python (import json, from os import path)
        if ((node.type === 'import_statement' || node.type === 'import_from_statement') && ext === '.py') {
            const moduleName = node.children.find(c => c.type === 'dotted_name');
            if (moduleName) imports.add(moduleName.text);
        }

        node.children.forEach(walk);
    }

    walk(rootNode);
    return Array.from(imports);
}
````

Done! If you restart the daemon and save a .py file, the indexer will automatically extract its AST, inject its variables into the lexical engine (TF-IDF), calculate the semantic vector (Ollama), and create the bidirectional graph topology relative to the rest of your monorepo.

## License
Distributed under the MIT License. Built for high-security local architectures.