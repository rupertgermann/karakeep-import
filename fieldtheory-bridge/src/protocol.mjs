import { discoverSources, selectSource } from "./source-discovery.mjs";

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
};

const safeRequestId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value)
    ? value
    : "unknown";

function errorResponse(requestId, code, message) {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    type: "error",
    error: { code, message },
  });
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

export async function handleLine(
  line,
  handlers = { discoverSources, selectSource },
) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return errorResponse("unknown", "invalid_json", "Request is not valid JSON.");
  }

  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return errorResponse(
      "unknown",
      "invalid_request",
      "Request must be a JSON object.",
    );
  }

  const requestId = safeRequestId(request.requestId);
  if (request.protocolVersion !== PROTOCOL_VERSION) {
    return errorResponse(
      requestId,
      "unsupported_protocol",
      "Unsupported bridge protocol version.",
    );
  }
  if (requestId === "unknown") {
    return errorResponse(
      requestId,
      "invalid_request",
      "Request identifier is invalid.",
    );
  }

  const allowedFields = COMMAND_FIELDS[request.command];
  if (!allowedFields) {
    return errorResponse(
      requestId,
      "unsupported_command",
      "Unsupported bridge command.",
    );
  }
  if (!hasOnlyFields(request, allowedFields)) {
    return errorResponse(
      requestId,
      "invalid_request",
      "Request contains unsupported fields.",
    );
  }
  if (request.command === "selectSource" && !validSource(request.source)) {
    return errorResponse(
      requestId,
      "invalid_request",
      "Source selection is invalid.",
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
