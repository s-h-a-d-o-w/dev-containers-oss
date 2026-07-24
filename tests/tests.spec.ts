import { test, expect } from "./baseTest";

const isWindows = process.platform === "win32";

test("basics", async ({ workbox }) => {
  // Get rid of git popup
  if (!isWindows) {
    await workbox.getByRole("button", { name: "Never" }).click();
  }

  // REOPEN IN CONTAINER
  await workbox.getByRole("button", { name: "Reopen in Container" }).click();
  await expect(workbox).toHaveTitle(/Dev Container/u);

  // REBUILD
  await workbox.locator("a").filter({ hasText: ".devcontainer" }).click({
    timeout: 120_000, // Windows needs some time
  });
  await workbox.locator("a").filter({ hasText: "devcontainer.json" }).click();
  const editor = workbox.locator(".monaco-editor");
  await editor.click();
  await workbox.keyboard.type("// dummy");
  await editor.press("ControlOrMeta+s");
  await workbox.getByRole("button", { name: "Rebuild" }).click();
  await expect(workbox).not.toHaveTitle(/Dev Container/u);
  await expect(workbox).toHaveTitle(/Dev Container/u);

  // REOPEN LOCALLY (via remote menu)
  await workbox.getByRole("button", { name: /remote.*/u }).click({
    timeout: 120_000,
  });
  await workbox.getByRole("option", { name: "Reopen Folder Locally" }).click();
  await expect(workbox).not.toHaveTitle(/Dev Container/u);

  // SHOW CONTAINER CONFIG
  // `hasConfig` takes a while to set
  await expect(async () => {
    await workbox.getByRole("main").press("ControlOrMeta+Shift+p");
    await workbox
      .getByRole("textbox", { name: "Type the name of a command to run." })
      .fill(">Open Container Configuration File");
    try {
      await workbox
        .getByRole("option", { name: "Container Configuration File" })
        .click({ timeout: 1000 });
      await expect(workbox).toHaveTitle(/devcontainer.json/u);
    } catch (error) {
      // Close the command palette before the next attempt
      await workbox.keyboard.press("Escape");
      throw error;
    }
  }).toPass({ timeout: 30_000 });
  // await workbox.pause();
});
