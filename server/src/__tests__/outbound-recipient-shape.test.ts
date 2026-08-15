import { describe, expect, it } from "vitest";
import {
  assertIntendedRecipient,
  assertProspectingRecipient,
  classifyRecipientShape,
  IntendedRecipientMismatchError,
  ProspectingRecipientError,
  normalizeAddress,
} from "../services/outbound-recipient-shape.js";

// AUR-5732. The evidence base for this suite is not hypothetical: these are the
// literal contact_path values from research/aur681/aur681-conversation-tracker.csv,
// every one of which was mailed as if it were a person.
const REAL_AUR681_QUEUE_ADDRESSES: ReadonlyArray<[string, string]> = [
  ["Oak View Group", "coupa@oakviewgroup.com"],
  ["Exact Sciences", "procurementops@exactsciences.com"],
  ["Help at Home", "Coupa@helpathome.com"],
  ["Atlantic Aviation", "supplierenablement@atlanticaviation.com"],
  ["Novolex", "Suppliers@Novolex.com"],
  ["Olymel (procurement)", "approvisionnement@olymel.com"],
  ["Olymel (AP)", "comptesfournisseurs@olymel.com"],
  ["Ball", "supplierenablement@ball.com"],
  ["Sonoco", "CoupaSupplierEnablement@Sonoco.com"],
  ["DaVita (support queue)", "PRISMSupportServices@davita.com"],
  ["DaVita (coupa queue)", "DaVitaCoupaSuppliers@davita.com"],
  ["ADM", "ADMCoupa@adm.com"],
  ["Britvic", "NewBusinessEnquiries@britvic.com"],
  ["Westbury Street (press desk)", "pressenquiries@wshlimited.com"],
  ["Pact Group (generic)", "info@pactgroup.com.au"],
  ["Pact Group (vendor queue)", "vendor.inquiry@pactgroup.com"],
  ["Molson Coors (wrong dept)", "ESG-Sustainability@molsoncoors.com"],
  ["Salling Group", "logisticsfeebf@sallinggroup.com"],
  ["Casey's", "procurement@caseys.com"],
  ["WSH (corrected route, still a queue)", "sourcedwithpurpose@wshsupport.com"],
];

// The control set. A guard proven only by its failing case is half-proven —
// one that flags every address would block all outreach forever, which is the
// mirror-image defect of the fail-open sensor it replaces.
const REAL_NAMED_HUMANS: ReadonlyArray<string> = [
  // The Help at Home agent we never once wrote to. Whole point of AUR-5732.
  "zwelsher@helpathome.com",
  "donna.huffman@oakviewgroup.com",
  "jake.ladendorf@novolex.com",
  "renee.cusack@ball.com",
  "justin.quinlan@adm.com",
  "matt.swindall@britvic.com",
  "jpatil@pactgroup.com.au",
  "cferguson@molsoncoors.com",
  "m.wightman@tolko.com",
  "abbey.jones@sonoco.com",
];

describe("classifyRecipientShape (AUR-5732)", () => {
  describe("FIRES on every contact path AUR-681 actually used", () => {
    it.each(REAL_AUR681_QUEUE_ADDRESSES)("%s — %s reads as a role/queue inbox", (_label, address) => {
      const verdict = classifyRecipientShape(address);
      expect(verdict.shape).toBe("role_inbox");
      expect(verdict.matchedRule).toBeTruthy();
    });

    it("covers all 18 tracker rows with zero misses", () => {
      const missed = REAL_AUR681_QUEUE_ADDRESSES.filter(
        ([, address]) => classifyRecipientShape(address).shape !== "role_inbox",
      );
      expect(missed).toEqual([]);
    });
  });

  describe("PASSES named humans", () => {
    it.each(REAL_NAMED_HUMANS)("%s reads as a named human", (address) => {
      const verdict = classifyRecipientShape(address);
      expect(verdict.shape).toBe("named_human");
      expect(verdict.matchedRule).toBeNull();
    });
  });

  it("strips display names and casing before deciding", () => {
    expect(classifyRecipientShape("Zachary Welsher <ZWelsher@HelpAtHome.com>")).toMatchObject({
      address: "zwelsher@helpathome.com",
      localPart: "zwelsher",
      domain: "helpathome.com",
      shape: "named_human",
    });
    expect(classifyRecipientShape("Great Support <Coupa@helpathome.com>").shape).toBe("role_inbox");
  });

  it("records which rule fired so a verdict is auditable", () => {
    // The AUR-5732 acceptance-criteria regex catches the anchored forms...
    expect(classifyRecipientShape("coupa@helpathome.com").matchedRule).toBe("aur5732-prefix");
    // ...and the token tier catches the concatenated corporate forms it misses.
    expect(classifyRecipientShape("admcoupa@adm.com").matchedRule).toBe("token:coupa");
    expect(classifyRecipientShape("newbusinessenquiries@britvic.com").matchedRule).toBe("token:enquir");
  });
});

