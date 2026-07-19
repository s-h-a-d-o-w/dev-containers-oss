import {
  commands,
  env,
  ExtensionContext,
  ExtensionMode,
  ManagedResolvedAuthority,
  RelativePattern,
  Uri,
  window,
  workspace,
  WorkspaceFolder,
} from "vscode";
import fs from "node:fs";
import { devcontainerUp, readMergedCustomizations } from "./devContainerCli.ts";
import { getWorkspaceFolder } from "./utilities.ts";
import {
  createLogTerminal,
  getLog,
  resetLog,
  setDevMode,
  withLogTerminal,
} from "./log.ts";
import {
  getHandoffMarkerPath,
  sshRuntime,
  resolveLocalWorkspaceFolder,
} from "./runtimes/ssh.ts";
import {
  AUTHORITY_PREFIX,
  decodeLocalFolder,
  nativeRuntime,
  registerRemoteResolver,
} from "./runtimes/native.ts";
import { EXTENSION_ID } from "./constants.ts";

const SSH_REMOTE_AUTHORITY_PREFIX = "ssh-remote+";
const CONTAINER_AUTHORITY_PREFIX = `${AUTHORITY_PREFIX}+`;

// Global-state key holding a rebuild/reopen that must finish from a local window. When the
// command is triggered inside the container, we cannot rebuild in place (removing the
// container drops this window's SSH connection), so we stash the request, reopen the host
// folder locally, and resume it there on the next activation.
const PENDING_REOPEN_KEY = `${EXTENSION_ID}.pendingReopen`;

// Workspace-scoped flag set when the user picks "Don't Show Again" on the reopen prompt,
// so the suggestion is suppressed for this folder only (not globally).
const DONT_PROMPT_REOPEN_KEY = `${EXTENSION_ID}.dontPromptReopen`;

type PendingReopen = {
  localFolder: string;
  rebuild: boolean;
  native?: boolean;
};

// E.g. vscodium now has native support but that might not be the case for every flavor of VS Code.
function isNativeRuntimeAvailable(): boolean {
  return (
    typeof workspace.registerRemoteAuthorityResolver === "function" &&
    typeof ManagedResolvedAuthority === "function"
  );
}

// Render the handed-off setup log in a read-only terminal that closes on any keypress,
// mirroring the official Dev Containers extension. The captured text is printed locally
// (this UI extension cannot cat the container-side file) and, since the log is already
// complete, the terminal is finished immediately.
function showLogInReadOnlyTerminal(logText: string) {
  const term = createLogTerminal("Devcontainer Configuration");
  term.write(logText.endsWith("\n") ? logText : logText + "\n");
  term.finish();
}

// When the folder has just reopened inside the container over SSH, surface the setup log
// that the launching window handed off. This extension runs as a UI (local) extension in
// the reopened window, so the marker lives on the local host and is keyed by the window's
// host alias; the log itself lives in the container and is shown via a remote terminal.
// Consuming (deleting) the marker keeps this to the first activation only, so later
// reloads of the same window do not reopen the terminal.
function showHandoffLogIfPresent() {
  if (!env.remoteName) {
    return;
  }
  const authority = workspace.workspaceFolders?.[0]?.uri.authority ?? "";
  if (!authority.startsWith(SSH_REMOTE_AUTHORITY_PREFIX)) {
    return;
  }
  const hostAlias = authority.slice(SSH_REMOTE_AUTHORITY_PREFIX.length);
  const markerPath = getHandoffMarkerPath(hostAlias);
  if (!fs.existsSync(markerPath)) {
    return;
  }
  let logText = "";
  try {
    logText = fs.readFileSync(markerPath, "utf8");
    fs.unlinkSync(markerPath);
  } catch {
    // if we cannot read/remove the marker, still show whatever we have
  }
  showLogInReadOnlyTerminal(logText);
}

function getConfigUri(ws: WorkspaceFolder) {
  return Uri.joinPath(ws.uri, ".devcontainer", "devcontainer.json");
}

function getWorkspaceOrThrow(): WorkspaceFolder {
  const workspaceFolder = getWorkspaceFolder();
  if (!workspaceFolder) {
    throw new Error("No folder open");
  }
  return workspaceFolder;
}

function withUiErrorHandling(
  action: () => Promise<void>,
  options?: { appendToOutput?: boolean },
): () => Promise<void> {
  return async () => {
    try {
      await action();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      window.showErrorMessage(message);
      if (options?.appendToOutput ?? true) {
        getLog().appendLine(`Error: ${message}`);
      }
    }
  };
}

