import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  downloadFileToCacheDir,
  getHFHubCachePath,
  getRepoFolderName,
  listFiles,
  modelInfo,
  REGEX_COMMIT_HASH,
} from "@huggingface/hub";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import { ModelUnavailableError } from "../errors.js";
import type { ModelUnavailableMode } from "../types.js";
import { SlabWindowTokenizer } from "./tokenizer.js";

export interface ModelArtifact {
  session: InferenceSession;
  tokenizer: SlabWindowTokenizer;
  labels: string[];
  modelDir: string;
  /** ONNX graph input names, used to decide whether to feed token_type_ids. */
  inputNames: string[];
  /** Cached after first load so inference does not re-import onnxruntime-node. */
  TensorClass: typeof Tensor;
}

export interface OnnxModelLoaderOptions {
  modelId: string;
  onModelUnavailable: ModelUnavailableMode;
  cacheDir?: string;
  hfToken?: string;
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
 * How long to wait after a failed download before allowing another attempt.
 * Applies only in `"try-download-then-throw"` mode.
 */
const RETRY_COOLDOWN_MS = 5_000;

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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function snapshotIsLoadable(snapshotDir: string): Promise<boolean> {
  const tokenizerOk = await fileExists(path.join(snapshotDir, "tokenizer.json"));
  if (!tokenizerOk) return false;
  for (const rel of ONNX_CANDIDATES) {
    if (await fileExists(path.join(snapshotDir, rel))) return true;
  }
  return false;
}

/**
 * Lazy loader for ONNX classifier artifacts published on the HF Hub.
 *
 * Loading is deferred until the first inference call so importing the library
 * is fast. Failure behaviour is controlled by `onModelUnavailable`:
 *
 * - `"try-download-then-throw"`: on failure, throws `ModelUnavailableError`
 *   but clears cached state after a 5-second cooldown so the next call retries.
 *   Once a retry succeeds the loader self-heals and operates normally.
 *
 * - `"throw"`: the first failure is cached permanently; every subsequent
 *   `load()` call throws immediately with no retry.
 */
export class OnnxModelLoader {
  private artifact: ModelArtifact | null = null;
  private failure: { error: Error; failedAt: number } | null = null;
  private loadPromise: Promise<ModelArtifact> | null = null;

  constructor(private readonly options: OnnxModelLoaderOptions) {}

  get modelId(): string {
    return this.options.modelId;
  }

  /**
   * HF commit SHA the loaded snapshot resolved to, or null if the model has not
   * been loaded yet. Does NOT trigger loading.
   */
  get snapshotRevision(): string | null {
    if (this.artifact === null) return null;
    return path.basename(this.artifact.modelDir);
  }

  /**
   * Load the model artifact. Idempotent — concurrent callers share one download.
   * Throws `ModelUnavailableError` when the model is not available.
   */
  async load(): Promise<ModelArtifact> {
    if (this.artifact !== null) return this.artifact;

    if (this.failure !== null) {
      if (this.options.onModelUnavailable === "throw") {
        throw new ModelUnavailableError(this.modelId, this.failure.error);
      }
      const elapsed = Date.now() - this.failure.failedAt;
      if (elapsed < RETRY_COOLDOWN_MS) {
        const remainingSec = Math.ceil((RETRY_COOLDOWN_MS - elapsed) / 1000);
        throw new ModelUnavailableError(
          this.modelId,
          this.failure.error,
          `retry in ${remainingSec}s`,
        );
      }
      this.failure = null;
      this.loadPromise = null;
    }

    try {
      this.artifact = await this.loadOnce();
      return this.artifact;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.failure = { error, failedAt: Date.now() };
      this.loadPromise = null;
      throw new ModelUnavailableError(this.modelId, error);
    }
  }

  private loadOnce(): Promise<ModelArtifact> {
    this.loadPromise ??= this.loadFromCacheOrHub();
    return this.loadPromise;
  }

  private async loadFromCacheOrHub(): Promise<ModelArtifact> {
    const repo = { type: "model", name: this.modelId } as const;
    const auth = this.options.hfToken ? { accessToken: this.options.hfToken } : {};

    const { sha, files } = await this.resolveSnapshotFiles(repo, auth);
    const downloaded = await this.downloadArtifacts(repo, sha, files, auth);
    return this.buildArtifact(downloaded);
  }

