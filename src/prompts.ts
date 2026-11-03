import { type ExtensionContext, commands, env, window } from "vscode";
import { EXTENSION_ID } from "./constants.ts";
import { getWorkspaceFolder, hasDevcontainerConfig } from "./utilities.ts";

export const DONT_PROMPT_REOPEN_KEY = `${EXTENSION_ID}.dontPromptReopen`;
const DONT_PROMPT_SSH_FALLBACK_INSTRUCTIONS = `${EXTENSION_ID}.dontPromptSshFallbackInstructions`;

export async function promptReopenInContainerIfConfigured(
  context: ExtensionContext,
  isReopening: boolean,
) {
  if (
    (env.remoteName && env.remoteName !== "wsl") ||
    isReopening ||
    context.workspaceState.get<boolean>(DONT_PROMPT_REOPEN_KEY) ||
    !(await hasDevcontainerConfig(getWorkspaceFolder()))
  ) {
    return;
  }

  const reopen = "Reopen in Container";
  const dontShowAgain = "Don't Show Again";
  const choice = await window.showInformationMessage(
    "This workspace contains a devcontainer.json file. Would you like to reopen it inside a container?",
    reopen,
    dontShowAgain,
  );
  if (choice === reopen) {
    await commands.executeCommand(`${EXTENSION_ID}.openFolderInDevcontainer`);
  } else if (choice === dontShowAgain) {
    await context.workspaceState.update(DONT_PROMPT_REOPEN_KEY, true);
  }
}

export async function promptSshFallbackInstructions(context: ExtensionContext) {
  if (context.globalState.get<boolean>(DONT_PROMPT_SSH_FALLBACK_INSTRUCTIONS)) {
    return;
  }

  const goToInstructions = "Go to instructions";
  const dontShowAgain = "Don't show again";
  const choice = await window.showWarningMessage(
    "We're not able to use the native devcontainer integration, probably because of a lack of permissions. Check out the top of the README.",
    goToInstructions,
    dontShowAgain,
  );

  if (choice === goToInstructions) {
    await commands.executeCommand("extension.open", context.extension.id);
  } else if (choice === dontShowAgain) {
    await context.globalState.update(
      DONT_PROMPT_SSH_FALLBACK_INSTRUCTIONS,
      true,
    );
  }
}
