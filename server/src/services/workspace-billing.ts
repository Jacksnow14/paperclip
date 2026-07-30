import { google } from "googleapis";
import { loadServiceAccountKey } from "./google-service-account.js";

const DOMAIN = "tryauranode.com";
const IMPERSONATED_ADMIN = `board@${DOMAIN}`;
const LICENSING_PRODUCT_ID = "Google-Apps";

export type WorkspaceLicenseStatus = "granted" | "scope_not_granted";

export interface WorkspaceBillingSummary {
  domain: string;
  seatsTotal: number;
  seatsActive: number;
  seatsSuspended: number;
  planSku: string | null;
  licenseSkus: string[];
  licenseStatus: WorkspaceLicenseStatus;
  paymentStatus: "unavailable_via_api";
  source: "google_workspace_directory_api";
  fetchedAt: string;
}

interface DirectoryUser {
  suspended?: boolean;
}

function buildAuthClient(scopes: string[]) {
  const key = loadServiceAccountKey();
  return new google.auth.JWT({
    email: key["client_email"],
    key: key["private_key"],
    scopes,
    subject: IMPERSONATED_ADMIN,
  });
}

async function fetchAllDirectoryUsers(auth: InstanceType<typeof google.auth.JWT>): Promise<DirectoryUser[]> {
  const admin = google.admin({ version: "directory_v1", auth });
  const users: DirectoryUser[] = [];
  let pageToken: string | undefined;
  do {
    const res = await admin.users.list({
      customer: "my_customer",
      maxResults: 200,
      projection: "basic",
      pageToken,
    });
    users.push(...((res.data.users ?? []) as DirectoryUser[]));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return users;
}

// Domain-wide delegation for admin.directory.user.readonly is granted, but
// apps.licensing.readonly is not (Tier B, pending founder grant — AUR-3290).
// A JWT requesting an ungranted scope fails at token exchange with
// `unauthorized_client`, so licensing is fetched via a separate token request
// and any failure there degrades to scope_not_granted rather than failing the
// whole summary.
async function fetchLicenseSkus(): Promise<{ status: WorkspaceLicenseStatus; skus: string[] }> {
  try {
    const auth = buildAuthClient(["https://www.googleapis.com/auth/apps.licensing.readonly"]);
    await auth.authorize();
    const licensing = google.licensing({ version: "v1", auth });
    const skus = new Set<string>();
    let pageToken: string | undefined;
    do {
      const res = await licensing.licenseAssignments.listForProduct({
        productId: LICENSING_PRODUCT_ID,
        customerId: DOMAIN,
        maxResults: 200,
        pageToken,
      });
      for (const item of res.data.items ?? []) {
        if (item.skuId) skus.add(item.skuId);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return { status: "granted", skus: [...skus] };
  } catch {
    return { status: "scope_not_granted", skus: [] };
  }
}

export async function getWorkspaceBillingSummary(): Promise<WorkspaceBillingSummary> {
  const directoryAuth = buildAuthClient(["https://www.googleapis.com/auth/admin.directory.user.readonly"]);
  const users = await fetchAllDirectoryUsers(directoryAuth);
  const seatsSuspended = users.filter((u) => u.suspended === true).length;
  const seatsTotal = users.length;
  const seatsActive = seatsTotal - seatsSuspended;

  const license = await fetchLicenseSkus();

  return {
    domain: DOMAIN,
    seatsTotal,
    seatsActive,
    seatsSuspended,
    planSku: license.skus[0] ?? null,
    licenseSkus: license.skus,
    licenseStatus: license.status,
    paymentStatus: "unavailable_via_api",
    source: "google_workspace_directory_api",
    fetchedAt: new Date().toISOString(),
  };
}
