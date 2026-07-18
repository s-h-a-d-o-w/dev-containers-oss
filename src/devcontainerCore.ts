import * as vscode from "vscode";
import * as path from "path";
import { spawn } from "child_process";
import { EXTENSION_ID } from "./constants";

export type DevcontainerUpResult = {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
};

export type DevcontainerCustomizations = {
  extensions: string[];
  settings: Record<string, unknown>;
};

export function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

export function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

export function getDevcontainerPath(wsFsPath: string): string {
  return path.join(wsFsPath, ".devcontainer", "devcontainer.json");
}

// Injected by esbuild via a banner (see esbuild.mts) so the running extension can report
// which build it came from. Absent when running unbundled (e.g. tests), hence the guard.
declare const __BUILD_INFO__:
  | { version: string; buildTimestamp: number }
  | undefined;

export function getBuildInfo(): { version: string; buildTimestamp: number } {
  return typeof __BUILD_INFO__ !== "undefined"
    ? __BUILD_INFO__
    : { version: "unknown", buildTimestamp: 0 };
}

// Write the current build's version and timestamp to the log. Called at the very start of
// every build/connect flow so each setup log records exactly which build produced it.
export function logBuildInfo(): void {
  const { version, buildTimestamp } = getBuildInfo();
  getLog().appendLine(
    `Dev Containers OSS v${version} (built @ ${new Date(buildTimestamp).toLocaleString()})`,
  );
}

let logBuffer = "";
let logSink: ((chunk: string) => void) | undefined;
let isDev = false;

// Enable extra, developer-facing log output (e.g. the raw commands being spawned). Set from
// activate() based on the extension's ExtensionMode so it only shows while developing.
export function setDevMode(value: boolean): void {
  isDev = value;
}

export function resetLog(): void {
  logBuffer = "";
}

export function getBufferedLog(): string {
  return logBuffer;
}

// The devcontainer CLI runs with --log-format json, so its lines look like
// {"type":"text","level":2,"timestamp":...,"text":"..."}. For a human-readable log we
// unwrap the `text` field of those lines and leave everything else (plain SSH setup
// output) untouched.
export function toReadableLog(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return line;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === "object" && typeof obj.text === "string") {
          return obj.text.replace(/\r?\n$/, "");
        }
      } catch {
        // not a JSON log line; keep as-is
      }
      return line;
    })
    .join("\n");
}

export type DevcontainerLog = {
  append: (value: string) => void;
  appendLine: (value: string) => void;
};

let logger: DevcontainerLog | undefined;

// Central log target for all devcontainer setup output. Every write is buffered (so the
// full session log can be handed off and replayed in a terminal after the folder reopens
// over SSH) and, while a build is in progress, streamed straight into that build's terminal
// via the sink set by withLogTerminal. There is deliberately no Output channel: setup
// output only ever surfaces in the read-only build terminal, matching Cursor and VS Code.
export function getLog(): DevcontainerLog {
  if (!logger) {
    logger = {
      append(value) {
        logBuffer += value;
        logSink?.(value);
      },
      appendLine(value) {
        logBuffer += value + "\n";
        logSink?.(value + "\n");
      },
    };
  }
  return logger;
}

// Run `fn` while streaming all log output into a fresh read-only terminal, then finish the
// terminal. This is the only place setup output is shown, mirroring the official Dev
// Containers extension: a terminal, only while building/configuring.
export async function withLogTerminal<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const term = createLogTerminal(name);
  // Replay anything already logged this session (e.g. the build-info line written right
  // after resetLog, before this terminal existed) so nothing logged pre-terminal is lost.
  if (logBuffer) term.write(logBuffer);
  logSink = (chunk) => term.write(chunk);
  try {
    return await fn();
  } finally {
    term.finish();
    logSink = undefined;
  }
}

// Render setup output in a read-only terminal, mirroring the official Dev Containers
// extension. A Pseudoterminal has no live shell for the user to type into; writes made
// before the terminal is opened are buffered so nothing is lost. Once finish() is called,
// any keypress closes the terminal.
export function createLogTerminal(name: string): {
  write: (text: string) => void;
  finish: () => void;
} {
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number | void>();
  let opened = false;
  let finished = false;
  let pending = "";
  const emit = (text: string) => {
    const body = text.replace(/\r?\n/g, "\r\n");
    if (opened) writeEmitter.fire(body);
    else pending += body;
  };
  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open() {
      opened = true;
      if (pending) {
        writeEmitter.fire(pending);
        pending = "";
      }
    },
    handleInput() {
      if (finished) closeEmitter.fire();
    },
    close() {},
  };
  const terminal = vscode.window.createTerminal({ name, pty });
  terminal.show();
  return {
    write: emit,
    finish: () => {
      finished = true;
      emit(
        "\r\n\r\nTerminal is finished. Press any key to close the terminal.\r\n",
      );
    },
  };
}

// Quiet commands are housekeeping calls whose output is irrelevant to the user (e.g. reading
// the container's home directory). They stay hidden from the build terminal in production but
// are still shown while developing the extension, where seeing everything aids debugging.
function shouldStream(quiet?: boolean): boolean {
  return isDev || !quiet;
}

