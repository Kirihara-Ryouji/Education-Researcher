import { defineConfig } from "vitest/config";

// Runtime integration tests create many short-lived processes and copy the
// bundled skill tree. On Windows, parallel workers contend for those files and
// can exceed their deadlines; keep the normal parallel pool on other systems.
export default defineConfig({
  test: {
    ...(process.platform === "win32" ? { maxWorkers: 1 } : {}),
  },
});
