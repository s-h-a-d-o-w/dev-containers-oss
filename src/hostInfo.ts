import { env } from "vscode";
import fs from "node:fs";
import path from "node:path";
import type { ProductInfo } from "./types/types.ts";

// Read and parse the running editor's product.json. Returns an empty object when the
// file is missing or malformed; callers fall back to their own defaults.
export function readProductJson(): Partial<ProductInfo> {
  try {
    const productJsonPath = path.join(env.appRoot, "product.json");
    return JSON.parse(
      fs.readFileSync(productJsonPath, "utf8"),
    ) as Partial<ProductInfo>;
  } catch {
    return {};
  }
}

// The SSH remote extension installs each container's VS Code server under a
// product-specific folder in the user's home (e.g. .vscode-server, .vscodium-server,
// .cursor-server). The name comes from the running client's product.json, so we read
// serverDataFolderName there and fall back to an appName heuristic. We intentionally do
// not derive it from applicationName: the mapping is not `.${applicationName}-server`
// (VS Code's is .vscode-server not .code-server, VSCodium's is .vscodium-server), so
// guessing that way would produce the wrong folder.
export function getServerDataFolderName(): string {
  const product = readProductJson();
  if (
    typeof product.serverDataFolderName === "string" &&
    product.serverDataFolderName
  ) {
    return product.serverDataFolderName;
  }
  const appName = (env.appName || "").toLowerCase();
  // Insiders/pre-release builds append a "-insiders" suffix to the server folder
  // (e.g. .vscode-server-insiders, .vscodium-server-insiders); Cursor/Positron do not
  // ship such builds, so the suffix only matters for VS Code and VSCodium.
  const suffix = appName.includes("insiders") ? "-insiders" : "";
  if (appName.includes("cursor")) {
    return ".cursor-server";
  }
  if (appName.includes("positron")) {
    return ".positron-server";
  }
  if (appName.includes("codium")) {
    return `.vscodium-server${suffix}`;
  }
  return `.vscode-server${suffix}`;
}
