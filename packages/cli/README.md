# Auterim CLI

The Auterim CLI analyzes dependency indicators locally and can submit derived metadata to an Auterim Protected Product after browser authorization and explicit terminal consent.

This package is a private release candidate. It is not published to npm.

## Requirements

Node.js 22.6 or newer.

## Commands

```sh
npx auterim connect
auterim connect --dry-run
auterim --help
auterim --version
```

`connect --dry-run` is offline and does not require authorization. Connected mode uses `https://auterim.com` by default. `--server` is intended for loopback development only.

The scanner does not execute project code or make network requests. It reads bounded local metadata such as package manifests, selected configuration files, and import references. It does not upload source files, environment values, or credentials. With explicit consent, it may upload derived provider candidates, evidence-family summaries, safe relative paths, the project folder name, and sanitized Git remote identity. Review that summary before submitting.

Browser authorization binds the CLI session to a workspace and Product selected by an authenticated owner/admin. A new authorization is required for every connection attempt. The CLI does not persist ingestion credentials, browser cookies, or the selected Product.

Local state contains an opaque random project ID and the last successful local scan timestamp only. The config filename is a local-only SHA-256 hash of the resolved project path; the path and hash are not sent to Auterim. This is a convenience marker, never used for authorization. Delete the matching state file to reset local recognition.

Known local candidates remain unconfirmed until a workspace member explicitly adds the dependency from the Product view. Unknown candidates remain review-only and do not create catalog entries or monitoring coverage.

## Exit codes

- `0`: completed successfully, or offline dry-run completed.
- `1`: configuration, interaction, or internal failure.
- `2`: invalid command or origin.
- `3`: user declined submission.
- `4`: authorization failed or expired.
- `5`: local scan failed.
- `6`: remote submission failed.
- `130`: interrupted with Ctrl+C.

Piped/CI runs do not start a connection because upload requires an interactive consent prompt. If browser opening is unavailable, copy the printed Auterim approval URL into a browser.

## Network and retry behavior

The scanner makes zero network requests. Connected CLI requests go only to Auterim to create a session, poll for approval, cancel an incomplete session, and submit the reviewed payload. A submission is not reported as successful until Auterim confirms it. If a submission response is ambiguous, start a fresh connection and scan; the CLI does not maintain a durable retry queue.

This package's CLI version, payload schema version, scanner version, and provider registry version are independent compatibility values. See `docs/cli-product-discovery.md` in the Auterim repository for the full protocol and release policy.
