import { schedules } from "@trigger.dev/sdk";
import { syncSearchConsole } from "@/lib/growth-v2/feedback";
import { isSearchConsoleConfigured } from "@/lib/growth-v2/search-console";

export const syncSearchConsoleTask = schedules.task({
  id: "sync-auterim-search-console",
  cron: { pattern: "30 3 * * *", timezone: "UTC" },
  run: async () => {
    if (!isSearchConsoleConfigured()) return { status: "not_configured" };
    return syncSearchConsole();
  },
});