function logCommand(command: string, args: string[]) {
  if (!isDev) return;
  const out = getLog();
  const printable = [command, ...args].join(" ");
  out.appendLine("");
  out.appendLine(`$ ${printable}`);
}

function makeWorkspaceSlug(wsFsPath: string): string {
  const name = path.basename(wsFsPath).toLowerCase();
  let slug = name.replace(/[^a-z0-9._-]+/g, "-");
  slug = slug.replace(/^[._-]+|[._-]+$/g, "");
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
  if (stream) logCommand(command, args);
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
    child.stdout.on("data", (d) => {
      if (stream) out.append(d.toString());
    });
    child.stderr.on("data", (d) => {
      if (stream) out.append(d.toString());
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

export async function runCommandCapture(
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
  if (stream) logCommand(command, args);
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      if (stream) out.append(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (stream) out.append(s);
    });
    child.on("error", () => resolve({ stdout: "", stderr: "error", code: 1 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

// The extension host runs on the Electron/Node binary at process.execPath.
// Setting ELECTRON_RUN_AS_NODE lets us execute the bundled devcontainer CLI as a plain Node script.
function getNodeEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
}

export function runCliCapture(
  ctx: vscode.ExtensionContext,
  args: string[],
  { cwd }: { cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cliPath = vscode.Uri.joinPath(
    ctx.extensionUri,
    "dist",
    "devcontainers-cli",
    "dist",
    "spec-node",
    "devContainersSpecCLI.js",
  ).fsPath;
  return runCommandCapture(process.execPath, [cliPath, ...args], {
    cwd,
    env: getNodeEnv(),
    quiet: true,
  });
}

// The running editor ships its own CLI at <appRoot>/out/cli.js, launched the same way
// the platform `code`/`codium`/`cursor` wrapper scripts do: the Electron binary in
// plain-Node mode. This lets us drive commands like --install-extension --remote.
export function runEditorCliCapture(
  args: string[],
  { cwd }: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cliPath = path.join(vscode.env.appRoot, "out", "cli.js");
  return runCommandCapture(process.execPath, [cliPath, ...args], {
    cwd,
    env: getNodeEnv(),
  });
}

// With --log-format json the CLI emits JSON log lines plus a final result object.
// The result is the last line that parses to an object carrying the given key.
function findResultObject(output: string, key: string) {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && key in obj) return obj;
    } catch {
      // not the result line
    }
  }
  return undefined;
}

function parseUpResult(output: string) {
  return findResultObject(output, "outcome");
}

export async function devcontainerUp(
  ctx: vscode.ExtensionContext,
  wsFsPath: string,
  options?: { rebuild?: boolean },
): Promise<DevcontainerUpResult> {
  const args = ["up", "--workspace-folder", wsFsPath];
  if (options?.rebuild) {
    args.push("--remove-existing-container");
  }
  if (options?.rebuild) {
    vscode.window.showInformationMessage("Rebuilding devcontainer...");
  }
  const res = await runCliCapture(ctx, args, { cwd: wsFsPath });
  const result = parseUpResult(res.stdout) ?? parseUpResult(res.stderr);
  if (res.code !== 0 || !result || result.outcome !== "success") {
    const detail =
      result?.message || result?.description || `exit code ${res.code}`;
    throw new Error(`devcontainer up failed: ${detail}`);
  }
  if (!result.containerId) {
    throw new Error(
      "devcontainer up succeeded but did not return a containerId",
    );
  }
  return {
    containerId: result.containerId,
    remoteUser: result.remoteUser || "",
    remoteWorkspaceFolder: result.remoteWorkspaceFolder || "",
  };
}

// The merged configuration folds together the top-level devcontainer.json, image
// metadata, and every feature's customizations. Its `customizations.vscode` is an
// array of { extensions, settings } entries (one per contributing source), so we
// concatenate the extension lists and merge the settings objects in source order.
export async function readMergedCustomizations(
  ctx: vscode.ExtensionContext,
  wsFsPath: string,
): Promise<DevcontainerCustomizations> {
  const empty: DevcontainerCustomizations = { extensions: [], settings: {} };
  const args = [
    "read-configuration",
    "--include-merged-configuration",
    "--workspace-folder",
    wsFsPath,
  ];
  let res: { stdout: string; stderr: string; code: number };
  try {
    res = await runCliCapture(ctx, args, { cwd: wsFsPath });
  } catch (err: any) {
    getLog().appendLine(
      `Could not read devcontainer customizations: ${err?.message ?? String(err)}`,
    );
    return empty;
  }
  const result =
    findResultObject(res.stdout, "mergedConfiguration") ??
    findResultObject(res.stderr, "mergedConfiguration");
  const vscodeEntries = result?.mergedConfiguration?.customizations?.vscode;
  if (!Array.isArray(vscodeEntries)) {
    return empty;
  }
  const extensions: string[] = [];
  let settings: Record<string, unknown> = {};
  for (const entry of vscodeEntries) {
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray(entry.extensions)) {
      for (const ext of entry.extensions) {
        if (typeof ext === "string") extensions.push(ext);
      }
    }
    if (entry.settings && typeof entry.settings === "object") {
      settings = { ...settings, ...entry.settings };
    }
  }
  return { extensions: Array.from(new Set(extensions)), settings };
}
