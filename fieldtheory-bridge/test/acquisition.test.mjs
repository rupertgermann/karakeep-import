import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { syncBookmarksGraphQL } from "fieldtheory/dist/graphql-bookmarks.js";

import { acquireSnapshot } from "../src/acquisition.mjs";
import {
  discoverSources,
  resolveFirefoxProfileDirectory,
  selectSource,
} from "../src/source-discovery.mjs";

const source = {
  browserId: "chrome",
  profileId: "Profile 2",
};

test("acquires a discovered absolute Firefox profile without exposing its path", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "karakeep-x-absolute-firefox-"),
  );
  const firefoxRoot = path.join(fixtureRoot, "Firefox");
  const externalProfile = path.join(
    fixtureRoot,
    "External Profiles",
    "default-release",
  );
  await mkdir(externalProfile, { recursive: true });
  await mkdir(firefoxRoot, { recursive: true });
  await writeFile(
    path.join(firefoxRoot, "profiles.ini"),
    [
      "[Profile0]",
      "Name=default-release",
      "IsRelative=0",
      `Path=${externalProfile}`,
      "",
    ].join("\n"),
  );
  const discoveryDependencies = {
    userDataDirForBrowser: (browserId) =>
      browserId === "firefox" ? firefoxRoot : undefined,
  };
  const discovered = await discoverSources(discoveryDependencies);
  const discoveredSource = {
    browserId: "firefox",
    profileId: discovered.browsers[0].profiles[0].id,
  };
  const profileDirectories = [];

  await acquireSnapshot(
    {
      consent: true,
      source: discoveredSource,
      dataDir: path.join(fixtureRoot, "staging"),
      signal: new AbortController().signal,
      onProgress: () => {},
    },
    {
      selectSource: (request) => selectSource(request, discoveryDependencies),
      resolveFirefoxProfileDirectory: (selectedSource) =>
        resolveFirefoxProfileDirectory(
          selectedSource,
          discoveryDependencies,
        ),
      acquireBookmarks: async (options) => {
        profileDirectories.push(options.firefoxProfileDir);
        return { added: 1, totalBookmarks: 1 };
      },
      acquireBookmarkFolders: async (options) => {
        profileDirectories.push(options.firefoxProfileDir);
        return { folders: [], skippedFolders: [] };
      },
    },
  );

  assert.deepEqual(profileDirectories, [externalProfile, externalProfile]);
  assert.equal(JSON.stringify(discovered).includes(fixtureRoot), false);
});

test("returns a resumable result before acquiring folders when X throttles bookmark backfill", async () => {
  let folderCalls = 0;

  const result = await acquireSnapshot(
    {
      consent: true,
      source,
      dataDir: "/private/app-data/fieldtheory/staging",
      signal: new AbortController().signal,
      onProgress: () => {},
    },
    {
      selectSource: async () => source,
      acquireBookmarks: async () => ({
        added: 3,
        totalBookmarks: 42,
        stopReason: "rate limited",
      }),
      acquireBookmarkFolders: async () => {
        folderCalls += 1;
        return { folders: [], skippedFolders: [] };
      },
    },
  );

  assert.deepEqual(result, {
    total: 42,
    added: 3,
    folders: [],
    mediaDownloaded: false,
    resumeReason: "rateLimited",
  });
  assert.equal(folderCalls, 0);
});

test("checkpoints a fetched page and pauses on a long Retry-After without waiting", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "karakeep-x-throttle-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const entries = [
    {
      entryId: "tweet-123",
      content: {
        itemContent: { tweet_results: { result: { legacy: { id_str: "123" } } } },
      },
    },
    { entryId: "cursor-bottom-next", content: { value: "next-page" } },
  ];
  const firstPage = {
    data: {
      bookmark_timeline_v2: {
        timeline: { instructions: [{ type: "TimelineAddEntries", entries }] },
      },
    },
  };
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return requests === 1
      ? Response.json(firstPage)
      : new Response(null, { status: 429, headers: { "Retry-After": "3600" } });
  });
  const waits = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    waits.push(delay);
    callback();
  });

  const result = await acquireSnapshot(
    {
      consent: true,
      source,
      dataDir,
      signal: new AbortController().signal,
      onProgress() {},
    },
    {
      selectSource: async () => source,
      acquireBookmarks: (options) =>
        syncBookmarksGraphQL({ ...options, csrfToken: "fixture-only", delayMs: 0 }),
      acquireBookmarkFolders: () =>
        assert.fail("paused acquisition must skip folders"),
    },
  );

  assert.equal(result.resumeReason, "rateLimited");
  assert.equal(result.total, 1);
  assert.deepEqual(waits, [0]);
  assert.equal(requests, 2);
  const saved = JSON.parse(
    await readFile(path.join(dataDir, "bookmarks-backfill-state.json"), "utf8"),
  );
  const bookmark = JSON.parse(
    await readFile(path.join(dataDir, "bookmarks.jsonl"), "utf8"),
  );
  assert.equal(saved.lastCursor, "next-page");
  assert.equal(bookmark.id, "123");
});

test("passes the saved cursor into a same-source bookmark backfill", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "karakeep-x-resume-"));
  await writeFile(
    path.join(dataDir, "bookmarks-backfill-state.json"),
    '{"lastCursor":"resume-cursor"}',
  );
  let receivedCursor;

  await acquireSnapshot(
    {
      consent: true,
      source,
      dataDir,
      signal: new AbortController().signal,
      onProgress: () => {},
    },
    {
      selectSource: async () => source,
      acquireBookmarks: async (options) => {
        receivedCursor = options.resumeCursor;
        return { added: 1, totalBookmarks: 1 };
      },
      acquireBookmarkFolders: async () => ({ folders: [], skippedFolders: [] }),
    },
  );

  assert.equal(receivedCursor, "resume-cursor");
});

