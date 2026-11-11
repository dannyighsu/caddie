import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["core/**/*.test.ts", "drivers/**/*.test.ts", "scripts/**/*.test.ts"] },
});
