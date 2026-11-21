import {
  syncBookmarkFolders as acquireBookmarkFolders,
  syncBookmarksGraphQL as acquireBookmarks,
} from "fieldtheory/dist/graphql-bookmarks.js";
import {
  browserUserDataDir,
  getBrowser,
} from "fieldtheory/dist/browsers.js";
import { readFile } from "node:fs/promises";
import {
  resolveFirefoxProfileDirectory,
  selectSource,
} from "./source-discovery.mjs";

const COMPATIBILITY_MESSAGE =
  "X bookmark acquisition is temporarily incompatible. A Karakeep Transfer update may be required.";

export class AcquisitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AcquisitionError";
    this.code = code;
  }
}

const defaultDependencies = {
  selectSource,
  resolveFirefoxProfileDirectory,
  acquireBookmarks,
  acquireBookmarkFolders,
};

async function sourceOptions(source, dependencies) {
  if (source.browserId !== "firefox") {
    const root = browserUserDataDir(getBrowser(source.browserId));
    if (!root) {
      throw new AcquisitionError("source_unavailable", "Source is unavailable.");
    }
    return {
      browser: source.browserId,
      chromeUserDataDir: root,
      chromeProfileDirectory: source.profileId,
    };
  }

  const profile = await dependencies.resolveFirefoxProfileDirectory(source);
  if (!profile) {
    throw new AcquisitionError("source_unavailable", "Source is unavailable.");
  }
  return {
    browser: "firefox",
    firefoxProfileDir: profile,
  };
}

function bookmarkProgress(progress) {
  return {
    phase: "bookmarks",
    completed: Number.isSafeInteger(progress.totalFetched)
      ? progress.totalFetched
      : 0,
    total: null,
  };
}

function folderProgress(progress) {
  const total = Number.isSafeInteger(progress.totalFolders)
    ? progress.totalFolders
    : null;
  const index = Number.isSafeInteger(progress.folderIndex)
    ? progress.folderIndex
    : 0;
  return {
    phase: "folders",
    completed: progress.phase === "applying" ? index + 1 : index,
    total,
  };
}

function cancellation() {
  return new AcquisitionError("cancelled", "Acquisition was cancelled.");
}

function resumeReason(stopReason) {
  if (stopReason === "rate limited") return "rateLimited";
  if (stopReason === "max runtime reached") return "maxRuntime";
  return null;
}

async function savedResumeCursor(dataDir) {
  try {
    const state = JSON.parse(
      await readFile(`${dataDir}/bookmarks-backfill-state.json`, "utf8"),
    );
    return typeof state.lastCursor === "string" && state.lastCursor.length > 0
      ? state.lastCursor
      : undefined;
  } catch {
    return undefined;
  }
}

export async function acquireSnapshot(
  { consent, source, dataDir, signal, onProgress },
  dependencies = defaultDependencies,
) {
  const previousDataDir = process.env.FT_DATA_DIR;
  process.env.FT_DATA_DIR = dataDir;

  try {
    if (consent !== true) {
      throw new AcquisitionError(
        "consent_required",
        "Explicit X-session consent is required.",
      );
    }
    try {
      await dependencies.selectSource({ consent, source });
    } catch {
      throw new AcquisitionError(
        "source_unavailable",
        "Source is unavailable.",
      );
    }
    const options = await sourceOptions(source, dependencies);
    const resumeCursor = await savedResumeCursor(dataDir);
    const bookmarks = await dependencies.acquireBookmarks({
      ...options,
      ...(resumeCursor === undefined ? {} : { resumeCursor }),
      stopOnRateLimit: true,
      signal,
      onProgress: (progress) => onProgress(bookmarkProgress(progress)),
    });
    if (signal.aborted || bookmarks.stopReason === "interrupted") {
      throw cancellation();
    }
    const resumable = resumeReason(bookmarks.stopReason);
    if (resumable) {
      return {
        total: bookmarks.totalBookmarks,
        added: bookmarks.added,
        folders: [],
        mediaDownloaded: false,
        resumeReason: resumable,
      };
    }

    const folders = await dependencies.acquireBookmarkFolders({
      ...options,
      onProgress: (progress) => onProgress(folderProgress(progress)),
    });
    if (signal.aborted) {
      throw cancellation();
    }
    if (folders.skippedFolders.length > 0) {
      throw new AcquisitionError("x_compatibility", COMPATIBILITY_MESSAGE);
    }

    return {
      total: bookmarks.totalBookmarks,
      added: bookmarks.added,
      folders: folders.folders.map((folder) => folder.name),
      mediaDownloaded: false,
    };
  } catch (error) {
    if (error instanceof AcquisitionError) {
      throw error;
    }
    throw new AcquisitionError("x_compatibility", COMPATIBILITY_MESSAGE);
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.FT_DATA_DIR;
    } else {
      process.env.FT_DATA_DIR = previousDataDir;
    }
  }
}
