import {
  syncBookmarkFolders,
  syncBookmarksGraphQL,
} from "fieldtheory/dist/graphql-bookmarks.js";
import {
  browserUserDataDir,
  getBrowser,
} from "fieldtheory/dist/browsers.js";
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
  syncBookmarksGraphQL,
  syncBookmarkFolders,
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

export async function acquireSnapshot(
  { source, dataDir, signal, onProgress },
  dependencies = defaultDependencies,
) {
  const previousDataDir = process.env.FT_DATA_DIR;
  process.env.FT_DATA_DIR = dataDir;

  try {
    try {
      await dependencies.selectSource({ consent: true, source });
    } catch {
      throw new AcquisitionError(
        "source_unavailable",
        "Source is unavailable.",
      );
    }
    const options = await sourceOptions(source, dependencies);
    const bookmarks = await dependencies.syncBookmarksGraphQL({
      ...options,
      signal,
      onProgress: (progress) => onProgress(bookmarkProgress(progress)),
    });
    if (signal.aborted || bookmarks.stopReason === "interrupted") {
      throw cancellation();
    }

    const folders = await dependencies.syncBookmarkFolders({
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
