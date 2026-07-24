import { spawn } from "node:child_process";
import { getLog, logCommand, shouldStream } from "./log.ts";

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
    input,
  }: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; quiet?: boolean },
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
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
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
