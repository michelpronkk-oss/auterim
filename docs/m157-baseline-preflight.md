# M15.7 baseline Preflight

Auterim has two Preflight modes. A `change` Preflight remains tied to an existing
material customer impact and continues to produce the existing repository
findings. A `baseline` Preflight is explicitly started by a workspace owner or
admin for a protected Product and an actively mapped, available GitHub
repository.

Baseline verification reads the repository's current default-branch HEAD through
the existing GitHub App provider. It records the repository identity, exact
commit SHA, verification state, and observation time. It does not create a
provider change, impact assessment, customer exposure finding, or change
notification. Repeating a request for the same Product, repository, and commit
returns the same completed run and evidence.

The run is stored with `preflight_mode = 'baseline'`, no impact assessment, and
no `verified_impact`. The evidence row explicitly identifies its Product and
repository. Only the trusted server RPC can write it; authorized workspace
members can read it through the Product protection read model. Customer-facing
Product flows label it as a repository baseline, separate from provider-change
Preflight.

Deployment correlation may use this evidence only when the Product and its
repository mapping are still protected/active, the evidence is verified, and the
exact commit SHA matches the authoritative current Production deployment.
Baseline evidence can therefore support `production_verified` without
fabricating a provider incident, while change-driven Preflight remains
unchanged.
