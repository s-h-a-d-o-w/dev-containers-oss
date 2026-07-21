/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { test as base, type Page, _electron } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { downloadAndUnzipCodium } from "./download.ts";

export { expect } from "@playwright/test";

type TestFixtures = {
  workbox: Page;
  createTempDir: () => Promise<string>;
};

export const test = base.extend<TestFixtures>({
  workbox: async ({ createTempDir }, use) => {
    const defaultCachePath = await createTempDir();
    const codiumPath = await downloadAndUnzipCodium();
    console.log(`Using VSCodium from ${codiumPath}`);

    const electronApp = await _electron.launch({
      executablePath: codiumPath,
      args: [
        // Stolen from https://github.com/microsoft/vscode-test/blob/0ec222ef170e102244569064a12898fb203e5bb7/lib/runTest.ts#L126-L160
        // https://github.com/microsoft/vscode/issues/84238
        "--no-sandbox",
        // https://github.com/microsoft/vscode-test/issues/221
        "--disable-gpu-sandbox",
        // https://github.com/microsoft/vscode-test/issues/120
        "--disable-updates",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-workspace-trust",
        `--extensionDevelopmentPath=${path.join(__dirname, "..")}`,
        `--extensions-dir=${path.join(defaultCachePath, "extensions")}`,
        `--user-data-dir=${path.join(defaultCachePath, "user-data")}`,
        path.join(__dirname, "fixture"),
      ],
    });

    const workbox = await electronApp.firstWindow();
    await workbox.context().tracing.start({
      screenshots: true,
      snapshots: true,
      title: test.info().title,
    });

    await use(workbox);

    const tracePath = test.info().outputPath("trace.zip");
    await workbox.context().tracing.stop({ path: tracePath });
    test.info().attachments.push({
      name: "trace",
      path: tracePath,
      contentType: "application/zip",
    });
    // With an active dev-container connection, a graceful shutdown waits on the
    // remote to disconnect and can hang well past the test timeout. Fixture
    // teardown shares the test timeout budget, so bound the close and fall back
    // to killing the underlying process if it does not exit in time.
    try {
      await Promise.race([
        electronApp.close(),
        // oxlint-disable-next-line promise/param-names
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("electronApp.close() timed out")),
            15_000,
          ),
        ),
      ]);
    } catch {
      electronApp.process().kill("SIGKILL");
    }
    const logPath = path.join(defaultCachePath, "user-data");
    if (fs.existsSync(logPath)) {
      const logOutputPath = test.info().outputPath("vscode-logs");
      await fs.promises.cp(logPath, logOutputPath, { recursive: true });
    }
  },
  // oxlint-disable-next-line no-empty-pattern
  createTempDir: async ({}, use) => {
    const tempDirs: string[] = [];

    await use(async () => {
      const tempDir = await fs.promises.realpath(
        await fs.promises.mkdtemp(path.join(os.tmpdir(), "pwtest-")),
      );
      tempDirs.push(tempDir);
      return tempDir;
    });

    for (const tempDir of tempDirs) {
      await fs.promises.rm(tempDir, { recursive: true });
    }
  },
});
