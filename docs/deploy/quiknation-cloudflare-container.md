# QuikNation Paperclip Cloudflare Container

The `quiknation-paperclip` Worker routes all requests to one named production Container, `quiknation-production`, on port 3100. `max_instances` is 1, the instance type is `basic`, and the idle timeout is 30 minutes. Deployment uses the root Dockerfile. Durable data belongs in the existing Neon Paperclip database and the private R2 bucket `quiknation-paperclip`; Container disk is ephemeral. Only the Container's existing S3 provider accesses R2, and its bucket setting stays `quiknation-paperclip`. The Worker has no native R2 bucket binding.

## Review and deployment gates

This change prepares deployment; it does not deploy anything. The counted independent review gate requires both **Mary (Cursor)** and **Katherine (Codex)** to PASS the same re-pinned PR head through live Orca, and CI must be green. **Gran** remains an additional reviewer, but Gran feedback does **not** satisfy the independent review gate for this commit metadata. Mo requests exact-head reviews after the final SHA is reported and then handles merge and deployment.

The latest fixes were built in the Codex harness while Git author and committer metadata inherited **Claude Opus 4.8**. Mary's clarification of that metadata determines the counted Mary/Katherine reviewer assignment. Git identity is unchanged; do not spoof identity or rewrite metadata to change reviewer eligibility. This document records the required reviewers, not received PASS verdicts.

Mary's PASS at `1b2fe042c4ef512cf2301d5531a47cfc28231841` applies only to that earlier head. The checksum/operator-user follow-up requires fresh counted exact-head PASSes.

`Deploy QuikNation Paperclip` is manual-only and runs only on `master`. Supply the full authorized master commit as `expected_sha`; the workflow rejects a mismatch with the selected workflow revision. It reruns repository checks and the Worker bundle check before the `production` environment job can assume an approved AWS OIDC role. Configure protection on that environment before using it; an environment name alone does not establish an approval gate. The workflow does not configure IAM, mint keys, provision a database, create a bucket, or delete bucket contents.

On 2026-10-06, after Mo's approval, live verification confirmed the AWS OIDC role trusts the exact GitHub OIDC subject `repo:imaginationeverywhere/paperclip:environment:production` and has the required `secretsmanager:GetSecretValue` permissions scoped to the seven approved Secrets Manager names listed below. Mo confirmed these prerequisites; this harness did not change IAM or inspect any secret values. `AWS_ROLE_ARN` names the approved role. OIDC trust and scoped reads are verified prerequisites, while deployment still requires the counted exact-head PASS reviews and green CI.

Required repository/environment variables (the names are now configured; their values were not inspected):

| Variable | Purpose |
| --- | --- |
| `AWS_ROLE_ARN` | Mo-approved role with trust for `repo:imaginationeverywhere/paperclip:environment:production` and scoped Secrets Manager read permissions |
| `AWS_REGION` | Region containing the approved Secrets Manager names |
| `PAPERCLIP_AUTH_PUBLIC_BASE_URL` | Final HTTPS Paperclip origin, with no credentials, path, query or fragment |

Public exposure requires explicit auth base-URL mode. The workflow supplies the validated public URL to Wrangler; the Container forwards it into Paperclip. Strict secret-reference mode is enabled. Local disk database backups are disabled because they would disappear on restart; backup/restore of Neon remains an operator responsibility. No migration override is configured. The existing server startup applies pending migrations when stdin/stdout are not TTY, as in the Container's Node command, so an authorized deployment can initialize an empty database. Do not start the server as a read-only schema check.

## Closed registration and first-admin bootstrap

`PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` is set in Wrangler and forwarded to the Container. Public email/password registration stays disabled throughout bootstrap and normal operation. Existing-account sign-in remains available. Never temporarily enable registration to create the first admin, and never switch the public Container to `local_trusted`.

First-admin setup is **blocked until an approved authenticated human account exists**. The existing bootstrap CLI creates a one-use **admin invitation**, not a user account. `/api/invites/:token/accept` requires an already authenticated human account before it can promote that account. A bootstrap link alone cannot register a user or bypass disabled sign-up.

1. Verify that an individually approved human Better Auth account already exists and can sign in to this instance. If no such account exists, setup remains **blocked** until a separately authorized operator uses the private account-creation procedure below. Never open registration as a workaround.
2. In an authorized private operator session with the existing runtime database connection injected securely, use an authenticated Paperclip CLI config with sign-up disabled and the correct public base URL. Run `pnpm paperclipai auth bootstrap-ceo --expires-hours 1`. Do not use `--force` for initial bootstrap. The CLI refuses to issue another initial invite when an admin already exists.
3. Deliver the generated invite link privately to the approved account owner. Treat the link as a credential; never put it or account passwords into CI logs, Git, tickets or this document. The owner signs in with their existing account and accepts the invitation before expiry.
4. Verify the human account's `instance_admin` role and required company memberships. The consumed bootstrap invite cannot be accepted again. Subsequent human invites must be issued by the authorized board and accepted by pre-provisioned, signed-in accounts; human company joins follow the existing board approval flow.

