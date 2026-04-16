import type { NextConfig } from "next";

const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:4001";

const allowedDevOrigins = process.env.ALLOWED_DEV_ORIGINS
  ? process.env.ALLOWED_DEV_ORIGINS.split(",").map((s) => s.trim())
  : [];

const defaultDevOrigins = ["43.156.29.117"];

const nextConfig: NextConfig = {
  allowedDevOrigins: Array.from(
    new Set([...defaultDevOrigins, ...allowedDevOrigins].filter(Boolean)),
  ),
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiProxyTarget}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
