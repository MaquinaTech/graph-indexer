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
│   └── CSS_SCSS.md
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

`init` asks for your languages and frameworks, then assembles the correct layers for you:

| File | Contents | Ownership |
| :--- | :--- | :--- |
| `GRAPH_INDEXER_PROMPT.md` | Layers 1 + 2, assembled for your selection | Generated — re-run `init` to regenerate; do not edit |
| `GRAPH_INDEXER_DOMAIN.md` | Layer 3 template | **Yours** — fill it in; `init` never overwrites it |
| `CLAUDE.md` | `@GRAPH_INDEXER_PROMPT.md` / `@GRAPH_INDEXER_DOMAIN.md` import lines | Appended once, idempotent |
| `.cursor/rules/graph-indexer.mdc` | Same assembled layers as an always-on Cursor rule | Generated — regenerated on re-run |

## Manual setup

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
