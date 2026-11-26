import {
  watchContainerShutdown,
  type ShutdownPlan,
} from "./shutdownWatcher.ts";

process.once("message", (plan: ShutdownPlan) => {
  try {
    watchContainerShutdown(plan);
  } catch {
    process.exitCode = 1;
    process.disconnect?.();
  }
});
