import { env, type ExtensionContext, Uri, window } from "vscode";
import fs from "node:fs";
import path from "node:path";
import { runCommandCapture } from "./runCommands.ts";
import { getLog } from "./log.ts";
import { EXTENSION_ID } from "./constants.ts";
import { parseWslPath, setWslDistroFromPath } from "./wsl.ts";

export type DevcontainerUpResult = {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
};

export type DevcontainerCustomizations = {
  extensions: string[];
  settings: Record<string, unknown>;
};

// The extension host runs on the Electron/Node binary at process.execPath.
// Setting ELECTRON_RUN_AS_NODE lets us execute the bundled devcontainer CLI as a plain Node script.
function getEnvWithElectronAsNode(): NodeJS.ProcessEnv {
  return { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
}

// The version installed inside WSL comes from the @devcontainers/cli dependency range in our
// package.json, stripped of any semver range prefix (^, ~, >=, ...).
function getDevcontainerCliVersion(ctx: ExtensionContext): string {
  const pkgPath = Uri.joinPath(ctx.extensionUri, "package.json").fsPath;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const range = pkg.dependencies?.["@devcontainers/cli"] ?? "";
  return range.replace(/^[^\d]*/u, "");
}

// Build a `wsl.exe` invocation that ensures the devcontainer CLI is installed in the distro
// (via the upstream install script, pinned to our bundled version) and then runs it. The
// install is skipped when the pinned version is already present, so repeated calls only pay
// the download cost once.
function buildWslCliInvocation(
  ctx: ExtensionContext,
  distro: string,
  cliArgs: string[],
): { command: string; args: string[]; input: string } {
  const version = getDevcontainerCliVersion(ctx);
  const installUrl =
    "https://raw.githubusercontent.com/devcontainers/cli/main/scripts/install.sh";
  const installScript = `/tmp/${EXTENSION_ID}-install.sh`;
  const script = [
    "set -e",
    'BIN="$HOME/.devcontainers/bin"',
    `if ! "$BIN/devcontainer" --version 2>/dev/null | grep -qx "${version}"; then`,
    `  curl -fsSL "${installUrl}" -o "${installScript}"`,
    `  sh "${installScript}" --version ${version}`,
    "fi",
    // Invoke the wrapper by its absolute path rather than relying on PATH resolution: some
    // distros/shells still report "devcontainer: not found" for the bare name right after the
    // install adds $BIN to PATH.
    'exec "$BIN/devcontainer" "$@"',
  ].join("\n");
  // Feed the script to `sh` over stdin (`-s`) instead of embedding it as a `wsl.exe`
  // command-line argument. Passing a multi-line, quote-heavy script through the
  // Node spawn -> Windows CreateProcess -> wsl.exe chain mangles the embedded quotes
  // (so `$BIN` ends up wrong and every run reinstalls, then fails with "not found").
  // The CLI args after `--` become the script's positional parameters ("$@").
  return {
    command: "wsl.exe",
    args: ["-d", distro, "sh", "-s", "--", ...cliArgs],
    input: script,
  };
}

function runCliCapture(
  ctx: ExtensionContext,
  args: string[],
  { cwd, quiet = true }: { cwd?: string; quiet?: boolean },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const wsl = cwd ? parseWslPath(cwd) : undefined;
  if (wsl) {
    // Normalize any WSL UNC path in the arguments (e.g. the --workspace-folder value) to a
    // native Linux path the in-distro CLI understands.
    const wslArgs = args.map((arg) => parseWslPath(arg)?.linuxPath ?? arg);
    const {
      command,
      args: cmdArgs,
      input,
    } = buildWslCliInvocation(ctx, wsl.distro, wslArgs);
    // wsl.exe is a Win32 process and cannot start in a UNC working directory, so we omit
    // cwd; the CLI locates the project through the normalized --workspace-folder path.
    return runCommandCapture(command, cmdArgs, { input, quiet });
  }
  const cliPath = Uri.joinPath(
    ctx.extensionUri,
    "dist",
    "devcontainers-cli",
    "dist",
    "spec-node",
    "devContainersSpecCLI.js",
  ).fsPath;
  return runCommandCapture(process.execPath, [cliPath, ...args], {
    cwd,
    env: getEnvWithElectronAsNode(),
    quiet,
  });
}

// The running editor ships its own CLI at <appRoot>/out/cli.js, launched the same way
// the platform `code`/`codium`/`cursor` wrapper scripts do: the Electron binary in
// plain-Node mode. This lets us drive commands like --install-extension --remote.
export function runEditorCliCapture(
  args: string[],
  { cwd }: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cliPath = path.join(env.appRoot, "out", "cli.js");
  return runCommandCapture(process.execPath, [cliPath, ...args], {
    cwd,
    env: getEnvWithElectronAsNode(),
  });
}

// The CLI writes its final result object to stdout as JSON (independent of the log
// format used for progress output). The result is the last line that parses to an
// object carrying the given key.
function findResultObject(output: string, key: string) {
  const lines = output
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      // oxlint-disable-next-line typescript/no-explicit-any
      const obj = JSON.parse(line) as Record<string, any>;
      if (typeof obj === "object" && key in obj) {
        return obj;
      }
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
  ctx: ExtensionContext,
  wsFsPath: string,
  options?: { rebuild?: boolean },
): Promise<DevcontainerUpResult> {
  // `devcontainer up` is the entry point of every flow (native resolver, native launch, and
  // SSH). Recomputing the WSL context here means every docker command issued afterwards in
  // this process routes to the distro that hosts the container (or to the host if none).
  setWslDistroFromPath(wsFsPath);
  const args = ["up", "--workspace-folder", wsFsPath];
  if (options?.rebuild) {
    args.push("--remove-existing-container");
  }
  if (options?.rebuild) {
    window.showInformationMessage("Rebuilding devcontainer...");
  }
  const { code, stderr, stdout } = await runCliCapture(ctx, args, {
    cwd: wsFsPath,
    quiet: false,
  });
  const result = parseUpResult(stdout) ?? parseUpResult(stderr);
  if (code !== 0 || result?.outcome !== "success") {
    const detail = (result?.message ??
      result?.description ??
      `exit code ${code}`) as string;
    throw new Error(`devcontainer up failed: ${detail}`);
  }
  if (!result.containerId) {
    throw new Error(
      "devcontainer up succeeded but did not return a containerId",
    );
  }
  return {
    containerId: result.containerId as string,
    remoteUser: (result.remoteUser ?? "") as string,
    remoteWorkspaceFolder: (result.remoteWorkspaceFolder ?? "") as string,
  };
}

function isEntryObject(entry: unknown): entry is Record<string, unknown> {
  return typeof entry === "object" && entry !== null;
}

// The merged configuration folds together the top-level devcontainer.json, image
// metadata, and every feature's customizations. Its `customizations.vscode` is an
// array of { extensions, settings } entries (one per contributing source), so we
// concatenate the extension lists and merge the settings objects in source order.
export async function readMergedCustomizations(
  ctx: ExtensionContext,
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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    getLog().appendLine(
      `Could not read devcontainer customizations: ${message}`,
    );
    return empty;
  }
  const result =
    findResultObject(res.stdout, "mergedConfiguration") ??
    findResultObject(res.stderr, "mergedConfiguration");
  // oxlint-disable-next-line typescript/no-unsafe-member-access
  const vscodeEntries = result?.mergedConfiguration?.customizations
    ?.vscode as unknown;
  if (!Array.isArray(vscodeEntries)) {
    return empty;
  }
  const extensions: string[] = [];
  const settings: Record<string, unknown> = {};
  for (const entry of vscodeEntries) {
    if (!isEntryObject(entry)) {
      continue;
    }
    if (Array.isArray(entry.extensions)) {
      for (const ext of entry.extensions) {
        if (typeof ext === "string") {
          extensions.push(ext);
        }
      }
    }
    if (entry.settings && typeof entry.settings === "object") {
      Object.assign(settings, entry.settings);
    }
  }
  return { extensions: [...new Set(extensions)], settings };
}
