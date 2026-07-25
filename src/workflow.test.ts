import { describe, expect, it } from "vitest";

import {
  initialWorkflowState,
  workflowReducer,
  type DestinationSummary,
  type TransferPreview,
  type TransferResult,
  type XSourceSummary,
} from "./workflow";

const destination: DestinationSummary = {
  serverUrl: "https://karakeep.example.com",
  userId: "user-1",
  userName: "Taylor",
};

const source: XSourceSummary = {
  kind: "x",
  browser: "Google Chrome",
  profileId: "Default",
  profileName: "Personal",
};

const fileSource = {
  kind: "file" as const,
  format: "field-theory-jsonl" as const,
  fileName: "bookmarks.jsonl",
};

const preview: TransferPreview = {
  total: 12,
  pending: 9,
  previouslyDelivered: 3,
  folders: ["Reference", "Reading"],
  destination,
};

describe("transfer workflow", () => {
  it("guides a fresh user from Destination to X Source selection", () => {
    expect(
      workflowReducer(initialWorkflowState, {
        type: "destination.connected",
        destination,
      }),
    ).toEqual({
      step: "choose-source",
      destination,
    });
  });

  it("starts acquisition only after an X Source is selected", () => {
    const withSource = workflowReducer(
      { step: "choose-source", destination },
      { type: "source.selected", source },
    );

    expect(
      workflowReducer(withSource, { type: "acquisition.started" }),
    ).toEqual({
      step: "acquiring",
      destination,
      source,
      progress: {
        completed: 0,
        total: null,
      },
    });
  });

  it("models a File Source without fabricating or replacing an X Source", () => {
    const withFileSource = workflowReducer(
      { step: "choose-source", destination },
      { type: "source.selected", source: fileSource },
    );

    expect(withFileSource).toEqual({
      step: "source-ready",
      destination,
      source: fileSource,
    });
  });

  it("shows a read-only preview after acquisition", () => {
    expect(
      workflowReducer(
        {
          step: "acquiring",
          destination,
          source,
          progress: { completed: 7, total: 12 },
        },
        { type: "acquisition.completed", preview },
      ),
    ).toEqual({
      step: "preview",
      destination,
      source,
      preview,
    });
  });

  it("reports completed delivery outcomes", () => {
    const result: TransferResult = {
      created: 7,
      existing: 2,
      retried: 1,
      failed: 0,
      cancelled: 0,
    };

    expect(
      workflowReducer(
        {
          step: "delivering",
          destination,
          source,
          preview,
          progress: { completed: 8, total: 9 },
        },
        { type: "delivery.completed", result },
      ),
    ).toEqual({
      step: "result",
      destination,
      source,
      result,
    });
  });

  it("starts delivery with the pending preview count", () => {
    expect(
      workflowReducer(
        {
          step: "preview",
          destination,
          source,
          preview,
        },
        { type: "delivery.started" },
      ),
    ).toEqual({
      step: "delivering",
      destination,
      source,
      preview,
      progress: {
        completed: 0,
        total: 9,
      },
    });
  });

  it("updates acquisition progress from a typed backend event", () => {
    expect(
      workflowReducer(
        {
          step: "acquiring",
          destination,
          source,
          progress: { completed: 2, total: null },
        },
        {
          type: "operation.progressed",
          progress: { completed: 7, total: 12 },
        },
      ),
    ).toEqual({
      step: "acquiring",
      destination,
      source,
      progress: { completed: 7, total: 12 },
    });
  });

  it("updates delivery progress without losing its preview", () => {
    expect(
      workflowReducer(
        {
          step: "delivering",
          destination,
          source,
          preview,
          progress: { completed: 2, total: 9 },
        },
        {
          type: "operation.progressed",
          progress: { completed: 5, total: 9 },
        },
      ),
    ).toEqual({
      step: "delivering",
      destination,
      source,
      preview,
      progress: { completed: 5, total: 9 },
    });
  });

  it("returns cancellation to the preview without losing it", () => {
    expect(
      workflowReducer(
        {
          step: "delivering",
          destination,
          source,
          preview,
          progress: { completed: 4, total: 9 },
        },
        { type: "operation.cancelled" },
      ),
    ).toEqual({
      step: "preview",
      destination,
      source,
      preview,
    });
  });

  it("returns acquisition cancellation to the selected source", () => {
    expect(
      workflowReducer(
        {
          step: "acquiring",
          destination,
          source,
          progress: { completed: 4, total: 12 },
        },
        { type: "operation.cancelled" },
      ),
    ).toEqual({
      step: "source-ready",
      destination,
      source,
    });
  });

  it("keeps a recoverable failure local to its retry step", () => {
    expect(
      workflowReducer(
        {
          step: "acquiring",
          destination,
          source,
          progress: { completed: 2, total: null },
        },
        {
          type: "operation.failed",
          error: {
            code: "x-compatibility",
          },
        },
      ),
    ).toEqual({
      step: "failure",
      retry: {
        step: "source-ready",
        destination,
        source,
      },
      error: {
        code: "x-compatibility",
      },
    });
  });

  it("retries an acquisition failure from the selected source", () => {
    const failed = workflowReducer(
      {
        step: "acquiring",
        destination,
        source,
        progress: { completed: 2, total: null },
      },
      {
        type: "operation.failed",
        error: { code: "x-compatibility" },
      },
    );

    expect(workflowReducer(failed, { type: "failure.retried" })).toEqual({
      step: "source-ready",
      destination,
      source,
    });
  });

  it("keeps a delivery failure local to the preview retry step", () => {
    expect(
      workflowReducer(
        {
          step: "delivering",
          destination,
          source,
          preview,
          progress: { completed: 4, total: 9 },
        },
        {
          type: "operation.failed",
          error: {
            code: "network",
          },
        },
      ),
    ).toEqual({
      step: "failure",
      retry: {
        step: "preview",
        destination,
        source,
        preview,
      },
      error: {
        code: "network",
      },
    });
  });

  it("routes a pre-source failure back to Destination connection", () => {
    expect(
      workflowReducer(initialWorkflowState, {
        type: "operation.failed",
        error: {
          code: "destination-invalid",
        },
      }),
    ).toEqual({
      step: "failure",
      retry: {
        step: "connect-destination",
      },
      error: {
        code: "destination-invalid",
      },
    });
  });

  it("routes a post-destination failure back to source selection", () => {
    expect(
      workflowReducer(
        { step: "source-ready", destination, source },
        {
          type: "operation.failed",
          error: {
            code: "source-unavailable",
          },
        },
      ),
    ).toEqual({
      step: "failure",
      retry: {
        step: "source-ready",
        destination,
        source,
      },
      error: {
        code: "source-unavailable",
      },
    });
  });

  it("ignores actions which are invalid for the current step", () => {
    const states = [
      workflowReducer(initialWorkflowState, {
        type: "source.selected",
        source,
      }),
      workflowReducer(initialWorkflowState, {
        type: "acquisition.started",
      }),
      workflowReducer(initialWorkflowState, {
        type: "acquisition.completed",
        preview,
      }),
      workflowReducer(initialWorkflowState, {
        type: "delivery.started",
      }),
      workflowReducer(initialWorkflowState, {
        type: "delivery.completed",
        result: {
          created: 0,
          existing: 0,
          retried: 0,
          failed: 0,
          cancelled: 0,
        },
      }),
      workflowReducer(initialWorkflowState, {
        type: "operation.cancelled",
      }),
      workflowReducer(initialWorkflowState, {
        type: "operation.progressed",
        progress: { completed: 1, total: 1 },
      }),
      workflowReducer(initialWorkflowState, {
        type: "failure.retried",
      }),
    ];

    expect(states).toEqual(Array.from({ length: 8 }, () => initialWorkflowState));
  });
});
