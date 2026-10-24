# M15.79 migration connection trust

## Verified diagnosis

Run 40130090521 failed before the bounded transaction began. Its old error handler
suppressed the underlying connection code. A separate authorized read-only diagnostic
using the same target and driver returned `SELF_SIGNED_CERT_IN_CHAIN`. Supplying the
official Supabase CA, with certificate and hostname verification enabled, succeeded:
TLS 1.3, `authorized=true`, database/login/role `postgres`, transaction read-only `on`.
This identifies the missing trust anchor; the diagnostic did not change pooler settings,
credentials, database configuration, schema, data or migration history. The original
workflow has not been retried.

## Authenticated source and pin

Supabase Studio's production certificate-download URL is defined in its
[vendor source at commit 7e866ef83e89e35cdda45a6c98abd069d5fa1b2f](https://github.com/supabase/supabase/blob/7e866ef83e89e35cdda45a6c98abd069d5fa1b2f/apps/studio/hooks/custom-content/custom-content.json).
Its [SSL settings component](https://github.com/supabase/supabase/blob/7e866ef83e89e35cdda45a6c98abd069d5fa1b2f/apps/studio/components/interfaces/Settings/Database/SSLConfiguration.tsx)
selects the `prod` certificate. The public certificate was downloaded from
`https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`
over authenticated HTTPS, with normal certificate/hostname verification and redirects
rejected. Authentication here is of the vendor HTTPS server; the public CA needs no
account credential. It was not obtained from an unverified database handshake.

The vendored certificate is `scripts/certs/supabase-prod-ca-2021.crt`:

- Subject/issuer: Supabase Root 2021 CA, Supabase Inc.
- Validity: 2021-04-28 10:56:53 UTC through 2031-04-26 10:56:53 UTC.
- SHA-256 of DER: `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`.

The helper checks the exact DER pin, CA/self-signature and validity period before use.
Only this trust anchor is supplied to this connection. SNI targets the validated pooler
hostname, Node's normal hostname verifier remains active, and TLS 1.2 or newer is required.
The connected socket must report authorized TLS. There is no runtime certificate download,
trust-on-first-use, insecure fallback or retry. Rotation requires vendor-source verification,
an explicit pin update in a reviewed PR, CI and a separately authorized plan-only run.

## Evidence and unchanged gates

Connection failures print only a fixed allowlist of error codes. Raw messages, stacks,
URLs, query parameters, password values and arbitrary codes are never printed. Successful
TLS reports only the public CA pin, protocol and verified-hostname status.

The exact migration SHA-256 remains
`e761b0d8e22acffd92bb1a5dcb44cb050679791a4cd392e7381b1d2799d55cef`.
The 5s lock, 30s statement and 60s transaction timeouts, atomic schema/history transaction,
project/SHA/history checks, plan/apply separation and reviewer approval gates are unchanged.
Production runner validation still requires a new, separately authorized plan after merge.

## Disposable tests

`tests/fixtures/migration-tls/` contains a fake localhost CA, leaf certificates and a fake
server private key solely for loopback TLS tests. These are public test fixtures and cannot
authenticate a Production server. The CA signing key is not committed. Tests exercise trusted,
untrusted, expired and wrong-host certificates with the same strict TLS options as the helper.
No test uses a Production password or connects to a hosted database.
