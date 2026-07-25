import assert from "node:assert/strict";
import test from "node:test";

import { acquireSnapshot } from "../src/acquisition.mjs";

const source = {
  browserId: "chrome",
  profileId: "Profile 2",
};

test("acquires bookmarks and folders through the pinned Field Theory modules", async () => {
  const calls = [];

  const result = await acquireSnapshot(
    {
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
      syncBookmarksGraphQL: async (options) => {
        calls.push({
          operation: "bookmarks",
          browser: options.browser,
          profile: options.chromeProfileDirectory,
          dataDir: process.env.FT_DATA_DIR,
        });
        return { added: 3, totalBookmarks: 42 };
      },
      syncBookmarkFolders: async (options) => {
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
      syncBookmarksGraphQL: async (options) => {
        options.onProgress({
          page: 2,
          totalFetched: 40,
          newAdded: 3,
          done: false,
        });
        return { added: 3, totalBookmarks: 42 };
      },
      syncBookmarkFolders: async (options) => {
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
        syncBookmarksGraphQL: async () => {
          throw new Error(`GraphQL operation changed: ${secret}`);
        },
        syncBookmarkFolders: async () => {
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
        syncBookmarksGraphQL: async () => {
          controller.abort();
          return {
            added: 0,
            totalBookmarks: 12,
            stopReason: "interrupted",
          };
        },
        syncBookmarkFolders: async () => {
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
        source,
        dataDir: "/private/app-data/fieldtheory/staging",
        signal: new AbortController().signal,
        onProgress: () => {},
      },
      {
        selectSource: async () => {
          throw new Error("profile moved");
        },
        syncBookmarksGraphQL: async () => {
          acquisitionCalls += 1;
        },
        syncBookmarkFolders: async () => {
          acquisitionCalls += 1;
        },
      },
    ),
    (error) =>
      error.code === "source_unavailable" && acquisitionCalls === 0,
  );
});
