import { commands, FileType, Uri, workspace, type WorkspaceFolder } from "vscode";
import path from "node:path";
import { EXTENSION_ID } from "./constants.ts";

export async function getDevcontainerConfigs(ws: WorkspaceFolder): Promise<Uri[]> {
  const configs: Uri[] = [];
  const devcontainerDir = Uri.joinPath(ws.uri, ".devcontainer");
  try {
    for (const [name, type] of await workspace.fs.readDirectory(devcontainerDir)) {
      if ((type & FileType.File) && /^devcontainer(?:\..+)?\.json$/u.test(name)) {
        configs.push(Uri.joinPath(devcontainerDir, name));
      }
      if (type & FileType.Directory) {
        const config = Uri.joinPath(devcontainerDir, name, "devcontainer.json");
        try { await workspace.fs.stat(config); configs.push(config); } catch { /* absent */ }
      }
    }
  } catch { /* absent */ }

  const rootConfig = Uri.joinPath(ws.uri, ".devcontainer.json");
  try { await workspace.fs.stat(rootConfig); configs.push(rootConfig); } catch { /* absent */ }

  const defaultConfig = Uri.joinPath(devcontainerDir, "devcontainer.json");
  return configs.sort((a, b) => {
    if (a.toString() === defaultConfig.toString()) return -1;
    if (b.toString() === defaultConfig.toString()) return 1;
    return a.path.localeCompare(b.path);
  });
}

export function getHomeDir(): string {
  return process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
}

export function getWorkspaceFolder(): WorkspaceFolder | undefined {
  return workspace.workspaceFolders?.[0];
}

export async function hasDevcontainerConfig(ws: WorkspaceFolder | undefined) {
  if (!ws) {
    return false;
  }
  try {
    // Resolve the config via the VS Code filesystem API rather than Node's fs: When we're "running" in the dev container, the extension is still on the host and fs.existsSync would run on the local machine.
    return (await getDevcontainerConfigs(ws)).length > 0;
  } catch {
    return false;
  }
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

export async function updateDevcontainerContext() {
  await commands.executeCommand(
    "setContext",
    `${EXTENSION_ID}.hasConfig`,
    await hasDevcontainerConfig(getWorkspaceFolder()),
  );
}
