const { spawnSync } = require("node:child_process");

const result = spawnSync(
  "claude",
  [
    "--setting-sources", "",
    "--settings", '{"forceLoginMethod":"claudeai"}',
    "auth", "status", "--json",
  ],
  { encoding: "utf8", timeout: 30000 },
);

let status;
try {
  status = JSON.parse(result.stdout);
} catch {
  console.error("Claude subscription status unavailable; no inference started.");
  process.exit(1);
}
if (
  result.status !== 0 ||
  status?.loggedIn !== true ||
  status.authMethod !== "claude.ai" ||
  status.apiProvider !== "firstParty"
) {
  console.error("Expected official Claude subscription login; no inference started.");
  process.exit(1);
}
console.log(JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: ["pro", "max", "team", "enterprise"].includes(status.subscriptionType)
    ? status.subscriptionType : null,
}));
