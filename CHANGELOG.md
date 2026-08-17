# Changelog

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/);
this project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-08-17

First release: the Bastion prompt-injection detection engine for Node.js.
Matches our Python package (v1.3.5) on model, thresholds, and scores.

### Added

- `Guard.protect()` — two-stage detection: regex heuristics, then an ONNX
  DeBERTa-v3 classifier. Heuristics scoring at or above `0.95` short-circuit
  without loading the model.
- `Guard.protectChunked()` — splits documents on sentence and line boundaries
  and takes the worst verdict, for content larger than the model's 512-token
  window. Exposed alongside `chunkContent()`, `DEFAULT_CHUNK_OPTIONS`, and
  `MODEL_TOKEN_WINDOW`.
- `verifyLicense()` — offline Ed25519 licence verification via Node's built-in
  `node:crypto`; no optional dependency and no network call.
- Telemetry: `ReportingGuard`, `BackgroundReporter`, `MultiReporter`,
  `NoopReporter`, and HTTP / OTLP / LangSmith channels. All off by default.
- Dual ESM + CJS builds with type declarations. Node 20+.

### Notes

- `protect()` is async. Node cannot download a model or create an ONNX session
  synchronously.
- `protect()` reads at most 512 tokens (~2,000 characters). Use
  `protectChunked()` for documents, tool results, and retrieved passages.
- The default `attackAbove` of `0.5` is calibrated for chat prompts. Document
  content carries a materially higher false-positive rate — see
  [docs/measurements.md](docs/measurements.md).
- `onnxruntime-node` is pinned to an exact version. INT8 inference is not
  bit-stable across releases, and the pin keeps scores reproducible.
- Exact scores are reproducible per architecture; verdicts are not
  architecture-dependent. The test suite asserts strict equality on the
  reference platform and a tolerance elsewhere.

### Not included

- Framework integrations (LangChain, LlamaIndex, LiteLLM, OpenAI Agents), which
  remain available in the Python package.
- `TemperatureScaler.fit()` — a training-time helper. `transform()` is included
  and used at inference.
