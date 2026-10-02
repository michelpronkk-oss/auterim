# Auterim

Auterim helps companies know when the tools they depend on change—before those changes become their problem.

This repository is the local application foundation: Next.js App Router, strict TypeScript, Tailwind CSS, environment validation, and safe integration boundaries. Database implementation and all remote service connections are intentionally deferred.

## Requirements

- Node.js 22 or newer
- npm

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. The `/app` route is a product shell placeholder; authentication and dependency tracking are not implemented.

## Validation commands

```bash
npm run lint
npm run typecheck
npm run test:run
npm run build
npm run env:check
```

`npm run env:check` reads only this project's `.env.local`. It validates values without printing secrets and does not make remote requests.

## Environment

Copy `.env.example` to `.env.local` when configuring a local integration. Do not put privileged values in `NEXT_PUBLIC_` variables. See [environment setup](docs/environment-setup.md) before configuring the dedicated Auterim Supabase project.

## Architecture

See [architecture](docs/architecture.md) and the design-only [database plan](docs/database-plan.md). No schema, migrations, or SQL are included in this milestone.
