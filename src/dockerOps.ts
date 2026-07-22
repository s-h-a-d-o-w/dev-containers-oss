import { window, workspace } from "vscode";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getHomeDir } from "./utilities.ts";
import { runCommand, runCommandCapture } from "./runCommands.ts";
import { getLog } from "./log.ts";
import { EXTENSION_ID } from "./constants.ts";
import { getServerDataFolderName } from "./hostInfo.ts";
import { dockerInvocation } from "./wsl.ts";

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
  const { command, args } = dockerInvocation(
    dockerExecArgs(containerId, { user }, argv),
  );
  return runCommandCapture(command, args, { quiet: options?.quiet });
}

export function spawnDockerExec(
  containerId: string,
  user: string,
  argv: string[],
) {
  const { command, args } = dockerInvocation(
    dockerExecArgs(containerId, { user, interactive: true }, argv),
  );
  return spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
}

// When the docker invocation is routed through `wsl.exe` (docker lives inside WSL), any
// script passed on the command line as `sh -c "<script>"` has its embedded quotes mangled
// by the Node spawn -> Windows CreateProcess -> wsl.exe chain (the same failure that forced
// the CLI invocation onto stdin). So we deliver the script over stdin to a bare `sh` (which
// reads and executes its commands from stdin) instead, keeping it off the wsl.exe command
// line entirely. Data the script needs (git config, known_hosts, settings) can no longer
// arrive on the now-occupied stdin, so it is base64-embedded and exposed as $DATA.
function withEmbeddedData(script: string, data?: string): string {
  if (data === undefined) {
    return script;
  }
  const b64 = Buffer.from(data, "utf8").toString("base64");
  // base64 uses no shell metacharacters or whitespace, so $DATA is recovered verbatim
  // regardless of the payload. Command substitution strips trailing newlines exactly like
  // the previous `DATA="$(cat)"` did.
  return `DATA=$(printf %s ${b64} | base64 -d)\n${script}`;
}

// Streaming variant (mirrors runCommand): output goes to the log terminal.
export function dockerExecShell(
  containerId: string,
  { data, user }: { data?: string; user?: string },
  script: string,
) {
  const { command, args } = dockerInvocation(
    dockerExecArgs(containerId, { user, interactive: true }, ["sh"]),
  );
  return runCommand(command, args, { input: withEmbeddedData(script, data) });
}

// Capturing variant. `params` become the script's positional parameters ("$@"), passed via
// `sh -s -- ...` — those are simple tokens (no quotes/spaces), so they survive the wsl.exe
// command line unharmed.
export function dockerExecShellCapture(
  containerId: string,
  {
    data,
    params,
    quiet,
    user,
  }: { data?: string; params?: string[]; quiet?: boolean; user?: string },
  script: string,
) {
  const argv = params ? ["sh", "-s", "--", ...params] : ["sh"];
  const { command, args } = dockerInvocation(
    dockerExecArgs(containerId, { user, interactive: true }, argv),
  );
  return runCommandCapture(command, args, {
    input: withEmbeddedData(script, data),
    quiet,
  });
}

export async function dockerInspectLabel(
  containerId: string,
  label: string,
): Promise<string | undefined> {
  // A `--format '{{ index .Config.Labels "…" }}'` template carries spaces and double
  // quotes on the command line, which wsl.exe mangles when docker lives inside WSL (the
  // same hazard that forced the shell scripts onto stdin). So we fetch the full inspect
  // JSON — a bare argv with no quotes/spaces — and pick the label out in JS instead.
  const { command, args } = dockerInvocation(["inspect", containerId]);
  const result = await runCommandCapture(command, args, { quiet: true });
  if (result.code !== 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      Config?: { Labels?: Record<string, string> };
    }[];
    const value = parsed[0]?.Config?.Labels?.[label]?.trim();
    if (!value) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export async function execInContainerAsRoot(
  containerId: string,
  script: string,
  input?: string,
): Promise<void> {
  await dockerExecShell(containerId, { data: input, user: "0" }, script);
}

async function getContainerUsername(containerId: string): Promise<string> {
  const result = await dockerExecShellCapture(
    containerId,
    { quiet: true },
    "whoami 2>/dev/null || id -un",
  );
  const user = result.stdout.trim();
  if (user) {
    return user;
  }
  window.showWarningMessage(
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
  const res = await dockerExecShellCapture(
    containerId,
    { quiet: true, user: "0" },
    `(getent passwd ${user} 2>/dev/null || grep "^${user}:" /etc/passwd) | head -n1 | cut -d: -f6`,
  );
  const home = res.stdout.trim();
  if (home) {
    return home;
  }
  return user === "root" ? "/root" : `/home/${user}`;
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
  const config = workspace.getConfiguration(EXTENSION_ID);
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

  const existing = await dockerExecShellCapture(
    containerId,
    { quiet: true, user: "0" },
    `cat ${settingsPath} 2>/dev/null || true`,
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
    `printf '%s\\n' "$DATA" > ${settingsPath}`,
    `chown -R ${user} ${home}/${serverFolder}`,
    `chmod 600 ${settingsPath}`,
  ].join("\n");
  await execInContainerAsRoot(containerId, script, contents);
  getLog().appendLine(
    `Applied ${Object.keys(settings).length} devcontainer setting(s) to ${settingsPath}.`,
  );
}
