import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for production Docker / Railway standalone image
  output: "standalone",
  serverExternalPackages: ["exceljs"],
};

export default nextConfig;
