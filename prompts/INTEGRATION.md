# Integrating the graph-indexer prompt suite

The suite is a **3-layer architecture**. Each layer is a standalone XML block; you combine them by **concatenation, in layer order**. Never merge layers into one hand-edited blob ("god prompt") — that is what causes context dilution and framework hallucinations.

```
prompts/
├── CORE.md                          Layer 1 — universal rules (always required)
├── languages/                       Layer 2 — pick the ones matching your code
│   ├── JAVASCRIPT_TYPESCRIPT.md
│   ├── PYTHON.md
│   ├── GO.md
│   ├── RUST.md
│   ├── JAVA.md
│   ├── KOTLIN.md
│   ├── CSHARP.md
│   ├── RUBY.md
│   ├── PHP.md
│   ├── CSS_SCSS.md
│   ├── BASH.md
│   ├── C.md
│   └── SWIFT.md
├── frameworks/                      Layer 2 — pick the ones matching your stack
│   ├── REACT.md
│   ├── NODE_EXPRESS_NESTJS.md
│   ├── FASTAPI_DJANGO.md
│   ├── SPRING_BOOT.md
│   ├── RAILS.md
│   ├── LARAVEL_SYMFONY.md
│   ├── ASPNET_CORE.md
│   └── ANDROID.md
└── DOMAIN_TEMPLATE.md               Layer 3 — copy, then fill with YOUR project's rules
```

## The assembly rule

```
Layer 1 (CORE)  →  Layer 2 (language)  →  Layer 2 (framework)  →  Layer 3 (domain)
```

