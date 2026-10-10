import { workspace, type WorkspaceFolder } from "vscode";
import path from "node:path";
import { EXTENSION_ID } from "./constants.ts";

export function getWorkspaceFolder(): WorkspaceFolder | undefined {
  return workspace.workspaceFolders?.[0];
}

export function getHomeDir(): string {
  return process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
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

// Docker-compatible CLIs (podman, nerdctl, ...) are drop-in replacements for the `docker`
// and `docker-compose` binaries, so every invocation goes through these two settings.
function getPathSetting(key: string): string | undefined {
  const value = workspace
    .getConfiguration(EXTENSION_ID)
    .get<string>(key)
    ?.trim();
  return value === "" ? undefined : value;
}

export function getDockerPath(): string {
  return getPathSetting("dockerPath") ?? "docker";
}

export function getDockerComposePath(): string | undefined {
  return getPathSetting("dockerComposePath");
}
