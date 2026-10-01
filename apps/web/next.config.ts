import type { NextConfig } from "next";

const API = process.env.REELFLOW_API_URL ?? "http://127.0.0.1:4000";

const config: NextConfig = {
  transpilePackages: ["@reelflow/ui", "@reelflow/types"],
  poweredByHeader: false,
  // Dev server only: allow the loopback IP as well as "localhost".
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    // Instagram login waits for the ingestion engine (proxy check, paced requests, 2FA):
    // the default 30 s rewrite timeout cuts it off with "socket hang up".
    proxyTimeout: 5 * 60_000,
  },
  // Same-origin API: the session cookie is SameSite=Strict and never crosses origins.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
