import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  async redirects() {
    return [{ source: "/subprocessors", destination: "/privacy#providers", permanent: true }];
  },
};

export default nextConfig;
