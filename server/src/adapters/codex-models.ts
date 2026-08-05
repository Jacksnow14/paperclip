import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterModel } from "./types.js";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { readConfigFile } from "../config-file.js";

const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const OPENAI_MODELS_TIMEOUT_MS = 5000;
const OPENAI_MODELS_CACHE_TTL_MS = 60_000;

let cached: { keyFingerprint: string; expiresAt: number; models: AdapterModel[] } | null = null;

function fingerprint(apiKey: string): string {
  return `${apiKey.length}:${apiKey.slice(-6)}`;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeModels([
    ...models,
    ...codexFallbackModels,
  ]).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
}

// AUR-4689: on ChatGPT-account auth there is no OpenAI API key, so the OpenAI
// /v1/models endpoint is unusable and the static fallback can drift from what
// the account can actually run (gpt-5.3-codex was retired provider-side while
// still listed here). The Codex CLI maintains its own account-scoped
// availability cache; when present it is the best ground truth available.
function readCodexCliModelsCache(): AdapterModel[] {
  try {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    const raw = readFileSync(join(codexHome, "models_cache.json"), "utf8");
    const parsed = JSON.parse(raw) as { models?: unknown };
    const entries = Array.isArray(parsed.models) ? parsed.models : [];
    const models: AdapterModel[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const { slug, display_name: displayName, visibility } = entry as {
        slug?: unknown;
        display_name?: unknown;
        visibility?: unknown;
      };
      if (typeof slug !== "string" || slug.trim().length === 0) continue;
      // "hide" marks internal models the CLI does not offer for selection.
      if (visibility === "hide") continue;
      models.push({
        id: slug.trim(),
        label:
          typeof displayName === "string" && displayName.trim().length > 0 ? displayName.trim() : slug.trim(),
      });
    }
    return dedupeModels(models);
  } catch {
    return [];
  }
}

function cliCacheOrStaticFallback(): AdapterModel[] {
  const cliCacheModels = readCodexCliModelsCache();
  if (cliCacheModels.length > 0) return cliCacheModels;
  return dedupeModels(codexFallbackModels);
}

function resolveOpenAiApiKey(): string | null {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;

  const config = readConfigFile();
  if (config?.llm?.provider !== "openai") return null;
  const configKey = config.llm.apiKey?.trim();
  return configKey && configKey.length > 0 ? configKey : null;
}

async function fetchOpenAiModels(apiKey: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_MODELS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || id.trim().length === 0) continue;
      models.push({ id, label: id });
    }
    return dedupeModels(models);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function loadCodexModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  const forceRefresh = options?.forceRefresh === true;
  const apiKey = resolveOpenAiApiKey();
  if (!apiKey) return cliCacheOrStaticFallback();

  const now = Date.now();
  const keyFingerprint = fingerprint(apiKey);
  if (!forceRefresh && cached && cached.keyFingerprint === keyFingerprint && cached.expiresAt > now) {
    return cached.models;
  }

  const fetched = await fetchOpenAiModels(apiKey);
  if (fetched.length > 0) {
    const merged = mergedWithFallback(fetched);
    cached = {
      keyFingerprint,
      expiresAt: now + OPENAI_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cached && cached.keyFingerprint === keyFingerprint && cached.models.length > 0) {
    return cached.models;
  }

  return cliCacheOrStaticFallback();
}

export async function listCodexModels(): Promise<AdapterModel[]> {
  return loadCodexModels();
}

export async function refreshCodexModels(): Promise<AdapterModel[]> {
  return loadCodexModels({ forceRefresh: true });
}

export function resetCodexModelsCacheForTests() {
  cached = null;
}
