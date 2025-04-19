// frontend_app/next.config.ts
import type { NextConfig } from "next";
import path from 'path'; // Import the 'path' module

const nextConfig = {
  output: 'standalone',
  // Add the webpack config block
  webpack(config, { isServer }) { // Add options argument if needed, like isServer
    // Define the alias
    config.resolve.alias = {
      ...config.resolve.alias, // Preserve existing aliases
      '@': path.resolve(__dirname), // Map '@' to the project root (frontend_app)
    };
    return config;
  },
  // Configure allowed origins for development
  async headers() {
    return [
      {
        source: '/_next/:path*',
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: 'http://100.121.160.49:3000',
          },
        ],
      },
    ];
  },
} as NextConfig;

export default nextConfig;
