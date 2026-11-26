// Standalone host-side process. IPC disconnects even when the extension host exits
// without calling deactivate. A grace period lets a reloaded window acquire a new
// lease before we stop anything. No Docker remove/down/prune commands are used.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ShutdownAction } from "./devContainerCli.ts";

export type ShutdownPlan = {
  directory: string;
  action: ShutdownAction;
  containerId: string;
  project?: string;
  docker: { command: string; args: string[] };
};

export function leaseDirectory(plan: ShutdownPlan): string {
  const key = createHash("sha256")
    .update(JSON.stringify([plan.docker, plan.project ?? plan.containerId]))
    .digest("hex");
  return path.join(plan.directory, key);
}

export function hasActiveLease(directory: string): boolean {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    try {
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        // Unknown files are not proof that it is safe to stop a container.
        return true;
      }
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        return true;
      }
      fs.unlinkSync(file);
    }
  }
  return false;
}

export function shutdownArguments(plan: ShutdownPlan): string[] {
  if (plan.action === "stopCompose") {
    // Query the live project rather than a captured list: services may have been
    // recreated while the window was open. Never affect another Compose project.
    return [
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${plan.project}`,
    ];
  }
  return ["stop", "--time", "10", plan.containerId];
}

function runDocker(plan: ShutdownPlan, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.docker.command, [...plan.docker.args, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Docker exited with code ${code}`));
      }
    });
  });
}

export function watchContainerShutdown(
  plan: ShutdownPlan,
  connection: {
    once: (event: "disconnect", listener: () => void) => unknown;
    send?: (message: string) => unknown;
  } = process,
  gracePeriod = 30_000,
): void {
  const directory = leaseDirectory(plan);
  fs.mkdirSync(directory, { recursive: true });
  const lease = path.join(directory, randomUUID());
  fs.writeFileSync(lease, String(process.pid), { mode: 0o600 });
  connection.once("disconnect", () => {
    fs.unlinkSync(lease);
    if (plan.action === "none") {
      return;
    }
    setTimeout(() => {
      void (async () => {
        if (hasActiveLease(directory)) {
          return;
        }
        const output = await runDocker(plan, shutdownArguments(plan));
        if (plan.action === "stopCompose") {
          const ids = output.trim().split(/\s+/u).filter(Boolean);
          if (ids.length > 0 && !hasActiveLease(directory)) {
            await runDocker(plan, ["stop", "--time", "10", ...ids]);
          }
        }
      })().catch(() => {
        /* Docker may already have shut down with the host. */
      });
    }, gracePeriod);
  });
  connection.send?.("ready");
}