test("acquires bookmarks and folders through the pinned Field Theory modules", async () => {
  const calls = [];

  const result = await acquireSnapshot(
    {
      consent: true,
      source,
      dataDir: "/private/app-data/fieldtheory/staging",
      signal: new AbortController().signal,
      onProgress: () => {},
    },
    {
      selectSource: async () => ({
        browserId: "chrome",
        browserName: "Google Chrome",
        profileId: "Profile 2",
        profileName: "Research",
      }),
      acquireBookmarks: async (options) => {
        calls.push({
          operation: "bookmarks",
          browser: options.browser,
          profile: options.chromeProfileDirectory,
          dataDir: process.env.FT_DATA_DIR,
        });
        return { added: 3, totalBookmarks: 42 };
      },
      acquireBookmarkFolders: async (options) => {
        calls.push({
          operation: "folders",
          browser: options.browser,
          profile: options.chromeProfileDirectory,
          dataDir: process.env.FT_DATA_DIR,
        });
        return {
          folders: [{ id: "folder-1", name: "Research" }],
          skippedFolders: [],
        };
      },
    },
  );

  assert.deepEqual(
    { calls, result },
    {
      calls: [
        {
          operation: "bookmarks",
          browser: "chrome",
          profile: "Profile 2",
          dataDir: "/private/app-data/fieldtheory/staging",
        },
        {
          operation: "folders",
          browser: "chrome",
          profile: "Profile 2",
          dataDir: "/private/app-data/fieldtheory/staging",
        },
      ],
      result: {
        total: 42,
        added: 3,
        folders: ["Research"],
        mediaDownloaded: false,
      },
    },
  );
});

test("emits structured bookmark and folder progress without session material", async () => {
  const events = [];

  await acquireSnapshot(
    {
      consent: true,
      source,
      dataDir: "/private/app-data/fieldtheory/staging",
      signal: new AbortController().signal,
      onProgress: (event) => events.push(event),
    },
    {
      selectSource: async () => ({
        browserId: "chrome",
        browserName: "Google Chrome",
        profileId: "Profile 2",
        profileName: "Research",
      }),
      acquireBookmarks: async (options) => {
        options.onProgress({
          page: 2,
          totalFetched: 40,
          newAdded: 3,
          done: false,
        });
        return { added: 3, totalBookmarks: 42 };
      },
      acquireBookmarkFolders: async (options) => {
        options.onProgress({
          phase: "walking",
          folder: { id: "folder-1", name: "Research" },
          folderIndex: 0,
          totalFolders: 1,
        });
        return {
          folders: [{ id: "folder-1", name: "Research" }],
          skippedFolders: [],
        };
      },
    },
  );

  assert.deepEqual(events, [
    {
      phase: "bookmarks",
      completed: 40,
      total: null,
    },
    {
      phase: "folders",
      completed: 0,
      total: 1,
    },
  ]);
});

test("classifies upstream acquisition failures without exposing password-equivalent values", async () => {
  const secret = "auth-token-canary-acquisition-8472";

  await assert.rejects(
    acquireSnapshot(
      {
        consent: true,
        source,
        dataDir: "/private/app-data/fieldtheory/staging",
        signal: new AbortController().signal,
        onProgress: () => {},
      },
      {
        selectSource: async () => ({
          browserId: "chrome",
          browserName: "Google Chrome",
          profileId: "Profile 2",
          profileName: "Research",
        }),
        acquireBookmarks: async () => {
          throw new Error(`GraphQL operation changed: ${secret}`);
        },
        acquireBookmarkFolders: async () => {
          throw new Error("must not run");
        },
      },
    ),
    (error) =>
      error.code === "x_compatibility" &&
      error.message ===
        "X bookmark acquisition is temporarily incompatible. A Karakeep Transfer update may be required." &&
      !JSON.stringify(error).includes(secret),
  );
});

test("reports cancellation before folder acquisition begins", async () => {
  const controller = new AbortController();
  let folderCalls = 0;

  await assert.rejects(
    acquireSnapshot(
      {
        consent: true,
        source,
        dataDir: "/private/app-data/fieldtheory/staging",
        signal: controller.signal,
        onProgress: () => {},
      },
      {
        selectSource: async () => ({
          browserId: "chrome",
          browserName: "Google Chrome",
          profileId: "Profile 2",
          profileName: "Research",
        }),
        acquireBookmarks: async () => {
          controller.abort();
          return {
            added: 0,
            totalBookmarks: 12,
            stopReason: "interrupted",
          };
        },
        acquireBookmarkFolders: async () => {
          folderCalls += 1;
          return { folders: [], skippedFolders: [] };
        },
      },
    ),
    (error) => error.code === "cancelled" && folderCalls === 0,
  );
});

test("rejects a moved browser profile before reading any X session", async () => {
  let acquisitionCalls = 0;

  await assert.rejects(
    acquireSnapshot(
      {
        consent: true,
        source,
        dataDir: "/private/app-data/fieldtheory/staging",
        signal: new AbortController().signal,
        onProgress: () => {},
      },
      {
        selectSource: async () => {
          throw new Error("profile moved");
        },
        acquireBookmarks: async () => {
          acquisitionCalls += 1;
        },
        acquireBookmarkFolders: async () => {
          acquisitionCalls += 1;
        },
      },
    ),
    (error) =>
      error.code === "source_unavailable" && acquisitionCalls === 0,
  );
});
