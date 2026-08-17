import { readFile } from "node:fs/promises";
import path from "node:path";
import { downloadFileToCacheDir, listFiles, modelInfo } from "@huggingface/hub";
import type { InferenceSession } from "onnxruntime-node";
import { BastionTokenizer } from "./tokenizer.js";

export interface ModelArtifact {
  session: InferenceSession;
  tokenizer: BastionTokenizer;
  labels: string[];
  modelDir: string;
  /** ONNX graph input names, used to decide whether to feed token_type_ids. */
  inputNames: string[];
}

/**
 * Files the ONNX runtime path actually needs: the INT8 model plus the small
 * sidecars (tokenizer / config / labels). Mirrors the Python loader's
 * `allow_patterns`, and exists for the same reason — the fp32 weights
 * (`model.safetensors`, `onnx/model.onnx`) are ~570 MB combined and are never
 * used at runtime.
 */
const SIDECAR_PATTERNS = ["*.json", "*.txt", "*.model"];
const PREFERRED_PATTERNS = ["onnx/model_quantized.onnx", ...SIDECAR_PATTERNS];
const FALLBACK_PATTERNS = ["*.onnx", "onnx/*.onnx", ...SIDECAR_PATTERNS];

/** ONNX locations in HF/Optimum-conventional order, quantized first. */
const ONNX_CANDIDATES = ["onnx/model_quantized.onnx", "onnx/model.onnx", "model.onnx"];

/**
 * Python's `fnmatch` semantics, which `huggingface_hub` uses for
 * `allow_patterns`: `*` matches any character INCLUDING `/`, so `*.json`
 * also matches `nested/dir/file.json`.
 */
function fnmatch(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return regex.test(name);
}

function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => fnmatch(name, p));
}

/**
 * Lazy loader for ONNX classifier artifacts published on the HF Hub.
 *
 * Loading is deferred until the first inference call so importing the library
 * is fast. A failed load is cached and downgraded to a warning: the stage then
 * reports itself unavailable and the guard degrades to heuristics-only rather
 * than throwing.
 */
export class OnnxModelLoader {
  private artifactValue: ModelArtifact | null = null;
  private loadError: Error | null = null;
  private loadPromise: Promise<ModelArtifact> | null = null;

  constructor(
    readonly modelId: string,
    private readonly cacheDir?: string,
    private readonly hfToken?: string,
  ) {}

  /**
   * HF commit SHA the loaded snapshot resolved to, or null if the model has not
   * been loaded yet. Does NOT trigger loading.
   */
  get revision(): string | null {
    if (this.artifactValue === null) return null;
    return path.basename(this.artifactValue.modelDir);
  }

