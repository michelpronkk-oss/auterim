import { createVerificationRunnerServer } from "./server.ts";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`verification_runner_config_missing_${name.toLowerCase()}`);
  return value;
}

const port = Number(process.env.PORT ?? "8080");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
  throw new Error("verification_runner_port_invalid");

const workRoot = required("FIX_VERIFICATION_RUNNER_WORK_ROOT");
const runner = createVerificationRunnerServer({
  authSecret: required("FIX_VERIFICATION_RUNNER_AUTH_SECRET"),
  artifactOrigin: required("NEXT_PUBLIC_SUPABASE_URL"),
  cachePublicKey: required("FIX_DEPENDENCY_CACHE_PUBLIC_KEY"),
  jobStorePath: `${workRoot}/jobs`,
  workRoot,
});

await runner.listen(port, "0.0.0.0");
process.stdout.write("M15.78 verification runner listening\n");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void runner.close().finally(() => process.exit(0));
  });
}
