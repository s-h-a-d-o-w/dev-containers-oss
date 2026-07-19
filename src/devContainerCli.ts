import { env, type ExtensionContext, Uri, window } from "vscode";
import path from "node:path";
import { runCommandCapture } from "./runCommands.ts";
import { getLog } from "./log.ts";

export type DevcontainerUpResult = {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
};

export type DevcontainerCustomizations = {
  extensions: string[];
  settings: Record<string, unknown>;
};

// The extension host runs on the Electron/Node binary at process.execPath.
// Setting ELECTRON_RUN_AS_NODE lets us execute the bundled devcontainer CLI as a plain Node script.
function getEnvWithElectronAsNode(): NodeJS.ProcessEnv {
  return { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
}

function runCliCapture(
  ctx: ExtensionContext,
  args: string[],
  { cwd }: { cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cliPath = Uri.joinPath(
    ctx.extensionUri,
    "dist",
    "devcontainers-cli",
    "dist",
    "spec-node",
    "devContainersSpecCLI.js",
  ).fsPath;
  return runCommandCapture(process.execPath, [cliPath, ...args], {
    cwd,
    env: getEnvWithElectronAsNode(),
    quiet: true,
  });
}

// The running editor ships its own CLI at <appRoot>/out/cli.js, launched the same way
// the platform `code`/`codium`/`cursor` wrapper scripts do: the Electron binary in
// plain-Node mode. This lets us drive commands like --install-extension --remote.
export function runEditorCliCapture(
  args: string[],
  { cwd }: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cliPath = path.join(env.appRoot, "out", "cli.js");
  return runCommandCapture(process.execPath, [cliPath, ...args], {
    cwd,
    env: getEnvWithElectronAsNode(),
  });
}

// The CLI writes its final result object to stdout as JSON (independent of the log
// format used for progress output). The result is the last line that parses to an
// object carrying the given key.
function findResultObject(output: string, key: string) {
  const lines = output
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      // oxlint-disable-next-line typescript/no-explicit-any
      const obj = JSON.parse(line) as Record<string, any>;
      if (typeof obj === "object" && key in obj) {
        return obj;
      }
    } catch {
      // not the result line
    }
  }
  return undefined;
}

function parseUpResult(output: string) {
  return findResultObject(output, "outcome");
}

export async function devcontainerUp(
  ctx: ExtensionContext,
  wsFsPath: string,
  options?: { rebuild?: boolean },
): Promise<DevcontainerUpResult> {
  const args = ["up", "--workspace-folder", wsFsPath];
  if (options?.rebuild) {
    args.push("--remove-existing-container");
  }
  if (options?.rebuild) {
    window.showInformationMessage("Rebuilding devcontainer...");
  }
  const { code, stderr, stdout } = await runCliCapture(ctx, args, {
    cwd: wsFsPath,
  });
  const result = parseUpResult(stdout) ?? parseUpResult(stderr);
  if (code !== 0 || result?.outcome !== "success") {
    const detail = (result?.message ??
      result?.description ??
      `exit code ${code}`) as string;
    throw new Error(`devcontainer up failed: ${detail}`);
  }
  if (!result.containerId) {
    throw new Error(
      "devcontainer up succeeded but did not return a containerId",
    );
  }
  return {
    containerId: result.containerId as string,
    remoteUser: (result.remoteUser ?? "") as string,
    remoteWorkspaceFolder: (result.remoteWorkspaceFolder ?? "") as string,
  };
}

function isEntryObject(entry: unknown): entry is Record<string, unknown> {
  return typeof entry === "object" && entry !== null;
}

// The merged configuration folds together the top-level devcontainer.json, image
// metadata, and every feature's customizations. Its `customizations.vscode` is an
// array of { extensions, settings } entries (one per contributing source), so we
// concatenate the extension lists and merge the settings objects in source order.
export async function readMergedCustomizations(
  ctx: ExtensionContext,
  wsFsPath: string,
): Promise<DevcontainerCustomizations> {
  const empty: DevcontainerCustomizations = { extensions: [], settings: {} };
  const args = [
    "read-configuration",
    "--include-merged-configuration",
    "--workspace-folder",
    wsFsPath,
  ];
  let res: { stdout: string; stderr: string; code: number };
  try {
    res = await runCliCapture(ctx, args, { cwd: wsFsPath });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    getLog().appendLine(
      `Could not read devcontainer customizations: ${message}`,
    );
    return empty;
  }
  const result =
    findResultObject(res.stdout, "mergedConfiguration") ??
    findResultObject(res.stderr, "mergedConfiguration");
  // oxlint-disable-next-line typescript/no-unsafe-member-access
  const vscodeEntries = result?.mergedConfiguration?.customizations
    ?.vscode as unknown;
  if (!Array.isArray(vscodeEntries)) {
    return empty;
  }
  const extensions: string[] = [];
  const settings: Record<string, unknown> = {};
  for (const entry of vscodeEntries) {
    if (!isEntryObject(entry)) {
      continue;
    }
    if (Array.isArray(entry.extensions)) {
      for (const ext of entry.extensions) {
        if (typeof ext === "string") {
          extensions.push(ext);
        }
      }
    }
    if (entry.settings && typeof entry.settings === "object") {
      Object.assign(settings, entry.settings);
    }
  }
  return { extensions: [...new Set(extensions)], settings };
}
