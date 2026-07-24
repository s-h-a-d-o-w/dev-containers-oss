// oxlint-disable no-template-curly-in-string
import {
  commands,
  type Disposable,
  env,
  EventEmitter,
  type ExtensionContext,
  type ManagedMessagePassing,
  ManagedResolvedAuthority,
  type RemoteAuthorityResolver,
  RemoteAuthorityResolverError,
  Uri,
  window,
  workspace,
} from "vscode";
import fs from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DevcontainerUpResult, ProductInfo } from "../types/types.ts";
import {
  devcontainerUp,
  readMergedCustomizations,
} from "../devContainerCli.ts";
import {
  getBufferedLog,
  getLog,
  logBuildInfo,
  resetLog,
  setBufferedLog,
  withLogTerminal,
} from "../log.ts";
import { EXTENSION_ID } from "../constants.ts";
import {
  applyRemoteMachineSettings,
  copyHostDevEnvironment,
  dockerExecCapture,
  dockerExecShellCapture,
  getEffectiveUser,
  getUserHome,
  spawnDockerExec,
} from "../dockerOps.ts";
import { getServerDataFolderName, readProductJson } from "../hostInfo.ts";

// Authority scheme handled by our remote resolver. The full authority is
// `<AUTHORITY_PREFIX>+<hex(localFolder)>`, so the container a window belongs to can be
// recovered purely from the authority string (no external state needed).
export const AUTHORITY_PREFIX = EXTENSION_ID;

function encodeAuthority(localFolder: string): string {
  return `${AUTHORITY_PREFIX}+${Buffer.from(localFolder, "utf8").toString("hex")}`;
}

// `authority` here is the part after the scheme, e.g. `dev-containers-oss+<hex>`.
export function decodeLocalFolder(authority: string): string {
  const plus = authority.indexOf("+");
  const hex = plus !== -1 ? authority.slice(plus + 1) : authority;
  return Buffer.from(hex, "hex").toString("utf8");
}

// Local (host-side) marker carrying the build log that the launching window printed before
// it reopened the folder in the container. nativeRuntime and the remote resolver run in
// different windows (separate extension-host processes), so the in-memory log buffer cannot
// cross that boundary; persisting it to a temp file lets the resolver replay it in the
// reopened window's setup terminal. Keyed by the workspace folder so it only fires for the
// window we just launched.
function getHandoffMarkerPath(localFolder: string): string {
  const key = Buffer.from(localFolder, "utf8").toString("hex");
  return path.join(tmpdir(), `${EXTENSION_ID}-native-handoff-${key}.pending`);
}

// Read and delete the handoff marker for this folder, returning its contents when present.
// Consuming it keeps the replay to the first resolve after a reopen, so later reconnects
// (which run no fresh build) start with an empty buffer.
function consumeHandoffLog(localFolder: string): string | undefined {
  const markerPath = getHandoffMarkerPath(localFolder);
  if (!fs.existsSync(markerPath)) {
    return undefined;
  }
  try {
    const text = fs.readFileSync(markerPath, "utf8");
    fs.unlinkSync(markerPath);
    return text;
  } catch {
    return undefined;
  }
}

// The REH (remote extension host / server) build we install into the container must match
// the running client exactly, so its identity is read from the client's own product.json.
function readProductInfo(): ProductInfo {
  const { appRoot } = env;
  const product: Partial<ProductInfo> = readProductJson();
  let appPackage: { version?: string } = {};
  try {
    appPackage = JSON.parse(
      fs.readFileSync(path.join(appRoot, "package.json"), "utf8"),
    ) as { version?: string };
  } catch {
    // version may still live on product.json
  }
  return {
    commit: product.commit ?? "",
    quality: product.quality ?? "stable",
    version: product.version ?? appPackage.version ?? "",
    release: product.release ?? "",
    applicationName: product.applicationName ?? "codium",
    serverApplicationName: product.serverApplicationName ?? "codium-server",
    serverDataFolderName: getServerDataFolderName(),
    serverDownloadUrlTemplate: product.serverDownloadUrlTemplate,
  };
}

