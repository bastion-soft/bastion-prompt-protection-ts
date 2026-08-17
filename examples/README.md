# Examples — ways to use Bastion Prompt Protection

Each pattern is self-contained: its own folder with a tutorial `README.md` and
runnable code. Pick the one that matches where you are.

| Pattern                 | Best for                                                 | Tutorial                                          |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| **1. Raw ONNX, no SDK** | Skeptics, compliance reviewers, porting to another stack | [`01_raw_onnx/`](01_raw_onnx/README.md)           |
| **2. SDK**              | Standard server-side Node/TS apps; fastest integration   | [`02_sdk/`](02_sdk/README.md)                     |
| **3. Offline cache**    | Air-gapped, regulated, or container-baked deployments    | [`03_offline_cache/`](03_offline_cache/README.md) |

All three reach the same risk number for the same prompt. They differ in how
much you trust the vendor: Pattern 1 minimises the trust surface (no library,
raw weights); Pattern 2 maximises convenience.

Every example runs with plain `node` — no build step, no TypeScript toolchain:

```bash
npm install @bastionsoft/prompt-protection
node examples/02_sdk/main.mjs
```

## Not included

Framework integrations (LangChain, LlamaIndex, OpenAI Agents, LiteLLM) are
available in our Python package — see [Scope](../README.md#scope).

For a language-agnostic HTTP sidecar, we publish ready-made
[Docker images](https://github.com/bastion-soft/bastion-prompt-protection/tree/main/docker)
that expose the same detector over `POST /protect`.
