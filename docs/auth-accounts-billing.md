# Auth, accounts, plans, and billing

## Authentication and workspaces

Supabase Auth provides signup with email verification, login, logout, password recovery, password reset, and a safe same-origin auth callback. The browser uses the public Supabase URL and anon key. Account API routes verify the Supabase access token server-side; service-role credentials and Dodo credentials remain server-side. Workspace records are isolated by membership and RLS. Billing mutations require an owner or admin.

After verification, an authenticated user can create or resume a workspace through the idempotent onboarding start operation. The account read model resumes the saved onboarding state and returns its dependencies, coverage, activation state, billing status, and initial assessment together.

## Activation trial

Signup and workspace creation do not start a trial. The first successful `activate_workspace_protection` transaction changes onboarding to active. A database trigger creates one Pro trial beginning at that activation timestamp and ending exactly five days later. Replayed activation returns the same activation and subscription. Failed activation creates no trial. Historical active workspaces receive a trial record anchored to their original activation timestamp, so migration time cannot grant a new trial.

Activation also stores an initial assessment derived from actual tenant records and global catalog/snapshot records at the activation watermark. It reports zero where no evidence exists. Shared snapshots remain global; no snapshot bodies or tenant copies are created. A source with no baseline remains eligible for the existing shared scan queue.

## Plans and capabilities

`src/lib/billing/plan-catalog.ts` is the canonical plan and quota definition:

| Plan     | Monthly price | Included access                                                                                                  |
| -------- | ------------: | ---------------------------------------------------------------------------------------------------------------- |
| Core     |           $29 | Dependency monitoring, customer impact, protection reports; no repository connection, Preflight, or Generate Fix |
| Pro      |           $79 | Core plus repository connections, automatic Preflight, and Generate Fix                                          |
| Business |          $199 | Pro plus automatic remediation and automated Draft PR preparation; no auto-merge or deployment                   |

Capabilities and usage limits are resolved centrally from the server-side billing snapshot. Routes and background execution recheck paid capabilities. Existing records remain stored when a plan expires or is downgraded. After an unpaid Pro trial expires, paid execution locks and the owner/admin can select a plan. Past-due subscriptions get a bounded seven-day read grace; automated execution is paused during grace.

## Dodo billing

The browser submits internal plan slugs only. Server configuration maps those slugs to `DODO_PRODUCT_CORE_MONTHLY`, `DODO_PRODUCT_PRO_MONTHLY`, and `DODO_PRODUCT_BUSINESS_MONTHLY`; product identifiers or plan names supplied by a client are never trusted. Checkout and portal operations require workspace owner/admin membership. Subscription state changes only from signature-verified Dodo webhooks. Event receipts store identifiers and processing status, not raw payloads. Duplicate and stale provider events are safe to replay and cannot overwrite newer state.

Set `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY`, the three product IDs, and `DODO_PAYMENTS_ENVIRONMENT` in the server environment. Never prefix these values with `NEXT_PUBLIC_`. Tests use fixtures and make no payment-provider calls. Use the provider's test environment for manual checkout verification.

## Repository and execution gates

Repository connections and protection selection require Pro-or-higher access. Preflight entitlement is checked when assessments or repository links enqueue work, before Trigger dispatch, before run claims, and before results are persisted. Expired, Core, on-hold, or past-due work cannot start or finish paid Preflight execution. Existing findings remain readable under workspace membership. Generate Fix proposal creation requires Pro-or-higher access.

No live payment, Trigger deployment, or Vercel deployment is performed by the local test suite.
