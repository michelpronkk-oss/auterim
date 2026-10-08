import OpenAI from "openai";
import { captureException } from "@sentry/nextjs";

export const providerConfiguration = {
  endpoint: "https://api.openai.com/v1",
  model: "gpt-6.1-sol",
  client: OpenAI,
  captureException,
};
