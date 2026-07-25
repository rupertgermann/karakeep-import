import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

import {
  transferApi,
  type DeliveryEvent,
  type TransferSourceRequest,
} from "./transfer-api";
import type { TransferPreview } from "./workflow";

const preview: TransferPreview = {
  total: 3,
  pending: 2,
  previouslyDelivered: 1,
  folders: ["Reading"],
  destination: {
    serverUrl: "https://keep.example",
    userId: "user-1",
    userName: "Reader",
  },
};

describe("transfer desktop API", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
  });

  it.each<{
    label: string;
    source: TransferSourceRequest;
  }>([
    { label: "active X Source", source: { kind: "x" } },
    {
      label: "one-run File Source",
      source: {
        kind: "file",
        path: "/private/selected/bookmarks.jsonl",
        format: "fieldTheoryJsonl",
      },
    },
  ])("previews the $label through one command", async ({ source }) => {
    mocks.invoke.mockResolvedValue(preview);

    const actual = await transferApi.previewTransfer(source);

    expect({
      actual,
      invokeCalls: mocks.invoke.mock.calls,
    }).toEqual({
      actual: preview,
      invokeCalls: [["preview_transfer", { source }]],
    });
  });

  it("installs the delivery listener before starting and returns its cleanup", async () => {
    const calls: string[] = [];
    const unlisten = vi.fn();
    mocks.listen.mockImplementation(async () => {
      calls.push("listen");
      return unlisten;
    });
    mocks.invoke.mockImplementation(async () => {
      calls.push("invoke");
    });
    const request = {
      deliveryId: "delivery-1",
      source: { kind: "x" as const },
    };

    const cleanup = await transferApi.startDelivery(request, vi.fn());

    expect({
      calls,
      cleanup,
      listenCalls: mocks.listen.mock.calls,
      invokeCalls: mocks.invoke.mock.calls,
    }).toEqual({
      calls: ["listen", "invoke"],
      cleanup: unlisten,
      listenCalls: [["delivery", expect.any(Function)]],
      invokeCalls: [["start_delivery", { request }]],
    });
  });

  it("forwards the opaque approval alongside the existing File Source selector", async () => {
    mocks.listen.mockResolvedValue(() => {});
    mocks.invoke.mockResolvedValue(undefined);

    await transferApi.startDelivery(
      {
        approvalId: "file-approval-1",
        deliveryId: "delivery-file",
        source: {
          kind: "file",
          path: "/private/selected/bookmarks.jsonl",
          format: "fieldTheoryJsonl",
        },
      },
      vi.fn(),
    );

    expect(mocks.invoke).toHaveBeenCalledWith("start_delivery", {
      request: {
        approvalId: "file-approval-1",
        deliveryId: "delivery-file",
        source: {
          kind: "file",
          path: "/private/selected/bookmarks.jsonl",
          format: "fieldTheoryJsonl",
        },
      },
    });
  });

  it("forwards only events for the delivery that installed the listener", async () => {
    let listener: ((event: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementation(async (_name, callback) => {
      listener = callback;
      return () => {};
    });
    mocks.invoke.mockResolvedValue(undefined);
    const onEvent = vi.fn();
    await transferApi.startDelivery(
      { deliveryId: "delivery-filtered", source: { kind: "x" } },
      onEvent,
    );

    listener?.({
      payload: {
        type: "cancelled",
        deliveryId: "another-delivery",
        result: {
          created: 0,
          existing: 0,
          retried: 0,
          failed: 0,
          cancelled: 1,
        },
      },
    });
    listener?.({
      payload: {
        type: "cancelled",
        deliveryId: "delivery-filtered",
        result: {
          created: 0,
          existing: 0,
          retried: 0,
          failed: 0,
          cancelled: 1,
        },
      },
    });

    expect(onEvent).toHaveBeenCalledOnce();
  });

  it("forwards only allowlisted event fields and redacted failure codes", async () => {
    let listener: ((event: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementation(async (_name, callback) => {
      listener = callback;
      return () => {};
    });
    mocks.invoke.mockResolvedValue(undefined);
    const events: DeliveryEvent[] = [];
    await transferApi.startDelivery(
      { deliveryId: "delivery-safe", source: { kind: "x" } },
      (event) => events.push(event),
    );

    listener?.({
      payload: {
        type: "progress",
        deliveryId: "delivery-safe",
        progress: { completed: 1, total: 2, bookmarkContent: "secret" },
        apiKey: "api-key-canary",
      },
    });
    listener?.({
      payload: {
        type: "completed",
        deliveryId: "delivery-safe",
        result: {
          created: 1,
          existing: 1,
          retried: 1,
          failed: 0,
          cancelled: 0,
          privateNote: "secret",
        },
      },
    });
    listener?.({
      payload: {
        type: "failed",
        deliveryId: "delivery-safe",
        code: "network",
        message: "api-key-canary",
      },
    });
    listener?.({
      payload: {
        type: "cancelled",
        deliveryId: "delivery-safe",
        result: {
          created: 1,
          existing: 0,
          retried: 1,
          failed: 0,
          cancelled: 1,
          privateNote: "secret",
        },
        reason: "private bookmark text",
      },
    });
    listener?.({
      payload: {
        type: "debug",
        deliveryId: "delivery-safe",
        apiKey: "api-key-canary",
      },
    });

    expect(events).toEqual([
      {
        type: "progress",
        deliveryId: "delivery-safe",
        progress: { completed: 1, total: 2 },
      },
      {
        type: "completed",
        deliveryId: "delivery-safe",
        result: {
          created: 1,
          existing: 1,
          retried: 1,
          failed: 0,
          cancelled: 0,
        },
      },
      {
        type: "failed",
        deliveryId: "delivery-safe",
        code: "network",
      },
      {
        type: "cancelled",
        deliveryId: "delivery-safe",
        result: {
          created: 1,
          existing: 0,
          retried: 1,
          failed: 0,
          cancelled: 1,
        },
      },
    ]);
  });

  it("ignores malformed numeric progress, completion, and cancellation payloads", async () => {
    let listener: ((event: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementation(async (_name, callback) => {
      listener = callback;
      return () => {};
    });
    mocks.invoke.mockResolvedValue(undefined);
    const onEvent = vi.fn();
    await transferApi.startDelivery(
      { deliveryId: "delivery-invalid", source: { kind: "x" } },
      onEvent,
    );

    listener?.({
      payload: {
        type: "progress",
        deliveryId: "delivery-invalid",
        progress: { completed: -1, total: 2 },
      },
    });
    listener?.({
      payload: {
        type: "completed",
        deliveryId: "delivery-invalid",
        result: {
          created: "one",
          existing: 0,
          retried: 0,
          failed: 0,
          cancelled: 0,
        },
      },
    });
    listener?.({
      payload: {
        type: "cancelled",
        deliveryId: "delivery-invalid",
      },
    });

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("maps an unknown backend failure code to the redacted unexpected code", async () => {
    let listener: ((event: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementation(async (_name, callback) => {
      listener = callback;
      return () => {};
    });
    mocks.invoke.mockResolvedValue(undefined);
    const onEvent = vi.fn();
    await transferApi.startDelivery(
      { deliveryId: "delivery-error", source: { kind: "x" } },
      onEvent,
    );

    listener?.({
      payload: {
        type: "failed",
        deliveryId: "delivery-error",
        code: "raw-backend-error",
        message: "private backend detail",
      },
    });

    expect(onEvent).toHaveBeenCalledWith({
      type: "failed",
      deliveryId: "delivery-error",
      code: "unexpected",
    });
  });

  it("removes the delivery listener when startup fails", async () => {
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValue(unlisten);
    mocks.invoke.mockRejectedValue(new Error("delivery unavailable"));

    await expect(
      transferApi.startDelivery(
        {
          deliveryId: "delivery-error",
          source: { kind: "x" },
        },
        vi.fn(),
      ),
    ).rejects.toThrow("delivery unavailable");

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("cancels only the requested delivery through the command boundary", async () => {
    mocks.invoke.mockResolvedValue(undefined);

    await transferApi.cancelDelivery("delivery-1");

    expect(mocks.invoke).toHaveBeenCalledWith("cancel_delivery", {
      deliveryId: "delivery-1",
    });
  });
});
