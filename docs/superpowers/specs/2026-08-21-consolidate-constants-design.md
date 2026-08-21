# Design: Consolidate Guard Constants into `config.ts`

**Date:** 2026-08-21  
**Status:** Approved

## Goal

Move all guard-facing constants into `config.ts` as the single source of truth.
Consumers and internal modules import from `config.ts`; the public API surface in `index.ts` is unchanged.

## Scope

Constants that move:

| Constant                | Current home       | Moves to    |
| ----------------------- | ------------------ | ----------- |
| `MIN_OVERLAP`           | `chunking.ts`      | `config.ts` |
| `MODEL_TOKEN_WINDOW`    | `chunking.ts`      | `config.ts` |
| `DEFAULT_CHUNK_OPTIONS` | `chunking.ts`      | `config.ts` |
| `LABEL_SAFE`            | `guard.ts`         | `config.ts` |
| `LABEL_ATTACK`          | `guard.ts`         | `config.ts` |
| `STAGE_HEURISTICS`      | `guard.ts`         | `config.ts` |
| `STAGE_BINARY`          | `guard.ts`         | `config.ts` |
| `NEUTRAL_RISK`          | `stages/binary.ts` | `config.ts` |

Out of scope (stay where they are):

- `VERSION` in `version.ts` — generated/replaced by the build toolchain.
- Telemetry constants (`VECTOR_*`, `ORIGIN_*`) in `telemetry/reporter.ts` — separate subsystem.

## Changes to `config.ts`

Three new sections are appended after the existing `DEFAULT_MAX_INPUT` declaration:

```
// ── Chunking defaults ──────────────────────────────────────────
MIN_OVERLAP, MODEL_TOKEN_WINDOW, DEFAULT_CHUNK_OPTIONS

// ── Output vocabulary ──────────────────────────────────────────
LABEL_SAFE, LABEL_ATTACK, STAGE_HEURISTICS, STAGE_BINARY

// ── Stage sentinels ────────────────────────────────────────────
NEUTRAL_RISK
```

`DEFAULT_CHUNK_OPTIONS` is typed as `Readonly<Required<ChunkOptions>>`.
`config.ts` uses `import type { ChunkOptions } from "./chunking.js"` — a type-only import, erased at emit, no runtime circular dependency.

`ChunkOptions` is re-exported from `config.ts` (it backs `DEFAULT_CHUNK_OPTIONS` which now lives there).

## Import graph after the change

```
config.ts
  └── import type { ChunkOptions }  ←── chunking.ts   (type-only, erased at runtime)

chunking.ts
  └── import { MIN_OVERLAP, MODEL_TOKEN_WINDOW, DEFAULT_CHUNK_OPTIONS, ChunkOptions }
        from config.ts

guard.ts
  └── import { LABEL_SAFE, LABEL_ATTACK, STAGE_HEURISTICS, STAGE_BINARY, … }
        from config.ts   (already imports from here)

stages/binary.ts
  └── import { NEUTRAL_RISK } from config.ts
```

## Changes to `index.ts`

All re-exports of the moved constants shift from their current source to `./config.js`.
`ChunkOptions` type also moves from the `./chunking.js` block to the `./config.js` block.
`./chunking.js` continues to re-export `chunkContent` (the function only).

**No change to the public API** — same exported names, same import path for consumers.

## Testing

No new tests required. The existing unit test suite (especially `guard.test.ts` and `chunking.test.ts`) exercises every constant indirectly. A full `vitest run` on the fast tests confirms correctness.
