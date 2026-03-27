/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // ffjavascript → web-worker uses dynamic require(); harmless but noisy in dev/build logs.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      { module: /node_modules[\\/]web-worker/ },
    ];

    // Allow importing UIDAI cert assets (existing flow).
    config.module.rules.push({
      test: /\.cer$/i,
      type: "asset/source",
    });

    // Some browser-only libraries have optional Node paths. Ensure webpack never tries to polyfill them.
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      fs: false,
      path: false,
      os: false,
      crypto: false,
      stream: false,
      encoding: false,
    };

    return config;
  },
};

module.exports = nextConfig