This is an operator procedure for a later authorized rollout. No account, invitation or admin-role change was made while preparing this PR. Account readiness and completed first-admin acceptance are release prerequisites, not facts established by the signup configuration test.

### Private one-time operator account creation

`scripts/create-operator-user.ts` is a private manual tool, never a CI or deployment step, and does not run migrations. Only after the target database is identified, its Better Auth tables are initialized and verified, and an operator is separately authorized to create the approved human account, supply `DATABASE_URL` securely through the private process environment. Do not put its value in shell arguments, history, tickets or logs. From the repository root, invoke:

```sh
node --import ./server/node_modules/tsx/dist/loader.mjs scripts/create-operator-user.ts \
  --email operator@example.com --name "Approved Operator"
```

Replace the example identity with the approved human's email/name. The script normalizes email, refuses an existing normalized email, and inserts the Better Auth user and `credential` account in one transaction. It locks the user table during the duplicate check/inserts because the current schema has no unique email constraint. The user is unverified and receives no admin role, company membership or session. It hashes a newly generated random initial password with the server's installed Better Auth implementation.

After commit, stdout contains exactly one JSON credential record (`email`, `name`, `password`). Stdout is sensitive: use an unrecorded private operator session, deliver the credential privately, and exclude it from terminal transcripts, logs, CI, artifacts, Git and chat. Do not use `tee`, shell tracing or combined stdout/stderr capture. The password is generated once; the script does not enforce single-use login or expiry. Rotate it after the first private sign-in. A duplicate or failed transaction emits no credential. If output fails after commit, account creation must not be retried. Complete the separate admin-invitation flow above after the account can authenticate. This tool was not run against production during this preparation.

### Live Neon schema evidence — conditional startup readiness

Mo reported safe live platform-API metadata for project **Quik Nation** (`aged-sun-91521621`), production branch `br-hidden-resonance-ae5dsb8h`, database `paperclip`, owner `neondb_owner`, created `2026-10-06T02:12Z`. Both read-only table listing and an `information_schema` query returned no application tables: this database is empty. Those results supersede the earlier project-name and brain searches that found no matching record.

Source review confirms `server/src/index.ts` calls `ensureMigrations(config.databaseUrl)`. With no migration prompt override, `promptApplyMigrations` returns true when stdin or stdout is not TTY. Docker starts Node without a TTY. For an empty database, `packages/db/src/client.ts` handles `no-migration-journal-empty-db` in `applyPendingMigrations` by applying the bundled migrations. The local journal's 49 entries through `0048_flashy_marrow` are the expected source revision, **not proof of an applied live schema**.

This is **source plus read-only Neon evidence of startup readiness, conditional on the approved runtime `DATABASE_URL` targeting that `paperclip` database**. The OIDC-only secret value was not read, so its exact host/database mapping is **not verified** and remains a release prerequisite. No migration, journal repair, operator account creation or database mutation was run. Confirm the target mapping through an authorized operator/metadata path without exposing the secret, then obtain initialized-schema proof after the separately authorized startup. Do not fetch the secret or add a CI database query to resolve this evidence gap.

## Approved secret names

The deploy script reads the following existing names only after the operator authorizes and runs the protected production workflow. Local review must use `describe-secret` metadata only, never `get-secret-value`.

| AWS Secrets Manager name | Runtime binding |
| --- | --- |
| `quik-nation/quiknation/paperclip/DATABASE_URL` | `DATABASE_URL` |
| `quik-nation/quiknation/paperclip/BETTER_AUTH_SECRET` | `BETTER_AUTH_SECRET` |
| `quik-nation/quiknation/paperclip/PAPERCLIP_AGENT_JWT_SECRET` | `PAPERCLIP_AGENT_JWT_SECRET` |
| `quik-nation/quiknation/paperclip/PAPERCLIP_SECRETS_MASTER_KEY` | `PAPERCLIP_SECRETS_MASTER_KEY` |
| `quik-nation/quiknation/paperclip/R2_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` |
| `quik-nation/quiknation/paperclip/R2_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` |
| `quik-nation/shared/CLOUDFLARE_CONTAINERS_TOKEN` | Deploy-process `CLOUDFLARE_API_TOKEN` only |

The two R2 names above are the only approved R2 credentials. Do not substitute a shared R2 credential, create keys/IAM, or widen access. Secret values never belong in Git, GitHub secrets, artifacts, or logs. During a future authorized deployment, the script uses a unique restrictive runner directory, writes the six runtime bindings to a mode-0600 secrets file, and removes temporary files on success or failure. AWS OIDC session credentials are not forwarded to the Container.

