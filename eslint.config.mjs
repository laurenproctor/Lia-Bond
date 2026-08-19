import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/** @type {import('eslint').Linter.Config[]} */
const eslintConfig = [
  {
    // `.claude/` holds tool state and git worktree checkouts of other
    // branches, whose files would otherwise be linted as this project's own.
    // `* [2-9].*` are iCloud conflict copies, which .gitignore also covers —
    // repeated here because ESLint does not read .gitignore, so an ignored
    // duplicate would otherwise still be linted as this project's own source.
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      ".claude/**",
      "**/* [2-9].*",
    ],
  },
  ...coreWebVitals,
  ...nextTypescript,
];

export default eslintConfig;