function mapArch(uname: string): string {
  switch (uname.trim()) {
    case "x86_64": {
      return "x64";
    }
    case "aarch64":
    case "arm64": {
      return "arm64";
    }
    case "armv7l": {
      return "armhf";
    }
    default: {
      return uname.trim();
    }
  }
}

function buildServerDownloadUrl(
  product: ProductInfo,
  os: string,
  arch: string,
): string {
  if (!product.serverDownloadUrlTemplate) {
    throw new Error(
      "This editor build does not expose serverDownloadUrlTemplate in product.json, so the container server cannot be downloaded automatically. Use the SSH-based command instead.",
    );
  }
  return product.serverDownloadUrlTemplate
    .replaceAll("${quality}", product.quality)
    .replaceAll("${commit}", product.commit)
    .replaceAll("${version}", product.version)
    .replaceAll("${release}", product.release)
    .replaceAll("${os}", os)
    .replaceAll("${arch}", arch);
}

async function detectContainerArch(containerId: string): Promise<string> {
  const res = await dockerExecCapture(containerId, undefined, ["uname", "-m"], {
    quiet: true,
  });
  return mapArch(res.stdout || "x86_64");
}

// Download and extract the matching server into the container user's home, unless it is
// already present for this commit. Runs as the container user so the files are owned
// correctly and the server can write its data next to them.
async function ensureServerInstalled(
  containerId: string,
  user: string,
  home: string,
  product: ProductInfo,
): Promise<string> {
  const binDir = `${home}/${product.serverDataFolderName}/bin/${product.commit}`;
  const serverBin = `${binDir}/bin/${product.serverApplicationName}`;
  const arch = await detectContainerArch(containerId);
  const url = buildServerDownloadUrl(product, "linux", arch);
  getLog().appendLine(
    `Ensuring server ${product.commit} (${arch}) is installed in the container...`,
  );
  const script = [
    "set -e",
    `BIN="${binDir}"`,
    `if [ -x "${serverBin}" ]; then exit 0; fi`,
    `mkdir -p "$BIN"`,
    'TMP="$(mktemp)"',
    "if command -v curl >/dev/null 2>&1; then",
    `  curl -fsSL "${url}" -o "$TMP";`,
    "elif command -v wget >/dev/null 2>&1; then",
    `  wget -qO "$TMP" "${url}";`,
    "else",
    '  echo "Neither curl nor wget is available in the container to download the server." >&2; exit 1;',
    "fi",
    'tar -xzf "$TMP" -C "$BIN" --strip-components=1',
    'rm -f "$TMP"',
    `test -x "${serverBin}"`,
  ].join("\n");
  const res = await dockerExecShellCapture(containerId, { user }, script);
  if (res.code !== 0) {
    throw new Error(
      `Failed to install server in container: ${res.stderr.trim() || `exit code ${res.code}`}`,
    );
  }
  return binDir;
}

// Start the server (idempotently) listening on a loopback port inside the container and
// return that port. A pidfile keeps repeated resolves (e.g. window reloads) from spawning
// duplicate servers, and the port is scraped from the server's own startup log.
async function ensureServerRunning(
  containerId: string,
  user: string,
  home: string,
  binDir: string,
  product: ProductInfo,
  agentSock?: string,
): Promise<number> {
  const serverBin = `${binDir}/bin/${product.serverApplicationName}`;
  const stateDir = `${home}/${product.serverDataFolderName}`;
  const log = `${stateDir}/.codium-reh.log`;
  const pidFile = `${stateDir}/.codium-reh.pid`;
  const script = [
    "set -e",
    `LOG="${log}"`,
    `PIDF="${pidFile}"`,
    ...(agentSock ? [`export SSH_AUTH_SOCK="${agentSock}"`] : []),
    'if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null; then',
    "  :",
    "else",
    '  rm -f "$LOG"',
    `  nohup "${serverBin}" --start-server --host 127.0.0.1 --port 0 --without-connection-token --telemetry-level off --accept-server-license-terms >"$LOG" 2>&1 &`,
    '  echo $! > "$PIDF"',
    "fi",
    "P=",
    "for i in $(seq 1 150); do",
    `  P=$(sed -n 's/.*listening on \\([0-9][0-9]*\\).*/\\1/p; s/.*bound to [0-9.]*:\\([0-9][0-9]*\\).*/\\1/p' "$LOG" 2>/dev/null | head -n1)`,
    '  if [ -n "$P" ]; then break; fi',
    "  sleep 0.2",
    "done",
    'if [ -z "$P" ]; then echo "server did not report a listening port" >&2; tail -n 60 "$LOG" >&2; exit 1; fi',
    'echo "PORT=$P"',
  ].join("\n");
  const res = await dockerExecShellCapture(containerId, { user }, script);
  const match = /PORT=(?<port>\d+)/u.exec(res.stdout);
  if (res.code !== 0 || !match) {
    throw new Error(
      `Failed to start server in container: ${res.stderr.trim() || `exit code ${res.code}`}`,
    );
  }
  return Number(match.groups?.["port"]);
}