  async isAvailable(): Promise<boolean> {
    if (this.artifactValue !== null) return true;
    if (this.loadError !== null) return false;
    try {
      this.artifactValue = await this.load();
      return true;
    } catch (err) {
      this.loadError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `bastion-prompt-protection: model ${this.modelId} unavailable (${this.loadError.message}). ` +
          `Stage will return a neutral score until weights are published.`,
      );
      return false;
    }
  }

  async artifact(): Promise<ModelArtifact> {
    if (!(await this.isAvailable())) {
      throw new Error(`Model ${this.modelId} is not available: ${this.loadError?.message}`);
    }
    return this.artifactValue as ModelArtifact;
  }

  private load(): Promise<ModelArtifact> {
    // Collapse concurrent first-calls onto a single download. This handles
    // concurrency *within* a process; `doLoad` handles it across processes.
    this.loadPromise ??= this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<ModelArtifact> {
    const repo = { type: "model", name: this.modelId } as const;

    // Resolve the repo commit SHA up front and pin every file download to it.
    //
    // This is load-bearing: with the default `revision: "main"`, the hub client
    // places each file under a snapshot directory named after that file's own
    // last-commit oid, so files scatter across several directories and none of
    // them is the repo commit. Pinning an explicit 40-char SHA puts everything
    // under `snapshots/<sha>/`, matching Python's `snapshot_download` layout —
    // which is also what `modelVersion` is derived from.
    const auth = this.hfToken ? { accessToken: this.hfToken } : {};

    const info = await modelInfo({ name: this.modelId, additionalFields: ["sha"], ...auth });
    const sha = info.sha;
    if (!sha) throw new Error(`could not resolve commit sha for ${this.modelId}`);

    const allFiles: string[] = [];
    for await (const entry of listFiles({ repo, revision: sha, recursive: true, ...auth })) {
      if (entry.type === "file") allFiles.push(entry.path);
    }

    // Prefer the quantized build; fall back to the full ONNX set only if the
    // repo ships no quantized model.
    const hasQuantized = allFiles.includes("onnx/model_quantized.onnx");
    const patterns = hasQuantized ? PREFERRED_PATTERNS : FALLBACK_PATTERNS;
    const wanted = allFiles.filter((f) => matchesAny(f, patterns));

    const downloaded = new Map<string, string>();
    for (const file of wanted) {
      const localPath = await downloadWithRetryImpl({
        repo,
        path: file,
        revision: sha,
        ...(this.cacheDir ? { cacheDir: this.cacheDir } : {}),
        ...auth,
      });
      downloaded.set(file, localPath);
    }

    const onnxRel = ONNX_CANDIDATES.find((c) => downloaded.has(c));
    if (onnxRel === undefined) {
      throw new Error(
        `No ONNX weights found for ${this.modelId}. Looked for: ${ONNX_CANDIDATES.join(", ")}`,
      );
    }
    const onnxPath = downloaded.get(onnxRel) as string;

    const tokenizerPath = downloaded.get("tokenizer.json");
    if (tokenizerPath === undefined) {
      throw new Error(`tokenizer.json not found for ${this.modelId}`);
    }

    // Every file lives under .../snapshots/<sha>/<relative path>; strip the
    // relative part back off to recover the snapshot root.
    const modelDir = onnxPath.slice(0, onnxPath.length - onnxRel.length - 1);

    const tokenizerJson = JSON.parse(await readFile(tokenizerPath, "utf-8"));
    const configPath = downloaded.get("tokenizer_config.json");
    const tokenizerConfig = configPath ? JSON.parse(await readFile(configPath, "utf-8")) : {};
    const tokenizer = new BastionTokenizer(tokenizerJson, tokenizerConfig);

    // Imported lazily so that merely importing the package does not load the
    // native ONNX binding.
    const ort = await import("onnxruntime-node");
    const session = await ort.InferenceSession.create(onnxPath, {
      executionProviders: ["cpu"],
    });

    const labelsPath = downloaded.get("labels.txt");
    const labels = labelsPath ? await loadLabels(labelsPath) : [];

    return {
      session,
      tokenizer,
      labels,
      modelDir,
      inputNames: [...session.inputNames],
    };
  }
}

/** Download one file, tolerating a concurrent process warming the same cache. */
async function downloadWithRetryImpl(
  params: Parameters<typeof downloadFileToCacheDir>[0],
): Promise<string> {
  // The hub client downloads to `<blob>.incomplete` and then renames it, so two
  // processes warming the same cold cache collide: the slower one finds the temp
  // file already gone and fails with `ENOENT … rename`. That happens whenever
  // several workers start at once, and it leaves the guard silently degraded to
  // heuristics-only.
  //
  // Retrying fixes it, but the backoff has to outlast the *other* download —
  // the quantized model is ~87 MB — so this grows to several seconds rather than
  // giving up in milliseconds. Retries are per-file, so losing one race does not
  // restart the whole set.
  const MAX_ATTEMPTS = 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await downloadFileToCacheDir(params);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_ATTEMPTS) break;
      // Not unref'd: this timer is what we are waiting on, and letting the loop
      // go idle would exit the process mid-retry.
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError;
}

async function loadLabels(labelsPath: string): Promise<string[]> {
  try {
    const text = await readFile(labelsPath, "utf-8");
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}
