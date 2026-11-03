import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDockerCommand,
  getWslHostPath,
  parseWslInfo,
  setWslDistroFromPath,
} from "./wsl.ts";

vi.mock(import("vscode"), () => ({}));

describe("wsl path routing", () => {
  afterEach(() => {
    setWslDistroFromPath("/home/user/project");
  });

  it("remote-WSL workspace paths round-trip through the Windows host", () => {
    const hostPath = getWslHostPath(
      "wsl+Ubuntu-24.04",
      "/home/user/my project",
    );
    expect(hostPath).toBe(
      String.raw`\\wsl.localhost\Ubuntu-24.04\home\user\my project`,
    );
    expect(parseWslInfo(hostPath!)).toStrictEqual({
      distro: "Ubuntu-24.04",
      linuxPath: "/home/user/my project",
    });
  });

  it("only WSL authorities resolve to WSL host paths", () => {
    expect(
      getWslHostPath("ssh-remote+server", "/home/user/project"),
    ).toBeUndefined();
    expect(getWslHostPath("wsl+", "/home/user/project")).toBeUndefined();
  });

  it("docker uses the distro from the Remote-WSL workspace", () => {
    const hostPath = getWslHostPath("wsl+Debian", "/home/user/project");
    setWslDistroFromPath(hostPath!);
    expect(buildDockerCommand(["ps"])).toStrictEqual({
      command: "wsl.exe",
      args: ["-d", "Debian", "docker", "ps"],
    });
    setWslDistroFromPath("/home/user/project");
    expect(buildDockerCommand(["ps"])).toStrictEqual({
      command: "docker",
      args: ["ps"],
    });
  });
});
