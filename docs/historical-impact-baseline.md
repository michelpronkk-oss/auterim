# Historical impact baseline

Live customer impact remains limited to material source changes whose original `source_changes.created_at` is at or after the dependency's `protection_started_at`. Onboarding, later scans, and baseline reviews do not move either timestamp or reinterpret the global classification.

An owner or admin can explicitly request **Check recent changes** for a protected Product dependency. The server validates workspace membership, Product ownership, Product protection, and the dependency's enabled protection state. It queues only current, classified, material source changes from the 30 days immediately before `protection_started_at`. The source evidence and classification remain global and immutable; only the tenant-specific assessment is added.

Assessments and queue rows carry `evaluation_mode` (`live` or `baseline`). Baseline mode is part of the model packet and the assessment fingerprint, so a historical review cannot be mistaken for a live assessment. The worker rechecks the Product, dependency, classification, and time window immediately before persisting an assessment. A disabled dependency, archived Product, superseded classification, or out-of-window change cannot complete.

The operation is retry-safe. Repeating the same request does not create duplicate queue or assessment identities. A zero-candidate response is valid. Relevant baseline findings may enter the existing Preflight path when that path's normal eligibility rules allow it; Auterim does not force a Preflight. Baseline assessments do not create a “newly detected” customer notification, verified-risk notification, or deadline notification. The UI labels the result **Historical baseline assessment**.

The operation is exposed through the existing authenticated Product dependency API (`POST /api/products/{productId}/dependencies`, action `baseline_assessment`). The database RPC is the authorization boundary and permits only owner/admin members. Queue and assessment writes remain server-side; workspace reads continue to use existing tenant RLS.
