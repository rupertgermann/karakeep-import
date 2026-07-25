import { createInterface } from "node:readline";

const reader = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of reader) {
  const request = JSON.parse(line);
  if (request.requestId === "secret-error-1") {
    process.stderr.write("auth-token-canary-8472");
    process.exitCode = 1;
    continue;
  }

  process.stdout.write(
    `${JSON.stringify({
      protocolVersion: 1,
      requestId: request.requestId,
      type: "result",
      command: request.command,
      data: {
        browsers: [
          {
            id: "chrome",
            name: "Google Chrome",
            profiles: [{ id: "Default", name: "Personal" }],
          },
        ],
      },
    })}\n`,
  );
}
