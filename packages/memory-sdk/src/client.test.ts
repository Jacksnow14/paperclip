import { describe, expect, it, vi } from "vitest";
import { MemoryClient, MemoryClientError } from "./client.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeClient(fetchImpl: typeof fetch) {
  return new MemoryClient({ baseUrl: "https://api.paperclip.ai/", apiKey: "token-123", fetchImpl });
}

describe("MemoryClient", () => {
  it("store() posts to /v1/memory with the bearer key and content", async () => {
    const record = {
      id: "1",
      agentId: "a",
      companyId: "c",
      namespace: "default",
      content: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ memory: record }, 201));
    const client = makeClient(fetchMock);

    const result = await client.store("hello", { namespace: "notes" });

    expect(result).toEqual(record);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.paperclip.ai/v1/memory");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer token-123");
    expect(JSON.parse(init.body)).toEqual({ content: "hello", namespace: "notes" });
  });

  it("search() sends q, namespace and limit as query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const client = makeClient(fetchMock);

    await client.search("migrations", { namespace: "notes", limit: 5 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.paperclip.ai/v1/memory/search?q=migrations&namespace=notes&limit=5");
    expect(init.method).toBe("GET");
  });

  it("forget() DELETEs /v1/memory/:id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = makeClient(fetchMock);

    await client.forget("abc123");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.paperclip.ai/v1/memory/abc123");
    expect(init.method).toBe("DELETE");
  });

  it("throws MemoryClientError with status and body on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "forbidden" }, 403));
    const client = makeClient(fetchMock);

    await expect(client.search("x")).rejects.toMatchObject({
      name: "MemoryClientError",
      status: 403,
      body: { error: "forbidden" },
    });
    await expect(client.search("x")).rejects.toBeInstanceOf(MemoryClientError);
  });
});
