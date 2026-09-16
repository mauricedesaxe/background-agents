import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(() => "/skills/import/bulk", "bulk import skills");
