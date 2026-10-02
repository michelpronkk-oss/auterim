# Environment setup

Auterim currently has no connected database or external integration. The local environment check reads only this project's `.env.local`; it does not inspect inherited machine variables, discover projects, or make network calls.

## Dedicated Supabase setup checklist

1. Confirm the selected Supabase dashboard project is Auterim.
2. Copy only the dedicated Auterim project URL and key values.
3. Add them to `Auterim/.env.local` using `.env.example` as a guide. Use the publishable key for `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; keep the secret/service-role key in a server-only variable.
4. Confirm no Wanterest URL or project ref appears anywhere in Auterim.
5. Only after confirmation may Supabase CLI linking occur.
6. Verify the project ref before any migration.
7. Never run `db push` against an unverified project.

> Never use Supabase projects discovered automatically through ChatGPT/Desktop integrations for Auterim database operations.

The current Supabase client convention is a publishable key for browser-facing use and a secret key for privileged server-side use. The app also recognizes the legacy `SUPABASE_SERVICE_ROLE_KEY` name for compatibility. Never prefix the privileged key with `NEXT_PUBLIC_`.

No real credentials belong in `.env.example` or Git. `npm run env:check` reports configuration presence and a redacted project identifier from `.env.local` without printing key values.

## Other integrations

`TRIGGER_SECRET_KEY` and `RESEND_API_KEY` can be added to `.env.local` when those services are deliberately configured for Auterim. This foundation does not authenticate to Trigger.dev, send email, or make remote calls.
