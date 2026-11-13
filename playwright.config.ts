import { defineConfig } from "@playwright/test";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile();
} catch {
  // No .env on CI
}

// Might be set, which would make the launched Electron app run as plain Node.
delete process.env["ELECTRON_RUN_AS_NODE"];

export default defineConfig({
  reporter: process.env["CI"] ? "html" : "list",
  timeout: 240_000,
  expect: {
    timeout: 120_000,
  },
  testDir: "tests",

  // Tests have become incredibly flaky ever since I started testing first supported and latest VSCodium release. This also weird stuff going on with timeouts, where e.g. default action timeouts are reported as 30s even though they're supposed to be 10s by default: https://github.com/s-h-a-d-o-w/dev-containers-oss/actions/runs/42052410368/job/127340797172
  // Might have to migrate to a strategy where playwright is run twice and the release tested is decided by environment variable.
  // But for now, let's try retries:
  retries: 2,
});
