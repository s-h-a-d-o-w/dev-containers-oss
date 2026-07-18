export default {
  "**/*.{mjs,js,ts}": "pnpm lint",
  "**/*.ts": () => "pnpm typecheck",
  "**/*": "oxfmt --no-error-on-unmatched-pattern",
};