export function activate(context: ExtensionContext) {
  setDevMode(context.extensionMode === ExtensionMode.Development);

  showHandoffLogIfPresent();

  // Register the native remote resolver so folders can be opened directly inside the
  // container over a docker-exec tunnel (no SSH), via the `dev-containers-oss+` authority.
  // Only possible when the `resolvers` proposed API is available; otherwise every action
  // routes through the SSH runtime.
  const nativeAvailable = isNativeRuntimeAvailable();
  if (nativeAvailable) {
    context.subscriptions.push(...registerRemoteResolver(context));
  }

  // Resolve the config via the VS Code filesystem API rather than Node's fs: while
  // connected this extension runs on the UI (local) host, but the workspace lives on the
  // remote, so fs.existsSync on the remote fsPath would always miss.
  async function hasDevcontainerConfig(ws: WorkspaceFolder | undefined) {
    if (!ws) {
      return false;
    }
    try {
      await workspace.fs.stat(getConfigUri(ws));
      return true;
    } catch {
      return false;
    }
  }

  async function updateDevcontainerContext() {
    const has = await hasDevcontainerConfig(getWorkspaceFolder());
    await commands.executeCommand(
      "setContext",
      `${EXTENSION_ID}.hasConfig`,
      has,
    );
  }
  // Initialize context
  void updateDevcontainerContext();

  // The alias of the container this window is connected to, if it is one of ours.
  function getConnectedHostAlias(): string | undefined {
    if (!env.remoteName) {
      return undefined;
    }
    const authority = getWorkspaceFolder()?.uri.authority ?? "";
    if (!authority.startsWith(SSH_REMOTE_AUTHORITY_PREFIX)) {
      return undefined;
    }
    return authority.slice(SSH_REMOTE_AUTHORITY_PREFIX.length);
  }

  // The host-side folder of the native (managed) container this window is connected to, if
  // any. The local path is encoded straight into the authority, so no lookup is needed.
  function getConnectedContainerLocalFolder(): string | undefined {
    if (!env.remoteName) {
      return undefined;
    }
    const authority = getWorkspaceFolder()?.uri.authority ?? "";
    if (!authority.startsWith(CONTAINER_AUTHORITY_PREFIX)) {
      return undefined;
    }
    return decodeLocalFolder(authority);
  }

  // When connected to one of our containers and devcontainer.json changes on disk, offer to
  // rebuild so the edits take effect, mirroring the official Dev Containers extension. Only
  // shown while connected: from a local window there is no running container to rebuild.
  async function promptRebuildOnConfigChange() {
    if (!getConnectedHostAlias() && !getConnectedContainerLocalFolder()) {
      return;
    }
    const rebuild = "Rebuild";
    const choice = await window.showInformationMessage(
      "Configuration file changed: devcontainer.json. The container might need to be rebuilt to apply the changes.",
      rebuild,
      "Ignore",
    );
    if (choice === rebuild) {
      await commands.executeCommand(`${EXTENSION_ID}.rebuildAndOpen`);
    }
  }

  // Watch for changes to devcontainer.json to keep the hasConfig context in sync and, while
  // connected, prompt to rebuild so edits take effect.
  const initialWorkspaceFolder = getWorkspaceFolder();
  if (initialWorkspaceFolder) {
    const watcher = workspace.createFileSystemWatcher(
      new RelativePattern(
        initialWorkspaceFolder,
        ".devcontainer/devcontainer.json",
      ),
    );
    watcher.onDidCreate(updateDevcontainerContext);
    watcher.onDidDelete(updateDevcontainerContext);
    watcher.onDidChange(() => {
      void updateDevcontainerContext();
      void promptRebuildOnConfigChange();
    });
    context.subscriptions.push(watcher);
  }

  async function openFolderWithSsh(
    wsFsPath: string,
    forceRebuild: boolean,
  ): Promise<void> {
    resetLog();
    await withLogTerminal("Devcontainer Configuration", async () => {
      const result = await devcontainerUp(context, wsFsPath, {
        rebuild: forceRebuild,
      });
      const customizations = await readMergedCustomizations(context, wsFsPath);
      await sshRuntime(
        wsFsPath,
        result.containerId,
        result.remoteUser,
        result.remoteWorkspaceFolder,
        customizations,
      );
    });
  }

  async function useSsh(forceRebuild: boolean): Promise<void> {
    const hostAlias = getConnectedHostAlias();
    if (hostAlias) {
      // We are inside the container we are about to (re)build. The devcontainer CLI runs
      // on the host, and removing/recreating the container would sever this window's SSH
      // ProxyCommand pipe mid-operation (ERR_STREAM_PREMATURE_CLOSE) and can crash the
      // editor. So detach first: reopen the host folder in a local window and let it
      // resume the request on activation via the pending marker below.
      const localFolder = await resolveLocalWorkspaceFolder(hostAlias);
      if (!localFolder) {
        throw new Error(
          "Could not determine the host workspace folder for the connected container. Try again with the workspace opened directly.",
        );
      }
      await context.globalState.update(PENDING_REOPEN_KEY, {
        localFolder,
        rebuild: forceRebuild,
      } satisfies PendingReopen);
      await commands.executeCommand(
        "vscode.openFolder",
        Uri.file(localFolder),
        false,
      );
      return;
    }
    await openFolderWithSsh(getWorkspaceOrThrow().uri.fsPath, forceRebuild);
  }

  async function useNative(forceRebuild: boolean): Promise<void> {
    const connectedLocalFolder = getConnectedContainerLocalFolder();
    if (connectedLocalFolder) {
      // We are inside the container the resolver connected us to. Rebuilding removes this
      // container and would drop the docker-exec managed connection mid-operation, so
      // detach first: reopen the host folder locally and resume there on activation.
      await context.globalState.update(PENDING_REOPEN_KEY, {
        localFolder: connectedLocalFolder,
        rebuild: forceRebuild,
        native: true,
      } satisfies PendingReopen);
      await commands.executeCommand(
        "vscode.openFolder",
        Uri.file(connectedLocalFolder),
        false,
      );
      return;
    }
    await nativeRuntime(
      context,
      getWorkspaceOrThrow().uri.fsPath,
      forceRebuild,
    );
  }

  // Single entry point for opening/rebuilding a devcontainer. When already connected we
  // stay on whichever runtime the current window uses (its authority tells us which). For
  // a fresh open from a local window we prefer the native runtime and fall back to SSH
  // when the proposed API is unavailable, so users never have to pick a runtime.
  async function openDevcontainer(forceRebuild: boolean): Promise<void> {
    if (getConnectedHostAlias()) {
      await useSsh(forceRebuild);
      return;
    }
    if (getConnectedContainerLocalFolder()) {
      await useNative(forceRebuild);
      return;
    }
    if (nativeAvailable) {
      await useNative(forceRebuild);
    } else {
      await useSsh(forceRebuild);
    }
  }

  // After the connected window reopened the host folder locally, finish the stashed
  // rebuild/reopen here. Guarded to a local window whose folder matches the request so a
  // stale marker cannot fire in an unrelated window.
  async function resumePendingReopenIfAny() {
    const pending = context.globalState.get<PendingReopen>(PENDING_REOPEN_KEY);
    if (!pending) {
      return;
    }
    if (env.remoteName) {
      return;
    }
    const workspaceFolder = getWorkspaceFolder();
    if (
      !workspaceFolder ||
      workspaceFolder.uri.fsPath !== pending.localFolder
    ) {
      return;
    }
    await context.globalState.update(PENDING_REOPEN_KEY, undefined);
    await withUiErrorHandling(
      () =>
        pending.native
          ? nativeRuntime(context, pending.localFolder, pending.rebuild)
          : openFolderWithSsh(pending.localFolder, pending.rebuild),
      { appendToOutput: false },
    )();
  }

  // Don't prompt if we're already in the process of reopening.
  const isReopening = Boolean(
    context.globalState.get<PendingReopen>(PENDING_REOPEN_KEY),
  );
  async function promptReopenInContainerIfConfigured() {
    if (
      env.remoteName ||
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
  void promptReopenInContainerIfConfigured();

  void resumePendingReopenIfAny();

  const openFolderInDevcontainer = commands.registerCommand(
    `${EXTENSION_ID}.openFolderInDevcontainer`,
    withUiErrorHandling(
      async () => {
        await openDevcontainer(false);
      },
      { appendToOutput: false },
    ),
  );

  const rebuildAndOpen = commands.registerCommand(
    `${EXTENSION_ID}.rebuildAndOpen`,
    withUiErrorHandling(
      async () => {
        await openDevcontainer(true);
      },
      { appendToOutput: false },
    ),
  );

  const reopenFolderLocally = commands.registerCommand(
    `${EXTENSION_ID}.reopenFolderLocally`,
    withUiErrorHandling(
      async () => {
        // Determine the host-side folder for whichever connection this window uses: SSH
        // (resolve via the host alias) or native container (decoded straight from the
        // authority). Then reopen it in a local window.
        let localFolder = getConnectedContainerLocalFolder();
        if (!localFolder) {
          const hostAlias = getConnectedHostAlias();
          if (hostAlias) {
            localFolder = await resolveLocalWorkspaceFolder(hostAlias);
          }
        }
        if (!localFolder) {
          throw new Error(
            "Could not determine the host workspace folder for the connected container.",
          );
        }
        await commands.executeCommand(
          "vscode.openFolder",
          Uri.file(localFolder),
          false,
        );
      },
      { appendToOutput: false },
    ),
  );

  const openDevcontainerConfig = commands.registerCommand(
    `${EXTENSION_ID}.openDevcontainerConfig`,
    withUiErrorHandling(
      async () => {
        const workspaceFolder = getWorkspaceOrThrow();
        if (!(await hasDevcontainerConfig(workspaceFolder))) {
          throw new Error(
            ".devcontainer/devcontainer.json not found in this folder",
          );
        }
        const doc = await workspace.openTextDocument(
          getConfigUri(workspaceFolder),
        );
        await window.showTextDocument(doc, { preview: false });
      },
      { appendToOutput: false },
    ),
  );

  const resetReopenPrompt = commands.registerCommand(
    `${EXTENSION_ID}.resetReopenPrompt`,
    withUiErrorHandling(
      async () => {
        await context.workspaceState.update(DONT_PROMPT_REOPEN_KEY, undefined);
      },
      { appendToOutput: false },
    ),
  );

  context.subscriptions.push(
    openFolderInDevcontainer,
    openDevcontainerConfig,
    rebuildAndOpen,
    reopenFolderLocally,
    resetReopenPrompt,
  );
}

export function deactivate() {
  // no-op: containers are managed by the devcontainer CLI and reused across sessions
}
