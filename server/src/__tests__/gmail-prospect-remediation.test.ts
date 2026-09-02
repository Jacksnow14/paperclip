import { describe, expect, it, vi } from "vitest";

// routes/gmail.ts pulls in the real gmail service, which constructs a
// googleapis client at import time. Stub it — this suite only exercises the
// pure text builder, not any transport.
vi.mock("googleapis", () => ({
  google: {
    auth: { JWT: vi.fn() },
    gmail: vi.fn(() => ({ users: { messages: {} } })),
  },
}));

const { remediationHint } = await import("../routes/gmail.js");

type Verdict = Parameters<typeof remediationHint>[0];

function verdict(over: Partial<Verdict>): Verdict {
  return {
    address: "info@swisswater.com",
    sendable: false,
    reason: "role/system mailbox: info@",
    source: "non-prospect",
    ...over,
  } as Verdict;
}

describe("remediationHint (AUR-6330)", () => {
  // FIRE case: the refusal the AUR-5891 opt-out actually downgrades.
  it("names the vendor_inquiry opt-out for a role/system mailbox refusal", () => {
    const hint = remediationHint(verdict({}));
    expect(hint).toContain("vendor_inquiry");
    expect(hint).toContain("outboundJustification");
    // The address must be echoed so the assignee can copy the payload as-is
    // rather than re-deriving who was blocked.
    expect(hint).toContain("info@swisswater.com");
  });

  // PASS cases: refusals the opt-out does NOT downgrade. Advertising the flag
  // here would advertise a bypass that does not exist — gmail.ts hard-blocks
  // `suppression` and `denylisted recipient:` regardless of declared intent.
  it("stays silent for bounce/machine-only suppression evidence", () => {
    expect(
      remediationHint(
        verdict({ source: "suppression", reason: "hard bounce recorded 2026-07-01" }),
      ),
    ).toBe("");
  });

  it("stays silent for a denylisted recipient", () => {
    expect(remediationHint(verdict({ reason: "denylisted recipient: x@y.com" }))).toBe("");
  });

  // Own-domain never reaches the incident filer at all (gmail.ts downgrades it
  // to a warning per AUR-5807), but the builder must not claim an opt-out for
  // it either, in case that ordering ever changes.
  it("stays silent for an own-domain recipient", () => {
    expect(
      remediationHint(verdict({ reason: "own domain: temeculacoffeeroasters.com" })),
    ).toBe("");
  });

  it("tolerates a null reason without throwing", () => {
    expect(remediationHint(verdict({ reason: null }))).toBe("");
  });
});
