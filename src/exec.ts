import vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import { getHomeDir, getLog, runCommand, runCommandCapture } from "./core.ts";
import { EXTENSION_ID } from "./constants.ts";
import { ProductInfo } from "./types.ts";

// Build the argv for a `docker exec` invocation. Both runtimes talk to the container
// this way; centralizing the argument order keeps the two transports consistent.
export function dockerExecArgs(
  containerId: string,
  opts: { user?: string; interactive?: boolean },
  argv: string[],
): string[] {
  return [
    "exec",
    ...(opts.user === undefined ? [] : ["-u", opts.user]),
    ...(opts.interactive ? ["-i"] : []),
    containerId,
    ...argv,
  ];
}

export function dockerExecCapture(
  containerId: string,
  user: string | undefined,
  argv: string[],
  options?: { quiet?: boolean },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return runCommandCapture(
    "docker",
    dockerExecArgs(containerId, { user }, argv),
    { quiet: options?.quiet },
  );
}

export async function execInContainerAsRoot(
  containerId: string,
  script: string,
  input?: string,
): Promise<void> {
  await runCommand(
    "docker",
    dockerExecArgs(containerId, { user: "0", interactive: true }, [
      "sh",
      "-c",
      script,
    ]),
    { input },
  );
}

async function getContainerUsername(containerId: string): Promise<string> {
  const result = await runCommandCapture(
    "docker",
    ["exec", containerId, "sh", "-c", "whoami 2>/dev/null || id -un"],
    { quiet: true },
  );
  const user = result.stdout.trim();
  if (user) {
    return user;
  }
  vscode.window.showWarningMessage(
    "Could not detect container user. Falling back to 'root'.",
  );
  return "root";
}

export function getEffectiveUser(
  containerId: string,
  remoteUser?: string,
): string | Promise<string> {
  if (remoteUser) {
    return remoteUser;
  }
  return getContainerUsername(containerId);
}

export async function getUserHome(
  containerId: string,
  user: string,
): Promise<string> {
  const res = await runCommandCapture(
    "docker",
    [
      "exec",
      "-u",
      "0",
      containerId,
      "sh",
      "-c",
      `(getent passwd ${user} 2>/dev/null || grep "^${user}:" /etc/passwd) | head -n1 | cut -d: -f6`,
    ],
    { quiet: true },
  );
  const home = res.stdout.trim();
  if (home) {
    return home;
  }
  return user === "root" ? "/root" : `/home/${user}`;
}

// Read and parse the running editor's product.json. Returns an empty object when the
// file is missing or malformed; callers fall back to their own defaults.
export function readProductJson(): Partial<ProductInfo> {
  try {
    const productJsonPath = path.join(vscode.env.appRoot, "product.json");
    return JSON.parse(
      fs.readFileSync(productJsonPath, "utf8"),
    ) as Partial<ProductInfo>;
  } catch {
    return {};
  }
}

// The SSH remote extension installs each container's VS Code server under a
// product-specific folder in the user's home (e.g. .vscode-server, .vscodium-server,
// .cursor-server). The name comes from the running client's product.json, so we read
// serverDataFolderName there and fall back to an appName heuristic. We intentionally do
// not derive it from applicationName: the mapping is not `.${applicationName}-server`
// (VS Code's is .vscode-server not .code-server, VSCodium's is .vscodium-server), so
// guessing that way would produce the wrong folder.
export function getServerDataFolderName(): string {
  const product = readProductJson();
  if (
    typeof product.serverDataFolderName === "string" &&
    product.serverDataFolderName
  ) {
    return product.serverDataFolderName;
  }
  const appName = (vscode.env.appName || "").toLowerCase();
  // Insiders/pre-release builds append a "-insiders" suffix to the server folder
  // (e.g. .vscode-server-insiders, .vscodium-server-insiders); Cursor/Positron do not
  // ship such builds, so the suffix only matters for VS Code and VSCodium.
  const suffix = appName.includes("insiders") ? "-insiders" : "";
  if (appName.includes("cursor")) {
    return ".cursor-server";
  }
  if (appName.includes("positron")) {
    return ".positron-server";
  }
  if (appName.includes("codium")) {
    return `.vscodium-server${suffix}`;
  }
  return `.vscode-server${suffix}`;
}

