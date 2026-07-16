import { describe, expect, it } from "vitest";
import {
  classifyGmailOutbound,
  GmailOutboundBlockedError,
  BLOCKED_RECIPIENT_DOMAINS,
} from "../services/gmail-outbound-guard.js";

describe("classifyGmailOutbound — pure classifier", () => {
  describe("gated cases (strong signals)", () => {
    it("flags report@bunq.com with 'account takeover' body (domain blocklist wins)", () => {
      const d = classifyGmailOutbound({
        to: "report@bunq.com",
        subject: "URGENT fraud report",
        text: "We have confirmed an account takeover on our merchant account.",
      });
      expect(d.gated).toBe(true);
      // Domain blocklist takes absolute priority over content-pattern detection
      expect(d.category).toBe("blocked_domain");
      expect(d.external).toBe(true);
    });

    it("flags Shopify abuse recipient alone — domain blocklist fires before content patterns", () => {
      const d = classifyGmailOutbound({
        to: "abuse@shopify.com",
        subject: "Hello",
        text: "Some text",
      });
      expect(d.gated).toBe(true);
      expect(d.category).toBe("blocked_domain");
    });

    it("flags 'we are reporting' strong signal even without report recipient", () => {
      const d = classifyGmailOutbound({
        to: "merchant-trust@shopify.com",
        subject: "Alert",
        text: "We are reporting unauthorized access.",
      });
      expect(d.gated).toBe(true);
    });

    it("flags chargeback keyword", () => {
      const d = classifyGmailOutbound({
        to: "disputes@bank.com",
        subject: "Chargeback notice",
        text: "We will file a chargeback on this transaction.",
      });
      expect(d.gated).toBe(true);
      expect(d.category).toBe("chargeback");
    });

    it("flags law enforcement signal", () => {
      const d = classifyGmailOutbound({
        to: "support@example.com",
        subject: "Escalation",
        text: "We are filing a police report with law enforcement.",
      });
      expect(d.gated).toBe(true);
      expect(d.category).toBe("law_enforcement");
    });
  });

  describe("not-gated cases", () => {
    it("allows normal transactional email", () => {
      const d = classifyGmailOutbound({
        to: "customer@example.com",
        subject: "Your order is ready",
        text: "Thank you for your purchase.",
      });
      expect(d.gated).toBe(false);
      expect(d.category).toBeNull();
    });

    it("allows internal tryauranode.com recipient even with strong content", () => {
      // Internal recipients are not gated
      const d = classifyGmailOutbound({
        to: "board@tryauranode.com",
        subject: "Account takeover note",
        text: "FYI account takeover was investigated — all clear.",
      });
      // category may be set, but gated is false because recipient is internal
      expect(d.gated).toBe(false);
    });

    it("allows recipient without report-desk address and no strong body signals", () => {
      const d = classifyGmailOutbound({
        to: "info@partner.com",
        subject: "Partnership update",
        text: "Happy to work together.",
      });
      expect(d.gated).toBe(false);
    });
  });

  describe("weak signals — only gated when paired with report recipient", () => {
    it("gates 'freeze account' when sent to report@", () => {
      const d = classifyGmailOutbound({
        to: "report@bank.com",
        subject: "Please freeze account",
        text: "We ask you to freeze the account due to suspicious activity.",
      });
      expect(d.gated).toBe(true);
    });

    it("does NOT gate 'freeze account' to a non-report recipient", () => {
      const d = classifyGmailOutbound({
        to: "support@partner.com",
        subject: "Account issue",
        text: "We ask you to freeze the account due to suspicious activity.",
      });
      expect(d.gated).toBe(false);
    });
  });

  describe("cc handling", () => {
    it("accepts a plain string cc without misclassifying by character", () => {
      const d = classifyGmailOutbound({
        to: "customer@example.com",
        cc: "info@partner.com",
        subject: "Order",
        text: "Thanks!",
      });
      expect(d.gated).toBe(false);
    });

    it("gates when a blocklisted domain appears only in a string cc", () => {
      const d = classifyGmailOutbound({
        to: "internal@tryauranode.com",
        cc: "legal@shopify.com",
        subject: "FYI",
        text: "See attached.",
      });
      expect(d.gated).toBe(true);
      expect(d.category).toBe("blocked_domain");
    });
  });

  describe("GmailOutboundBlockedError", () => {
    it("carries the decision and has name GmailOutboundBlockedError", () => {
      const d = classifyGmailOutbound({
        to: "fraud@bank.com",
        subject: "fraud report",
        text: "account takeover confirmed",
      });
      const err = new GmailOutboundBlockedError(d);
      expect(err.name).toBe("GmailOutboundBlockedError");
      expect(err.decision).toBe(d);
      expect(err.message).toContain("AUR-2525");
    });
  });
});

