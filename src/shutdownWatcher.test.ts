import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasActiveLease,
  leaseDirectory,
  shutdownArguments,
  watchContainerShutdown,
  type ShutdownPlan,
} from "./shutdownWatcher.ts";

vi.mock(import("node:child_process"), () => ({
  spawn: vi.fn<typeof spawn>() as unknown as typeof spawn,
}));

describe("container shutdown watcher", () => {
  let directory: string;
  let plan: ShutdownPlan;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-test-"));
    plan = {
      directory,
      action: "stopContainer",
      containerId: "container-id",
      docker: { command: "docker", args: [] },
    };
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
      });
      queueMicrotask(() => {
        child.emit("close", 0);
      });
      return child as ReturnType<typeof spawn>;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("registers a lease before acknowledging readiness", () => {
    const connection = Object.assign(new EventEmitter(), {
      send: vi.fn<(message: string) => void>(),
    });
    watchContainerShutdown(plan, connection);
    expect(hasActiveLease(leaseDirectory(plan))).toBe(true);
    expect(connection.send).toHaveBeenCalledWith("ready");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("stops, but never removes, a container after disconnect and the grace period", async () => {
    const connection = new EventEmitter();
    watchContainerShutdown(plan, connection);
    connection.emit("disconnect");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      "docker",
      ["stop", "--time", "10", "container-id"],
      expect.anything(),
    );
  });

  it("keeps the container running when a reloaded window connects", async () => {
    const oldConnection = new EventEmitter();
    watchContainerShutdown(plan, oldConnection);
    oldConnection.emit("disconnect");
    watchContainerShutdown(plan, new EventEmitter());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("stops only after the last connected window closes", async () => {
    const first = new EventEmitter();
    const second = new EventEmitter();
    watchContainerShutdown(plan, first);
    watchContainerShutdown(plan, second);
    first.emit("disconnect");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawn).not.toHaveBeenCalled();
    second.emit("disconnect");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("does not stop containers for shutdownAction none", async () => {
    const connection = new EventEmitter();
    watchContainerShutdown({ ...plan, action: "none" }, connection);
    connection.emit("disconnect");
    await vi.runAllTimersAsync();
    expect(hasActiveLease(leaseDirectory(plan))).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("protects a Compose project when another service has a connected window", () => {
    const compose = {
      ...plan,
      project: "my-project",
      action: "stopCompose" as const,
    };
    expect(leaseDirectory(compose)).toBe(
      leaseDirectory({ ...compose, containerId: "other-service" }),
    );
    expect(leaseDirectory(compose)).not.toBe(
      leaseDirectory({ ...compose, project: "other-project" }),
    );
    expect(shutdownArguments(compose)).toStrictEqual([
      "ps",
      "-q",
      "--filter",
      "label=com.docker.compose.project=my-project",
    ]);
  });

  it("stops running Compose project containers without running compose down", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
      });
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("service-one\nservice-two\n"));
        child.emit("close", 0);
      });
      return child as ReturnType<typeof spawn>;
    });
    const connection = new EventEmitter();
    watchContainerShutdown(
      { ...plan, project: "project", action: "stopCompose" },
      connection,
    );
    connection.emit("disconnect");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawn).toHaveBeenLastCalledWith(
      "docker",
      ["stop", "--time", "10", "service-one", "service-two"],
      expect.anything(),
    );
  });

  it("preserves WSL Docker routing", async () => {
    const connection = new EventEmitter();
    watchContainerShutdown(
      {
        ...plan,
        docker: { command: "wsl.exe", args: ["-d", "Debian", "docker"] },
      },
      connection,
    );
    connection.emit("disconnect");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawn).toHaveBeenCalledWith(
      "wsl.exe",
      ["-d", "Debian", "docker", "stop", "--time", "10", "container-id"],
      expect.anything(),
    );
  });

  it("ignores stale leases from dead watchers", () => {
    fs.writeFileSync(path.join(directory, "stale"), "123456");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });
    expect(hasActiveLease(directory)).toBe(false);
    expect(fs.readdirSync(directory)).toStrictEqual([]);
  });

  it("fails safe if lease ownership cannot be checked", () => {
    fs.writeFileSync(path.join(directory, "unknown"), "invalid");
    expect(hasActiveLease(directory)).toBe(true);
  });
});
