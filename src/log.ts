import vscode from "vscode";

export type DevcontainerLog = {
  append: (value: string) => void;
  appendLine: (value: string) => void;
};

let logBuffer = "";
let logSink: ((chunk: string) => void) | undefined;
let logger: DevcontainerLog | undefined;
let isDev = false;

// Injected by esbuild via a banner (see esbuild.mts) so the running extension can report
// which build it came from. Absent when running unbundled (e.g. tests), hence the guard.
declare const __BUILD_INFO__:
  | { version: string; buildTimestamp: number }
  | undefined;

export function getBuildInfo(): { version: string; buildTimestamp: number } {
  return __BUILD_INFO__ ?? { version: "unknown", buildTimestamp: 0 };
}

// Central log target for all devcontainer setup output. Every write is buffered (so the
// full session log can be handed off and replayed in a terminal after the folder reopens
// over SSH) and, while a build is in progress, streamed straight into that build's terminal
// via the sink set by withLogTerminal. There is deliberately no Output channel: setup
// output only ever surfaces in the read-only build terminal, matching Cursor and VS Code.
export function getLog(): DevcontainerLog {
  logger ??= {
    append(value) {
      logBuffer += value;
      logSink?.(value);
    },
    appendLine(value) {
      logBuffer += value + "\n";
      logSink?.(value + "\n");
    },
  };
  return logger;
}

// Write the current build's version and timestamp to the log. Called at the very start of
// every build/connect flow so each setup log records exactly which build produced it.
export function logBuildInfo(): void {
  const { version, buildTimestamp } = getBuildInfo();
  getLog().appendLine(
    `Dev Containers OSS v${version} (built @ ${new Date(buildTimestamp).toLocaleString()})`,
  );
}

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

// Render setup output in a read-only terminal, mirroring the official Dev Containers
// extension. A Pseudoterminal has no live shell for the user to type into; writes made
// before the terminal is opened are buffered so nothing is lost. Once finish() is called,
// any keypress closes the terminal.
export function createLogTerminal(name: string): {
  write: (text: string) => void;
  finish: () => void;
} {
  const writeEmitter = new vscode.EventEmitter<string>();
  // oxlint-disable-next-line typescript/no-invalid-void-type
  const closeEmitter = new vscode.EventEmitter<number | void>();
  let opened = false;
  let finished = false;
  let pending = "";
  const emit = (text: string) => {
    const body = text.replaceAll(/\r?\n/gu, "\r\n");
    if (opened) {
      writeEmitter.fire(body);
    } else {
      pending += body;
    }
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
      if (finished) {
        closeEmitter.fire();
      }
    },
    close() {
      /* empty */
    },
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
  if (logBuffer) {
    term.write(logBuffer);
  }
  logSink = (chunk) => term.write(chunk);
  try {
    return await fn();
  } finally {
    term.finish();
    logSink = undefined;
  }
}

// Quiet commands are housekeeping calls whose output is irrelevant to the user (e.g. reading
// the container's home directory). They stay hidden from the build terminal in production but
// are still shown while developing the extension, where seeing everything aids debugging.
export function shouldStream(quiet?: boolean): boolean {
  return isDev || !quiet;
}

export function logCommand(command: string, args: string[]): void {
  if (!isDev) {
    return;
  }
  const out = getLog();
  const printable = [command, ...args].join(" ");
  out.appendLine("");
  out.appendLine(`$ ${printable}`);
}
