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
  await workbox
    .locator("a")
    .filter({ hasText: ".devcontainer" })
    .click({ timeout: 240_000 }); // macOS is slow here
  await workbox.locator("a").filter({ hasText: "devcontainer.json" }).click();
  const editor = workbox.locator(".monaco-editor");
  await editor.click();
  await workbox.keyboard.type("// dummy");
  await editor.press("ControlOrMeta+s");
  await workbox.getByRole("button", { name: "Rebuild" }).click();
  await expect(workbox).not.toHaveTitle(/Dev Container/u);
  await expect(workbox).toHaveTitle(/Dev Container/u);

  // REOPEN LOCALLY (via remote menu)
  await workbox
    .getByRole("button", { name: /remote.*/u })
    .click({ timeout: 240_000 });
  await workbox.getByRole("option", { name: "Reopen Folder Locally" }).click();
  await expect(workbox).not.toHaveTitle(/Dev Container/u);

  // SHOW CONTAINER CONFIG
  await workbox.getByRole("main").press("ControlOrMeta+Shift+p");
  await workbox
    .getByRole("textbox", { name: "Type the name of a command to run." })
    .fill(">Open Container Configuration File");
  await workbox
    .getByRole("option", { name: "Container Configuration File" })
    .click();
  await expect(workbox).toHaveTitle(/devcontainer.json/u);
  // await workbox.pause();
});
