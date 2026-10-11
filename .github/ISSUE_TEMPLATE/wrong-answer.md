---
name: Wrong or missing answer
about: A tool returned a reference, caller or result that is wrong, missing or slow
labels: wrong-answer
---

**What you ran** (the MCP tool and its arguments, or the CLI command):

```
npx graph-indexer refs Cart.total
```

**What it answered** (paste the output, trimmed to the wrong part):

**What you expected**, and why (e.g. `src/checkout.ts:42` calls it through a `Cart` parameter):

**A minimal snippet that reproduces it**, if you can share one (two or three small files are ideal):

**Report** — output of `npx graph-indexer report` (no paths, names or code):

```
```

Every confirmed wrong answer becomes a regression test.
