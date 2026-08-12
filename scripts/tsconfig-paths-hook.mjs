/**
 * Teaches `node --experimental-strip-types` two things `tsconfig.json`'s
 * `moduleResolution: "bundler"` allows that a plain Node ESM loader does not:
 * the `@/*` alias, and extensionless relative imports (e.g. `./evaluate`
 * resolving to `./evaluate.ts`).
 *
 * Next.js, Vitest, and TypeScript itself all resolve both forms; a plain
 * `node` invocation resolves neither. This module exists for scripts that run
 * under plain `node` (the seed generator, the matrix-parity generator) and
 * therefore need it. It matters even for a script whose own imports are all
 * `@/`-aliased or fully extensioned: those imports can transitively reach a
 * source file (e.g. `src/lib/rules/transitions.ts` importing `./evaluate`)
 * that was written for the bundler resolver, not for plain Node.
 *
 * Used as: node --import ./scripts/tsconfig-paths-hook.mjs script.ts
 */

import { registerHooks } from "node:module";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const projectRoot = new URL("../", import.meta.url);

function isFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

/** Try the extensionless forms TypeScript allows, in the order it allows them. */
function resolveAliasTarget(subpath) {
  const candidates = [
    new URL(`src/${subpath}`, projectRoot),
    new URL(`src/${subpath}.ts`, projectRoot),
    new URL(`src/${subpath}.tsx`, projectRoot),
    new URL(`src/${subpath}/index.ts`, projectRoot),
  ];

  return candidates.find(isFile);
}

/** Same extensionless forms, resolved against the importing module rather than `src/`. */
function resolveRelativeTarget(specifier, parentURL) {
  const candidates = [
    new URL(specifier, parentURL),
    new URL(`${specifier}.ts`, parentURL),
    new URL(`${specifier}.tsx`, parentURL),
    new URL(`${specifier}/index.ts`, parentURL),
  ];

  return candidates.find(isFile);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = resolveAliasTarget(specifier.slice(2));
      if (!target) {
        throw new Error(`Cannot resolve alias "${specifier}" under src/`);
      }
      return { url: target.href, shortCircuit: true };
    }

    // Relative specifiers resolve directly whenever they already carry a
    // real extension (the common case) — only fall back to the bundler-style
    // extensionless search when Node's own resolution fails.
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const target = resolveRelativeTarget(specifier, context.parentURL);
        if (!target) throw error;
        return { url: target.href, shortCircuit: true };
      }
    }

    return nextResolve(specifier, context);
  },
});
