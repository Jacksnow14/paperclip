import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mockAuthorize = vi.fn().mockResolvedValue(undefined);
const mockUsersList = vi.fn();
const mockLicenseAssignmentsListForProduct = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    auth: {
      JWT: vi.fn().mockImplementation(() => ({ authorize: mockAuthorize })),
    },
    admin: vi.fn(() => ({ users: { list: mockUsersList } })),
    licensing: vi.fn(() => ({
      licenseAssignments: { listForProduct: mockLicenseAssignmentsListForProduct },
    })),
  },
}));

const FAKE_SA_KEY = JSON.stringify({
  client_email: "sa@proj.iam.gserviceaccount.com",
  private_key: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
});

async function loadService() {
  return import("../services/workspace-billing.js");
}

describe("getWorkspaceBillingSummary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockAuthorize.mockResolvedValue(undefined);
    process.env.GOOGLE_WORKSPACE_SA_KEY = FAKE_SA_KEY;
  });

  afterEach(() => {
    delete process.env.GOOGLE_WORKSPACE_SA_KEY;
  });

  it("counts active vs suspended seats across paginated Directory API results", async () => {
    mockUsersList
      .mockResolvedValueOnce({
        data: {
          users: [{ suspended: false }, { suspended: false }, { suspended: true }],
          nextPageToken: "page-2",
        },
      })
      .mockResolvedValueOnce({
        data: { users: [{ suspended: false }], nextPageToken: undefined },
      });
    mockLicenseAssignmentsListForProduct.mockResolvedValue({
      data: { items: [{ skuId: "Google-Apps-For-Business" }], nextPageToken: undefined },
    });

    const { getWorkspaceBillingSummary } = await loadService();
    const summary = await getWorkspaceBillingSummary();

    expect(summary).toMatchObject({
      domain: "tryauranode.com",
      seatsTotal: 4,
      seatsActive: 3,
      seatsSuspended: 1,
      paymentStatus: "unavailable_via_api",
      source: "google_workspace_directory_api",
      licenseStatus: "granted",
      planSku: "Google-Apps-For-Business",
      licenseSkus: ["Google-Apps-For-Business"],
    });
    expect(typeof summary.fetchedAt).toBe("string");
    expect(mockUsersList).toHaveBeenCalledTimes(2);
  });

  it("degrades licensing to scope_not_granted when the licensing scope is not delegated", async () => {
    mockUsersList.mockResolvedValueOnce({
      data: { users: [{ suspended: false }], nextPageToken: undefined },
    });
    // Only fetchLicenseSkus() calls authorize() explicitly; directory calls go
    // straight through the mocked admin.users.list without a prior authorize.
    mockAuthorize.mockRejectedValueOnce(
      Object.assign(new Error("unauthorized_client"), { code: "unauthorized_client" }),
    );

    const { getWorkspaceBillingSummary } = await loadService();
    const summary = await getWorkspaceBillingSummary();

    expect(summary.licenseStatus).toBe("scope_not_granted");
    expect(summary.planSku).toBeNull();
    expect(summary.licenseSkus).toEqual([]);
    expect(summary.seatsActive).toBe(1);
  });
});
