import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/** @type {import('eslint').Linter.Config[]} */
const eslintConfig = [
  {
    // `.claude/` holds tool state and git worktree checkouts of other
    // branches, whose files would otherwise be linted as this project's own.
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", ".claude/**"],
  },
  ...coreWebVitals,
  ...nextTypescript,
];

export default eslintConfig;
