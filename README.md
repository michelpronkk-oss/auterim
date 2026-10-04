# Auterim

Auterim helps companies know when the tools they depend on change—before those changes become their problem.

## Local development

Requirements: Node.js 22 or newer and npm.

```bash
npm install
npm run dev
```

The `/app` route remains a product shell. Milestone 2 adds the database foundation and a server-side source-monitoring pipeline; it does not add sign-in screens or customer workflows.

## Safety and validation

```bash
npm run project:check
npm run env:check
npm run lint
npm run typecheck
npm run test:run
npm run build
npm run format:check
```

## Customer impact evaluation

Run `npm run eval:impact` for deterministic offline coverage. `npm run eval:impact:live` is opt-in and makes up to three paid OpenAI calls using only this repository's configured key and model; run it only when that configuration is intended for live evaluation.

Run the identity and environment checks before any Supabase, Trigger.dev, GitHub, or deployment operation. The checks inspect only this checkout's configuration, make no remote calls, and never print secret values.

## Architecture

- [Architecture and security boundaries](docs/architecture.md)
- [Database migration and operational notes](docs/database-plan.md)
- [Environment setup](docs/environment-setup.md)
- [Public URL dependency discovery](docs/url-dependency-discovery.md)

The migration under `supabase/migrations/` is the database source of truth. The OpenAI dependency and pricing source are seeded there. Trigger.dev contains one daily dispatcher and one source scan task; automated tests use controlled content and an in-memory Postgres engine.
