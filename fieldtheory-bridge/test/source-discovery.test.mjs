import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";

import {
  discoverSources,
  resolveFirefoxProfileDirectory,
  selectSource,
} from "../src/source-discovery.mjs";

async function chromiumProfile(root, directory, displayName) {
  const profile = path.join(root, directory);
  await mkdir(profile, { recursive: true });
  await writeFile(
    path.join(profile, "Preferences"),
    JSON.stringify({ profile: { name: displayName } }),
  );
}

test("discovers the supported browser and profile matrix in stable UI order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "karakeep-x-sources-"));
  const chrome = path.join(root, "Chrome");
  const edge = path.join(root, "Edge");
  const brave = path.join(root, "Brave");
  const chromium = path.join(root, "Chromium");
  const safari = path.join(root, "Safari");
  const firefox = path.join(root, "Firefox");

  await chromiumProfile(chrome, "Default", "Personal");
  await chromiumProfile(chrome, "Profile 2", "Research");
  await chromiumProfile(edge, "Default", "Work");
  await chromiumProfile(edge, "Profile 3", "Edge research");
  await chromiumProfile(brave, "Default", "Personal");
  await chromiumProfile(brave, "Profile 1", "Reading");
  await chromiumProfile(chromium, "Default", "Default");
  await chromiumProfile(chromium, "Profile 10", "Archive");
  await chromiumProfile(safari, "Default", "Unsupported");
  await mkdir(path.join(firefox, "Profiles", "abc.default-release"), {
    recursive: true,
  });
  await mkdir(path.join(firefox, "Profiles", "research"), {
    recursive: true,
  });
  await writeFile(
    path.join(firefox, "profiles.ini"),
    [
      "[Profile0]",
      "Name=default-release",
      "IsRelative=1",
      "Path=Profiles/abc.default-release",
      "",
      "[Profile1]",
      "Name=Research",
      "IsRelative=1",
      "Path=Profiles/research",
      "",
    ].join("\n"),
  );

  const result = await discoverSources({
    userDataDirForBrowser: (browserId) =>
      ({
        chrome,
        edge,
        brave,
        chromium,
        firefox,
        safari,
      })[browserId],
  });

  assert.deepEqual(result, {
    browsers: [
      {
        id: "chrome",
        name: "Google Chrome",
        profiles: [
          { id: "Default", name: "Personal" },
          { id: "Profile 2", name: "Research" },
        ],
      },
      {
        id: "edge",
        name: "Microsoft Edge",
        profiles: [
          { id: "Default", name: "Work" },
          { id: "Profile 3", name: "Edge research" },
        ],
      },
      {
        id: "brave",
        name: "Brave",
        profiles: [
          { id: "Default", name: "Personal" },
          { id: "Profile 1", name: "Reading" },
        ],
      },
      {
        id: "chromium",
        name: "Chromium",
        profiles: [
          { id: "Default", name: "Default" },
          { id: "Profile 10", name: "Archive" },
        ],
      },
      {
        id: "firefox",
        name: "Firefox",
        profiles: [
          {
            id: "Profiles/abc.default-release",
            name: "default-release",
          },
          {
            id: "Profiles/research",
            name: "Research",
          },
        ],
      },
    ],
  });
});

test("resolves an absolute Firefox profile from its path-safe discovered ID", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "karakeep-x-firefox-absolute-source-"),
  );
  const firefox = path.join(fixtureRoot, "Firefox");
  const absoluteProfile = path.join(
    fixtureRoot,
    "External Profiles",
    "abc.default-release",
  );
  await mkdir(absoluteProfile, { recursive: true });
  await mkdir(firefox, { recursive: true });
  await writeFile(
    path.join(firefox, "profiles.ini"),
    [
      "[Profile0]",
      "Name=default-release",
      "IsRelative=0",
      `Path=${absoluteProfile}`,
      "",
    ].join("\n"),
  );
  const dependencies = {
    userDataDirForBrowser: (browserId) =>
      browserId === "firefox" ? firefox : undefined,
  };

  const discovered = await discoverSources(dependencies);
  const profile = discovered.browsers[0].profiles[0];

  assert.deepEqual(profile, {
    id: "absolute:Profile0",
    name: "default-release",
  });
  assert.equal(
    await resolveFirefoxProfileDirectory(
      { browserId: "firefox", profileId: profile.id },
      dependencies,
    ),
    absoluteProfile,
  );
  assert.equal(JSON.stringify(discovered).includes(fixtureRoot), false);
});

test("does not reinterpret an escaping relative Firefox profile as absolute", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "karakeep-x-firefox-relative-escape-"),
  );
  const firefox = path.join(fixtureRoot, "Firefox");
  await mkdir(path.join(fixtureRoot, "outside"), { recursive: true });
  await mkdir(firefox, { recursive: true });
  await writeFile(
    path.join(firefox, "profiles.ini"),
    [
      "[Profile0]",
      "Name=outside",
      "IsRelative=1",
      "Path=../outside",
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    await discoverSources({
      userDataDirForBrowser: (browserId) =>
        browserId === "firefox" ? firefox : undefined,
    }),
    { browsers: [] },
  );
});

test("accepts a discovered source only after explicit X-session consent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "karakeep-x-consent-"));
  const chrome = path.join(root, "Chrome");
  await chromiumProfile(chrome, "Default", "Personal");
  const dependencies = {
    userDataDirForBrowser: (browserId) =>
      browserId === "chrome" ? chrome : undefined,
  };

  await assert.rejects(
    selectSource(
      {
        consent: false,
        source: { browserId: "chrome", profileId: "Default" },
      },
      dependencies,
    ),
    /Explicit X-session consent is required/,
  );

  assert.deepEqual(
    await selectSource(
      {
        consent: true,
        source: { browserId: "chrome", profileId: "Default" },
      },
      dependencies,
    ),
    {
      browserId: "chrome",
      browserName: "Google Chrome",
      profileId: "Default",
      profileName: "Personal",
    },
  );
});

test("uses safe profile-directory names when preferences are unreadable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "karakeep-x-fallback-"));
  const brave = path.join(root, "Brave");
  const profile = path.join(brave, "Profile 7");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "Preferences"), "{");

  assert.deepEqual(
    await discoverSources({
      userDataDirForBrowser: (browserId) =>
        browserId === "brave" ? brave : undefined,
    }),
    {
      browsers: [
        {
          id: "brave",
          name: "Brave",
          profiles: [{ id: "Profile 7", name: "Profile 7" }],
        },
      ],
    },
  );
});
