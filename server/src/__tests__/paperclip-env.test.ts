import { afterEach, describe, expect, it } from "vitest";
import { buildPaperclipEnv } from "../adapters/utils.js";

const ORIGINAL_PAPERCLIP_RUNTIME_API_URL = process.env.PAPERCLIP_RUNTIME_API_URL;
const ORIGINAL_PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
const ORIGINAL_PAPERCLIP_LISTEN_HOST = process.env.PAPERCLIP_LISTEN_HOST;
const ORIGINAL_PAPERCLIP_LISTEN_PORT = process.env.PAPERCLIP_LISTEN_PORT;
const ORIGINAL_HOST = process.env.HOST;
const ORIGINAL_PORT = process.env.PORT;
const ORIGINAL_PAPERCLIP_DISABLE_LOOPBACK_REWRITE = process.env.PAPERCLIP_DISABLE_LOOPBACK_REWRITE;
const ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;

afterEach(() => {
  if (ORIGINAL_PAPERCLIP_RUNTIME_API_URL === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
  else process.env.PAPERCLIP_RUNTIME_API_URL = ORIGINAL_PAPERCLIP_RUNTIME_API_URL;

  if (ORIGINAL_PAPERCLIP_API_URL === undefined) delete process.env.PAPERCLIP_API_URL;
  else process.env.PAPERCLIP_API_URL = ORIGINAL_PAPERCLIP_API_URL;

  if (ORIGINAL_PAPERCLIP_LISTEN_HOST === undefined) delete process.env.PAPERCLIP_LISTEN_HOST;
  else process.env.PAPERCLIP_LISTEN_HOST = ORIGINAL_PAPERCLIP_LISTEN_HOST;

  if (ORIGINAL_PAPERCLIP_LISTEN_PORT === undefined) delete process.env.PAPERCLIP_LISTEN_PORT;
  else process.env.PAPERCLIP_LISTEN_PORT = ORIGINAL_PAPERCLIP_LISTEN_PORT;

  if (ORIGINAL_HOST === undefined) delete process.env.HOST;
  else process.env.HOST = ORIGINAL_HOST;

  if (ORIGINAL_PORT === undefined) delete process.env.PORT;
  else process.env.PORT = ORIGINAL_PORT;

  if (ORIGINAL_PAPERCLIP_DISABLE_LOOPBACK_REWRITE === undefined) delete process.env.PAPERCLIP_DISABLE_LOOPBACK_REWRITE;
  else process.env.PAPERCLIP_DISABLE_LOOPBACK_REWRITE = ORIGINAL_PAPERCLIP_DISABLE_LOOPBACK_REWRITE;

  if (ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON === undefined) delete process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
  else process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
});

describe("buildPaperclipEnv", () => {
  it("prefers an explicit PAPERCLIP_RUNTIME_API_URL", () => {
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://203.0.113.42:3102";
    process.env.PAPERCLIP_API_URL = "http://localhost:4100";
    process.env.PAPERCLIP_LISTEN_HOST = "127.0.0.1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://203.0.113.42:3102");
  });

  it("falls back to PAPERCLIP_API_URL when no runtime URL is configured", () => {
    delete process.env.PAPERCLIP_RUNTIME_API_URL;
    process.env.PAPERCLIP_API_URL = "http://localhost:4100";
    process.env.PAPERCLIP_LISTEN_HOST = "127.0.0.1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:4100");
  });

  it("uses runtime listen host/port when explicit URL is not set", () => {
    delete process.env.PAPERCLIP_RUNTIME_API_URL;
    delete process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_LISTEN_HOST = "0.0.0.0";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";
    process.env.PORT = "3100";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:3101");
  });

  it("formats IPv6 hosts safely in fallback URL generation", () => {
    delete process.env.PAPERCLIP_RUNTIME_API_URL;
    delete process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_LISTEN_HOST = "::1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://[::1]:3101");
  });

  it("does not rewrite the host by default (back-compat, no opts passed)", () => {
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://78.153.195.107:3210";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://78.153.195.107:3210");
  });

  it("preferLoopback rewrites a public host to 127.0.0.1, preserving port and path", () => {
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://78.153.195.107:3210/base/path";

    const env = buildPaperclipEnv(
      { id: "agent-1", companyId: "company-1" },
      { preferLoopback: true },
    );

    expect(env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:3210/base/path");
  });

  it("preferLoopback leaves an already-loopback URL unchanged", () => {
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://localhost:3210";

    const env = buildPaperclipEnv(
      { id: "agent-1", companyId: "company-1" },
      { preferLoopback: true },
    );

    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:3210");

    process.env.PAPERCLIP_RUNTIME_API_URL = "http://127.0.0.1:3210";
    const env2 = buildPaperclipEnv(
      { id: "agent-1", companyId: "company-1" },
      { preferLoopback: true },
    );
    expect(env2.PAPERCLIP_API_URL).toBe("http://127.0.0.1:3210");
  });

  it("preferLoopback rewrites an IPv6/public host to the IPv4 literal 127.0.0.1", () => {
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://[2001:db8::1]:3210";

    const env = buildPaperclipEnv(
      { id: "agent-1", companyId: "company-1" },
      { preferLoopback: true },
    );

    expect(env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:3210");
  });

  it("PAPERCLIP_DISABLE_LOOPBACK_REWRITE=1 disables the rewrite even with preferLoopback", () => {
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://78.153.195.107:3210";
    process.env.PAPERCLIP_DISABLE_LOOPBACK_REWRITE = "1";

    const env = buildPaperclipEnv(
      { id: "agent-1", companyId: "company-1" },
      { preferLoopback: true },
    );

    expect(env.PAPERCLIP_API_URL).toBe("http://78.153.195.107:3210");
  });

  it("passes PAPERCLIP_RUNTIME_API_CANDIDATES_JSON through when present", () => {
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://78.153.195.107:3210";
    process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = '["http://78.153.195.107:3210","http://127.0.0.1:3210"]';

    const env = buildPaperclipEnv(
      { id: "agent-1", companyId: "company-1" },
      { preferLoopback: true },
    );

    expect(env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON).toBe(
      '["http://78.153.195.107:3210","http://127.0.0.1:3210"]',
    );
  });
});
