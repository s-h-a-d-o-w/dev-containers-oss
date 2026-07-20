import { basename } from "node:path";
import { createHash } from "node:crypto";
import {
  commands,
  env,
  type ExtensionContext,
  ExtensionMode,
  ManagedResolvedAuthority,
  RelativePattern,
  Uri,
  window,
  workspace,
  type WorkspaceFolder,
} from "vscode";
import { devcontainerUp, readMergedCustomizations } from "./devContainerCli.ts";
import { getWorkspaceFolder } from "./utilities.ts";
import { getLog, resetLog, setDevMode, withLogTerminal } from "./log.ts";
import {
  getConnectedHostAlias,
  resolveLocalWorkspaceFolder,
  showHandoffLogIfPresent,
  sshRuntime,
} from "./runtimes/ssh.ts";
import {
  AUTHORITY_PREFIX,
  decodeLocalFolder,
  nativeRuntime,
  registerRemoteResolver,
} from "./runtimes/native.ts";
import { EXTENSION_ID } from "./constants.ts";

const CONTAINER_AUTHORITY_PREFIX = `${AUTHORITY_PREFIX}+`;
const PENDING_REOPEN_KEY = `${EXTENSION_ID}.pendingReopen`;
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

  void showHandoffLogIfPresent(); // SSH-only

  // Register the native remote resolver so folders can be opened directly inside the
  // container over a docker-exec tunnel (no SSH), via the `dev-containers-oss+` authority.
  const nativeAvailable = isNativeRuntimeAvailable();
  if (nativeAvailable) {
    context.subscriptions.push(...registerRemoteResolver(context));
  }

  async function hasDevcontainerConfig(ws: WorkspaceFolder | undefined) {
    if (!ws) {
      return false;
    }
    try {
      // Resolve the config via the VS Code filesystem API rather than Node's fs: When we're "running" in the dev container, the extension is still on the host and fs.existsSync would run on the local machine.
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

  async function promptRebuildOnConfigChange(changedFile: string) {
    if (!getConnectedHostAlias() && !getConnectedContainerLocalFolder()) {
      return;
    }
    const rebuild = "Rebuild";
    const choice = await window.showInformationMessage(
      `Configuration file changed: ${changedFile}. The container might need to be rebuilt to apply the changes.`,
      rebuild,
      "Ignore",
    );
    if (choice === rebuild) {
      await commands.executeCommand(`${EXTENSION_ID}.rebuildAndOpen`);
    }
  }

  // Rebuild prompt on changes in .devcontainer
  const initialWorkspaceFolder = getWorkspaceFolder();
  if (initialWorkspaceFolder) {
    const watcher = workspace.createFileSystemWatcher(
      new RelativePattern(initialWorkspaceFolder, ".devcontainer/**"),
    );

    const onConfigChanged = (uri: Uri) => {
      // vscode causes change events with schemes such as `git` when e.g. staging files. The file
      // on disk is untouched => Only react to the workspace folder's own filesystem scheme
      // (`file`, or `vscode-remote` when connected to a container).
      if (uri.scheme !== initialWorkspaceFolder.uri.scheme) {
        return;
      }
      void updateDevcontainerContext();
      void promptRebuildOnConfigChange(basename(uri.fsPath));
    };

    watcher.onDidCreate(onConfigChanged);
    watcher.onDidDelete(onConfigChanged);
    watcher.onDidChange(onConfigChanged);
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
  // a fresh open from a local window we prefer the native runtime and fall back to SSH.
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
