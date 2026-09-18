# Advanced — local model cache (offline / regulated)

Pre-download the model once, then run fully offline. For air-gapped
deployments, GDPR-strict workloads, container images built without runtime
network access, or anywhere you need deterministic startup with no surprise
downloads.

**Use this when:** the runtime cannot reach huggingface.co at request time, or
you want to bake the model into an image at build time.

## Prerequisites

```bash
npm install @bastionsoft/prompt-protection
```

You need outbound HTTPS for the _initial_ download. After that, none.

## Run

```bash
node examples/03_offline_cache/main.mjs
```

## Expected output

```
Model cached under: /your/path/examples/03_offline_cache/.bastion-cache
  risk=0.9853  label=attack  stage=classifier
  modelVersion=3a5bbe0

Re-running with HF_HUB_OFFLINE=1 ...
  risk=0.9927  label=attack  stage=classifier
  risk=0.97  label=attack  stage=heuristics
```

## Baking the model into a container

Warm the cache at build time so the image ships with weights and the runtime
never reaches the network:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Warm the model cache into the image.
ENV HF_HOME=/opt/hf-cache
RUN node -e "import('@bastionsoft/prompt-protection').then(async ({ Guard }) => { \
      await new Guard().protect('warmup'); \
    })"

# Fail loudly at runtime if anything still tries to fetch.
ENV HF_HUB_OFFLINE=1
COPY . .
CMD ["node", "server.mjs"]
```

## Notes

- `cacheDir` and `HF_HOME` both work; `cacheDir` scopes the cache to one Guard,
  `HF_HOME` moves the whole HuggingFace cache. With neither, the standard
  `~/.cache/huggingface/` is used.
- The layout is the standard HuggingFace one
  (`models--<org>--<name>/snapshots/<sha>/`), so a cache populated by the Python
  package — or by `huggingface-cli download` — is reused as-is.
- Pin the snapshot you shipped by recording `guard.modelVersion` in your audit
  logs; it's the 7-character prefix of the commit SHA actually loaded.
- A complete cached snapshot loads with **zero Hub calls** — `HF_HUB_OFFLINE=1`
  is belt-and-braces for CI/Docker, not required on a warm cache.
- Heuristic short-circuit (≥ `0.95`) needs no model weights. If the classifier
  is required and unavailable, `protect()` throws `ModelUnavailableError`.

## When to use something else

| Instead                                    | If                                         |
| ------------------------------------------ | ------------------------------------------ |
| [`02_sdk/`](../02_sdk/README.md)           | The runtime can reach the network normally |
| [`01_raw_onnx/`](../01_raw_onnx/README.md) | You want no SDK in the path at all         |
