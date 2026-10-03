import { schedules } from "@trigger.dev/sdk";
import { dispatchCustomerImpactTask } from "@/trigger/dispatch-customer-impact";

export const dispatchCustomerImpactQueue = schedules.task({
  id: "dispatch-customer-impact-queue",
  cron: { pattern: "*/15 * * * *", timezone: "UTC" },
  run: async () => dispatchCustomerImpactTask.trigger({}),
});
