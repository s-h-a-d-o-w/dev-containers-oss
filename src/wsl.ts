// Windows exposes the WSL filesystem through UNC paths of the form
// \\wsl.localhost\<distro>\<path> (older builds use \\wsl$\<distro>\<path>). Docker, the
// devcontainer CLI, and the containers themselves all live inside the distro, so when the
// opened folder is such a path we must run those tools in WSL (via `wsl.exe`) and hand them
// native Linux paths (/<path>) rather than the UNC path.
const WSL_UNC_RE =
  /^\\\\wsl(?:\.localhost|\$)\\(?<distro>[^\\]+)\\(?<rest>.*)$/u;

export type WslLocation = { distro: string; linuxPath: string };

export function parseWslPath(fsPath: string): WslLocation | undefined {
  const match = WSL_UNC_RE.exec(fsPath);
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
  currentDistro = parseWslPath(fsPath)?.distro;
}

// Resolve `docker <argv>` to the command + args that run it in the right place: directly on
// the host, or inside the active distro through `wsl.exe`.
export function dockerInvocation(argv: string[]): {
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

// The same resolution as a single command-line string, for embedding in an SSH
// ProxyCommand (which is parsed and executed by SSH, not spawned by us).
export function dockerCommandLinePrefix(): string {
  return currentDistro ? `wsl.exe -d ${currentDistro} docker` : "docker";
}
