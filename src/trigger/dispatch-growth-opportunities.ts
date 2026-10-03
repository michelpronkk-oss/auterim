import { schedules } from "@trigger.dev/sdk";
import { dispatchGrowthOpportunityEvaluation } from "@/lib/growth/dispatch";

/** A bounded global queue worker; tenant data and tenant fan-out are not involved. */
export const dispatchGrowthOpportunities = schedules.task({
  id: "dispatch-growth-opportunities",
  cron: { pattern: "*/15 * * * *", timezone: "UTC" },
  run: async () => dispatchGrowthOpportunityEvaluation({ limit: 25 }),
});
