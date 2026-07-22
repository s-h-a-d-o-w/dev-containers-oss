import { test, expect } from "./baseTest";

test("basics", async ({ workbox }) => {
  // REOPEN IN CONTAINER
  await expect(workbox).toHaveTitle(
    "[Extension Development Host] fixture - VSCodium",
  );
  await workbox.getByRole("button", { name: "Reopen in Container" }).click();
  await expect(workbox).toHaveTitle(
    "[Extension Development Host] fixture [Dev Container] - VSCodium",
  );

  // REBUILD
  await workbox.locator("a").filter({ hasText: ".devcontainer" }).click();
  await workbox.locator("a").filter({ hasText: "devcontainer.json" }).click();
  const editor = workbox.locator(".monaco-editor");
  await editor.click();
  await workbox.keyboard.type("// dummy");
  await editor.press("ControlOrMeta+s");
  await workbox.getByRole("button", { name: "Rebuild" }).click();
  await expect(workbox).toHaveTitle(
    "[Extension Development Host] fixture - VSCodium",
  );
  await expect(workbox).toHaveTitle(
    "[Extension Development Host] devcontainer.json - fixture [Dev Container] - VSCodium",
  );

  // REOPEN LOCALLY
  await workbox.getByRole("button", { name: /remote.*/u }).click();
  await workbox.getByRole("option", { name: "Reopen Folder Locally" }).click();
  await expect(workbox).toHaveTitle(
    "[Extension Development Host] fixture - VSCodium",
  );
});