Metadata-only verification on 2026-10-06 confirmed all seven names exist in `us-east-1`, including both R2 names. This verifies existence only; values, IAM permissions, token scope and live connectivity were not inspected. No production bucket mutation was performed.

## Task environment attribution

`POST /api/companies/:companyId/issues` accepts optional `source_env` with exactly `production`, `staging`, or `develop`. Omitted or null values remain unattributed. Creation persists one company-scoped `source_env:<value>` label in the same transaction as the issue and includes the attribution in the issue-created activity event. Concurrent creates reuse the company's label. Create, list and get responses expose the derived `source_env` field.

Attribution is create-time only. PATCH does not accept `source_env`; editing ordinary labels preserves the existing attribution. Reserved source labels cannot be created, attached to another issue, replaced or deleted through the label API. Existing ordinary label operations stay available. This adds no database migration and leaves existing issues unattributed unless they already have a recognized source label.

The ADE module `@quiknation/ade-aiagentoffice` must send `source_env` when creating a task. That caller is outside this repository and was not modified here.

## Heartbeat and persistence limits

There is no scheduled Worker trigger. Paperclip's Node process checks timer heartbeats, scheduled routines and queued-run recovery every 30 seconds. Those checks stop when the Container sleeps. An incoming request starts the Container and its scheduler; scheduled work cannot wake an asleep Container on its own. The existing `/api/agents/instance/scheduler-heartbeats` route reports policy, not whether a heartbeat is due, and querying it wakes the Container. No cron or unconditional wake is configured. This deployment is not acceptance proof for unattended scheduled work.

Neon stores application records; R2 stores uploads/attachments through the existing S3 provider. Local agent workspaces, filesystem artifacts and file-based run logs do not become durable through that attachment binding. Verify external execution/storage requirements before using agents that depend on those local files.

## Local validation and remaining blockers

Use Node 22+ for Wrangler (CI uses Node 24):

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm typecheck:paperclip-worker
pnpm test:run
pnpm build
pnpm check:paperclip-worker
shellcheck scripts/deploy-quiknation-paperclip.sh
```

The Worker check uses `--dry-run --containers-rollout=none`; it validates configuration and bundles the Worker without uploading or building the Container image. PR CI also builds the root Dockerfile without deploying. For a local image check on a host with Docker, run `docker build --tag quiknation-paperclip:review .`. Memory and env files are excluded from the Docker build context.

Local validation on 2026-10-06 passed `pnpm -r typecheck`, `pnpm test:run` and `pnpm build`: **962 tests passed across 186 files, with one existing Windows-only test skipped on macOS**. Focused operator-user, Container, registration and deploy-script tests passed: 31 tests across four files. The standalone operator script typecheck passed, and the actual CLI rejected a missing `DATABASE_URL` without stdout or a connection. Its tests use fake transaction storage and the real Better Auth hasher, with no network or real database. The existing root tsconfig references a missing `droid-local` config; isolated CLI tests load through `tsx` instead of Vite's root-project transform. Earlier Worker typecheck, Wrangler dry-run bundle, shellcheck and workflow YAML parsing passed. These are local results; CI and Container-image verification require separate proof at the exact PR head.

This rollout has an explicitly authorized exception to the default lockfile policy in `doc/DEVELOPING.md`. Its reviewed `pnpm-lock.yaml` dependency changes are committed, and installs in PR and deploy jobs are frozen. Other branches retain the existing lockfile ownership policy. All `pnpm/action-setup` references are pinned to the verified upstream `v4.3.0` commit `b906affcce14559ad1aafd4ab0e942779e9f58b1`. Deployment pins `aws-actions/configure-aws-credentials` to the upstream `v4.3.1` commit `7474bc4690e29a8392af63c5b98e7449536d5c3a`; both were checked against their official Git refs and commit metadata.

After Mo's approval, live verification on 2026-10-06 confirmed Actions enabled and permitted, all three required repository variable names configured, and the protected `production` environment with required reviewer `mojaray2k` and a `master`-only branch policy. Mo also confirmed the exact-subject OIDC trust and seven approved secret reads. These configuration prerequisites are satisfied. PR #1 is ready for review, and CI started at `485b6698571b313011af076ef821506909640852`; every subsequent head still requires green checks and new counted review verdicts. No organization Actions settings or IAM changes were made by this harness, and no secret values were inspected. Docker is unavailable on QCS1, so Container-image verification requires CI. First-admin account/bootstrap readiness, Neon schema readiness and runtime credential/connectivity verification remain separate operator prerequisites. No merge, workflow dispatch or deployment was performed during this preparation.

References: [Container class](https://developers.cloudflare.com/containers/api/container-class/) and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
