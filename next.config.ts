import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for production Docker / Railway standalone image
  output: "standalone",
  serverExternalPackages: ["exceljs"],
  eslint: {
    // Lint errors in the pipeline code should not block production builds.
    // Run `npm run lint` separately in CI to catch these.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
