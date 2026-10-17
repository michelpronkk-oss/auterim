import { task } from "@trigger.dev/sdk";
import { syncSearchConsole } from "@/lib/growth-v2/feedback";
import { isSearchConsoleConfigured } from "@/lib/growth-v2/search-console";

export const syncSearchConsoleTask = task({
  id: "sync-auterim-search-console",
  run: async () => {
    if (!isSearchConsoleConfigured()) return { status: "not_configured" };
    return syncSearchConsole();
  },
});
