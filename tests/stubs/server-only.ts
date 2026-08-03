/**
 * Stand-in for the `server-only` marker package under Vitest.
 *
 * `server-only` deliberately throws on import outside React's `react-server`
 * condition — that is the whole point of it, and it is what makes importing the
 * token vault from a client component a build failure rather than a leaked key.
 * Vitest runs in plain Node, where it would throw for the wrong reason.
 *
 * Aliasing it here gives the test runner the same empty module Next's server
 * build gets. The production guarantee is untouched; only the runner is taught
 * about it. See `resolve.alias` in vitest.config.mts.
 */
export {};
