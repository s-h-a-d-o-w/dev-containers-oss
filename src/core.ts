import vscode from "vscode";
import path from "node:path";
import { spawn } from "node:child_process";
import { EXTENSION_ID } from "./constants.ts";
import { getLog, logCommand, shouldStream } from "./log.ts";

export type DevcontainerUpResult = {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
};

export type DevcontainerCustomizations = {
  extensions: string[];
  settings: Record<string, unknown>;
};

export function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

export function getHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

export function getDevcontainerPath(wsFsPath: string): string {
  return path.join(wsFsPath, ".devcontainer", "devcontainer.json");
}

function makeWorkspaceSlug(wsFsPath: string): string {
  const name = path.basename(wsFsPath).toLowerCase();
  let slug = name.replaceAll(/[^a-z0-9._-]+/gu, "-");
  slug = slug.replaceAll(/^[._-]+|[._-]+$/gu, "");
  return slug || "workspace";
}

export function getHostAlias(wsFsPath: string): string {
  const slug = makeWorkspaceSlug(wsFsPath);
  return `${EXTENSION_ID}-${slug}`;
}

export function runCommand(
  command: string,
  args: string[],
  {
    quiet,
    cwd,
    env,
    input,
  }: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; quiet?: boolean },
): Promise<void> {
  const out = getLog();
  const stream = shouldStream(quiet);
  if (stream) {
    logCommand(command, args);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.stdout.on("data", (d: Buffer) => {
      if (stream) {
        out.append(d.toString());
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stream) {
        out.append(d.toString());
      }
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

export function runCommandCapture(
  command: string,
  args: string[],
  {
    quiet,
    cwd,
    env,
  }: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const out = getLog();
  const stream = shouldStream(quiet);
  if (stream) {
    logCommand(command, args);
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (stream) {
        out.append(s);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      if (stream) {
        out.append(s);
      }
    });
    child.on("error", () => resolve({ stdout: "", stderr: "error", code: 1 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

// The extension host runs on the Electron/Node binary at process.execPath.
// Setting ELECTRON_RUN_AS_NODE lets us execute the bundled devcontainer CLI as a plain Node script.
function getNodeEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
}

function runCliCapture(
  ctx: vscode.ExtensionContext,
  args: string[],
  { cwd }: { cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cliPath = vscode.Uri.joinPath(
    ctx.extensionUri,
    "dist",
    "devcontainers-cli",
    "dist",
    "spec-node",
    "devContainersSpecCLI.js",
  ).fsPath;
  return runCommandCapture(process.execPath, [cliPath, ...args], {
    cwd,
    env: getNodeEnv(),
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
  const cliPath = path.join(vscode.env.appRoot, "out", "cli.js");
  return runCommandCapture(process.execPath, [cliPath, ...args], {
    cwd,
    env: getNodeEnv(),
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
  ctx: vscode.ExtensionContext,
  wsFsPath: string,
  options?: { rebuild?: boolean },
): Promise<DevcontainerUpResult> {
  const args = ["up", "--workspace-folder", wsFsPath];
  if (options?.rebuild) {
    args.push("--remove-existing-container");
  }
  if (options?.rebuild) {
    vscode.window.showInformationMessage("Rebuilding devcontainer...");
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
  ctx: vscode.ExtensionContext,
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
