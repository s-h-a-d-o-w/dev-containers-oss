import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDockerCommand,
  getWslHostPath,
  parseWslInfo,
  setWslDistroFromPath,
} from "../src/wsl.ts";

void test("Remote-WSL workspace paths round-trip through the Windows host", () => {
  const hostPath = getWslHostPath("wsl+Ubuntu-24.04", "/home/user/my project");
  assert.equal(
    hostPath,
    String.raw`\\wsl.localhost\Ubuntu-24.04\home\user\my project`,
  );
  assert.deepEqual(parseWslInfo(hostPath), {
    distro: "Ubuntu-24.04",
    linuxPath: "/home/user/my project",
  });
});

void test("only WSL authorities resolve to WSL host paths", () => {
  assert.equal(
    getWslHostPath("ssh-remote+server", "/home/user/project"),
    undefined,
  );
  assert.equal(getWslHostPath("wsl+", "/home/user/project"), undefined);
});

void test("Docker uses the distro from the Remote-WSL workspace", () => {
  const hostPath = getWslHostPath("wsl+Debian", "/home/user/project");
  setWslDistroFromPath(hostPath!);
  assert.deepEqual(buildDockerCommand(["ps"]), {
    command: "wsl.exe",
    args: ["-d", "Debian", "docker", "ps"],
  });
  setWslDistroFromPath("/home/user/project");
  assert.deepEqual(buildDockerCommand(["ps"]), {
    command: "docker",
    args: ["ps"],
  });
});
