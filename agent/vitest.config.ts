import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each test file gets an isolated process; DB tests use in-memory or tmp files.
    isolate: true,
  },
});
