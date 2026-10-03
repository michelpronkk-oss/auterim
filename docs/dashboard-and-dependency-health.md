# Dashboard and dependency health

Milestone 12 adds the authenticated product surfaces under `/app`: Today, Dependencies, dependency detail, Changes, change detail, Actions, Notifications, and Settings. These pages use the existing workspace-authenticated protection, notification, connector, entitlement, and billing APIs. The browser sends the signed-in Supabase access token to those APIs; tenant authorization remains server-side. The public Supabase URL and publishable key are referenced directly for Next.js browser-bundle substitution; privileged Supabase secrets stay server-side.

## Read models and evidence

Today uses the protection summary, coverage RPC, current relevant changes, pending actions, and verified deadlines. Dependencies uses the bounded dependency overview. Detail routes return only records belonging to the selected workspace and require an authenticated workspace member. Change detail distinguishes the customer impact assessment from repository verification and only returns an assessed impact for a currently monitored dependency and classified source change.

Dependency health is customer-specific evidence language, not provider uptime. The list may report attention required, an access issue, incomplete coverage, pending baseline, no relevant change identified, monitoring evidence available, monitoring unavailable, or unknown. “No relevant change identified” means the available monitoring evidence has not identified a relevant change; it does not mean the provider is available or healthy. The UI does not invent a provider incident feed or runtime signal.

Global source snapshots remain global. Detail pages show source catalog entries and available shared baseline timestamps without copying source bodies into workspace records. Missing baseline evidence remains visible as pending.

## Product interactions

- Dependency and change details are backed by workspace-scoped API routes.
- Actions link to the related change assessment when one exists. Entitlement decisions remain in server-side action/read APIs.
- Notifications use the existing notification list and mark-read APIs.
- Settings use the existing connector read model, OAuth start and disconnect operations, and notification preference persistence. Provider credentials are not returned to the UI.
- Workspace switching stores only the selected workspace ID locally; workspace names and access are loaded from authenticated account APIs.
- Mobile navigation remains available at the bottom edge and desktop navigation remains in the side rail.

The dashboard does not add database tables, background scans, provider polling, email delivery, or new monitoring behavior.
