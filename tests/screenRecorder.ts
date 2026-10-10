import { spawn } from "node:child_process";

const FRAMERATE = 60;

/**
 * Grabs the whole X display via ffmpeg because Playwright's own video recording
 * is hardcoded to 25 fps.
 */
export function startScreenRecording(outputPath: string) {
  const display = process.env["DISPLAY"];
  if (!display) {
    console.warn("DISPLAY is not set - skipping screen recording.");
    return undefined;
  }

  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-y",
      "-f",
      "x11grab",
      "-draw_mouse",
      "1",
      "-framerate",
      String(FRAMERATE),
      "-i",
      display,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "28",
      "-pix_fmt",
      "yuv420p",
      outputPath,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );

  let stderr = "";
  ffmpeg.stderr.setEncoding("utf8");
  ffmpeg.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let spawnError: Error | undefined;
  ffmpeg.on("error", (error) => {
    spawnError = error;
  });

  return async () => {
    if (spawnError) {
      console.warn(`Screen recording unavailable: ${spawnError.message}`);
      return undefined;
    }

    // Graceful shutdown, so that the container is finalized properly.
    ffmpeg.stdin.end("q");
    const exitCode = await new Promise<number | null>((resolve) => {
      ffmpeg.on("close", resolve);
    });

    if (exitCode !== 0) {
      console.warn(`ffmpeg exited with code ${exitCode}:\n${stderr}`);
      return undefined;
    }

    return outputPath;
  };
}
