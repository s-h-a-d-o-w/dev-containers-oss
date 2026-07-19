import { workspace, type WorkspaceFolder } from "vscode";
import path from "node:path";
import { EXTENSION_ID } from "./constants.ts";

export function getWorkspaceFolder(): WorkspaceFolder | undefined {
  return workspace.workspaceFolders?.[0];
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
