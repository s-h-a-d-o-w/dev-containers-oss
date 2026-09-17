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

async function installExtensionInContainer(
  containerId: string,
  user: string,
  binDir: string,
  product: ProductInfo,
  extension: string,
) {
  const serverBin = `${binDir}/bin/${product.serverApplicationName}`;
  const params = ["--install-extension", extension];

  for (let attempt = 0; ; attempt++) {
    const res = await dockerExecShellCapture(
      containerId,
      { params, user },
      `"${serverBin}" "$@"`,
    );
    if (res.code === 0) {
      return;
    }

    const output = res.stderr.trim() || res.stdout.trim() || "no output";
    const galleryStatus = getGalleryStatus(output);
    const host = galleryStatus ? getExtensionGalleryHost() : undefined;
    getLog().appendLine(
      `Extension install failed for ${extension} (exit code ${res.code}): ${output}`,
    );

    if (galleryStatus) {
      getLog().appendLine(
        `HTTP ${galleryStatus} came from the extension marketplace${host ? ` (${host}) ` : " "}, not from the server running in the container.`,
      );
    }

    const delayMs = galleryStatus ? RETRY_DELAYS_MS[attempt] : undefined;
    if (delayMs === undefined) {
      window.showWarningMessage(
        galleryStatus
          ? `Devcontainer extension ${extension} could not be downloaded: the extension marketplace${host ? ` (${host}) ` : " "}kept returning ${galleryStatus}. The container itself is fine - retry the install later.`
          : `Devcontainer extension ${extension} may not have installed (server CLI exited with code ${res.code}). See the terminal for details.`,
      );
      return;
    }

    getLog().appendLine(
      `Retrying extension install in ${delayMs / 1000}s (attempt ${attempt + 2} of ${RETRY_DELAYS_MS.length + 1})...`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
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
    `Installing ${extensions.length} devcontainer extension(s) into the container server...`,
  );

  // Multi-extension server CLI calls can fail against Open VSX, while individual installs succeed.
  for (const extension of extensions) {
    await installExtensionInContainer(
      containerId,
      user,
      binDir,
      product,
      extension,
    );
  }
}
