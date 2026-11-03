import path from "node:path";
import type { ExtensionContext, Uri } from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandCapture } from "./runCommands.ts";
import { devcontainerUp } from "./devContainerCli.ts";

// Only the VS Code API surface used by these tests is available outside the editor.
// oxlint-disable-next-line vitest/prefer-import-in-mock
vi.mock("vscode", () => ({
  env: {},
  window: {},
  Uri: {
    joinPath: (uri: Uri, ...parts: string[]) => ({
      fsPath: path.join(uri.fsPath, ...parts),
    }),
  },
}));
vi.mock(import("./log.ts"), () => ({
  getLog: vi.fn<typeof import("./log.ts").getLog>(),
}));
vi.mock(import("./runCommands.ts"), () => ({
  runCommandCapture: vi.fn<typeof runCommandCapture>(),
}));

const context = {
  extensionUri: { fsPath: path.resolve(import.meta.dirname, "..") },
} as ExtensionContext;
const workspacePath = String.raw`\\wsl.localhost\Debian\home\user\project`;

describe("wsl CLI dependencies", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    ["docker\n", "Docker isn't available in your WSL installation."],
    ["curl\n", "curl isn't available in your WSL installation."],
    [
      "docker\ncurl\n",
      "Docker and curl aren't available in your WSL installation.",
    ],
  ])(
    "stops before installing or running the CLI when missing: %s",
    async (stdout, message) => {
      vi.mocked(runCommandCapture).mockResolvedValue({
        code: 0,
        stdout,
        stderr: "",
      });
      await expect(devcontainerUp(context, workspacePath)).rejects.toThrow(
        message,
      );
      // prefer-called-times requires this form, conflicting with prefer-called-once.
      // oxlint-disable-next-line vitest/prefer-called-once
      expect(runCommandCapture).toHaveBeenCalledTimes(1);
    },
  );

  it("checks the workspace's distro before running the CLI", async () => {
    vi.mocked(runCommandCapture)
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          outcome: "success",
          containerId: "container",
        }),
        stderr: "",
      });
    await expect(devcontainerUp(context, workspacePath)).resolves.toMatchObject(
      { containerId: "container" },
    );
    expect(runCommandCapture).toHaveBeenCalledTimes(2);
    const [command, args, options] =
      vi.mocked(runCommandCapture).mock.calls[0]!;
    expect(command).toBe("wsl.exe");
    expect(args).toStrictEqual(["-d", "Debian", "sh", "-s"]);
    expect(options.input).toContain("for tool in docker curl; do");
    expect(vi.mocked(runCommandCapture).mock.calls[1]?.[1]).toStrictEqual([
      "-d",
      "Debian",
      "sh",
      "-s",
      "--",
      "up",
      "--workspace-folder",
      "/home/user/project",
    ]);
  });

  it("reports a failed WSL invocation", async () => {
    vi.mocked(runCommandCapture).mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "error",
    });
    await expect(devcontainerUp(context, workspacePath)).rejects.toThrow(
      "Could not check Docker and curl availability in your WSL installation.",
    );
  });
});
