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
  code: number;
  galleryStatus: number | undefined;
  output: string;
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
      return { code: res.code, galleryStatus, output };
    }

    getLog().appendLine(
      `Retrying extension install in ${delayMs / 1000}s (attempt ${attempt + 2} of ${RETRY_DELAYS_MS.length + 1})...`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function warnAboutFailure(label: string, failure: InstallFailure) {
  const host = failure.galleryStatus ? getExtensionGalleryHost() : undefined;
  window.showWarningMessage(
    failure.galleryStatus
      ? `Devcontainer extension ${label} could not be downloaded: the extension marketplace${host ? ` (${host}) ` : " "}kept returning ${failure.galleryStatus}. The container itself is fine - retry the install later.`
      : `Devcontainer extension ${label} may not have installed (server CLI exited with code ${failure.code}). See the terminal for details.`,
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
    warnAboutFailure(extensions[0]!, failure);
    return;
  }

  // Multi-extension server CLI calls can fail against Open VSX, while individual installs succeed.
  getLog().appendLine(
    "Couldn't install extensions batched - will try to install extensions individually...",
  );

  for (const extension of extensions) {
    const singleFailure = await installExtensionsWithRetries(
      containerId,
      user,
      binDir,
      product,
      [extension],
    );
    if (singleFailure) {
      warnAboutFailure(extension, singleFailure);
    }
  }
}
