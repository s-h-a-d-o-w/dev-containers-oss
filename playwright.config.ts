import { defineConfig } from "@playwright/test";

export default defineConfig({
  reporter: process.env["CI"] ? "html" : "list",
  timeout: 240_000,
  expect: {
    timeout: 120_000,
  },
  workers: 1,
  testDir: "tests",
});
