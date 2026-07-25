import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  browserUserDataDir,
  getBrowser,
} from "fieldtheory/dist/browsers.js";

const SUPPORTED_BROWSERS = [
  { id: "chrome", name: "Google Chrome", backend: "chromium" },
  { id: "edge", name: "Microsoft Edge", backend: "chromium" },
  { id: "brave", name: "Brave", backend: "chromium" },
  { id: "chromium", name: "Chromium", backend: "chromium" },
  { id: "firefox", name: "Firefox", backend: "firefox" },
];

const defaultDependencies = {
  userDataDirForBrowser: (browserId) =>
    browserUserDataDir(getBrowser(browserId)),
};

async function readableJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function chromiumProfiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const directories = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (entry.name === "Default" || /^Profile \d+$/.test(entry.name)),
    )
    .sort((left, right) => {
      if (left.name === "Default") return -1;
      if (right.name === "Default") return 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true });
    });

  return Promise.all(
    directories.map(async (entry) => {
      const preferences = await readableJson(
        path.join(root, entry.name, "Preferences"),
      );
      const displayName = preferences?.profile?.name;
      return {
        id: entry.name,
        name:
          typeof displayName === "string" && displayName.trim()
            ? displayName.trim()
            : entry.name,
      };
    }),
  );
}

function parseFirefoxProfiles(ini) {
  const profiles = [];
  let current;

  for (const rawLine of ini.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^\[Profile\d+\]$/i.test(line)) {
      if (current?.path) profiles.push(current);
      current = { section: line.slice(1, -1) };
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "name") current.name = value;
    if (key === "path") current.path = value;
    if (key === "isrelative") current.isRelative = value === "1";
  }
  if (current?.path) profiles.push(current);
  return profiles;
}

async function firefoxProfiles(root) {
  let ini;
  try {
    ini = await readFile(path.join(root, "profiles.ini"), "utf8");
  } catch {
    return [];
  }

  const profiles = [];
  for (const profile of parseFirefoxProfiles(ini)) {
    const normalizedPath = profile.path.replace(/[\\/]/g, path.sep);
    const absolutePath = profile.isRelative
      ? path.resolve(root, normalizedPath)
      : path.normalize(normalizedPath);
    if (profile.isRelative) {
      const relative = path.relative(root, absolutePath);
      if (
        relative.length === 0 ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        continue;
      }
    } else if (!path.isAbsolute(absolutePath)) {
      continue;
    }
    try {
      const entries = await readdir(absolutePath);
      if (!Array.isArray(entries)) continue;
    } catch {
      continue;
    }
    profiles.push({
      id: profile.isRelative
        ? profile.path.replaceAll("\\", "/")
        : `absolute:${profile.section}`,
      name: profile.name || path.basename(profile.path),
      directory: absolutePath,
    });
  }
  return profiles;
}

export async function discoverSources(
  dependencies = defaultDependencies,
) {
  const browsers = [];

  for (const browser of SUPPORTED_BROWSERS) {
    const root = dependencies.userDataDirForBrowser(browser.id);
    if (!root) continue;
    const profiles =
      browser.backend === "firefox"
        ? await firefoxProfiles(root)
        : await chromiumProfiles(root);
    if (profiles.length === 0) continue;
    browsers.push({
      id: browser.id,
      name: browser.name,
      profiles: profiles.map(({ id, name }) => ({ id, name })),
    });
  }

  return { browsers };
}

export async function resolveFirefoxProfileDirectory(
  source,
  dependencies = defaultDependencies,
) {
  if (source?.browserId !== "firefox") return undefined;
  const root = dependencies.userDataDirForBrowser("firefox");
  if (!root) return undefined;
  const profiles = await firefoxProfiles(root);
  return profiles.find((profile) => profile.id === source.profileId)?.directory;
}

export async function selectSource(request, dependencies = defaultDependencies) {
  if (request.consent !== true) {
    throw new Error("Explicit X-session consent is required.");
  }

  const discovered = await discoverSources(dependencies);
  const browser = discovered.browsers.find(
    (candidate) => candidate.id === request.source?.browserId,
  );
  const profile = browser?.profiles.find(
    (candidate) => candidate.id === request.source?.profileId,
  );
  if (!browser || !profile) {
    throw new Error("The selected browser profile is no longer available.");
  }

  return {
    browserId: browser.id,
    browserName: browser.name,
    profileId: profile.id,
    profileName: profile.name,
  };
}
