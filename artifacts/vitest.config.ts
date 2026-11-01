import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The ACL and cookie logic are plain TS with WebCrypto — no Workers runtime
    // needed, so these run offline in CI. The end-to-end guarantee is covered
    // against a deployed Worker by scripts/guard.ts.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
