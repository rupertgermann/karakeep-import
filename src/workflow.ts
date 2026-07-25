export interface DestinationSummary {
  serverUrl: string;
  userId: string;
  userName: string;
}

export interface XSourceSummary {
  kind: "x";
  browser: string;
  profileId: string;
  profileName: string;
}

export interface FileSourceSummary {
  kind: "file";
  format: "field-theory-jsonl" | "chrome-netscape";
  fileName: string;
}

export type TransferSourceSummary = XSourceSummary | FileSourceSummary;

export interface TransferPreview {
  total: number;
  pending: number;
  previouslyDelivered: number;
  folders: string[];
  destination: DestinationSummary;
}

export interface TransferProgress {
  completed: number;
  total: number | null;
}

export interface TransferResult {
  created: number;
  existing: number;
  retried: number;
  failed: number;
  cancelled: number;
}

export type WorkflowErrorCode =
  | "browser-access"
  | "destination-authentication"
  | "destination-compatibility"
  | "destination-invalid"
  | "delivery-failed"
  | "network"
  | "source-unavailable"
  | "unexpected"
  | "x-compatibility";

export interface WorkflowError {
  code: WorkflowErrorCode;
}

type RetryState =
  | { step: "connect-destination" }
  | { step: "choose-source"; destination: DestinationSummary }
  | {
      step: "source-ready";
      destination: DestinationSummary;
      source: TransferSourceSummary;
    }
  | {
      step: "preview";
      destination: DestinationSummary;
      source: TransferSourceSummary;
      preview: TransferPreview;
    };

export type WorkflowState =
  | { step: "connect-destination" }
  | { step: "choose-source"; destination: DestinationSummary }
  | {
      step: "source-ready";
      destination: DestinationSummary;
      source: TransferSourceSummary;
    }
  | {
      step: "acquiring";
      destination: DestinationSummary;
      source: TransferSourceSummary;
      progress: TransferProgress;
    }
  | {
      step: "preview";
      destination: DestinationSummary;
      source: TransferSourceSummary;
      preview: TransferPreview;
    }
  | {
      step: "delivering";
      destination: DestinationSummary;
      source: TransferSourceSummary;
      preview: TransferPreview;
      progress: TransferProgress;
    }
  | {
      step: "result";
      destination: DestinationSummary;
      source: TransferSourceSummary;
      result: TransferResult;
    }
  | {
      step: "failure";
      retry: RetryState;
      error: WorkflowError;
    };

export type WorkflowAction =
  | {
      type: "destination.connected";
      destination: DestinationSummary;
    }
  | { type: "source.selected"; source: TransferSourceSummary }
  | { type: "acquisition.started" }
  | {
      type: "acquisition.completed";
      preview: TransferPreview;
    }
  | { type: "delivery.started" }
  | {
      type: "delivery.completed";
      result: TransferResult;
    }
  | {
      type: "operation.progressed";
      progress: TransferProgress;
    }
  | { type: "operation.cancelled" }
  | { type: "failure.retried" }
  | {
      type: "operation.failed";
      error: WorkflowError;
    };

export const initialWorkflowState: WorkflowState = {
  step: "connect-destination",
};

export function workflowReducer(
  state: WorkflowState,
  action: WorkflowAction,
): WorkflowState {
  switch (action.type) {
    case "destination.connected":
      return {
        step: "choose-source",
        destination: action.destination,
      };

    case "source.selected":
      if (state.step !== "choose-source") {
        return state;
      }
      return {
        step: "source-ready",
        destination: state.destination,
        source: action.source,
      };

    case "acquisition.started":
      if (state.step !== "source-ready") {
        return state;
      }
      return {
        step: "acquiring",
        destination: state.destination,
        source: state.source,
        progress: {
          completed: 0,
          total: null,
        },
      };

    case "acquisition.completed":
      if (state.step !== "acquiring") {
        return state;
      }
      return {
        step: "preview",
        destination: state.destination,
        source: state.source,
        preview: action.preview,
      };

    case "delivery.started":
      if (state.step !== "preview") {
        return state;
      }
      return {
        step: "delivering",
        destination: state.destination,
        source: state.source,
        preview: state.preview,
        progress: {
          completed: 0,
          total: state.preview.pending,
        },
      };

    case "delivery.completed":
      if (state.step !== "delivering") {
        return state;
      }
      return {
        step: "result",
        destination: state.destination,
        source: state.source,
        result: action.result,
      };

    case "operation.progressed":
      if (state.step !== "acquiring" && state.step !== "delivering") {
        return state;
      }
      return {
        ...state,
        progress: action.progress,
      };

    case "operation.cancelled":
      if (state.step === "delivering") {
        return {
          step: "preview",
          destination: state.destination,
          source: state.source,
          preview: state.preview,
        };
      }
      if (state.step === "acquiring") {
        return {
          step: "source-ready",
          destination: state.destination,
          source: state.source,
        };
      }
      return state;

    case "operation.failed":
      if (state.step === "acquiring") {
        return {
          step: "failure",
          retry: {
            step: "source-ready",
            destination: state.destination,
            source: state.source,
          },
          error: action.error,
        };
      }
      if (state.step === "delivering") {
        return {
          step: "failure",
          retry: {
            step: "preview",
            destination: state.destination,
            source: state.source,
            preview: state.preview,
          },
          error: action.error,
        };
      }
      if (state.step === "source-ready") {
        return {
          step: "failure",
          retry: state,
          error: action.error,
        };
      }
      if (state.step === "preview") {
        return {
          step: "failure",
          retry: state,
          error: action.error,
        };
      }
      if (state.step === "choose-source") {
        return {
          step: "failure",
          retry: state,
          error: action.error,
        };
      }
      return {
        step: "failure",
        retry: {
          step: "connect-destination",
        },
        error: action.error,
      };

    case "failure.retried":
      if (state.step !== "failure") {
        return state;
      }
      return state.retry;
  }
}
