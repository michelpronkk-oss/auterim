// Static config fixture; scanner must never evaluate this file.
const config = {
  framework: "nextjs",
  runtime: "nodejs",
  metadata: { provider: "openai", apiHost: "api.openai.com", model: "gpt-6.1-sol" },
};

export default config;
