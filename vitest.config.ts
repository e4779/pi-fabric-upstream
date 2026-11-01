import { defineConfig } from "vitest/config";
import { clearInheritedFabricEnv } from "./scripts/test-env.js";
import { isolatedTestTemp } from "./scripts/test-temp.js";

// Workers fork from this process, so they never see a parent Fabric run.
clearInheritedFabricEnv(process.env);

export default defineConfig({
  test: {
    environment: "node",
    env: isolatedTestTemp("pi-fabric-vitest-"),
    include: ["tests/**/*.test.ts"],
    maxWorkers: 2,
    // Real worker processes and cold TypeScript compilers share this suite.
    // Behavioral timeouts and performance budgets remain asserted by tests.
    testTimeout: 15_000,
    restoreMocks: true,
  },
});
