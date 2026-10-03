import { schedules } from "@trigger.dev/sdk";
import { evaluateGrowthFeedback } from "@/lib/growth-v2/feedback";

export const evaluateGrowthFeedbackTask = schedules.task({
  id: "evaluate-growth-feedback",
  cron: { pattern: "0 4 * * *", timezone: "UTC" },
  run: async () => {
    return evaluateGrowthFeedback();
  },
});
