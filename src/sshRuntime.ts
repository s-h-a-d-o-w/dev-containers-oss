import vscode from "vscode";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DevcontainerCustomizations,
  getBufferedLog,
  getHomeDir,
  getHostAlias,
  getLog,
  runCommandCapture,
  runEditorCliCapture,
} from "./core";
import {
  applyRemoteMachineSettings,
  copyHostDevEnvironment,
  execInContainerAsRoot,
  getEffectiveUser,
  getUserHome,
} from "./exec";
import { EXTENSION_ID } from "./constants";

// Local (host-side) marker whose presence tells the reopened window to display the log
// once, and whose contents carry the log text itself. The reopened window runs this
// extension as a UI (local) extension, so it can only read the marker on the local
// filesystem, not inside the container; keeping the log in the marker lets it render the
// text locally without reaching into the container. Keyed by host alias so it only
// triggers for the window we just launched.
export function getHandoffMarkerPath(hostAlias: string): string {
  return path.join(os.tmpdir(), `${EXTENSION_ID}-handoff-${hostAlias}.pending`);
}

// Recover the container id that Open-Remote-SSH tunnels through, from the ProxyCommand
// line of the host alias block in ~/.ssh/config. We write that block ourselves in
// ensureSshConfigHostAlias, so the `docker exec ... <containerId> /usr/sbin/sshd` form
// is stable and can be parsed back out.
function getContainerIdFromSshConfig(hostAlias: string): string | undefined {
  const sshConfigPath = path.join(getHomeDir(), ".ssh", "config");
  if (!fs.existsSync(sshConfigPath)) {
    return undefined;
  }
  const configText = fs.readFileSync(sshConfigPath, "utf8");
  const escapedAlias = hostAlias.replaceAll(
    /[.*+?^${}()|[\]\\]/gu,
    String.raw`\$&`,
  );
  const blockRegex = new RegExp(
    `^Host[ \\t]+${escapedAlias}[ \\t]*\\r?\\n(?:(?!^Host[ \\t]).*(?:\\r?\\n|$))*`,
    "mu",
  );
  const block = configText.match(blockRegex)?.[0];
  if (!block) {
    return undefined;
  }
  const proxyMatch =
    /ProxyCommand\s+docker\s+exec\s+.*?\s(?<containerId>\S+)\s+\/usr\/sbin\/sshd/u.exec(
      block,
    );
  return proxyMatch?.groups?.containerId;
}

// When rebuild/reopen is triggered from a window already connected to the container,
// this extension runs as a local (UI) extension, so workspaceFolders exposes the
// in-container path (e.g. /workspaces/foo) rather than the host path. The devcontainer
// CLI must be pointed at the host folder that holds .devcontainer/devcontainer.json,
// which the CLI recorded in the `devcontainer.local_folder` label when it created the
// container. We read it back via docker inspect using the container id from ssh config.
export async function resolveLocalWorkspaceFolder(
  hostAlias: string,
): Promise<string | undefined> {
  const containerId = getContainerIdFromSshConfig(hostAlias);
  if (!containerId) {
    return undefined;
  }
  const res = await runCommandCapture(
    "docker",
    [
      "inspect",
      "--format",
      '{{ index .Config.Labels "devcontainer.local_folder" }}',
      containerId,
    ],
    { quiet: true },
  );
  if (res.code !== 0) {
    return undefined;
  }
  const localFolder = res.stdout.trim();
  return localFolder || undefined;
}

async function resolvePublicKeyPath(): Promise<string | undefined> {
  const homeDir = getHomeDir();
  const candidates = [
    path.join(homeDir, ".ssh", "id_ed25519.pub"),
    path.join(homeDir, ".ssh", "id_rsa.pub"),
  ];
  let pubKeyPath = candidates.find((p) => fs.existsSync(p));
  if (!pubKeyPath) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "Select public SSH key (*.pub)",
      filters: { Key: ["pub"] },
      defaultUri: homeDir
        ? vscode.Uri.file(path.join(homeDir, ".ssh"))
        : undefined,
    });
    if (!picked || picked.length === 0) {
      vscode.window.showErrorMessage(
        "No SSH public key selected. Cannot configure SSH access.",
      );
      return undefined;
    }
    pubKeyPath = picked[0].fsPath;
  }
  return pubKeyPath;
}

