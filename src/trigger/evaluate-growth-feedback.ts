import { task } from "@trigger.dev/sdk";
import { evaluateGrowthFeedback } from "@/lib/growth-v2/feedback";

export const evaluateGrowthFeedbackTask = task({
  id: "evaluate-growth-feedback",
  run: async () => {
    return evaluateGrowthFeedback();
  },
});
