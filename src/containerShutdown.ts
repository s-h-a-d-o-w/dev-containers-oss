import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { ExtensionContext } from "vscode";
import { readShutdownAction } from "./devContainerCli.ts";
import { dockerInspectLabel } from "./dockerOps.ts";
import { getLog } from "./log.ts";
import { buildDockerCommand, setWslDistroFromPath } from "./wsl.ts";

// Only a connected window owns a lease. The launcher must not register one: opening
// the remote folder shuts down its extension host as part of the handoff.
let watcher: ChildProcess | undefined;
let watchedContainer: string | undefined;

export async function trackContainerShutdown(
  context: ExtensionContext,
  localFolder: string,
  containerId: string,
): Promise<void> {
  if (watchedContainer === containerId && watcher?.connected) {
    return;
  }
  try {
    setWslDistroFromPath(localFolder);
    const action = await readShutdownAction(context, localFolder, containerId);
    const project = await dockerInspectLabel(
      containerId,
      "com.docker.compose.project",
    );
    if (action === "stopCompose" && !project) {
      throw new Error("Container has no Docker Compose project label");
    }
    const docker = buildDockerCommand([]);
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "shutdownWatcher.js")],
      {
        detached: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Shutdown watcher did not start"));
      }, 5_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Shutdown watcher exited before becoming ready"));
      });
      child.once("message", () => {
        clearTimeout(timer);
        resolve();
      });
      child.send({
        directory: path.join(
          context.globalStorageUri.fsPath,
          "shutdown-leases",
        ),
        action,
        containerId,
        project,
        docker,
      });
    });
    if (watcher?.connected) {
      watcher.disconnect();
    }
    watcher = child;
    watchedContainer = containerId;
    child.unref();
    child.channel?.unref();
  } catch (error: unknown) {
    getLog().appendLine(
      `Automatic container shutdown unavailable: ${String(error)}`,
    );
  }
}