// Install and prepare sshd inside the CLI-managed container. The devcontainer spec
// image is not guaranteed to ship an SSH server, so we bolt it on at runtime.
export async function ensureSshdInContainer(
  containerId: string,
): Promise<void> {
  getLog().appendLine("Ensuring sshd is available in the container...");
  const script = [
    "set -e",
    "if ! command -v sshd >/dev/null 2>&1 && [ ! -x /usr/sbin/sshd ]; then",
    "  if command -v apt-get >/dev/null 2>&1; then",
    "    export DEBIAN_FRONTEND=noninteractive;",
    "    apt-get update && apt-get install -y --no-install-recommends openssh-server;",
    "  elif command -v apk >/dev/null 2>&1; then",
    "    apk add --no-cache openssh;",
    "  elif command -v dnf >/dev/null 2>&1; then",
    "    dnf install -y openssh-server;",
    "  elif command -v yum >/dev/null 2>&1; then",
    "    yum install -y openssh-server;",
    "  elif command -v zypper >/dev/null 2>&1; then",
    "    zypper install -y openssh;",
    "  else",
    '    echo "No supported package manager to install openssh-server" >&2; exit 1;',
    "  fi;",
    "fi",
    "mkdir -p /run/sshd /var/run/sshd",
    "ssh-keygen -A",
  ].join("\n");
  await execInContainerAsRoot(containerId, script);
}

async function ensureAuthorizedKeyInContainer(
  containerId: string,
  user: string,
  pubKeyPath: string,
): Promise<void> {
  const home = await getUserHome(containerId, user);
  const keyData = fs.readFileSync(pubKeyPath, "utf8").trim() + "\n";
  const script = [
    "set -e",
    'KEY="$(cat)"',
    `mkdir -p ${home}/.ssh`,
    `chmod 700 ${home}/.ssh`,
    `touch ${home}/.ssh/authorized_keys`,
    `grep -qxF "$KEY" ${home}/.ssh/authorized_keys || printf '%s\\n' "$KEY" >> ${home}/.ssh/authorized_keys`,
    `chmod 600 ${home}/.ssh/authorized_keys`,
    `chown -R ${user} ${home}/.ssh`,
  ].join("\n");
  await execInContainerAsRoot(containerId, script, keyData);
}

async function verifySshLogin(hostAlias: string): Promise<boolean> {
  const res = await runCommandCapture(
    "ssh",
    ["-o", "BatchMode=yes", hostAlias, "true"],
    { quiet: true },
  );
  if (res.code === 0) {
    return true;
  }
  if (res.stderr.includes("Bad configuration option")) {
    vscode.window.showWarningMessage(
      "SSH config parsing failed due to an invalid option in ~/.ssh/config. Comment out or remove non-standard options, then retry.",
    );
  } else {
    vscode.window.showWarningMessage(
      "SSH login to the devcontainer failed. Ensure Docker is running and on your PATH, then retry.",
    );
  }
  return false;
}

export async function setupSshAccess(
  containerId: string,
  user: string,
): Promise<void> {
  const pubKeyPath = await resolvePublicKeyPath();
  if (pubKeyPath) {
    await ensureAuthorizedKeyInContainer(containerId, user, pubKeyPath);
  }
  await copyHostDevEnvironment(containerId, user);
}

export function openSshTerminal(
  title: string,
  hostAlias: string,
): vscode.Terminal {
  const sshTerminal = vscode.window.createTerminal({
    name: title,
    shellPath: "ssh",
    shellArgs: [hostAlias],
  });
  sshTerminal.show();
  return sshTerminal;
}

// Connect Open-Remote-SSH to the container through a docker-exec ProxyCommand. This
// tunnels the SSH transport over `docker exec` (sshd in inetd mode), so no ports need
// to be published and it works regardless of the container's network configuration.
function ensureSshConfigHostAlias(
  hostAlias: string,
  containerId: string,
  user: string,
) {
  const homeDir = getHomeDir();
  const sshDir = path.join(homeDir, ".ssh");
  const sshConfigPath = path.join(sshDir, "config");
  fs.mkdirSync(sshDir, { recursive: true });
  let configText = fs.existsSync(sshConfigPath)
    ? fs.readFileSync(sshConfigPath, "utf8")
    : "";
  const forwardAgent = vscode.workspace
    .getConfiguration(EXTENSION_ID)
    .get<boolean>("forwardSshAgent", true);
  const block = [
    `Host ${hostAlias}`,
    `  User ${user}`,
    `  StrictHostKeyChecking no`,
    `  UserKnownHostsFile /dev/null`,
    ...(forwardAgent ? ["  ForwardAgent yes"] : []),
    `  ProxyCommand docker exec -i -u 0 ${containerId} /usr/sbin/sshd -i -o PubkeyAuthentication=yes`,
    "",
  ].join("\n");

  const escapedAlias = hostAlias.replaceAll(
    /[.*+?^${}()|[\]\\]/gu,
    String.raw`\$&`,
  );
  // JavaScript regex has no \Z anchor, so match the Host line plus every following
  // line that does not start a new Host block (covering the last block up to EOF).
  const blockRegex = new RegExp(
    `^Host[ \\t]+${escapedAlias}[ \\t]*\\r?\\n(?:(?!^Host[ \\t]).*(?:\\r?\\n|$))*`,
    "mu",
  );
  if (blockRegex.test(configText)) {
    configText = configText.replace(blockRegex, block);
  } else {
    configText += (configText.endsWith("\n") ? "" : "\n") + block;
  }
  fs.writeFileSync(sshConfigPath, configText, { mode: 0o600 });
}

