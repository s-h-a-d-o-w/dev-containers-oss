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
import { downloadAndUnzipCodium } from "./downloadAndUnzipCodium.ts";
import { startScreenRecording } from "./screenRecorder.ts";
import {
  captureTerminals,
  terminalCaptureKeybindings,
} from "./terminalCapture.ts";

export { expect } from "@playwright/test";

type TestFixtures = {
  createTempDir: () => Promise<string>;
  workbox: Page;
};

type TestOptions = {
  userSettings: Record<string, unknown>;
};

const isWindows = process.platform === "win32";

export const test = base.extend<TestFixtures & TestOptions>({
  userSettings: [{}, { option: true }],
  workbox: async ({ createTempDir, userSettings }, use) => {
    const defaultCachePath = await createTempDir();
    const codiumPath = await downloadAndUnzipCodium();
    console.log(`Using VSCodium from ${codiumPath}`);

    const userDataDir = path.join(defaultCachePath, "user-data");
    await fs.promises.mkdir(path.join(userDataDir, "User"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(userDataDir, "User", "settings.json"),
      JSON.stringify({
        // So that failures can be diagnosed based on the full build log.
        "terminal.integrated.scrollback": 100_000,
        ...userSettings,
      }),
    );
    await fs.promises.writeFile(
      path.join(userDataDir, "User", "keybindings.json"),
      JSON.stringify(terminalCaptureKeybindings),
    );

    const videoPath = test.info().outputPath("video.mp4");
    const stopScreenRecording = startScreenRecording(videoPath);

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
        `--user-data-dir=${userDataDir}`,
        isWindows
          ? process.env["WSL_FIXTURE_PATH"]!
          : path.join(__dirname, "fixture"),
      ],
    });

    const workbox = await electronApp.firstWindow();
    await workbox.context().tracing.start({
      screenshots: true,
      snapshots: true,
      title: test.info().title,
    });

    await use(workbox);

    const { expectedStatus, status } = test.info();
    if (status !== expectedStatus) {
      const content = await captureTerminals(workbox, electronApp);
      await test.info().attach(`terminal`, {
        body: content,
        contentType: "text/plain",
      });
    }

    const tracePath = test.info().outputPath("trace.zip");
    await workbox.context().tracing.stop({ path: tracePath });
    test.info().attachments.push({
      name: "trace",
      path: tracePath,
      contentType: "application/zip",
    });
    await electronApp.close();

    if (await stopScreenRecording?.()) {
      test.info().attachments.push({
        name: "video",
        path: videoPath,
        contentType: "video/mp4",
      });
    }

    if (fs.existsSync(userDataDir)) {
      const logOutputPath = test.info().outputPath("vscode-logs");
      await fs.promises.cp(userDataDir, logOutputPath, { recursive: true });
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
