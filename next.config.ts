import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The apex is the only canonical host. www.lia.bond stays in DNS so old
  // links resolve, but every request to it is sent to lia.bond permanently.
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.lia.bond" }],
        destination: "https://lia.bond/:path*",
        permanent: true,
      },
    ];
  },
  // Typed routes stay off while navigation targets come from mock fixtures as
  // plain strings. Turn on once routes are generated from typed helpers.
  typedRoutes: false,
  experimental: {
    serverActions: {
      // The help form attaches screenshots and screen recordings, capped at
      // 20 MB in total by `@/lib/support/help-attachments`. The default is 1 MB,
      // which a single phone screenshot can clear. The headroom covers the
      // multipart framing; raise both numbers together or neither.
      bodySizeLimit: "24mb",
    },
  },
};

export default nextConfig;
