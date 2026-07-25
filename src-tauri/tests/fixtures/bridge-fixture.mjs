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
  const checksEnvironment = request.requestId === "environment-boundary-1";
  const environmentIsClean =
    !process.env.KARAKEEP_API_KEY &&
    !process.env.FIELD_THEORY_UNRELATED_CANARY;
  const requiredEnvironmentIsPresent =
    process.env.XDG_CONFIG_HOME === "required-environment-canary";

  process.stdout.write(
    `${JSON.stringify({
      protocolVersion: 1,
      requestId: request.requestId,
      type: "result",
      command: request.command,
      data: {
        browsers: [
          {
            id: checksEnvironment
              ? environmentIsClean
                ? "environment-clean"
                : "environment-leaked"
              : "chrome",
            name: checksEnvironment
              ? requiredEnvironmentIsPresent
                ? "required-environment-present"
                : "required-environment-missing"
              : "Google Chrome",
            profiles: [{ id: "Default", name: "Personal" }],
          },
        ],
      },
    })}\n`,
  );
}
