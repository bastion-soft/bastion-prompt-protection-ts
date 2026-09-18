# @bastionsoft/prompt-protection

[![npm](https://img.shields.io/npm/v/@bastionsoft/prompt-protection)](https://www.npmjs.com/package/@bastionsoft/prompt-protection)
[![CI](https://github.com/bastion-soft/bastion-prompt-protection-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/bastion-soft/bastion-prompt-protection-ts/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@bastionsoft/prompt-protection)](https://www.npmjs.com/package/@bastionsoft/prompt-protection)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

Prompt injection and jailbreak detection for Node.js. Runs entirely in your
process — a regex heuristics pass, then an ONNX DeBERTa-v3 classifier on CPU. No
API calls, no data leaves the machine.

```bash
npm install @bastionsoft/prompt-protection
```

```ts
import { Guard } from "@bastionsoft/prompt-protection";

const guard = new Guard();

const result = await guard.protect("Ignore all previous instructions.");
// { risk: 0.9853, label: "attack", stageReached: "classifier", latencyMs: 32.6, isAttack: true }

if (result.isAttack) {
  // block, log, or route to a human
}
```

Construct `Guard` once at startup. The first `protect()` downloads ~98 MB of
model weights into the standard HuggingFace cache (~2 s); after that a scan is
single-digit milliseconds.

Also available for Python as
[`bastion-prompt-protection`](https://pypi.org/project/bastion-prompt-protection/) —
same model, same thresholds, same scores.

## Detection pipeline

1. **Heuristics** run on the full input (before any truncation) — chat-template
   control tokens (`0.97`), fake end-of-prompt delimiters (`0.90`), zero-width
   obfuscation (`0.96`), spaced letters (`0.80`), base64 payloads (`0.55`).
2. A heuristic score ≥ `0.95` returns immediately — **the model never loads**, so
   structural attacks cost microseconds.
3. Otherwise the input is truncated to `maxInputChars` (characters, not tokens)
   and scanned through the ONNX classifier in overlapping token windows; the
   worst window score is returned.

If the weights can't be downloaded, the classifier reports itself unavailable and
the guard degrades to heuristics-only with a warning rather than throwing.

## API

### `new Guard(config?)`

| Option                             |     Default | Meaning                                                      |
| ---------------------------------- | ----------: | ------------------------------------------------------------ |
| `preset`                           |    `"tiny"` | `"tiny"` (free, 70M) or `"multilingual"` (commercial, gated) |
| `model`                            |           — | Any HuggingFace repo id; overrides `preset`                  |
| `thresholds.attackAbove`           |       `0.5` | Risk at or above this is labelled `attack`                   |
| `thresholds.heuristicShortCircuit` |      `0.95` | Heuristic score at or above this skips the model             |
| `enableHeuristics`                 |      `true` | Run the regex stage                                          |
| `enableClassifier`                 |      `true` | Run the ONNX classifier stage                                |
| `maxInputChars`                    |    `262144` | Total input bound before token windowing (characters)        |
| `overlapTokens`                    |        `64` | Content-token overlap between consecutive windows            |
| `cacheDir`                         |           — | Override the model cache location                            |
| `hfToken`                          |           — | HuggingFace token; defaults to `$HF_TOKEN`                   |
| `licensePath` / `requireLicense`   | — / `false` | Offline commercial-license checks                            |

`protect(prompt)` resolves to
`{ risk, label, stageReached, latencyMs, isAttack }`. `risk` is rounded to 4
decimals, `latencyMs` to 3.

Also on the instance: `guard.sdkVersion`, `guard.modelVersion` (7-character
model-snapshot id, `null` until first use — worth recording in audit logs), and
`guard.licenseStatus()`.

### `protect(prompt, options?)` — documents and tool results

The classifier reads at most **512 tokens**. Beyond that, text is not weakly
weighted — it is not read at all, so an injection buried in a long file scores
the same as the clean file unless the input is windowed.

By default `protect()` splits content into overlapping **token-exact** sliding
windows and takes the worst verdict:

```ts
const result = await guard.protect(document);
// { risk, label, isAttack, windowsScanned, windowsTotal, windowsTotalExact, … }
```

| Option          |    Default | Meaning                                          |
| --------------- | ---------: | ------------------------------------------------ |
| `overlapTokens` |       `64` | Content tokens repeated from the previous window |
| `maxWindows`    | _no limit_ | Stop after this many windows                     |

Pass `{ maxWindows: 1 }` for Python-parity single-window mode (first 512 tokens
only). It stops at the first window over the threshold, so **clean content is
the expensive case** — every window is scanned. Compare `windowsScanned` with
`windowsTotal` to tell whether the whole input was covered; when
`windowsTotalExact` is false, `windowsTotal` is a density-based estimate.

Constants are exported as `MODEL_TOKEN_WINDOW`, `CONTENT_TOKEN_WINDOW`,
`DEFAULT_TOKEN_OVERLAP`, `DEFAULT_SLAB_CHARS`, and `DEFAULT_MAX_INPUT_CHARS`.

> **On document content, raise the threshold.** The `0.5` default is calibrated
> for chat prompts. On documents and tool results this model is materially more
> trigger-happy — roughly one clean document in four at `0.5`. Around `0.9`
> detects slightly _better_ on that content with a third fewer false positives.
> Measure on your own traffic before enforcing. See
> [docs/measurements.md](docs/measurements.md).

### Running it off the main thread

**`protect()` is CPU-bound and blocks the Node event loop** — most of it in the
tokenizer, which is pure JavaScript and cannot be offloaded in place. In a
server or gateway, run it in a child process: measured event-loop availability
during sustained scanning goes from **15% to 82%**.

A child process beats a worker thread here for two reasons: it contains a crash
in the native ONNX Runtime, and it makes timeouts enforceable — you cannot abort
a native call, but you can kill a process holding one.

```js
// detector-child.mjs
import { Guard } from "@bastionsoft/prompt-protection";
let guard;
let queue = Promise.resolve(); // serialise: one model, one inference at a time
process.on("message", (req) => {
  queue = queue.then(async () => {
    try {
      guard ??= new Guard();
      const { risk, label } = await guard.protect(req.text);
      process.send?.({ id: req.id, ok: true, risk, label });
    } catch (err) {
      process.send?.({ id: req.id, ok: false, error: String(err) });
    }
  });
});
process.once("disconnect", () => process.exit(0));
```

In the parent: keep a `Map` of pending request ids, enforce your own deadline
(kill and respawn on expiry), bound the queue so it sheds load instead of
growing, and reject pending requests when the child exits so callers fail
predictably rather than hanging.

## Editions

|           | **Free** (this package)         | **Commercial**                                        |
| --------- | ------------------------------- | ----------------------------------------------------- |
| Model     | `tiny` — DeBERTa-v3-xsmall, 70M | `multilingual` — mdeberta-v3-base, 280M               |
| Languages | English                         | + German, French, Spanish, Italian, Norwegian, Danish |
| License   | AGPL-3.0                        | Commercial (Bastionsoft EULA)                         |
| Weights   | Open on HuggingFace             | Gated — granted on purchase                           |

The commercial model extends coverage to seven languages at a lower
false-positive rate. Request a quote at <https://bastionsoft.com>.

The commercial weights are gated on HuggingFace, so downloading them needs a
token from an account granted access — set `$HF_TOKEN` or pass `hfToken`. The
free `tiny` model is public and needs no token.

```ts
const guard = new Guard({ preset: "multilingual", requireLicense: true });
guard.licenseStatus();
// { valid: true, reason: "valid", licenseId: "…", tier: "enterprise",
//   company: "…", validUntil: "…", expired: false }
```

Licenses are verified offline via Ed25519 — no network call, so it works
air-gapped.

## Scope

This release covers the detection engine. Framework integrations
(LangChain, LlamaIndex, LiteLLM) are available in the Python package and are not
yet here.

For a language-agnostic HTTP service, we publish
[Docker images](https://github.com/bastion-soft/bastion-prompt-protection/tree/main/docker)
exposing the same detector over `POST /protect`.

## Examples

Runnable tutorials in [`examples/`](examples/README.md) — raw ONNX with no SDK,
the standard integration, and offline/air-gapped operation.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test             # unit suite, no model download
npm run test:parity  # downloads weights, runs the fixture suite
npm run build
```

Detection behaviour is pinned by committed fixtures; see
[`scripts/`](scripts/) for how they are regenerated, and
[docs/measurements.md](docs/measurements.md) for the data behind the defaults.

Release process and npm/OIDC setup: [RELEASING.md](RELEASING.md).

## Security

Detection bypasses and package vulnerabilities: see [SECURITY.md](SECURITY.md).
Releases are published from CI via npm Trusted Publishing (OIDC) with provenance
attached — verify with `npm audit signatures`.

## License

AGPL-3.0-or-later. Commercial licensing: <https://bastionsoft.com>
