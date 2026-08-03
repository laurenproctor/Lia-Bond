/**
 * Teaches `node --experimental-strip-types` the `@/*` alias from tsconfig.json.
 *
 * Next.js and Vitest both resolve that alias themselves, but a plain `node`
 * invocation does not — and the seed generator is a plain node script. This is
 * ~20 lines of resolver rather than another build dependency.
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

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);

    const target = resolveAliasTarget(specifier.slice(2));
    if (!target) {
      throw new Error(`Cannot resolve alias "${specifier}" under src/`);
    }
    return { url: target.href, shortCircuit: true };
  },
});