async function installExtensionsInContainer(
  containerId: string,
  user: string,
  binDir: string,
  product: ProductInfo,
  extensions: string[],
): Promise<void> {
  if (extensions.length === 0) {
    return;
  }
  const serverBin = `${binDir}/bin/${product.serverApplicationName}`;
  const params: string[] = [];
  for (const id of extensions) {
    params.push("--install-extension", id);
  }
  getLog().appendLine(
    `Installing ${extensions.length} devcontainer extension(s) into the container server...`,
  );
  const res = await dockerExecShellCapture(
    containerId,
    { params, user },
    `"${serverBin}" "$@"`,
  );
  if (res.code !== 0) {
    getLog().appendLine(
      `Extension install failed (exit code ${res.code}): ${res.stderr.trim() || res.stdout.trim() || "no output"}`,
    );
    window.showWarningMessage(
      `Some devcontainer extensions may not have installed (server CLI exited with code ${res.code}). See the terminal for details.`,
    );
  }
}

// A single connection to the in-container server, tunneled through `docker exec`. VS Code's
// managed transport only needs an ordered, reliable byte stream, which the exec'd relay's
// stdio provides; the relay is run with the server's own bundled node so a node binary is
// guaranteed to exist.
function makeManagedConnection(
  containerId: string,
  user: string,
  home: string,
  product: ProductInfo,
  port: number,
): () => Thenable<ManagedMessagePassing> {
  const nodeBin = `${home}/${product.serverDataFolderName}/bin/${product.commit}/node`;
  const relay = `const net=require('net');const s=net.connect(${port},'127.0.0.1');s.on('connect',()=>{process.stdin.pipe(s);s.pipe(process.stdout);});s.on('error',(e)=>{process.stderr.write(String(e&&e.message||e));process.exit(1);});s.on('close',()=>process.exit(0));`;
  return () =>
    new Promise<ManagedMessagePassing>((resolve, reject) => {
      const child = spawnDockerExec(containerId, user, [nodeBin, "-e", relay]);
      const onReceive = new EventEmitter<Uint8Array>();
      const onClose = new EventEmitter<Error | undefined>();
      const onEnd = new EventEmitter<void>();
      let settled = false;

      child.stdout.on("data", (d: Buffer) => onReceive.fire(new Uint8Array(d)));
      child.stdout.on("end", () => onEnd.fire());
      child.stderr.on("data", (d: Buffer) => getLog().append(d.toString()));
      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        onClose.fire(err);
      });
      child.on("close", () => onClose.fire(undefined));

      const passing: ManagedMessagePassing = {
        onDidReceiveMessage: onReceive.event,
        onDidClose: onClose.event,
        onDidEnd: onEnd.event,
        send: (data) => {
          child.stdin.write(Buffer.from(data));
        },
        end: () => {
          try {
            child.stdin.end();
          } catch {
            // stream may already be closed
          }
          child.kill();
        },
      };

      child.on("spawn", () => {
        if (!settled) {
          settled = true;
          resolve(passing);
        }
      });
    });
}

// docker exec gives us no equivalent of SSH's ForwardAgent, so we build our own agent
// forwarder: a small relay runs inside the container (via the server's own node), listens
// on a unix socket, and multiplexes every connection to it over the exec's stdio back to
// this process, which in turn dials the host's $SSH_AUTH_SOCK. The container socket path
// is exported to the server as SSH_AUTH_SOCK so git/ssh inside the container just work.
//
// Frames are [type:u8][channel:u32be][len:u32be][payload]. The container opens channels
// (type 0) as apps connect; both sides exchange data (type 1) and close (type 2).
const agentBridges = new Map<string, boolean>();

