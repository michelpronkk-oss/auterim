import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    // Local release worktrees and validation fixtures are not part of this checkout.
    "release-worktrees/**",
    ".m157-clean-validation/**",
    // Trigger.dev bundles third-party dependencies here; lint authored task sources only.
    ".trigger/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