  private async resolveSnapshotFiles(
    repo: { type: "model"; name: string },
    auth: { accessToken?: string },
  ): Promise<{ sha: string; files: string[] }> {
    const cacheDir = this.options.cacheDir ?? getHFHubCachePath();
    const storageFolder = path.join(
      cacheDir,
      getRepoFolderName({ type: "model", name: this.modelId }),
    );

    const cachedSha = await findCachedSnapshotSha(path.join(storageFolder, "snapshots"));
    if (cachedSha !== null) {
      const files = await walkDir(path.join(storageFolder, "snapshots", cachedSha));
      return { sha: cachedSha, files };
    }

    const info = await modelInfo({ name: this.modelId, additionalFields: ["sha"], ...auth });
    const sha = info.sha;
    if (!sha) throw new Error(`could not resolve commit sha for ${this.modelId}`);

    const files: string[] = [];
    for await (const entry of listFiles({ repo, revision: sha, recursive: true, ...auth })) {
      if (entry.type === "file") files.push(entry.path);
    }
    return { sha, files };
  }

  private async downloadArtifacts(
    repo: { type: "model"; name: string },
    sha: string,
    allFiles: string[],
    auth: { accessToken?: string },
  ): Promise<Map<string, string>> {
    const hasQuantized = allFiles.includes("onnx/model_quantized.onnx");
    const patterns = hasQuantized ? PREFERRED_PATTERNS : FALLBACK_PATTERNS;
    const wanted = allFiles.filter((f) => matchesAny(f, patterns));

    const downloaded = new Map<string, string>();
    for (const file of wanted) {
      const localPath = await downloadWithRetry({
        repo,
        path: file,
        revision: sha,
        ...(this.options.cacheDir ? { cacheDir: this.options.cacheDir } : {}),
        ...auth,
      });
      downloaded.set(file, localPath);
    }
    return downloaded;
  }

  private async buildArtifact(downloaded: Map<string, string>): Promise<ModelArtifact> {
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

    const modelDir = onnxPath.slice(0, onnxPath.length - onnxRel.length - 1);

    const tokenizerJson = JSON.parse(await readFile(tokenizerPath, "utf-8"));
    const configPath = downloaded.get("tokenizer_config.json");
    const tokenizerConfig = configPath ? JSON.parse(await readFile(configPath, "utf-8")) : {};
    const tokenizer = new SlabWindowTokenizer(tokenizerJson, tokenizerConfig);

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
      TensorClass: ort.Tensor,
    };
  }
}

/**
 * Return the 40-char commit SHA of the most recently modified loadable snapshot
 * inside `snapshotsDir`, or `null` if none exists yet.
 */
async function findCachedSnapshotSha(snapshotsDir: string): Promise<string | null> {
  try {
    const entries = await readdir(snapshotsDir);
    const shaDirs = entries.filter((e) => REGEX_COMMIT_HASH.test(e));
    if (shaDirs.length === 0) return null;

    const loadable: string[] = [];
    for (const sha of shaDirs) {
      if (await snapshotIsLoadable(path.join(snapshotsDir, sha))) {
        loadable.push(sha);
      }
    }
    if (loadable.length === 0) return null;
    if (loadable.length === 1) return loadable[0] ?? null;

    let bestSha: string | null = null;
    let bestMtime = -1;
    for (const sha of loadable) {
      const entryStat = await stat(path.join(snapshotsDir, sha));
      if (entryStat.mtimeMs > bestMtime) {
        bestMtime = entryStat.mtimeMs;
        bestSha = sha;
      }
    }
    return bestSha;
  } catch {
    return null;
  }
}

/**
 * Recursively list all files inside `dir`, returning their paths relative to
 * `dir` (using forward-slash separators, matching the HF Hub file path format).
 */
async function walkDir(dir: string, rel = ""): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...(await walkDir(path.join(dir, entry.name), entryRel)));
    } else {
      results.push(entryRel);
    }
  }
  return results;
}

/** HTTP status codes that indicate a permanent failure not worth retrying. */
const FATAL_STATUS_CODES = new Set([403, 404]);

function isFatalHttpError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const match = err.message.match(/\b(4\d{2})\b/);
  if (match) {
    const code = Number(match[1]);
    return FATAL_STATUS_CODES.has(code);
  }
  return false;
}

/** Download one file, tolerating transient race/ETag conflicts. Fatal on 403/404. */
async function downloadWithRetry(
  params: Parameters<typeof downloadFileToCacheDir>[0],
): Promise<string> {
  const MAX_ATTEMPTS = 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await downloadFileToCacheDir(params);
    } catch (err) {
      lastError = err;
      if (isFatalHttpError(err)) break;
      if (attempt === MAX_ATTEMPTS) break;
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