// Seed the container user's known_hosts from the host so outbound SSH (e.g. git over
// SSH, using the forwarded agent) does not stop at an interactive host-key prompt.
// Entries are merged and de-duplicated, leaving any keys already present in place.
export async function ensureKnownHostsInContainer(
  containerId: string,
  user: string,
): Promise<void> {
  const hostKnownHosts = path.join(getHomeDir(), ".ssh", "known_hosts");
  if (!fs.existsSync(hostKnownHosts)) {
    return;
  }
  const data = fs.readFileSync(hostKnownHosts, "utf8");
  if (!data.trim()) {
    return;
  }
  const home = await getUserHome(containerId, user);
  const script = [
    "set -e",
    'DATA="$(cat)"',
    `mkdir -p ${home}/.ssh`,
    `chmod 700 ${home}/.ssh`,
    `touch ${home}/.ssh/known_hosts`,
    `printf '%s\\n' "$DATA" >> ${home}/.ssh/known_hosts`,
    `sort -u ${home}/.ssh/known_hosts -o ${home}/.ssh/known_hosts`,
    `chmod 644 ${home}/.ssh/known_hosts`,
    `chown -R ${user} ${home}/.ssh`,
  ].join("\n");
  await execInContainerAsRoot(containerId, script, data);
}

// Copy the host's ~/.gitconfig into the container user's home so commits made inside
// the container carry the same identity (user.name/email) and settings as on the host.
// The file is written verbatim; any existing container-side .gitconfig is replaced.
export async function ensureGitConfigInContainer(
  containerId: string,
  user: string,
): Promise<void> {
  const hostGitConfig = path.join(getHomeDir(), ".gitconfig");
  if (!fs.existsSync(hostGitConfig)) {
    return;
  }
  const data = fs.readFileSync(hostGitConfig, "utf8");
  if (!data.trim()) {
    return;
  }
  const home = await getUserHome(containerId, user);
  const script = [
    "set -e",
    'DATA="$(cat)"',
    `printf '%s' "$DATA" > ${home}/.gitconfig`,
    `chmod 644 ${home}/.gitconfig`,
    `chown ${user} ${home}/.gitconfig`,
  ].join("\n");
  await execInContainerAsRoot(containerId, script, data);
}

// Copy the host's git config and known_hosts into the container user's home (each gated
// by its own setting), so commits carry the host identity and outbound SSH (git, using
// the forwarded agent) does not stall on host-key prompts. Shared by both runtimes.
export async function copyHostDevEnvironment(
  containerId: string,
  user: string,
): Promise<void> {
  const config = vscode.workspace.getConfiguration(EXTENSION_ID);
  if (config.get<boolean>("copyKnownHosts", true)) {
    await ensureKnownHostsInContainer(containerId, user);
  }
  if (config.get<boolean>("copyGitConfig", true)) {
    await ensureGitConfigInContainer(containerId, user);
  }
}

// Devcontainer settings are written to the remote server's Machine-scoped settings
// file inside the container. This keeps them global to the container and invisible to
// the project (no .vscode/settings.json is touched). The server reads this on startup.
export async function applyRemoteMachineSettings(
  containerId: string,
  user: string,
  settings: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(settings).length === 0) {
    return;
  }
  const home = await getUserHome(containerId, user);
  const serverFolder = getServerDataFolderName();
  const settingsDir = `${home}/${serverFolder}/data/Machine`;
  const settingsPath = `${settingsDir}/settings.json`;

  const existing = await runCommandCapture(
    "docker",
    [
      "exec",
      "-u",
      "0",
      containerId,
      "sh",
      "-c",
      `cat ${settingsPath} 2>/dev/null || true`,
    ],
    { quiet: true },
  );
  const trimmed = existing.stdout.trim();
  let merged: Record<string, unknown> = {};
  let parseFailed = false;
  if (trimmed) {
    try {
      merged = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      parseFailed = true;
      getLog().appendLine(
        `Existing ${settingsPath} is not valid JSON; preserving it as settings.json.bak before rewriting.`,
      );
    }
  }
  // Feature/devcontainer settings take precedence over whatever we wrote previously.
  const finalSettings = { ...merged, ...settings };
  const contents = JSON.stringify(finalSettings, undefined, 2) + "\n";

  const script = [
    "set -e",
    `mkdir -p ${settingsDir}`,
    parseFailed ? `cp ${settingsPath} ${settingsPath}.bak` : ":",
    `cat > ${settingsPath}`,
    `chown -R ${user} ${home}/${serverFolder}`,
    `chmod 600 ${settingsPath}`,
  ].join("\n");
  await execInContainerAsRoot(containerId, script, contents);
  getLog().appendLine(
    `Applied ${Object.keys(settings).length} devcontainer setting(s) to ${settingsPath}.`,
  );
}