describe("classifyGmailOutbound — recipient domain blocklist (LAR-255)", () => {
  it("BLOCKED_RECIPIENT_DOMAINS contains the four required domains", () => {
    expect(BLOCKED_RECIPIENT_DOMAINS.has("bunq.com")).toBe(true);
    expect(BLOCKED_RECIPIENT_DOMAINS.has("shopify.com")).toBe(true);
    expect(BLOCKED_RECIPIENT_DOMAINS.has("cert.gov.ua")).toBe(true);
    expect(BLOCKED_RECIPIENT_DOMAINS.has("shopifylegal.zendesk.com")).toBe(true);
  });

  it("blocks send to any @bunq.com address with benign content", () => {
    const d = classifyGmailOutbound({
      to: "support@bunq.com",
      subject: "Hello",
      text: "Just saying hi.",
    });
    expect(d.gated).toBe(true);
    expect(d.category).toBe("blocked_domain");
    expect(d.external).toBe(true);
    expect(d.reasons).toContain("blocked-domain:bunq.com");
  });

  it("blocks send to any @shopify.com address with benign content", () => {
    const d = classifyGmailOutbound({
      to: "hello@shopify.com",
      subject: "Partnership",
      text: "We would like to discuss a partnership.",
    });
    expect(d.gated).toBe(true);
    expect(d.category).toBe("blocked_domain");
    expect(d.reasons).toContain("blocked-domain:shopify.com");
  });

  it("blocks send to any @cert.gov.ua address", () => {
    const d = classifyGmailOutbound({
      to: "contact@cert.gov.ua",
      subject: "Inquiry",
      text: "General inquiry.",
    });
    expect(d.gated).toBe(true);
    expect(d.category).toBe("blocked_domain");
    expect(d.reasons).toContain("blocked-domain:cert.gov.ua");
  });

  it("blocks send to any @shopifylegal.zendesk.com address", () => {
    const d = classifyGmailOutbound({
      to: "tickets@shopifylegal.zendesk.com",
      subject: "Question",
      text: "Routine question.",
    });
    expect(d.gated).toBe(true);
    expect(d.category).toBe("blocked_domain");
    expect(d.reasons).toContain("blocked-domain:shopifylegal.zendesk.com");
  });

  it("blocks when a blocklisted domain appears in CC (not just To)", () => {
    const d = classifyGmailOutbound({
      to: "internal@tryauranode.com",
      cc: ["legal@shopify.com"],
      subject: "FYI",
      text: "See attached.",
    });
    expect(d.gated).toBe(true);
    expect(d.category).toBe("blocked_domain");
  });

  it("does NOT block a non-blocklisted external domain with benign content", () => {
    const d = classifyGmailOutbound({
      to: "contact@partner.com",
      subject: "Partnership",
      text: "We would like to discuss a partnership.",
    });
    expect(d.gated).toBe(false);
    expect(d.category).toBeNull();
  });

  it("GmailOutboundBlockedError message for blocked_domain uses descriptive text", () => {
    const d = classifyGmailOutbound({
      to: "fraud@bunq.com",
      subject: "Hello",
      text: "Benign content.",
    });
    const err = new GmailOutboundBlockedError(d);
    expect(err.message).toContain("BLOCKED");
    expect(err.message).toContain("blocklisted recipient domain");
    expect(err.message).toContain("AUR-2525");
  });
});
