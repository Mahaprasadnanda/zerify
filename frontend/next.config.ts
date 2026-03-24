import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    config.module.rules.push({
      test: /\.cer$/i,
      type: "asset/source",
    });

    return config;
  },
};

export default nextConfig;
