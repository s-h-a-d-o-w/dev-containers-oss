import type { Configuration } from "lint-staged";

export default {
  "**/*.*{ts,js}": ["pnpm lint", () => "pnpm typecheck"],
  "**/*": [
    "pnpm oxfmt --no-error-on-unmatched-pattern --check",
    () => "pnpm knip",
  ],
} satisfies Configuration;
