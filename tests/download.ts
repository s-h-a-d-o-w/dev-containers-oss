import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const isWindows = process.platform === "win32";
const isDarwin = process.platform === "darwin";
const isLinux = process.platform === "linux";
const GITHUB_API_LATEST_RELEASE =
  "https://api.github.com/repos/VSCodium/VSCodium/releases/latest";

type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type GitHubRelease = {
  tag_name: string;
  assets: GitHubReleaseAsset[];
};

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

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const response = await fetch(GITHUB_API_LATEST_RELEASE, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch latest VSCodium release: ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as GitHubRelease;
}

function selectAsset(
  release: GitHubRelease,
  platformId: string,
): GitHubReleaseAsset {
  const extension = process.platform === "linux" ? ".tar.gz" : ".zip";
  const asset = release.assets.find(
    (candidate) =>
      candidate.name.startsWith("VSCodium-") &&
      candidate.name.includes(platformId) &&
      candidate.name.endsWith(extension),
  );
  if (!asset) {
    throw new Error(
      `No VSCodium ${extension} asset found for platform "${platformId}" in release ${release.tag_name}`,
    );
  }
  return asset;
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }
  await pipeline(response.body, createWriteStream(destination));
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

export async function downloadAndUnzipCodium(): Promise<string> {
  const platformId = getPlatformIdentifier();
  const release = await fetchLatestRelease();
  const asset = selectAsset(release, platformId);

  const workDir = path.join(tmpdir(), "vscodium-cache");
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
  await downloadFile(asset.browser_download_url, archivePath);
  await extractArchive(archivePath, extractDir);
  await rm(archivePath, { force: true });

  return executablePath;
}
