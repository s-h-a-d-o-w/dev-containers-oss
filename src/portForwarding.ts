import {
  EventEmitter,
  type Tunnel,
  type TunnelOptions,
  workspace,
} from "vscode";
import net from "node:net";
import { spawnDockerExec } from "./dockerOps.ts";
import { getLog } from "./log.ts";

export type TunnelTarget = {
  containerId: string;
  // Absolute path to the node binary the container server ships, used to run the relay.
  nodeBin: string;
  // Absolute path of the server install directory inside the container, used to recognise
  // ports that belong to the server itself.
  serverDataFolder: string;
  user: string;
};

let target: TunnelTarget | undefined;

export function setTunnelTarget(next: TunnelTarget) {
  target = next;
}

// Candidate hosts come from the container's /proc scan (localhost, 127.0.0.1, ::1, …).
// The relay is embedded as a JS string literal, so anything outside this set is rejected
// rather than interpolated.
function sanitizeRemoteHost(host: string | undefined): string {
  return host !== undefined && /^[a-zA-Z0-9.:_-]+$/u.test(host)
    ? host
    : "127.0.0.1";
}

// Mirrors VS Code's own tunnel host handling: bind loopback unless the user opted into
// exposing forwarded ports on all interfaces.
function getLocalHost(): string {
  const setting = workspace
    .getConfiguration("remote")
    .get<string>("localPortHost");
  return !setting || setting === "localhost" ? "127.0.0.1" : "0.0.0.0";
}

function listen(
  server: net.Server,
  host: string,
  port: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const settle = (error?: Error) => {
      server.removeAllListeners("error");
      server.removeAllListeners("listening");
      if (error) {
        reject(error);
        return;
      }
      const address = server.address();
      resolve(
        typeof address === "object" && address !== null ? address.port : port,
      );
    };

    server.once("error", settle);
    server.once("listening", () => settle());
    server.listen(port, host);
  });
}

// One `docker exec` relay per accepted connection: the exec'd node dials the port inside
// the container and its stdio becomes the byte stream for that connection. This is the same
// transport the managed authority connection uses, so forwarding works without publishing
// any container ports and regardless of where the Docker daemon runs.
function pipeConnection(
  socket: net.Socket,
  { containerId, nodeBin, user }: TunnelTarget,
  remoteHost: string,
  remotePort: number,
): void {
  const relay = `const net=require('net');const s=net.connect(${remotePort},'${remoteHost}');s.on('connect',()=>{process.stdin.pipe(s);s.pipe(process.stdout);});s.on('error',(e)=>{process.stderr.write(String(e&&e.message||e));process.exit(1);});s.on('close',()=>process.exit(0));`;
  const child = spawnDockerExec(containerId, user, [nodeBin, "-e", relay]);

  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  child.stderr.on("data", (d: Buffer) => getLog().append(d.toString()));

  // Either end going away tears down the other; the error handlers keep a broken pipe from
  // surfacing as an unhandled 'error' event in the extension host.
  const teardown = () => {
    socket.destroy();
    child.kill();
  };
  socket.on("error", teardown);
  socket.on("close", teardown);
  child.stdin.on("error", teardown);
  child.on("error", teardown);
  child.on("close", () => socket.destroy());
}

// The container's port scan reports every listening socket, including the ones opened by the
// server itself and by whatever runs inside it (the extension host's inspect port, language
// servers such as ESLint's, debug adapters). So we drop any candidate whose process command
// line comes out of the server install directory.
export function showCandidatePort(
  _host: string,
  _port: number,
  detail: string,
): Promise<boolean> {
  const serverDataFolder = target?.serverDataFolder;

  return Promise.resolve(
    serverDataFolder === undefined || !detail.includes(serverDataFolder),
  );
}

// Implementing this lets the core enable its forwarded ports features (the Ports view and
// automatic forwarding of detected ports). Without it, a managed authority only gets the
// core's fallback tunnel factory, which leaves those features switched off.
export function createTunnel(
  options: TunnelOptions,
): Promise<Tunnel> | undefined {
  const currentTarget = target;
  if (!currentTarget) {
    return undefined;
  }

  const remoteHost = sanitizeRemoteHost(options.remoteAddress.host);
  const remotePort = options.remoteAddress.port;
  const localHost = getLocalHost();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    pipeConnection(socket, currentTarget, remoteHost, remotePort);
  });

  return (async () => {
    let localPort: number;
    try {
      localPort = await listen(
        server,
        localHost,
        options.localAddressPort ?? remotePort,
      );
    } catch {
      // Requested port taken or privileged - the core expects us to pick another one.
      localPort = await listen(server, localHost, 0);
    }
    server.on("error", (error) => {
      getLog().appendLine(
        `Port forwarding for ${remoteHost}:${remotePort} failed: ${error.message}`,
      );
    });

    getLog().appendLine(
      `Forwarding ${remoteHost}:${remotePort} from the container to ${localHost}:${localPort}.`,
    );

    const onDidDispose = new EventEmitter<void>();
    let disposed = false;

    return {
      localAddress: { host: localHost, port: localPort },
      onDidDispose: onDidDispose.event,
      remoteAddress: { host: remoteHost, port: remotePort },
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        server.close();
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
        getLog().appendLine(
          `Stopped forwarding ${remoteHost}:${remotePort} from the container.`,
        );
        onDidDispose.fire();
        onDidDispose.dispose();
      },
    } satisfies Tunnel;
  })();
}
