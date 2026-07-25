import assert from "node:assert/strict";
import test from "node:test";

import {
  createBridgeSession,
  handleLine,
} from "../src/protocol.mjs";
import { AcquisitionError } from "../src/acquisition.mjs";

test("returns a versioned structured discovery result", async () => {
  const output = await handleLine(
    JSON.stringify({
      protocolVersion: 1,
      requestId: "discover-1",
      command: "discoverSources",
    }),
    {
      discoverSources: async () => ({
        browsers: [
          {
            id: "chrome",
            name: "Google Chrome",
            profiles: [{ id: "Default", name: "Personal" }],
          },
        ],
      }),
    },
  );

  assert.deepEqual(JSON.parse(output), {
    protocolVersion: 1,
    requestId: "discover-1",
    type: "result",
    command: "discoverSources",
    data: {
      browsers: [
        {
          id: "chrome",
          name: "Google Chrome",
          profiles: [{ id: "Default", name: "Personal" }],
        },
      ],
    },
  });
});

test("rejects secret-bearing input without echoing password-equivalent values", async () => {
  const secret = "auth-token-canary-8472";
  const output = await handleLine(
    JSON.stringify({
      protocolVersion: 1,
      requestId: "secret-1",
      command: "selectSource",
      consent: true,
      source: { browserId: "chrome", profileId: "Default" },
      authToken: secret,
    }),
  );

  assert.doesNotMatch(output, new RegExp(secret));
  assert.deepEqual(JSON.parse(output), {
    protocolVersion: 1,
    requestId: "secret-1",
    type: "error",
    error: {
      code: "invalid_request",
      message: "Request contains unsupported fields.",
    },
  });
});

test("returns a structured selected source without session material", async () => {
  const output = await handleLine(
    JSON.stringify({
      protocolVersion: 1,
      requestId: "select-1",
      command: "selectSource",
      consent: true,
      source: { browserId: "firefox", profileId: "Profiles/default" },
    }),
    {
      selectSource: async () => ({
        browserId: "firefox",
        browserName: "Firefox",
        profileId: "Profiles/default",
        profileName: "default-release",
      }),
    },
  );

  assert.deepEqual(JSON.parse(output), {
    protocolVersion: 1,
    requestId: "select-1",
    type: "result",
    command: "selectSource",
    data: {
      browserId: "firefox",
      browserName: "Firefox",
      profileId: "Profiles/default",
      profileName: "default-release",
    },
  });
  assert.doesNotMatch(output, /ct0|auth.?token|cookie/i);
});

test("returns stable errors for malformed or unsupported requests", async () => {
  const cases = [
    ["{", "unknown", "invalid_json"],
    ["[]", "unknown", "invalid_request"],
    [
      JSON.stringify({
        protocolVersion: 2,
        requestId: "version-1",
        command: "discoverSources",
      }),
      "version-1",
      "unsupported_protocol",
    ],
    [
      JSON.stringify({
        protocolVersion: 1,
        requestId: "contains spaces",
        command: "discoverSources",
      }),
      "unknown",
      "invalid_request",
    ],
    [
      JSON.stringify({
        protocolVersion: 1,
        requestId: "command-1",
        command: "runShell",
      }),
      "command-1",
      "unsupported_command",
    ],
    [
      JSON.stringify({
        protocolVersion: 1,
        requestId: "source-1",
        command: "selectSource",
        consent: true,
        source: { browserId: "chrome" },
      }),
      "source-1",
      "invalid_request",
    ],
  ];

  for (const [input, requestId, code] of cases) {
    const parsed = JSON.parse(await handleLine(input));
    assert.equal(parsed.requestId, requestId);
    assert.equal(parsed.type, "error");
    assert.equal(parsed.error.code, code);
  }
});

