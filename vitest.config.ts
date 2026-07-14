import { defineConfig } from "vitest/config";
import path from "path";

// Vitest config for the arbitrage module's pure-logic unit tests. Maps the "@/"
// alias to src/ so tests import the same way the app does.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
