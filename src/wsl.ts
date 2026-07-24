export type WslLocation = { distro: string; linuxPath: string };

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