describe("normalizeAddress", () => {
  it("returns a bare lowercase address", () => {
    expect(normalizeAddress("  Jane Prospect <Jane@Example.COM> ")).toBe("jane@example.com");
    expect(normalizeAddress("jane@example.com,")).toBe("jane@example.com");
  });
});

describe("assertProspectingRecipient (AUR-5732)", () => {
  const JUSTIFICATION =
    "Supplier portal is the only published intake and the buyer asked us to use it.";

  it("FIRES on the Help at Home queue with no justification", () => {
    expect(() =>
      assertProspectingRecipient({
        to: "Coupa@helpathome.com",
        recipientPersonName: "Zachary Welsher",
      }),
    ).toThrow(ProspectingRecipientError);
  });

  it("naming a human does NOT excuse mailing the queue", () => {
    // This is the exact AUR-681 pattern: target_role named Donna Huffman, and
    // the send went to coupa@oakviewgroup.com anyway.
    expect(() =>
      assertProspectingRecipient({
        to: "coupa@oakviewgroup.com",
        recipientPersonName: "Donna Huffman",
      }),
    ).toThrow(/role\/queue\/shared inbox/i);
  });

  it("PASSES a named human's work address", () => {
    const verdicts = assertProspectingRecipient({
      to: "zwelsher@helpathome.com",
      recipientPersonName: "Zachary Welsher",
      evidenceGrade: "verified_firstparty",
    });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].shape).toBe("named_human");
  });

  it("PASSES a queue when the queue is explicitly justified", () => {
    const verdicts = assertProspectingRecipient({
      to: "Coupa@helpathome.com",
      queueJustification: JUSTIFICATION,
    });
    expect(verdicts[0].shape).toBe("role_inbox");
  });

  it("rejects a token justification that says nothing", () => {
    expect(() =>
      assertProspectingRecipient({ to: "Coupa@helpathome.com", queueJustification: "   ok   " }),
    ).toThrow(ProspectingRecipientError);
  });

  it("still requires the send to say who it is for when the address looks human", () => {
    expect(() => assertProspectingRecipient({ to: "zwelsher@helpathome.com" })).toThrow(
      /must name the human/i,
    );
  });

  it("catches a queue hiding in cc", () => {
    expect(() =>
      assertProspectingRecipient({
        to: "zwelsher@helpathome.com",
        cc: "Coupa@helpathome.com",
        recipientPersonName: "Zachary Welsher",
      }),
    ).toThrow(ProspectingRecipientError);
  });

  it("splits a comma-separated recipient list", () => {
    expect(() =>
      assertProspectingRecipient({
        to: "zwelsher@helpathome.com, procurement@caseys.com",
        recipientPersonName: "Zachary Welsher",
      }),
    ).toThrow(/procurement@caseys\.com/);
  });

  it("refuses a prospecting send with no recipients at all", () => {
    expect(() => assertProspectingRecipient({ to: "" })).toThrow(/no recipients/i);
  });
});

