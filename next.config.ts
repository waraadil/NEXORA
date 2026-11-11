import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  experimental: {
    serverActions: {
      // WhatsApp text exports are routinely several MB — a year of one busy
      // chat is ~1.8 MB. The default 1 MB limit rejected those uploads before
      // the action could even run, so the import appeared to do nothing.
      // Kept in line with MAX_BYTES in conversations/import/actions.ts.
      bodySizeLimit: "30mb",
    },
  },
};

export default nextConfig;
