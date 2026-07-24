import type { Configuration } from "lint-staged";

export default {
  "**/*.*{ts,js}": (filenames) => [
    `pnpm lint ${filenames.join(" ")}`,
    "pnpm typecheck",
  ],
  "**/*": (filenames) => [
    `pnpm oxfmt --no-error-on-unmatched-pattern --check ${filenames.join(" ")}`,
    `pnpm knip`,
  ],
} satisfies Configuration;
