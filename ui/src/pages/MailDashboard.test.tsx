// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationsResponse } from "../api/mail";

const apiMocks = vi.hoisted(() => ({
  listConversations: vi.fn<() => Promise<ConversationsResponse>>(),
}));

vi.mock("../api/mail", () => ({
  mailApi: { listConversations: apiMocks.listConversations },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { MailDashboard } from "./MailDashboard";

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeConv(overrides: Partial<ConversationsResponse["conversations"][number]> = {}): ConversationsResponse["conversations"][number] {
  return {
    mailbox: "outreach@example.com",
    threadId: "thread-1",
    contact: "Alice Smith",
    owner: "agent-a",
    campaign: "launch-q2",
    lastOutbound: { subject: "Hello Alice", sentAt: "2026-05-30T10:00:00Z" },
    lastInbound: null,
    whoReplied: null,
    responseStatus: "awaiting-reply",
    ...overrides,
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
}

async function renderAndFlush(root: ReturnType<typeof createRoot>, element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
  await act(async () => {
    await flushPromises();
  });
}

describe("MailDashboard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the page header", async () => {
    apiMocks.listConversations.mockResolvedValue({ conversations: [] });
    const root = createRoot(container);

    await renderAndFlush(
      root,
      <QueryClientProvider client={makeQueryClient()}>
        <MailDashboard />
      </QueryClientProvider>,
    );

    expect(container.textContent).toContain("Mail");

    act(() => { root.unmount(); });
  });

  it("shows empty state when there are no conversations", async () => {
    apiMocks.listConversations.mockResolvedValue({ conversations: [] });
    const root = createRoot(container);

    await renderAndFlush(
      root,
      <QueryClientProvider client={makeQueryClient()}>
        <MailDashboard />
      </QueryClientProvider>,
    );

    expect(container.textContent).toContain("No conversations");

    act(() => { root.unmount(); });
  });

  it("renders conversation rows when data is returned", async () => {
    apiMocks.listConversations.mockResolvedValue({
      conversations: [
        makeConv({ contact: "Bob Jones", responseStatus: "needs-pickup" }),
        makeConv({ threadId: "thread-2", contact: "Carol White", responseStatus: "replied" }),
      ],
    });
    const root = createRoot(container);

    await renderAndFlush(
      root,
      <QueryClientProvider client={makeQueryClient()}>
        <MailDashboard />
      </QueryClientProvider>,
    );

    expect(container.textContent).toContain("Bob Jones");
    expect(container.textContent).toContain("Carol White");

    act(() => { root.unmount(); });
  });

  it("surfaces needs-pickup count in the stats bar", async () => {
    apiMocks.listConversations.mockResolvedValue({
      conversations: [
        makeConv({ threadId: "t1", responseStatus: "needs-pickup" }),
        makeConv({ threadId: "t2", responseStatus: "needs-pickup" }),
        makeConv({ threadId: "t3", responseStatus: "awaiting-reply" }),
      ],
    });
    const root = createRoot(container);

    await renderAndFlush(
      root,
      <QueryClientProvider client={makeQueryClient()}>
        <MailDashboard />
      </QueryClientProvider>,
    );

    // Stats bar shows "2" for needs-pickup (rendered with text-destructive)
    const destructiveCells = container.querySelectorAll(".text-destructive");
    const needsPickupStat = Array.from(destructiveCells).find((el) => el.textContent === "2");
    expect(needsPickupStat).not.toBeNull();

    act(() => { root.unmount(); });
  });

  it("shows error message when the API call fails", async () => {
    apiMocks.listConversations.mockRejectedValue(new Error("network failure"));
    const root = createRoot(container);

    await renderAndFlush(
      root,
      <QueryClientProvider client={makeQueryClient()}>
        <MailDashboard />
      </QueryClientProvider>,
    );

    expect(container.textContent).toContain("network failure");

    act(() => { root.unmount(); });
  });

  it("renders Needs Pickup badge for relevant conversations", async () => {
    apiMocks.listConversations.mockResolvedValue({
      conversations: [makeConv({ responseStatus: "needs-pickup" })],
    });
    const root = createRoot(container);

    await renderAndFlush(
      root,
      <QueryClientProvider client={makeQueryClient()}>
        <MailDashboard />
      </QueryClientProvider>,
    );

    expect(container.textContent).toContain("Needs Pickup");

    act(() => { root.unmount(); });
  });
});