1. **Order matters.** Core first, then language, then framework, then domain. Frameworks assume their base language layer is already loaded (`requires=` attribute in each file).
2. **Precedence on conflict:** a more specific layer *refines* a more general one (e.g. REACT's render-site protocol refines the core call-graph rule). But Layer 1's `<hard_limits>`, `<prime_directive>`, and `<fallback_protocol>` are **inviolable** — no lower layer may relax them.
3. **Only include layers you need.** A Go microservice needs `CORE + GO` — nothing else. Every unused layer dilutes the agent's attention.

## Automatic setup (recommended)

```bash
npx graph-indexer init
```

`init` asks for your languages and frameworks, then lets you **multi-select which agents/IDEs to wire** (Claude Code/Desktop, Cursor, VS Code/Copilot, Windsurf, Cline/Roo, JetBrains Junie, Codex/AGENTS.md, Gemini CLI). The choice is pre-checked from what's detected (or your last run) and remembered in `.graph-indexer/config.json`, so only the agents you pick get files — the two `GRAPH_INDEXER_*.md` source files are always written. For each selected agent it generates:

| File | Agent | Ownership |
| :--- | :--- | :--- |
| `GRAPH_INDEXER_PROMPT.md` | source of truth (Layers 1 + 2, assembled for your selection) | Generated — re-run `init` to regenerate; do not edit |
| `GRAPH_INDEXER_DOMAIN.md` | source of truth (Layer 3 template) | **Yours** — fill it in; `init` never overwrites it |
| `CLAUDE.md` | Claude Code (`@`-import lines) | Appended once, idempotent |
| `.cursor/rules/graph-indexer.mdc` | Cursor (always-on rule) | Generated — regenerated on re-run |
| `.windsurf/rules/graph-indexer.md` | Windsurf (always-on rule) | Generated — regenerated on re-run |
| `.clinerules/graph-indexer.md` | Cline / Roo Code (rule) | Generated — regenerated on re-run |
| `.github/copilot-instructions.md` | GitHub Copilot (managed block) | Shared — your text outside the markers is preserved |
| `.junie/guidelines.md` | JetBrains Junie (managed block) | Shared — your text outside the markers is preserved |
| `AGENTS.md` | AGENTS.md standard: Codex, Zed, Jules, … (managed block) | Shared — your text outside the markers is preserved |
| `GEMINI.md` | Gemini CLI (`@`-import) | Shared — references the canonical files (no duplication); your text outside the markers is preserved |

**Why some files reference and others embed.** `CLAUDE.md` and `GEMINI.md` use `@`-import (Claude Code imports, Gemini CLI's Memory Import Processor), so they just point at the canonical `GRAPH_INDEXER_*.md` — zero duplication. The Cursor/Windsurf/Cline rule files hold the assembled prompt verbatim, and the Copilot/Junie/AGENTS.md managed blocks embed it inline, because those tools read the file **literally** — they have no reliable import mechanism, so an `@`-reference would appear as plain text and the rules would silently not apply. (AGENTS.md embeds because its main reader, OpenAI Codex, does not yet honour `@` imports.) Embedded blocks are wrapped in `<!-- >>> graph-indexer >>> -->` … `<!-- <<< graph-indexer <<< -->` markers, so your own instructions around them survive re-runs.

## Manual setup

`init` already wires Claude Code, Cursor, Windsurf, Cline/Roo, Copilot, Junie, the AGENTS.md ecosystem, and Gemini (see the table above). Reach for the steps below only for a legacy format (`.cursorrules`, `.clauderc`), a raw-system-prompt config, or an agent not in that list.

### Claude Code (`CLAUDE.md` or `.clauderc`)

Claude Code loads `CLAUDE.md` from the project root and supports `@path` imports — reference the assembled files instead of pasting them:

```markdown
# CLAUDE.md
@GRAPH_INDEXER_PROMPT.md
@GRAPH_INDEXER_DOMAIN.md
```

If your tooling uses a `.clauderc` (or any agent config that takes a raw system prompt), paste the concatenated layers directly, in layer order.

### Cursor (`.cursorrules` or `.cursor/rules/`)

For the legacy single-file format, concatenate the layers into `.cursorrules`:

```bash
cat node_modules/graph-indexer/prompts/CORE.md \
    node_modules/graph-indexer/prompts/languages/JAVASCRIPT_TYPESCRIPT.md \
    node_modules/graph-indexer/prompts/frameworks/REACT.md \
    GRAPH_INDEXER_DOMAIN.md > .cursorrules
```

For the modern format, put the same concatenation in `.cursor/rules/graph-indexer.mdc` with this frontmatter:

```yaml
---
description: graph-indexer usage rules
alwaysApply: true
---
```

### Any other agent

Concatenate the layers (in order) into whatever field your agent calls "system prompt", "rules", or "custom instructions". The XML structure is self-describing — no other formatting is required.

## Worked examples

| Stack | Assembly |
| :--- | :--- |
| React SPA | `CORE + languages/JAVASCRIPT_TYPESCRIPT + languages/CSS_SCSS + frameworks/REACT + domain` |
| NestJS API + React front-end (monorepo) | `CORE + languages/JAVASCRIPT_TYPESCRIPT + frameworks/NODE_EXPRESS_NESTJS + frameworks/REACT + domain` |
| Django service | `CORE + languages/PYTHON + frameworks/FASTAPI_DJANGO + domain` |
| Spring Boot backend (Java or Kotlin) | `CORE + languages/JAVA` (or `KOTLIN`) `+ frameworks/SPRING_BOOT + domain` |
| Rails app | `CORE + languages/RUBY + frameworks/RAILS + domain` |
| Laravel / Symfony app | `CORE + languages/PHP + frameworks/LARAVEL_SYMFONY + domain` |
| ASP.NET Core API | `CORE + languages/CSHARP + frameworks/ASPNET_CORE + domain` |
| Android app | `CORE + languages/KOTLIN + frameworks/ANDROID + domain` |
| Go / Rust service | `CORE + languages/GO` (or `RUST`) `+ domain` |

## Layer 3 — make it yours

Copy `DOMAIN_TEMPLATE.md` (or let `init` create `GRAPH_INDEXER_DOMAIN.md`), then fill in entry points, domain vocabulary, critical paths, and no-go zones. Keep it under ~40 lines: Layer 3 exists to make the agent's *first* query hit rank-1, not to restate your architecture docs.