function startSshAgentBridge(
  containerId: string,
  user: string,
  home: string,
  product: ProductInfo,
): string | undefined {
  const authSock = process.env["SSH_AUTH_SOCK"];
  if (!authSock) {
    return undefined;
  }
  const agentSock = `${home}/.${EXTENSION_ID}-ssh-agent.sock`;
  if (agentBridges.get(containerId)) {
    return agentSock;
  }

  const nodeBin = `${home}/${product.serverDataFolderName}/bin/${product.commit}/node`;
  const containerScript = fs.readFileSync(
    path.join(__dirname, "agentBridgeContainer.js"),
    "utf8",
  );

  const child = spawnDockerExec(containerId, user, [
    nodeBin,
    "-e",
    containerScript,
    agentSock,
  ]);
  agentBridges.set(containerId, true);

  const channels = new Map<number, net.Socket>();
  let buf = Buffer.alloc(0);
  const send = (type: number, id: number, payload?: Buffer) => {
    const header = Buffer.alloc(9);
    header.writeUInt8(type, 0);
    header.writeUInt32BE(id, 1);
    header.writeUInt32BE(payload ? payload.length : 0, 5);
    child.stdin.write(payload ? Buffer.concat([header, payload]) : header);
  };

  child.stdout.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 9) {
        break;
      }
      const type = buf.readUInt8(0);
      const id = buf.readUInt32BE(1);
      const len = buf.readUInt32BE(5);
      if (buf.length < 9 + len) {
        break;
      }
      const payload = buf.subarray(9, 9 + len);
      buf = buf.subarray(9 + len);
      if (type === 0) {
        const host = net.connect(authSock);
        channels.set(id, host);
        host.on("data", (x: Buffer) => send(1, id, x));
        host.on("close", () => {
          if (channels.delete(id)) {
            send(2, id);
          }
        });
        host.on("error", () => {
          if (channels.delete(id)) {
            send(2, id);
          }
        });
      } else if (type === 1) {
        channels.get(id)?.write(payload);
      } else if (type === 2) {
        const host = channels.get(id);
        if (host) {
          channels.delete(id);
          host.end();
        }
      }
    }
  });
  child.stderr.on("data", (d: Buffer) => getLog().append(d.toString()));
  const cleanup = () => {
    agentBridges.delete(containerId);
    for (const s of channels.values()) {
      s.destroy();
    }
    channels.clear();
  };
  child.on("error", (err) => {
    getLog().appendLine(
      `SSH agent forwarding bridge failed to start: ${err.message}`,
    );
    cleanup();
  });
  child.on("close", cleanup);
  getLog().appendLine(
    `Forwarding host SSH agent into the container at ${agentSock}.`,
  );
  return agentSock;
}

// One-time provisioning marker, kept in the user's home so it lives and dies with the
// container: a rebuild recreates the container without it, forcing a fresh provision.
const PROVISIONED_MARKER = `.${EXTENSION_ID}-provisioned`;

async function isContainerProvisioned(
  containerId: string,
  user: string,
  home: string,
): Promise<boolean> {
  const res = await dockerExecShellCapture(
    containerId,
    { quiet: true, user },
    `test -f "${home}/${PROVISIONED_MARKER}"`,
  );
  return res.code === 0;
}

async function markContainerProvisioned(
  containerId: string,
  user: string,
  home: string,
): Promise<void> {
  await dockerExecShellCapture(
    containerId,
    { quiet: true, user },
    `touch "${home}/${PROVISIONED_MARKER}"`,
  );
}

