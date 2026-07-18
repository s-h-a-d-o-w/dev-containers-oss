import esbuild from "esbuild";
import fs from "fs";
import path from "path";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const pkg = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf8"),
) as { version: string };
const buildTimestamp = Date.now();

const clean: esbuild.Plugin = {
  name: "clean",
  setup(build) {
    build.onStart(() => {
      fs.rmSync(path.join(import.meta.dirname, "dist"), {
        recursive: true,
        force: true,
      });
      copyDevcontainerCli();
      copyAgentBridgeScript();
    });
  },
};

// The devcontainer CLI is a single self-contained bundle. Ship it alongside the
// extension so it can be spawned as a Node script at runtime. The CLI resolves its
// own asset files (e.g. scripts/updateUID.Dockerfile) relative to
// path.join(__dirname, '..', '..'), so we must preserve its dist/spec-node depth and
// copy the scripts/ folder next to it.
function copyDevcontainerCli() {
  const cliRoot = path.join(
    import.meta.dirname,
    "node_modules",
    "@devcontainers",
    "cli",
  );
  const destDir = path.join(import.meta.dirname, "dist", "devcontainers-cli");

  const src = path.join(
    cliRoot,
    "dist",
    "spec-node",
    "devContainersSpecCLI.js",
  );
  const dest = path.join(
    destDir,
    "dist",
    "spec-node",
    "devContainersSpecCLI.js",
  );
  fs.mkdirSync(path.join(destDir, "dist", "spec-node"), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Copied devcontainer CLI to ${dest}`);

  const scriptsSrc = path.join(cliRoot, "scripts");
  const scriptsDest = path.join(destDir, "scripts");
  fs.cpSync(scriptsSrc, scriptsDest, { recursive: true });
  console.log(`Copied devcontainer CLI scripts to ${scriptsDest}`);
}

// The SSH agent forwarding bridge runs inside the container via the server's own node.
// It must stay a standalone script (not bundled into extension.js), so ship it verbatim
// next to the extension and read it at runtime with `node -e`.
function copyAgentBridgeScript() {
  const src = path.join(import.meta.dirname, "src", "agentBridgeContainer.js");
  const dest = path.join(
    import.meta.dirname,
    "dist",
    "agentBridgeContainer.js",
  );
  fs.mkdirSync(path.join(import.meta.dirname, "dist"), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Copied agent bridge script to ${dest}`);
}

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode", "fs", "path", "child_process", "net"],
    banner: {
      js: `globalThis.__BUILD_INFO__ = ${JSON.stringify({
        version: pkg.version,
        buildTimestamp,
      })};`,
    },
    logLevel: "info",
    plugins: [clean],
  });

  if (watch) {
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
