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

// Open VSX intermittently serves 503/429 from its CDN edge while the service itself is
// healthy, so a failed install is usually worth retrying rather than reporting as an outage.
function getGalleryStatus(output: string): number | undefined {
  const status = Number(
    /Server returned (?<status>\d{3})/u.exec(output)?.groups?.["status"],
  );
  return status === 429 || status >= 500 ? status : undefined;
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

  const serverBin = `${binDir}/bin/${product.serverApplicationName}`;
  const params: string[] = [];
  for (const id of extensions) {
    params.push("--install-extension", id);
  }
  getLog().appendLine(
    `Installing ${extensions.length} devcontainer extension(s) into the container server...`,
  );

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
      `Extension install failed (exit code ${res.code}): ${output}`,
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
          ? `Devcontainer extensions could not be downloaded: the extension marketplace${host ? ` (${host}) ` : " "}kept returning ${galleryStatus}. The container itself is fine - retry the install later.`
          : `Some devcontainer extensions may not have installed (server CLI exited with code ${res.code}). See the terminal for details.`,
      );
      return;
    }

    getLog().appendLine(
      `Retrying extension install in ${delayMs / 1000}s (attempt ${attempt + 2} of ${RETRY_DELAYS_MS.length + 1})...`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
