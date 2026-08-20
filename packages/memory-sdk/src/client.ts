/**
 * AUR-5952: TypeScript SDK for the agent memory store
 * (POST/GET/DELETE /v1/memory on the Paperclip API). Deliberately
 * dependency-free — plain fetch — so it stays a thin, standalone client any
 * Node or edge runtime can install without pulling in the rest of the
 * Paperclip workspace.
 */

export interface AgentMemoryRecord {
  id: string;
  agentId: string;
  companyId: string;
  namespace: string;
  content: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface AgentMemorySearchResult extends AgentMemoryRecord {
  score: number;
}

export interface MemoryClientOptions {
  /** Base URL of the Paperclip API, e.g. "https://api.paperclip.ai". No trailing slash required. */
  baseUrl: string;
  /** Per-agent API key (the same key used for other Paperclip agent endpoints). */
  apiKey: string;
  /** Override fetch (e.g. for testing). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface StoreOptions {
  namespace?: string;
  expiresAt?: Date | string;
}

export interface SearchOptions {
  namespace?: string;
  limit?: number;
}

export class MemoryClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "MemoryClientError";
  }
}

/**
 * MemoryClient wraps the three AUR-5952 endpoints: store(), search(), forget().
 *
 * @example
 * const memory = new MemoryClient({ baseUrl: "https://api.paperclip.ai", apiKey: process.env.PAPERCLIP_API_KEY! });
 * await memory.store("the deploy pipeline uses drizzle-kit for migrations");
 * const hits = await memory.search("how are migrations run?");
 */
export class MemoryClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MemoryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async store(content: string, options: StoreOptions = {}): Promise<AgentMemoryRecord> {
    const body: Record<string, unknown> = { content };
    if (options.namespace) body.namespace = options.namespace;
    if (options.expiresAt) {
      body.expiresAt = options.expiresAt instanceof Date ? options.expiresAt.toISOString() : options.expiresAt;
    }
    const res = await this.request("POST", "/v1/memory", body);
    const json = (await res.json()) as { memory: AgentMemoryRecord };
    return json.memory;
  }

  async search(query: string, options: SearchOptions = {}): Promise<AgentMemorySearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (options.namespace) params.set("namespace", options.namespace);
    if (options.limit) params.set("limit", String(options.limit));
    const res = await this.request("GET", `/v1/memory/search?${params.toString()}`);
    const json = (await res.json()) as { results: AgentMemorySearchResult[] };
    return json.results;
  }

  async forget(id: string): Promise<void> {
    await this.request("DELETE", `/v1/memory/${encodeURIComponent(id)}`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const responseBody = await res.json().catch(() => undefined);
      throw new MemoryClientError(`Paperclip memory API request failed (${res.status} ${method} ${path})`, res.status, responseBody);
    }
    return res;
  }
}
