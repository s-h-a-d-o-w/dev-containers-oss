import vscode from "vscode";
import path from "node:path";
import { spawn } from "node:child_process";
import { EXTENSION_ID } from "./constants.ts";
import { getLog, logCommand, shouldStream } from "./log.ts";

export function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

export function getHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

export function getDevcontainerPath(wsFsPath: string): string {
  return path.join(wsFsPath, ".devcontainer", "devcontainer.json");
}

function makeWorkspaceSlug(wsFsPath: string): string {
  const name = path.basename(wsFsPath).toLowerCase();
  let slug = name.replaceAll(/[^a-z0-9._-]+/gu, "-");
  slug = slug.replaceAll(/^[._-]+|[._-]+$/gu, "");
  return slug || "workspace";
}

export function getHostAlias(wsFsPath: string): string {
  const slug = makeWorkspaceSlug(wsFsPath);
  return `${EXTENSION_ID}-${slug}`;
}

export function runCommand(
  command: string,
  args: string[],
  {
    quiet,
    cwd,
    env,
    input,
  }: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; quiet?: boolean },
): Promise<void> {
  const out = getLog();
  const stream = shouldStream(quiet);
  if (stream) {
    logCommand(command, args);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.stdout.on("data", (d: Buffer) => {
      if (stream) {
        out.append(d.toString());
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stream) {
        out.append(d.toString());
      }
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

export function runCommandCapture(
  command: string,
  args: string[],
  {
    quiet,
    cwd,
    env,
  }: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const out = getLog();
  const stream = shouldStream(quiet);
  if (stream) {
    logCommand(command, args);
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (stream) {
        out.append(s);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      if (stream) {
        out.append(s);
      }
    });
    child.on("error", () => resolve({ stdout: "", stderr: "error", code: 1 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}
