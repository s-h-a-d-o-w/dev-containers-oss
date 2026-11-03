import { env, Uri, WorkspaceFolder, type ExtensionContext } from "vscode";
import { EXTENSION_ID } from "./constants";

export type WslLocation = { distro: string; linuxPath: string };

export const WSL_WORKSPACE_KEY = `${EXTENSION_ID}.wslWorkspace`;

// A Remote-WSL workspace exposes a Linux path, but this UI extension executes on
// Windows. Convert it to the same host path used when opening WSL folders directly.
export function getWslHostPath(
  authority: string,
  linuxPath: string,
): string | undefined {
  const prefix = "wsl+";
  if (!authority.startsWith(prefix) || authority.length === prefix.length) {
    return undefined;
  }
  const distro = authority.slice(prefix.length);
  return `\\\\wsl.localhost\\${distro}${linuxPath.replaceAll("/", "\\")}`;
}

export function maybeGetHostWorkspacePath(ws: WorkspaceFolder): string {
  if (ws.uri.scheme === "vscode-remote" && env.remoteName === "wsl") {
    const hostPath = getWslHostPath(ws.uri.authority, ws.uri.path);
    if (!hostPath || process.platform !== "win32") {
      throw new Error(
        "Could not resolve the WSL workspace on the Windows host.",
      );
    }
    return hostPath;
  }
  return ws.uri.fsPath;
}

// Return WSL projects to their WSL window, rather than opening their UNC path
// as a local Windows workspace. The host path remains stable for rebuild markers.
export function maybeGetHostWorkspaceUri(
  context: ExtensionContext,
  localFolder: string,
): Uri {
  const wslUri = context.globalState.get<string>(
    `${WSL_WORKSPACE_KEY}.${localFolder}`,
  );
  return wslUri ? Uri.parse(wslUri) : Uri.file(localFolder);
}

export function parseWslInfo(fsPath: string): WslLocation | undefined {
  const match =
    /^\\\\wsl(?:\.localhost|\$)\\(?<distro>[^\\]+)\\(?<rest>.*)$/u.exec(fsPath);
  if (!match?.groups || !match.groups["distro"] || !match.groups["rest"]) {
    return undefined;
  }
  const rest = match.groups["rest"].replaceAll("\\", "/");
  return { distro: match.groups["distro"], linuxPath: `/${rest}` };
}

// The distro whose docker daemon serves the current window, or undefined when docker runs
// natively on the host. This mirrors the "one window = one container" model the runtimes
// already rely on: it is (re)computed from the opened folder each time `devcontainer up`
// runs, before any docker command is issued, so every subsequent docker call in the same
// process routes to the right place.
let currentDistro: string | undefined;
export function setWslDistroFromPath(fsPath: string): void {
  currentDistro = parseWslInfo(fsPath)?.distro;
}

export function buildDockerCommand(argv: string[]): {
  command: string;
  args: string[];
} {
  if (currentDistro) {
    return {
      command: "wsl.exe",
      args: ["-d", currentDistro, "docker", ...argv],
    };
  }
  return { command: "docker", args: argv };
}

// For embedding in an SSH ProxyCommand (which is parsed and executed by SSH, not spawned by us).
export function buildDockerCommandLinePrefix(): string {
  return currentDistro ? `wsl.exe -d ${currentDistro} docker` : "docker";
}