test("redacts unexpected bridge failures", async () => {
  const secret = "ct0-canary-9921";
  const output = await handleLine(
    JSON.stringify({
      protocolVersion: 1,
      requestId: "failure-1",
      command: "discoverSources",
    }),
    {
      discoverSources: async () => {
        throw new Error(`profile failure ${secret}`);
      },
    },
  );

  assert.doesNotMatch(output, new RegExp(secret));
  assert.equal(JSON.parse(output).error.code, "bridge_error");
});

test("streams versioned acquisition progress and a secret-free result", async () => {
  const output = [];
  const session = createBridgeSession(
    {
      acquireSnapshot: async ({ onProgress }) => {
        onProgress({ phase: "bookmarks", completed: 20, total: null });
        return {
          total: 21,
          added: 1,
          folders: ["Research"],
          mediaDownloaded: false,
        };
      },
    },
    (line) => output.push(JSON.parse(line)),
  );

  session.handleLine(
    JSON.stringify({
      protocolVersion: 1,
      requestId: "acquire-1",
      command: "acquireSnapshot",
      source: { browserId: "chrome", profileId: "Default" },
    }),
  );
  await new Promise(setImmediate);

  assert.deepEqual(output, [
    {
      protocolVersion: 1,
      requestId: "acquire-1",
      type: "progress",
      command: "acquireSnapshot",
      data: { phase: "bookmarks", completed: 20, total: null },
    },
    {
      protocolVersion: 1,
      requestId: "acquire-1",
      type: "result",
      command: "acquireSnapshot",
      data: {
        total: 21,
        added: 1,
        folders: ["Research"],
        mediaDownloaded: false,
      },
    },
  ]);
});

test("allows only one acquisition operation at a time", async () => {
  const output = [];
  const session = createBridgeSession(
    {
      acquireSnapshot: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(
              new AcquisitionError("cancelled", "Acquisition was cancelled."),
            ),
          );
        }),
    },
    (line) => output.push(JSON.parse(line)),
  );

  session.handleLine(
    JSON.stringify({
      protocolVersion: 1,
      requestId: "acquire-active",
      command: "acquireSnapshot",
      source: { browserId: "chrome", profileId: "Default" },
    }),
  );
  session.handleLine(
    JSON.stringify({
      protocolVersion: 1,
      requestId: "acquire-second",
      command: "acquireSnapshot",
      source: { browserId: "chrome", profileId: "Default" },
    }),
  );
  await new Promise(setImmediate);

  assert.deepEqual(output[0], {
    protocolVersion: 1,
    requestId: "acquire-second",
    type: "error",
    error: {
      code: "operation_active",
      message: "Another acquisition is already running.",
    },
  });

  session.handleLine(
    JSON.stringify({
      protocolVersion: 1,
      requestId: "cancel-active",
      command: "cancelAcquisition",
      acquisitionId: "acquire-active",
    }),
  );
});

test("cancels the matching acquisition through the versioned protocol", async () => {
  const output = [];
  const session = createBridgeSession(
    {
      acquireSnapshot: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(
              new AcquisitionError("cancelled", "Acquisition was cancelled."),
            ),
          );
        }),
    },
    (line) => output.push(JSON.parse(line)),
  );

  session.handleLine(
    JSON.stringify({
      protocolVersion: 1,
      requestId: "acquire-cancel",
      command: "acquireSnapshot",
      source: { browserId: "firefox", profileId: "Profiles/default" },
    }),
  );
  session.handleLine(
    JSON.stringify({
      protocolVersion: 1,
      requestId: "cancel-1",
      command: "cancelAcquisition",
      acquisitionId: "acquire-cancel",
    }),
  );
  await new Promise(setImmediate);

  assert.deepEqual(output, [
    {
      protocolVersion: 1,
      requestId: "cancel-1",
      type: "result",
      command: "cancelAcquisition",
      data: { acquisitionId: "acquire-cancel" },
    },
    {
      protocolVersion: 1,
      requestId: "acquire-cancel",
      type: "cancelled",
      command: "acquireSnapshot",
      data: { acquisitionId: "acquire-cancel" },
    },
  ]);
});