async function ensureSshRemoteExtensionAvailable() {
  const sshExtCandidates = [
    "ms-vscode-remote.remote-ssh",
    "jeanp413.open-remote-ssh",
  ];
  const hasSshRemote = sshExtCandidates.some((id) =>
    vscode.extensions.getExtension(id),
  );
  if (hasSshRemote) {
    return;
  }

  // ms-vscode-remote.remote-ssh only runs on official Microsoft builds. Every other
  // build (VSCodium/Codium, Positron, Cursor, ...) must use the open-source alternative,
  // otherwise the ssh-remote authority never resolves and vscode.openFolder silently fails.
  const isMicrosoftVsCode = (vscode.env.appName || "")
    .toLowerCase()
    .includes("visual studio code");
  const suggestedId = isMicrosoftVsCode
    ? "ms-vscode-remote.remote-ssh"
    : "jeanp413.open-remote-ssh";
  const choice = await vscode.window.showInformationMessage(
    `An SSH remote extension is required to open the folder over SSH. Install ${suggestedId}?`,
    "Install",
    "Cancel",
  );
  if (choice === "Install") {
    await vscode.commands.executeCommand(
      "workbench.extensions.installExtension",
      suggestedId,
    );
  } else {
    throw new Error("SSH remote extension not installed");
  }
}

// Feature/devcontainer extensions are installed directly onto this container's remote
// host via the editor CLI (code --remote ssh-remote+<alias> --install-extension ...).
// Scoping to the host alias avoids touching global settings or other SSH hosts. All
// ids are passed in a single invocation so only one SSH connection is established.
async function installRemoteExtensions(
  hostAlias: string,
  extensions: string[],
): Promise<void> {
  if (extensions.length === 0) {
    return;
  }
  const args = ["--remote", `ssh-remote+${hostAlias}`];
  for (const id of extensions) {
    args.push("--install-extension", id);
  }
  getLog().appendLine(
    `Installing ${extensions.length} devcontainer extension(s) on the remote via the editor CLI...`,
  );
  const res = await runEditorCliCapture(args);
  if (res.code !== 0) {
    vscode.window.showWarningMessage(
      `Some devcontainer extensions may not have installed (editor CLI exited with code ${res.code}). See the devcontainer configuration terminal for details.`,
    );
  }
}

export async function sshRuntime(
  wsFsPath: string,
  containerId: string,
  remoteUser: string | undefined,
  remoteWorkspaceFolder: string,
  customizations: DevcontainerCustomizations,
): Promise<void> {
  const effectiveUser = await getEffectiveUser(containerId, remoteUser);
  await ensureSshdInContainer(containerId);
  await setupSshAccess(containerId, effectiveUser);
  await applyRemoteMachineSettings(
    containerId,
    effectiveUser,
    customizations.settings,
  );
  const hostAlias = getHostAlias(wsFsPath);
  ensureSshConfigHostAlias(hostAlias, containerId, effectiveUser);
  const ok = await verifySshLogin(hostAlias);
  await ensureSshRemoteExtensionAvailable();
  if (!ok) {
    openSshTerminal("Devcontainer SSH (manual)", hostAlias);
    return;
  }
  await installRemoteExtensions(hostAlias, customizations.extensions);
  fs.writeFileSync(getHandoffMarkerPath(hostAlias), getBufferedLog());
  const folder =
    remoteWorkspaceFolder || `/workspaces/${path.basename(wsFsPath)}`;
  const remoteUri = vscode.Uri.parse(
    `vscode-remote://ssh-remote+${hostAlias}${folder}`,
  );
  await vscode.commands.executeCommand("vscode.openFolder", remoteUri, false);
}
