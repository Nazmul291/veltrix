/// <reference types="vitest/config" />
import { vitePlugin as remix } from "@remix-run/dev";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    tailwindcss(),
    !process.env.VITEST &&
      remix({
        future: {
          v3_fetcherPersist: true,
          v3_relativeSplatPath: true,
          v3_throwAbortReason: true,
          v3_lazyRouteDiscovery: true,
        },
      }),
    tsconfigPaths(),
  ],
  test: {
    // The integration suites share one TEST_DATABASE_URL and TRUNCATE it, so test files run one at a time.
    fileParallelism: false,
  },
});
