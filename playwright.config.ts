import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  // Route-smoke tests visit multiple pages, each with a first-time development compilation.
  timeout: 120000,
  expect: { timeout: 15000 },
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3001",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npm run dev -- --port 3001",
    url: "http://127.0.0.1:3001/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
