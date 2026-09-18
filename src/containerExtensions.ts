import { window } from "vscode";
import { dockerExecShellCapture } from "./dockerOps.ts";
import { readProductJson } from "./hostInfo.ts";
import { getLog } from "./log.ts";
import type { ProductInfo } from "./types/types.ts";

const RETRY_DELAYS_MS = [2000, 5000, 10_000];

// The server CLI reports marketplace HTTP failures as a bare "Server returned <status>",
// which reads like the container server failed. It is actually the extension gallery from
// the client's product.json (Open VSX for VSCodium), so name the host in the log.
function getExtensionGalleryHost() {
  const serviceUrl = readProductJson().extensionsGallery?.serviceUrl;
  if (!serviceUrl) {
    return;
  }

  try {
    return new URL(serviceUrl).host;
  } catch {
    return serviceUrl;
  }
}

function getGalleryStatus(output: string): number | undefined {
  const status = Number(
    /Server returned (?<status>\d{3})/u.exec(output)?.groups?.["status"],
  );
  return status === 429 || status >= 500 ? status : undefined;
}

type InstallFailure = {
  galleryStatus: number | undefined;
};

async function installExtensionsWithRetries(
  containerId: string,
  user: string,
  binDir: string,
  product: ProductInfo,
  extensions: string[],
): Promise<InstallFailure | undefined> {
  const serverBin = `${binDir}/bin/${product.serverApplicationName}`;
  const params = extensions.flatMap((id) => ["--install-extension", id]);
  const label = extensions.join(", ");

  for (let attempt = 0; ; attempt++) {
    const res = await dockerExecShellCapture(
      containerId,
      { params, quiet: true, user },
      `"${serverBin}" "$@"`,
    );
    if (res.code === 0) {
      getLog().appendLine(`Successfully installed ${label}.`);
      return;
    }

    const output = res.stderr.trim() || res.stdout.trim() || "no output";
    const galleryStatus = getGalleryStatus(output);
    getLog().appendLine(
      `Extension install failed for ${label} (exit code ${res.code}): ${output}`,
    );

    if (galleryStatus) {
      const host = getExtensionGalleryHost();
      getLog().appendLine(
        `HTTP ${galleryStatus} came from the extension marketplace${host ? ` (${host}) ` : " "}, not from the server running in the container.`,
      );
    }

    const delayMs = galleryStatus ? RETRY_DELAYS_MS[attempt] : undefined;
    if (delayMs === undefined) {
      return { galleryStatus };
    }

    getLog().appendLine(
      `Retrying extension install in ${delayMs / 1000}s (attempt ${attempt + 2} of ${RETRY_DELAYS_MS.length + 1})...`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function warnAboutFailures(failures: Map<string, InstallFailure>) {
  const label = [...failures.keys()].join(", ");
  const galleryStatus = [...failures.values()].find(
    (failure) => failure.galleryStatus,
  )?.galleryStatus;
  const host = galleryStatus ? getExtensionGalleryHost() : undefined;
  const noun =
    failures.size === 1
      ? `Devcontainer extension ${label}`
      : `Devcontainer extensions ${label}`;

  window.showWarningMessage(
    galleryStatus
      ? `${noun} could not be downloaded: the extension marketplace${host ? ` (${host}) ` : " "}kept returning ${galleryStatus}. The container itself is fine - retry the install later.`
      : `${noun} may not have installed. See the terminal for details.`,
  );
}

export async function installExtensionsInContainer(
  containerId: string,
  user: string,
  binDir: string,
  product: ProductInfo,
  extensions: string[],
): Promise<void> {
  if (extensions.length === 0) {
    return;
  }

  getLog().appendLine(
    `Installing ${extensions.length} extension(s) into the container...`,
  );

  const failure = await installExtensionsWithRetries(
    containerId,
    user,
    binDir,
    product,
    extensions,
  );
  if (!failure) {
    return;
  }

  if (extensions.length === 1) {
    warnAboutFailures(new Map([[extensions[0]!, failure]]));
    return;
  }

  // Multi-extension server CLI calls can fail against Open VSX, while individual installs succeed.
  getLog().appendLine(
    "Couldn't install extensions batched - will try to install extensions individually...",
  );

  const failures = new Map<string, InstallFailure>();
  for (const extension of extensions) {
    const singleFailure = await installExtensionsWithRetries(
      containerId,
      user,
      binDir,
      product,
      [extension],
    );
    if (singleFailure) {
      failures.set(extension, singleFailure);
    }
  }

  if (failures.size > 0) {
    warnAboutFailures(failures);
  }
}
