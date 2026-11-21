import path from "node:path";

export function npmInvocation(args) {
  // Windows needs Node to run the npm CLI without its command shim.
  const cli = process.env.npm_execpath || (
    process.platform === "win32"
      ? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
      : null
  );
  return cli ? [process.execPath, [cli, ...args]] : ["npm", args];
}
