# Measurements

Working notes behind the defaults in this package. Everything here is
reproducible from the repo; the scripts that generate the fixtures live in
[`scripts/`](../scripts/).

Unless stated otherwise, figures come from the indirect-injection benchmarks
(BIPIA, InjecAgent, Z-Edgar, TensorTrust), stratified to equal attack/benign,
n=1300, on darwin/arm64.

---

## The model reads at most 512 tokens

`protect()` classifies one sequence. Past the token window — roughly 2,000
characters of English — the remaining text is not weakly weighted, it is not
read at all. Moving one injection through a ~20 KB document:

| Injection at char | `protect()` risk |
| ----------------- | ---------------: |
| 0                 |           0.7228 |
| 1,000             |           0.9375 |
| 2,000             |           0.9556 |
| 3,000             |           0.0956 |
| 10,000            |           0.0956 |
| 19,000            |           0.0956 |

The identical scores past the window are the tell: they equal the clean
document's score exactly, because the payload never reaches the model.

## Chunking

### Always, not only when long

| Strategy                   |      TPR |      FPR |
| -------------------------- | -------: | -------: |
| No chunking                |     85.2 |     17.5 |
| **Chunk everything**       | **87.5** | **17.4** |
| Chunk only if >2,000 chars |     86.3 |     17.5 |

At threshold 0.9. Only ~5% of these samples exceed the token window, yet
chunking still gains two points — so most of the benefit is **dilution**, not
truncation: a short injection inside a longer benign passage is scored down even
when the model reads every word. Splitting isolates the payload. Gating on
length addresses only truncation and discards the rest.

### Chunk size and threshold, swept jointly

At threshold 0.9:

| config      | scans | TPR ± se       | FPR ± se       |
| ----------- | ----: | -------------- | -------------- |
| 80/300      | 5,769 | 87.5 ± 1.3     | 19.1 ± 1.5     |
| **120/400** | 4,576 | **87.5 ± 1.3** | **17.4 ± 1.5** |
| 160/400     | 3,944 | 86.5 ± 1.3     | 16.3 ± 1.4     |
| 200/500     | 3,387 | 85.8 ± 1.4     | 15.8 ± 1.4     |
| 120/600     | 4,468 | 87.5 ± 1.3     | 17.2 ± 1.5     |

`120/400` sits on a **plateau, not a peak** — it ties `80/300` and `120/600`
exactly, and every neighbour is within one standard error. What the data does
show is that `minLen` drives the false-positive rate monotonically (bigger
chunks fragment less), while `maxLen` barely matters.

Raise `minLen` to 160–200 if false positives cost more than the last point of
detection; that also cuts scans by 14–26%. The ranking is stable across
thresholds 0.5–0.95 with no crossover, so these need no re-tuning when the
threshold moves.

### Overlap is off by default

| `overlap` | chunk scans | TPR @0.90 | FPR @0.90 |
| --------: | ----------: | --------: | --------: |
|     **0** |   **4,576** |  **87.5** |  **17.4** |
|        60 |        +31% |      87.8 |      17.2 |
|       119 |        +81% |      88.3 |      18.3 |

Per sample, `overlap: 60` recovered 17 attacks but lost 15 and added 14 false
positives — near-symmetric, so the apparent gain is noise. It _loses_
detections because repeating the previous chunk's tail adds benign context to a
chunk holding an injection, diluting the signal chunking exists to isolate.

Splits land at sentence and line ends, so an injected instruction stays intact
inside one chunk anyway. Only content with no punctuation at all (minified JSON,
long log lines) is cut blindly by `maxLen` — enable `overlap` if that dominates
your input.

### Threshold

| Threshold | Unchunked TPR/FPR | Chunked TPR/FPR |
| --------- | ----------------: | --------------: |
| 0.50      |       86.6 / 25.2 |     89.4 / 25.7 |
| 0.80      |       86.0 / 21.7 |     89.2 / 22.0 |
| **0.90**  |       85.2 / 17.5 | **87.5 / 17.4** |
| 0.95      |       83.4 / 10.2 |      84.2 / 9.2 |

Chunking detects more at every threshold for effectively no extra false
positives.

**Note the absolute false-positive rate.** The default `attackAbove` of 0.5 is
calibrated for chat prompts. On document and tool-result content this model is
materially more trigger-happy — around one clean document in four at 0.5, and on
one benchmark of clean email content it flags a majority. If you are scanning
documents, raise the threshold and measure on your own traffic before enforcing.

## Cost and the event loop

Detection is CPU-bound and blocks the Node event loop. Counting timer ticks that
fired against the number that should have, over 200 scans of a ~150-token prompt:

| Workload                       |     Wall | Ticks fired / expected | Loop availability |
| ------------------------------ | -------: | ---------------------: | ----------------: |
| Tokenizer alone                | 1,557 ms |                0 / 311 |                0% |
| `protect()` on the main thread | 6,844 ms |            200 / 1,369 |               15% |
| `protect()` in a child process | 7,951 ms |          1,305 / 1,590 |           **82%** |

The tokenizer is pure JavaScript — about 7.8 ms of synchronous main-thread work
per call that cannot be offloaded in place. Roughly 5.6 ms per scan of IPC
overhead buys the event loop back.

Chunked scanning of a clean 20 KB document costs ~1.2 s, since nothing hits the
threshold and every chunk is scanned.

## Cross-platform reproducibility

ONNX Runtime's INT8 kernels take different code paths per architecture, so exact
scores are reproducible only on the architecture they were measured on. The
113-case fixture, generated on darwin/arm64:

| Platform     | Bit-exact | Max difference |          Label changes |
| ------------ | --------: | -------------: | ---------------------: |
| darwin/arm64 |   113/113 |       0.000000 |                      0 |
| linux/arm64  |    75/113 |         0.0142 |                      0 |
| linux/x64    |         — |         < 0.05 | 1 (threshold-adjacent) |

The one label change is `long-002`: `0.4761` on darwin/arm64, `0.5022` on
linux/x64. The drift is 0.0261 — well inside tolerance — but the case sits only
0.0239 from the `0.5` threshold, so it lands on either side depending on
architecture.

Exactly **1 of 113** fixture cases falls within ±0.05 of the threshold, which is
about the rate to expect: verdicts are stable except for inputs the model itself
finds genuinely ambiguous. The parity suite asserts scores against a tolerance
everywhere, exact equality on the reference platform, and labels only where the
fixture score is far enough from the threshold for the label to be determinable.

**For deployments that need identical verdicts across mixed architectures**: pin
the architecture, or choose a threshold away from where your traffic clusters.

`onnxruntime-node` is pinned to an exact version for the same reason — INT8
inference is not bit-stable across ORT releases. On 1.27.0 versus 1.26.0 the
same token IDs produced logits differing by up to 0.2 and risk scores by up to
0.0216, with verdicts still agreeing throughout.

## Caveats

- One benchmark family. `bipia_code` (100 samples) drives a disproportionate
  share of the chunking gain.
- Only ~5% of samples exceed the token window, so this data measures dilution
  well and truncation barely at all.
- At n=1300 the resolution is about 1.5 points; differences smaller than that
  are noise.
