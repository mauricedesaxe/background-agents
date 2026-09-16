import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(
  () => "/skills/import/bulk/preview",
  "preview bulk skill import"
);
