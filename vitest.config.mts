import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Vite resolves the `@/*` paths from tsconfig.json natively, so no plugin.
    tsconfigPaths: true,
    alias: {
      // `server-only` throws on import outside React's react-server condition.
      // That is what makes importing the token vault from a client component a
      // build error, so it stays — but Vitest runs in plain Node, where it
      // would throw for the wrong reason. The stub is the same empty module
      // Next's server build receives.
      "server-only": fileURLToPath(
        new URL("./tests/stubs/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    // Node environment throughout: every suite exercises domain schemas,
    // repositories, permissions, connectors, or server actions. None need a DOM.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
  },
});