async function prepareContainerConnection(
  context: ExtensionContext,
  localFolder: string,
  up: DevcontainerUpResult,
): Promise<ManagedResolvedAuthority> {
  const product = readProductInfo();
  if (!product.commit) {
    throw new Error(
      "This editor build does not expose a commit in product.json, which is required to match the container server.",
    );
  }
  const user = await getEffectiveUser(up.containerId, up.remoteUser);
  const home = await getUserHome(up.containerId, user);

  // Server install, extensions, machine settings and host dev config are one-time
  // provisioning: they persist in the shared server data folder across reconnects and client
  // upgrades, so re-applying them on every resolve is wasted work. A marker in the container
  // gates them to first connect; a rebuild removes the container (and marker), so this
  // re-runs then, matching the official Dev Containers "rebuild after config changes"
  // behaviour.
  const provisioned = await isContainerProvisioned(up.containerId, user, home);
  const setup = async () => {
    const binDir = await ensureServerInstalled(
      up.containerId,
      user,
      home,
      product,
    );
    if (!provisioned) {
      const customizations = await readMergedCustomizations(
        context,
        localFolder,
      );
      await installExtensionsInContainer(
        up.containerId,
        user,
        binDir,
        product,
        customizations.extensions,
      );
      await applyRemoteMachineSettings(
        up.containerId,
        user,
        customizations.settings,
      );
      await copyHostDevEnvironment(up.containerId, user);
      await markContainerProvisioned(up.containerId, user, home);
    }
    return binDir;
  };

  // Only first-connect provisioning has anything worth watching, so that is the sole case
  // that gets a setup terminal (mirroring the Dev Containers extension). A reconnect to an
  // already-provisioned container just installs the server if missing and connects silently.
  const binDir = provisioned
    ? await setup()
    : await withLogTerminal("Devcontainer Configuration", setup);

  const forwardAgent = workspace
    .getConfiguration(EXTENSION_ID)
    .get<boolean>("forwardSshAgent", true);
  const agentSock = forwardAgent
    ? startSshAgentBridge(up.containerId, user, home, product)
    : undefined;

  const port = await ensureServerRunning(
    up.containerId,
    user,
    home,
    binDir,
    product,
    agentSock,
  );
  getLog().appendLine(
    `Container server is listening on 127.0.0.1:${port}; establishing managed connection.`,
  );
  return new ManagedResolvedAuthority(
    makeManagedConnection(up.containerId, user, home, product, port),
  );
}

export function registerRemoteResolver(
  context: ExtensionContext,
): Disposable[] {
  const resolver: RemoteAuthorityResolver = {
    async resolve(authority) {
      const localFolder = decodeLocalFolder(authority);

      const handoffLog = consumeHandoffLog(localFolder);
      if (handoffLog === undefined) {
        resetLog();
        logBuildInfo();
      } else {
        setBufferedLog(handoffLog);
      }

      try {
        const up = await devcontainerUp(context, localFolder);
        // Setup output is streamed into a read-only terminal inside here, but only on first
        // connect: reconnecting to an already-provisioned container connects silently.
        return await prepareContainerConnection(context, localFolder, up);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        getLog().appendLine(`Error: ${message}`);
        throw RemoteAuthorityResolverError.NotAvailable(message, true);
      }
    },
  };

  return [
    workspace.registerRemoteAuthorityResolver(AUTHORITY_PREFIX, resolver),
    workspace.registerResourceLabelFormatter({
      scheme: "vscode-remote",
      authority: `${AUTHORITY_PREFIX}+*`,
      formatting: {
        label: "${path}",
        separator: "/",
        tildify: true,
        workspaceSuffix: "Dev Container",
        stripPathStartingSeparator: false,
      },
    }),
  ] satisfies Disposable[];
}

// Bring the container up, then open a window bound to our managed authority. The resolver reuses the same (now running) container when that window connects.
export async function nativeRuntime(
  context: ExtensionContext,
  localFolder: string,
  forceRebuild: boolean,
): Promise<void> {
  resetLog();
  logBuildInfo();

  const up = await withLogTerminal("Devcontainer Configuration", () =>
    devcontainerUp(context, localFolder, { rebuild: forceRebuild }),
  );
  // Hand the build log off to the window we are about to open.
  fs.writeFileSync(getHandoffMarkerPath(localFolder), getBufferedLog());

  const authority = encodeAuthority(localFolder);
  const folder =
    up.remoteWorkspaceFolder || `/workspaces/${path.basename(localFolder)}`;
  const remoteUri = Uri.parse(`vscode-remote://${authority}${folder}`);
  await commands.executeCommand("vscode.openFolder", remoteUri, false);
}
