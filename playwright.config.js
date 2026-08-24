import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  // Keep each file on one worker: the three WebGL lanes are serial, while the
  // portal lane delays the composite scene workflow until startup pressure falls.
  fullyParallel: false,
  workers: 4,
  forbidOnly: true,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
