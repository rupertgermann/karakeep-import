import { mkdir, readFile, writeFile } from "node:fs/promises";
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

  if (request.consent !== true) {
    send({
      protocolVersion: 1,
      requestId: request.requestId,
      type: "error",
      error: { code: "consent_required", message: "consent is required" },
    });
    continue;
  }

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

  const snapshotPath = path.join(
    process.env.FT_DATA_DIR,
    "bookmarks.jsonl",
  );
  const seededSnapshot = await readFile(snapshotPath, "utf8").catch(() => "");

  if (request.requestId === "acquire-private-temp") {
    const privateTemp = path.join(process.env.FT_DATA_DIR, "tmp");
    if (
      process.env.TMPDIR !== privateTemp ||
      process.env.TMP !== privateTemp ||
      process.env.TEMP !== privateTemp
    ) {
      send({
        protocolVersion: 1,
        requestId: request.requestId,
        type: "error",
        error: { code: "temp_not_private", message: "temporary storage escaped" },
      });
      continue;
    }
  }

  if (request.requestId === "acquire-resumable") {
    await writeFile(
      snapshotPath,
      '{"id":"partial","tweetId":"partial","url":"https://x.com/example/status/partial","folderNames":[]}\n',
    );
    await writeFile(
      path.join(process.env.FT_DATA_DIR, "bookmarks-meta.json"),
      '{"totalBookmarks":1}\n',
    );
    await writeFile(
      path.join(process.env.FT_DATA_DIR, "bookmarks-backfill-state.json"),
      '{"lastCursor":"resume-cursor"}\n',
    );
    send({
      protocolVersion: 1,
      requestId: request.requestId,
      type: "result",
      command: "acquireSnapshot",
      data: {
        total: 1,
        added: 1,
        folders: [],
        mediaDownloaded: false,
        resumeReason: "rateLimited",
      },
    });
    continue;
  }

  if (request.requestId === "acquire-resumable-retry") {
    const [metadata, state] = await Promise.all([
      readFile(path.join(process.env.FT_DATA_DIR, "bookmarks-meta.json"), "utf8").catch(() => ""),
      readFile(path.join(process.env.FT_DATA_DIR, "bookmarks-backfill-state.json"), "utf8").catch(() => ""),
    ]);
    if (
      metadata !== '{"totalBookmarks":1}\n' ||
      state !== '{"lastCursor":"resume-cursor"}\n'
    ) {
      send({
        protocolVersion: 1,
        requestId: request.requestId,
        type: "error",
        error: { code: "resume_state_missing", message: "resume state was not seeded" },
      });
      continue;
    }
  }

  if (request.requestId === "acquire-cross-source-failure") {
    send({
      protocolVersion: 1,
      requestId: request.requestId,
      type: "error",
      error: {
        code: seededSnapshot ? "wrong_source_seeded" : "source_unavailable",
        message: "Profile B is unavailable.",
      },
    });
    continue;
  }

  if (request.requestId === "acquire-same-source-failure") {
    send({
      protocolVersion: 1,
      requestId: request.requestId,
      type: "error",
      error: {
        code: seededSnapshot ? "x_compatibility" : "expected_snapshot_missing",
        message: "X acquisition is unavailable.",
      },
    });
    continue;
  }

  if (request.source.profileId === "Profile A") {
    await writeFile(
      snapshotPath,
      '{"id":"profile-a","tweetId":"profile-a","url":"https://x.com/example/status/profile-a","folderNames":[]}\n',
    );
  } else if (request.source.profileId === "Profile B") {
    await writeFile(
      snapshotPath,
      `${seededSnapshot}{"id":"profile-b","tweetId":"profile-b","url":"https://x.com/example/status/profile-b","folderNames":[]}\n`,
    );
  } else {
    await writeFile(
      snapshotPath,
      [
        '{"id":"one","tweetId":"1","url":"https://x.com/example/status/1","folderNames":["Research"]}',
        '{"id":"two","tweetId":"2","url":"https://x.com/example/status/2","folderNames":[]}',
        "",
      ].join("\n"),
    );
  }
  await writeFile(
    path.join(process.env.FT_DATA_DIR, "bookmarks-meta.json"),
    '{"totalBookmarks":2}\n',
  );
  await writeFile(
    path.join(process.env.FT_DATA_DIR, "bookmarks-backfill-state.json"),
    '{"lastCursor":"next-cursor"}\n',
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
