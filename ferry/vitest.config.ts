import { defineConfig } from "vitest/config";

// Unit tests only; tests/e2e/*.mjs are scripts run by hand against a real daemon.
export default defineConfig({ test: { setupFiles: ["tests/i18n-setup.ts"], include: ["tests/**/*.test.ts"] } });
