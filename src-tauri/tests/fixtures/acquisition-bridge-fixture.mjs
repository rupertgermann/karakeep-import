import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

for await (const line of input) {
  const request = JSON.parse(line);
  if (request.command === "cancelAcquisition") {
    send({
      protocolVersion: 1,
      requestId: request.requestId,
      type: "result",
      command: "cancelAcquisition",
      data: { acquisitionId: request.acquisitionId },
    });
    continue;
  }
  if (request.command !== "acquireSnapshot") continue;

  await mkdir(process.env.FT_DATA_DIR, { recursive: true });
  if (process.env.KARAKEEP_API_KEY) {
    send({
      protocolVersion: 1,
      requestId: request.requestId,
      type: "error",
      error: {
        code: "leaked_environment",
        message: `Forbidden inherited key: ${process.env.KARAKEEP_API_KEY}`,
      },
    });
    continue;
  }
  send({
    protocolVersion: 1,
    requestId: request.requestId,
    type: "progress",
    command: "acquireSnapshot",
    data: { phase: "bookmarks", completed: 1, total: null },
  });

  if (request.requestId === "acquire-long") {
    await new Promise(() => {});
  }

  if (request.requestId === "acquire-compatibility") {
    await writeFile(
      path.join(process.env.FT_DATA_DIR, "bookmarks.jsonl"),
      '{"id":"partial","url":"https://x.com/example/status/partial"}\n',
    );
    process.stderr.write("auth-token-canary-acquisition-8472");
    send({
      protocolVersion: 1,
      requestId: request.requestId,
      type: "error",
      error: {
        code: "x_compatibility",
        message:
          "GraphQL operation changed: auth-token-canary-acquisition-8472",
      },
    });
    continue;
  }

  await writeFile(
    path.join(process.env.FT_DATA_DIR, "bookmarks.jsonl"),
    [
      '{"id":"one","tweetId":"1","url":"https://x.com/example/status/1","folderNames":["Research"]}',
      '{"id":"two","tweetId":"2","url":"https://x.com/example/status/2","folderNames":[]}',
      "",
    ].join("\n"),
  );
  send({
    protocolVersion: 1,
    requestId: request.requestId,
    type: "result",
    command: "acquireSnapshot",
    data: {
      total: 2,
      added: 2,
      folders: ["Research"],
      mediaDownloaded: false,
    },
  });
}
