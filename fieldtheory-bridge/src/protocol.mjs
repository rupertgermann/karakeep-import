import { discoverSources, selectSource } from "./source-discovery.mjs";
import {
  AcquisitionError,
  acquireSnapshot,
} from "./acquisition.mjs";

export const PROTOCOL_VERSION = 1;

const COMMAND_FIELDS = {
  discoverSources: new Set(["protocolVersion", "requestId", "command"]),
  selectSource: new Set([
    "protocolVersion",
    "requestId",
    "command",
    "consent",
    "source",
  ]),
  acquireSnapshot: new Set([
    "protocolVersion",
    "requestId",
    "command",
    "consent",
    "source",
  ]),
  cancelAcquisition: new Set([
    "protocolVersion",
    "requestId",
    "command",
    "acquisitionId",
  ]),
};

const safeRequestId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value)
    ? value
    : "unknown";

function errorResponse(requestId, code, message) {
  return JSON.stringify(errorMessage(requestId, code, message));
}

function errorMessage(requestId, code, message) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    type: "error",
    error: { code, message },
  };
}

function hasOnlyFields(value, fields) {
  return Object.keys(value).every((key) => fields.has(key));
}

function validSource(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    typeof value.browserId === "string" &&
    /^[a-z]{2,16}$/.test(value.browserId) &&
    typeof value.profileId === "string" &&
    value.profileId.length > 0 &&
    value.profileId.length <= 160
  );
}

function decodeLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return {
      error: errorMessage(
        "unknown",
        "invalid_json",
        "Request is not valid JSON.",
      ),
    };
  }

  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return {
      error: errorMessage(
        "unknown",
        "invalid_request",
        "Request must be a JSON object.",
      ),
    };
  }

  const requestId = safeRequestId(request.requestId);
  if (request.protocolVersion !== PROTOCOL_VERSION) {
    return {
      error: errorMessage(
        requestId,
        "unsupported_protocol",
        "Unsupported bridge protocol version.",
      ),
    };
  }
  if (requestId === "unknown") {
    return {
      error: errorMessage(
        requestId,
        "invalid_request",
        "Request identifier is invalid.",
      ),
    };
  }

  const allowedFields = COMMAND_FIELDS[request.command];
  if (!allowedFields) {
    return {
      error: errorMessage(
        requestId,
        "unsupported_command",
        "Unsupported bridge command.",
      ),
    };
  }
  if (!hasOnlyFields(request, allowedFields)) {
    return {
      error: errorMessage(
        requestId,
        "invalid_request",
        "Request contains unsupported fields.",
      ),
    };
  }
  if (
    ["selectSource", "acquireSnapshot"].includes(request.command) &&
    !validSource(request.source)
  ) {
    return {
      error: errorMessage(
        requestId,
        "invalid_request",
        "Source selection is invalid.",
      ),
    };
  }
  if (request.command === "acquireSnapshot" && request.consent !== true) {
    return {
      error: errorMessage(
        requestId,
        "consent_required",
        "Explicit X-session consent is required.",
      ),
    };
  }
  if (
    request.command === "cancelAcquisition" &&
    safeRequestId(request.acquisitionId) === "unknown"
  ) {
    return {
      error: errorMessage(
        requestId,
        "invalid_request",
        "Acquisition identifier is invalid.",
      ),
    };
  }

  return { request };
}

export async function handleLine(
  line,
  handlers = { discoverSources, selectSource },
) {
  const decoded = decodeLine(line);
  if (decoded.error) {
    return JSON.stringify(decoded.error);
  }
  const { request } = decoded;
  const requestId = request.requestId;
  if (!["discoverSources", "selectSource"].includes(request.command)) {
    return errorResponse(
      requestId,
      "session_required",
      "This command requires a bridge session.",
    );
  }

  try {
    const data =
      request.command === "discoverSources"
        ? await handlers.discoverSources()
        : await handlers.selectSource({
            consent: request.consent,
            source: request.source,
          });
    return JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      type: "result",
      command: request.command,
      data,
    });
  } catch (error) {
    const message =
      error instanceof Error &&
      [
        "Explicit X-session consent is required.",
        "The selected browser profile is no longer available.",
      ].includes(error.message)
        ? error.message
        : "The Field Theory bridge could not complete the request.";
    const code =
      message === "Explicit X-session consent is required."
        ? "consent_required"
        : message === "The selected browser profile is no longer available."
          ? "source_unavailable"
          : "bridge_error";
    return errorResponse(requestId, code, message);
  }
}

function acquisitionError(error) {
  if (error instanceof AcquisitionError && error.code === "consent_required") {
    return {
      type: "error",
      code: "consent_required",
      message: "Explicit X-session consent is required.",
    };
  }
  if (error instanceof AcquisitionError && error.code === "cancelled") {
    return { type: "cancelled" };
  }
  if (error instanceof AcquisitionError && error.code === "x_compatibility") {
    return {
      type: "error",
      code: "x_compatibility",
      message:
        "X bookmark acquisition is temporarily incompatible. A Karakeep Transfer update may be required.",
    };
  }
  if (
    error instanceof AcquisitionError &&
    error.code === "source_unavailable"
  ) {
    return {
      type: "error",
      code: "source_unavailable",
      message: "The selected browser profile is no longer available.",
    };
  }
  return {
    type: "error",
    code: "bridge_error",
    message: "The Field Theory bridge could not complete the request.",
  };
}

export function createBridgeSession(
  handlers = { acquireSnapshot },
  emit = (line) => process.stdout.write(`${line}\n`),
) {
  let active;
  const send = (message) => emit(JSON.stringify(message));

  const handleSessionLine = (line) => {
    const decoded = decodeLine(line);
    if (decoded.error) {
      send(decoded.error);
      return;
    }
    const { request } = decoded;

    if (["discoverSources", "selectSource"].includes(request.command)) {
      void handleLine(line).then(emit);
      return;
    }

    if (request.command === "cancelAcquisition") {
      if (!active || active.requestId !== request.acquisitionId) {
        send(
          errorMessage(
            request.requestId,
            "operation_not_active",
            "The requested acquisition is not running.",
          ),
        );
        return;
      }
      active.controller.abort();
      send({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        type: "result",
        command: "cancelAcquisition",
        data: { acquisitionId: request.acquisitionId },
      });
      return;
    }

    if (active) {
      send(
        errorMessage(
          request.requestId,
          "operation_active",
          "Another acquisition is already running.",
        ),
      );
      return;
    }

    const controller = new AbortController();
    active = { requestId: request.requestId, controller };
    void Promise.resolve(
      handlers.acquireSnapshot({
        consent: request.consent,
        source: request.source,
        dataDir: process.env.FT_DATA_DIR,
        signal: controller.signal,
        onProgress: (data) =>
          send({
            protocolVersion: PROTOCOL_VERSION,
            requestId: request.requestId,
            type: "progress",
            command: "acquireSnapshot",
            data,
          }),
      }),
    )
      .then((data) =>
        send({
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          type: "result",
          command: "acquireSnapshot",
          data,
        }),
      )
      .catch((error) => {
        const safe = acquisitionError(error);
        if (safe.type === "cancelled") {
          send({
            protocolVersion: PROTOCOL_VERSION,
            requestId: request.requestId,
            type: "cancelled",
            command: "acquireSnapshot",
            data: { acquisitionId: request.requestId },
          });
          return;
        }
        send(errorMessage(request.requestId, safe.code, safe.message));
      })
      .finally(() => {
        if (active?.requestId === request.requestId) {
          active = undefined;
        }
      });
  };

  return { handleLine: handleSessionLine };
}
