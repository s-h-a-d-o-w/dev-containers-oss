import { expect, type ElectronApplication, type Page } from "@playwright/test";

// `electron` isn't a dependency here, so Playwright's inferred module type is unusable.
type ElectronModule = {
  clipboard: { readText: () => string; writeText: (text: string) => void };
};

// xterm.js only renders the visible viewport, so the DOM can't be scraped. Instead we let
// VS Code itself serialize the full scrollback via select-all + copy and read the result
// from Electron's clipboard. Dedicated keybindings are used because the command palette
// steals terminal focus (which those commands require via `terminalFocus`).
export const terminalCaptureKeybindings = [
  { key: "f8", command: "workbench.action.terminal.focus" },
  {
    key: "f9",
    command: "workbench.action.terminal.selectAll",
    when: "terminalFocus",
  },
  {
    key: "f10",
    command: "workbench.action.terminal.copySelection",
    when: "terminalFocus",
  },
];

async function copyFocusedTerminal(
  workbox: Page,
  electronApp: ElectronApplication,
) {
  const readClipboard = () =>
    electronApp.evaluate((electron) =>
      (electron as ElectronModule).clipboard.readText(),
    );

  await electronApp.evaluate((electron) => {
    (electron as ElectronModule).clipboard.writeText("");
  });

  await workbox.keyboard.press("F9");
  await workbox.keyboard.press("F10");

  // Copying isn't synchronous with the keypress.
  await expect.poll(readClipboard, { timeout: 5000 }).not.toBe("");

  return readClipboard();
}

export async function captureTerminals(
  workbox: Page,
  electronApp: ElectronApplication,
) {
  try {
    // Opens the panel if it's closed - otherwise there would be nothing to select.
    await workbox.keyboard.press("F8");

    return await copyFocusedTerminal(workbox, electronApp);
  } catch (error) {
    console.warn(`Could not capture terminal content: ${String(error)}`);
  }
}
