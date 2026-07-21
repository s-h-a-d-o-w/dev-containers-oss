import { test, expect } from "./baseTest";

test("should be able to execute the first test of the example project", async ({
  workbox,
}) => {
  await expect(workbox).toHaveTitle(
    "[Extension Development Host] fixture - VSCodium",
  );
  await workbox.getByRole("button", { name: "Reopen in Container" }).click();

  await expect(workbox).toHaveTitle(
    "[Extension Development Host] fixture [Dev Container] - VSCodium",
    { timeout: 120_000 },
  );
  await workbox.getByRole("button", { name: "remote  Dev Container" }).click();
  await workbox
    .getByRole("option", { name: "Close Remote Connection" })
    .click();
});
