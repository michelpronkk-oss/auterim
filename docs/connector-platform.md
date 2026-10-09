# Connector platform V1

Auterim connectors share one workspace-scoped installation, capability, resource, credential, health, and audit model. Provider-specific HTTP and OAuth behavior stays in server-only adapters. Slack provides delivery, Linear explicit engineering action, Sentry bounded runtime context, and Vercel deployment context; GitHub is mapped into the shared capability/read model while its existing App and Preflight storage remain unchanged.

## Capabilities and lifecycle

The central provider catalog declares capabilities such as `CAN_VERIFY`, `CAN_RECEIVE_ALERTS`, `CAN_CREATE_ACTIONS`, `CAN_READ_RUNTIME_CONTEXT`, and `CAN_READ_DEPLOYMENT_CONTEXT`. Product operations gate on capability entitlements and workspace permissions, not provider-name checks scattered across domains. Current mapping: GitHub verifies repositories, Slack receives alerts, Linear creates actions, Sentry reads runtime context, and Vercel reads deployment metadata.

An installation moves through `authorizing`, `connected`, `degraded`, `reauth_required`, `revoked`, and `disconnected`. Health separately records `healthy`, `degraded`, `provider_unavailable`, `permission_missing`, `resource_missing`, `reauth_required`, and `revoked`. Transient network/rate-limit failures do not revoke access. Security-relevant transitions append bounded audit metadata; provider bodies and credentials are never audit data.

## OAuth and credentials

Slack uses OAuth v2 with a server-side authorization-code exchange and the documented bot scopes `channels:read` and `chat:write`. Linear and Sentry use authorization code with PKCE S256 and least-privilege scopes (`read,issues:create` and `org:read,project:read,event:read`). Each flow uses 256-bit random state and a separate HttpOnly, SameSite=Lax browser binding; only hashes are stored. State binds provider, workspace, actor, expiry, and claim token. Callback rechecks the bound actor's current owner/admin membership and entitlement, and claims state atomically before exchanging the code. Redirect URIs are checked against the exact configured application callback URL.

Tokens and the short-lived PKCE verifier are encrypted server-side with AES-256-GCM. AAD binds ciphertext to workspace/provider/account or OAuth state. `CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS` is a JSON version-to-base64-key ring and `CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION` selects the active version. Keep prior key versions during rotation until credentials are re-encrypted. Credential rows have no client grants or readable RLS policy. APIs and logs expose no token values.

Vercel uses its external Integration authorization callback and exchanges the one-time code server-side. The callback reads the installation configuration and verifies its ID, team/personal scope, selected project scope, and required read-only API scopes before persisting encrypted credentials. The server rechecks current project selection before cataloging or syncing. Project/deployment/domain/configuration read scopes are required; environment-variable scopes are never requested or used. See [deployment surfaces](deployment-surfaces.md) for current Production verification semantics.

## Resources and health

`connector_resources` holds bounded safe identifiers, display names, allowlisted metadata, selection, and access state. Slack lists public channels only and filters to channels the bot can access; it does not read message history. Linear discovers teams with bounded GraphQL pagination. Sentry discovers up to 100 projects and queries at most five selected projects with at most 50 unresolved issues per project in a 24-hour window. Event details, stack traces, request data, and PII are not persisted. Missing required scopes disable the provider capability and surface a reconnect/permission state. Refresh is lazy, leased, and credential-version compare-and-swapped; provider outages remain recoverable.

Vercel project resources are listed within the authorized installation scope with a 100-project bound and are not Product mappings until a selected project is synced and its repository identity matches an already protected Product repository. Deployment observations are bounded to 20 recent records per selected project and exclude environment variables, build logs, and raw provider payloads.

Safe provider errors normalize to `AUTH_REQUIRED`, `PERMISSION_MISSING`, `RESOURCE_NOT_FOUND`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `INVALID_REQUEST`, `TRANSIENT`, or `UNKNOWN_SAFE`. Retries are bounded; provider response bodies are not surfaced.

## Provider operations

### Slack delivery

Slack extends the existing M9 notification preference and `notification_deliveries` queue. A workspace admin selects one public channel and opts into Slack delivery. The existing notification policy, paid-plan gate, connection health, and selected resource are rechecked before delivery. Messages are short, omit source bodies/secrets, disable unfurls, and carry a stable delivery ID to reduce duplicate intent. No general Slack ingestion is implemented.

### Linear action creation

Linear issue creation is an explicit authenticated product action on a verified Preflight finding, gated by the canonical Pro entitlement. The operation creates a unique Auterim-to-Linear mapping before calling Linear; ambiguous results require review rather than blindly retrying. The issue contains a short grounded summary, safe repository reference, and Auterim link, never source contents or environment values.

### Sentry runtime context

Sentry provides bounded structured issue metadata for an authorized impact assessment. Correlation classes are `runtime_signal_found`, `runtime_signal_not_found`, and `runtime_signal_inconclusive`. Timing alone is insufficient; a provider/library identifier must match a bounded error type. Product language reports a related signal, never causality. Historical signal records remain available after disconnect.

## Entitlements and authorization

The existing canonical entitlement engine owns plan decisions: paid Core supports Slack delivery; Pro and Business support Slack, GitHub verification, Linear actions, Sentry runtime context, and Vercel deployment context. Vercel reuses the existing repository protection entitlement and quota rather than adding a plan or quota. Each server operation checks authenticated workspace membership, role where required, entitlement, connector capability, installation/resource ownership, and provider health. Connect, reconnect, disconnect, and resource selection require owner/admin. Safe status/resources are member-readable through RLS. Credentials, authorization state, and mutation RPCs are service-only. Composite foreign keys prevent cross-workspace installation/resource associations.

## Adding a connector

Add provider and capability catalog entries, a server-only adapter implementing only the needed OAuth/refresh/revoke/resource/capability operations, minimal scopes, safe resource metadata, normalized error handling, entitlement mapping in the central plan catalog, and bounded tests. Reuse the shared lifecycle, credential envelope, resource, health, and audit tables. Do not add provider-specific lifecycle tables unless a documented provider feature cannot fit the shared model. Add provider-specific docs and tests for callback binding, RLS isolation, pagination, idempotency, revocation, and failure recovery.
