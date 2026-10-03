<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- TRIGGER.DEV SKILLS START -->
## Trigger.dev skills

This project has Trigger.dev skills installed in `.agents/skills/`. Before editing a background or scheduled task, load `trigger-tasks`. Load `trigger-authoring-chat-agent` only when implementing a `chat.agent` AI agent.
<!-- TRIGGER.DEV SKILLS END -->

## Supabase remote safety

This repository is permanently linked only to the Auterim Supabase project:

lnljaacbptrubppoypaz

Before any remote Supabase mutation:

1. Read `supabase/.temp/project-ref`.
2. It MUST equal exactly `lnljaacbptrubppoypaz`.
3. Run `npm run project:check`.
4. Run `supabase db push --dry-run` before `supabase db push`.

If the linked project ref differs, STOP.

Never run:
- `supabase projects list` to choose a target
- `supabase db reset --linked`
- destructive remote reset commands

Never relink this repository to another Supabase project.
Never access Wanterest Supabase resources.


## Trigger.dev remote safety

This repository is permanently associated only with the Auterim Trigger.dev project:

proj_hwqtxtyrvwykjirkrdoh

Before any remote Trigger.dev mutation, deploy, task run, schedule change, or environment operation:

1. Read `trigger.config.ts`.
2. The project MUST equal exactly `proj_hwqtxtyrvwykjirkrdoh`.
3. Run `npm run project:check`.
4. Confirm the current working directory is the Auterim repository.
5. Load `.agents/skills/trigger-tasks/SKILL.md` before editing or deploying Trigger.dev tasks.

If the Trigger.dev project differs, is missing, or is ambiguous, STOP.

Never:
- use account-wide project discovery to choose a Trigger.dev project
- deploy to another Trigger.dev project
- modify another project's tasks, schedules, environments, or secrets
- reuse Wanterest Trigger.dev configuration
- access Wanterest Trigger.dev resources

The presence of an account-level `TRIGGER_ACCESS_TOKEN` does not authorize using any project except:

proj_hwqtxtyrvwykjirkrdoh