// AUR-5735 wrote six human-shaped but unverified addresses to
// aur681-contact-model.csv at evidence_grade: pattern_hypothesis — derived
// from a confirmed org pattern (first.last@domain) but never observed for
// that specific person. Every one of them classifies as named_human and
// trivially satisfies recipientPersonName. This suite proves the guard now
// asks the question recipientPersonName cannot answer: not "is this
// human-shaped and named?" but "do we actually know this reaches them?"
describe("assertProspectingRecipient — evidence grade (AUR-5735/AUR-5737)", () => {
  const QUEUE_JUSTIFICATION =
    "Supplier portal is the only published intake and the buyer asked us to use it.";
  const EVIDENCE_JUSTIFICATION =
    "Sole procurement contact at this account per LinkedIn; account is time-sensitive.";

  it("FIRES on a pattern_hypothesis address — the AUR-5735 failure mode", () => {
    expect(() =>
      assertProspectingRecipient({
        to: "abbey.jones@sonoco.com",
        recipientPersonName: "Abbey Jones",
        evidenceGrade: "pattern_hypothesis",
      }),
    ).toThrow(/evidence grade is not verified/i);
  });

  it("PASSES a verified_firstparty address", () => {
    const verdicts = assertProspectingRecipient({
      to: "abbey.jones@sonoco.com",
      recipientPersonName: "Abbey Jones",
      evidenceGrade: "verified_firstparty",
    });
    expect(verdicts[0].shape).toBe("named_human");
  });

  it("FIRES when evidenceGrade is omitted entirely — fails closed, not open", () => {
    expect(() =>
      assertProspectingRecipient({
        to: "abbey.jones@sonoco.com",
        recipientPersonName: "Abbey Jones",
      }),
    ).toThrow(/evidence grade is not verified/i);
  });

  it("PASSES a non-verified grade when explicitly justified", () => {
    const verdicts = assertProspectingRecipient({
      to: "abbey.jones@sonoco.com",
      recipientPersonName: "Abbey Jones",
      evidenceGrade: "pattern_hypothesis",
      evidenceJustification: EVIDENCE_JUSTIFICATION,
    });
    expect(verdicts[0].shape).toBe("named_human");
  });

  it("rejects a token evidenceJustification that says nothing", () => {
    expect(() =>
      assertProspectingRecipient({
        to: "abbey.jones@sonoco.com",
        recipientPersonName: "Abbey Jones",
        evidenceGrade: "pattern_hypothesis",
        evidenceJustification: "   ok   ",
      }),
    ).toThrow(ProspectingRecipientError);
  });

  it("does not require evidenceGrade for a queue-only send with no named human", () => {
    // No human is being claimed here — the queue itself is already justified
    // by queueJustification, a separate axis this suite doesn't touch.
    const verdicts = assertProspectingRecipient({
      to: "Coupa@helpathome.com",
      queueJustification: QUEUE_JUSTIFICATION,
    });
    expect(verdicts[0].shape).toBe("role_inbox");
  });

  it("names every affected address in the error so the misfire is diagnosable", () => {
    try {
      assertProspectingRecipient({
        to: "abbey.jones@sonoco.com",
        recipientPersonName: "Abbey Jones",
        evidenceGrade: "pattern_hypothesis",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProspectingRecipientError);
      expect((err as ProspectingRecipientError).message).toContain("abbey.jones@sonoco.com");
    }
  });
});

describe("assertIntendedRecipient (AUR-5732 extension of the AUR-4479 read-back)", () => {
  it("FIRES when the resolved recipient is the queue instead of the prospect", () => {
    // Reproduces the 2026-07-29 resend: To: was not us, so AUR-4479 passed it,
    // and it went straight back into the helpdesk queue.
    expect(() =>
      assertIntendedRecipient("Coupa@helpathome.com", "zwelsher@helpathome.com"),
    ).toThrow(IntendedRecipientMismatchError);
  });

  it("PASSES when the resolved recipient is the prospect", () => {
    expect(() =>
      assertIntendedRecipient("Zachary Welsher <ZWelsher@helpathome.com>", "zwelsher@helpathome.com"),
    ).not.toThrow();
  });

  it("is a no-op when no intended recipient was declared", () => {
    expect(() => assertIntendedRecipient("anyone@example.com", "")).not.toThrow();
  });

  it("names both addresses in the error so the misfire is diagnosable", () => {
    try {
      assertIntendedRecipient("coupa@helpathome.com", "zwelsher@helpathome.com");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntendedRecipientMismatchError);
      expect((err as IntendedRecipientMismatchError).intended).toBe("zwelsher@helpathome.com");
      expect((err as IntendedRecipientMismatchError).actual).toBe("coupa@helpathome.com");
    }
  });
});
