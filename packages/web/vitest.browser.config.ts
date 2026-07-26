import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    "process.env.NEXT_PUBLIC_TLDRAW_LICENSE_KEY": "undefined",
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  test: {
    include: ["src/**/*.browser.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium", viewport: { width: 1440, height: 900 } }],
    },
  },
});
