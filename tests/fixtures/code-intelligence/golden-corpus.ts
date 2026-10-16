import type { SnapshotFile } from "@/lib/code-intelligence/analyzer";

export type GoldenCodeCase = {
  name: string;
  files: SnapshotFile[];
  expected: {
    packages?: string[];
    imports?: string[];
    sdkCalls?: string[];
    events?: string[];
    endpoints?: string[];
    dynamicEndpoints?: number;
  };
};

export const CODE_INTELLIGENCE_GOLDEN_CORPUS: GoldenCodeCase[] = [
  {
    name: "direct package import and SDK call",
    files: [
      {
        path: "package.json",
        text: JSON.stringify({ dependencies: { openai: "^5.0.0" } }),
      },
      {
        path: "src/ai.ts",
        text: 'import OpenAI from "openai";\nconst client = new OpenAI({});\nexport async function reply() { return client.responses.create({ model: "m" }); }',
      },
    ],
    expected: {
      packages: ["openai@^5.0.0"],
      imports: ["openai"],
      sdkCalls: ["openai.responses.create"],
    },
  },
  {
    name: "aliased import, package subpath, and CommonJS require",
    files: [
      {
        path: "src/payment.ts",
        text: 'import StripeClient from "stripe";\nimport { Responses as OpenAIResponses } from "openai/resources/responses";\nconst stripe = new StripeClient("sk_live_never_store_this_secret_value_1234567890");\nstripe.webhooks.constructEvent(payload, sig, secret);\nOpenAIResponses.create({});\nconst telemetry = require("posthog-node");\ntelemetry.capture("event");',
      },
    ],
    expected: {
      imports: ["stripe", "openai/resources/responses", "posthog-node"],
      sdkCalls: [
        "stripe.webhooks.constructEvent",
        "openai.resources.responses.create",
        "posthog-node.capture",
      ],
    },
  },
  {
    name: "controlled webhook event and ignored comment",
    files: [
      {
        path: "src/webhook.ts",
        text: '// customer.subscription.deleted is only a comment\nexport function handle(event: {type: string}) { if (event.type === "customer.subscription.updated") return true; switch (event.type) { case "invoice.paid": return true; } }',
      },
    ],
    expected: { events: ["customer.subscription.updated", "invoice.paid"] },
  },
  {
    name: "static and dynamic endpoint references",
    files: [
      {
        path: "src/http.ts",
        text: 'fetch("https://" + "api.example.test/v1/items?api-version=v1");\nfetch(`${baseUrl}/v2/items`);',
      },
    ],
    expected: {
      endpoints: ["https://api.example.test/v1/items?api-version=v1"],
      dynamicEndpoints: 1,
    },
  },
  {
    name: "environment names and package declared without import",
    files: [
      {
        path: "package.json",
        text: JSON.stringify({
          dependencies: { "@sentry/node": "^9.0.0" },
          devDependencies: { vitest: "5.0.0" },
        }),
      },
      {
        path: "src/config.ts",
        text: 'export const key = process.env.OPENAI_API_KEY;\nexport const region = process.env["AWS_REGION"];',
      },
    ],
    expected: { packages: ["@sentry/node@^9.0.0", "vitest@5.0.0"] },
  },
];
