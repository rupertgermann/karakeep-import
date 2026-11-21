import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { FileSourceFormat } from "./desktop-api";
import type {
  TransferOptions,
  TransferPreview,
  TransferProgress,
  TransferResult,
} from "./workflow";

export type TransferSourceRequest =
  | { kind: "x" }
  | {
      kind: "file";
      path: string;
      format: FileSourceFormat;
    };

export interface StartDeliveryRequest {
  approvalId?: string;
  deliveryId: string;
  retryOf?: string;
  source: TransferSourceRequest;
  options: TransferOptions;
}

export type DeliveryFailureCode =
  | "destination-authentication"
  | "destination-compatibility"
  | "delivery-failed"
  | "network"
  | "unexpected";

export type DeliveryEvent =
  | {
      type: "progress";
      deliveryId: string;
      progress: TransferProgress;
    }
  | {
      type: "completed";
      deliveryId: string;
      result: TransferResult;
    }
  | {
      type: "cancelled";
      deliveryId: string;
      result: TransferResult;
    }
  | {
      type: "failed";
      deliveryId: string;
      code: DeliveryFailureCode;
      result: TransferResult;
    };

export interface TransferApi {
  previewTransfer(
    source: TransferSourceRequest,
    options: TransferOptions,
  ): Promise<TransferPreview>;
  startDelivery(
    request: StartDeliveryRequest,
    onEvent: (event: DeliveryEvent) => void,
  ): Promise<UnlistenFn>;
  cancelDelivery(deliveryId: string): Promise<void>;
}

const failureCodes = new Set<DeliveryFailureCode>([
  "destination-authentication",
  "destination-compatibility",
  "delivery-failed",
  "network",
  "unexpected",
]);

export const transferApi: TransferApi = {
  previewTransfer: (source, options) =>
    invoke<TransferPreview>("preview_transfer", { source, options }),

  startDelivery: async (request, onEvent) => {
    const unlisten = await listen<unknown>("delivery", ({ payload }) => {
      const event = deliveryEvent(payload, request.deliveryId);
      if (event !== null) {
        onEvent(event);
      }
    });
    try {
      await invoke<void>("start_delivery", { request });
      return unlisten;
    } catch (error) {
      unlisten();
      throw error;
    }
  },

  cancelDelivery: (deliveryId) =>
    invoke<void>("cancel_delivery", { deliveryId }),
};

function deliveryEvent(
  payload: unknown,
  expectedDeliveryId: string,
): DeliveryEvent | null {
  if (
    !isRecord(payload) ||
    payload.deliveryId !== expectedDeliveryId ||
    typeof payload.type !== "string"
  ) {
    return null;
  }

  switch (payload.type) {
    case "progress": {
      const progress = transferProgress(payload.progress);
      return progress === null
        ? null
        : {
            type: "progress",
            deliveryId: expectedDeliveryId,
            progress,
          };
    }

    case "completed": {
      const result = transferResult(payload.result);
      return result === null
        ? null
        : {
            type: "completed",
            deliveryId: expectedDeliveryId,
            result,
          };
    }

    case "cancelled": {
      const result = transferResult(payload.result);
      return result === null
        ? null
        : {
            type: "cancelled",
            deliveryId: expectedDeliveryId,
            result,
          };
    }

    case "failed": {
      const result = transferResult(payload.result);
      return result === null
        ? null
        : {
            type: "failed",
            deliveryId: expectedDeliveryId,
            code: failureCode(payload.code),
            result,
          };
    }

    default:
      return null;
  }
}

function transferProgress(value: unknown): TransferProgress | null {
  if (
    !isRecord(value) ||
    !isCount(value.completed) ||
    !(value.total === null || isCount(value.total))
  ) {
    return null;
  }
  return {
    completed: value.completed,
    total: value.total,
  };
}

function transferResult(value: unknown): TransferResult | null {
  if (
    !isRecord(value) ||
    !isCount(value.delivered) ||
    !isCount(value.created) ||
    !isCount(value.existing) ||
    !isCount(value.retried) ||
    !isCount(value.failed) ||
    !isCount(value.cancelled)
  ) {
    return null;
  }
  return {
    delivered: value.delivered,
    created: value.created,
    existing: value.existing,
    retried: value.retried,
    failed: value.failed,
    cancelled: value.cancelled,
  };
}

function failureCode(value: unknown): DeliveryFailureCode {
  return typeof value === "string" &&
    failureCodes.has(value as DeliveryFailureCode)
    ? (value as DeliveryFailureCode)
    : "unexpected";
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
