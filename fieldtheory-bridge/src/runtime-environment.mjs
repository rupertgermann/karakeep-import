import path from "node:path";
import { fileURLToPath } from "node:url";

export function runtimeEnvironment(
  environment = process.env,
  {
    platform = process.platform,
    modulePath = fileURLToPath(import.meta.url),
  } = {},
) {
  const configured = { ...environment };
  if (platform !== "win32") {
    return configured;
  }

  const resourceDirectory = path.win32.dirname(
    path.win32.dirname(
      path.win32.dirname(path.win32.dirname(modulePath)),
    ),
  );
  const sqliteDirectory = path.win32.join(
    resourceDirectory,
    "sqlite",
    "win-x64",
  );
  const pathKey =
    Object.keys(configured).find((key) => key.toUpperCase() === "PATH") ??
    "PATH";
  const inheritedPath = configured[pathKey];
  configured[pathKey] = inheritedPath
    ? `${sqliteDirectory}${path.win32.delimiter}${inheritedPath}`
    : sqliteDirectory;
  return configured;
}
