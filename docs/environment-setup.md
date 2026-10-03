# Environment setup

The local environment check reads only this project's `.env.local`; it does not inspect inherited machine variables, discover projects, or make network calls.

## Supabase identity and secrets

1. Confirm the selected Supabase dashboard project is Auterim.
2. Copy only the dedicated Auterim project URL and key values.
3. Add them to `Auterim/.env.local` using `.env.example` as a guide. Use the publishable key for `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; keep the secret/service-role key in a server-only variable.
4. Confirm no Wanterest URL or project ref appears anywhere in Auterim.
5. Run `npm run project:check` and `npm run env:check` before any database operation.
6. The database source of truth is the SQL migration under `supabase/migrations/`.
7. Verify the project ref before any remote migration. Do not use project discovery or automatic linking.

> Never use Supabase projects discovered automatically through ChatGPT/Desktop integrations for Auterim database operations.

The Supabase client convention is a publishable key for browser-facing use and a secret key for privileged server-side use. The app also recognizes the legacy `SUPABASE_SERVICE_ROLE_KEY` name for compatibility. Never prefix the privileged key with `NEXT_PUBLIC_`. The monitoring repository is server-only and uses only the local Auterim URL and server secret.

Semantic classification is optional. For live OpenAI classification, set `OPENAI_API_KEY`, `AUTERIM_CLASSIFIER_PROVIDER=openai`, and `AUTERIM_CLASSIFIER_MODEL` in this repository's `.env.local`. Keep the key server-only; do not use a `NEXT_PUBLIC_` prefix. Offline tests/evaluation use deterministic fakes. `npm run env:check` reports whether the combination is configured and prints only provider/model names, never the key. The key is not discovered from other repositories or machine-wide configuration.

No real credentials belong in `.env.example` or Git. `npm run env:check` reports configuration presence and a redacted project identifier from `.env.local` without printing key values.

## Other integrations

`TRIGGER_SECRET_KEY` is used by Trigger.dev when the configured Auterim project runs the daily dispatcher, source scan, and classification tasks. `RESEND_API_KEY` remains unconfigured and no email is sent. No Vercel deployment is required.
