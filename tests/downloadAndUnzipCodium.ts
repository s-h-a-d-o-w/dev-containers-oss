import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import ky from "ky";

const execFileAsync = promisify(execFile);

export const releases = {
  latest: undefined, // resolves to the latest release.
  firstSupported: "1.126.04524",
} satisfies Record<string, string | undefined>;
export type ReleaseKey = keyof typeof releases;

const isWindows = process.platform === "win32";
const isDarwin = process.platform === "darwin";
const RELEASES_URL = "https://github.com/VSCodium/VSCodium/releases";

function getPlatformIdentifier(): string {
  if (!["arm64", "x64"].includes(process.arch)) {
    throw new Error(`Unsupported architecture: ${process.arch}`);
  }
  if (
    !(
      process.platform === "linux" ||
      process.platform === "darwin" ||
      process.platform === "win32"
    )
  ) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  return `${process.platform}-${process.arch}`;
}

// Uses the github.com redirect instead of the REST API, which is rate limited without a token.
async function fetchLatestTag() {
  let url: string;
  try {
    ({ url } = await ky.head(`${RELEASES_URL}/latest`));
  } catch (error) {
    throw new Error(`Failed to fetch latest VSCodium release: ${error}`, {
      cause: error,
    });
  }

  const tag = /\/releases\/tag\/(?<tag>[^/?#]+)$/u.exec(url)?.groups?.["tag"];
  if (!tag) {
    throw new Error(`Unexpected VSCodium latest release URL: ${url}`);
  }
  return decodeURIComponent(tag);
}

function getAsset(tag: string, platformId: string) {
  const extension = process.platform === "linux" ? ".tar.gz" : ".zip";
  const name = `VSCodium-${platformId}-${tag}${extension}`;
  return { name, url: `${RELEASES_URL}/download/${tag}/${name}` };
}

async function downloadFile(url: string, destination: string): Promise<void> {
  try {
    const response = await ky.get(url);
    if (!response.body) {
      throw new Error(`Failed to download ${url}: no body`);
    }
    await pipeline(response.body, createWriteStream(destination));
  } catch (error) {
    throw new Error(`Failed to download ${url}: ${error}`, { cause: error });
  }
}

async function extractArchive(
  archivePath: string,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  if (archivePath.endsWith(".tar.gz")) {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", destination]);
  } else {
    await execFileAsync("unzip", ["-q", "-o", archivePath, "-d", destination]);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function downloadAndUnzipCodium(
  which: ReleaseKey = "latest",
): Promise<string> {
  console.log(`Downloading VSCodium release: ${which}`);
  const platformId = getPlatformIdentifier();
  const tag = releases[which] ?? (await fetchLatestTag());
  const asset = getAsset(tag, platformId);

  const workDir = path.join(tmpdir(), "vscodium-cache-" + which);
  console.log(`Downloading VSCodium release to: ${workDir}`);
  const archivePath = path.join(workDir, asset.name);
  const extractDir = path.join(
    workDir,
    asset.name.replace(/\.(?:tar\.gz|zip)$/u, ""),
  );
  const executablePath = isWindows
    ? path.join(extractDir, "VSCodium.exe")
    : isDarwin
      ? path.join(extractDir, "VSCodium.app/Contents/MacOS/VSCodium")
      : path.join(extractDir, "codium");

  if (await pathExists(executablePath)) {
    console.log("Re-using previously downloaded VSCodium.");
    return executablePath;
  }

  await mkdir(workDir, { recursive: true });
  await downloadFile(asset.url, archivePath);
  await extractArchive(archivePath, extractDir);
  await rm(archivePath, { force: true });

  return executablePath;
}
