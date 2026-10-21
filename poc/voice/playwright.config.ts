import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  workers: 2,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    browserName: "chromium",
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
    trace: "off",
    screenshot: "off",
    video: "off"
  },
  webServer: [{
    command: "npm run start",
    url: "http://127.0.0.1:3000/api/poc/health",
    reuseExistingServer: false,
    env: {
      MIRAI_OFFLINE_DEMO: "1",
      LIVEKIT_URL: "",
      LIVEKIT_API_KEY: "",
      LIVEKIT_API_SECRET: "synthetic-server-only-sentinel-32chars",
      DEEPGRAM_API_KEY: "",
      SARVAM_API_KEY: "",
      POC_CONTROL_SECRET: "synthetic-control-secret-for-local-tests-only",
      POC_DEVELOPER_KEY: "synthetic-developer-key-for-local-tests-only",
      JUDGE_SESSION_SECRET: "synthetic-session-secret-for-tests-32chars",
      ADMIN_RESET_SECRET: "synthetic-admin-reset-secret-32chars",
      POC_LIVE_APPROVAL: "",
      POC_BILLING_VERIFIED: "",
      POC_SARVAM_API_VERIFIED: "",
      INTERVIEWER_MODEL: ""
    }
  }, {
    command: "cd agent && .venv/bin/python main.py --serve",
    url: "http://127.0.0.1:8001/status",
    reuseExistingServer: false,
    env: {
      POC_CONTROL_SECRET: "synthetic-control-secret-for-local-tests-only",
      POC_LIVE_APPROVAL: "",
      LIVEKIT_URL: "",
      LIVEKIT_API_KEY: "",
      LIVEKIT_API_SECRET: "",
      DEEPGRAM_API_KEY: "",
      SARVAM_API_KEY: ""
    }
  }]
});
