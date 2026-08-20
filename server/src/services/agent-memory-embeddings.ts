/**
 * AUR-5952: embedding provider for the agent memory store. Injectable so
 * tests never make a real network call — see server/src/services/agent-memory.ts.
 */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

const DEFAULT_MODEL = "text-embedding-3-small";
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

export function openAiEmbedder(apiKey: string, model = DEFAULT_MODEL): Embedder {
  return {
    async embed(text: string): Promise<number[]> {
      const response = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: text }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`OpenAI embeddings request failed (${response.status}): ${body.slice(0, 500)}`);
      }

      const json = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const embedding = json.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error("OpenAI embeddings response did not include a vector");
      }
      return embedding;
    },
  };
}

/**
 * Resolves the embedder from OPENAI_API_KEY. Throws at call time (not at
 * import time) so the server can boot without an embedding key configured —
 * only requests that actually hit the memory API fail, with a clear message.
 */
export function resolveDefaultEmbedder(): Embedder {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not configured — the agent memory store needs it to embed content (text-embedding-3-small).",
    );
  }
  return openAiEmbedder(apiKey);
}
