import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Typed routes stay off while navigation targets come from mock fixtures as
  // plain strings. Turn on once routes are generated from typed helpers.
  typedRoutes: false,
};

export default nextConfig;
