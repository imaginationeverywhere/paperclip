# QuikNation Paperclip Cloudflare Container

The `quiknation-paperclip` Worker routes all requests to one named production Container, `quiknation-production`, on port 3100. `max_instances` is 1, the instance type is `basic`, and the idle timeout is 30 minutes. Deployment uses the root Dockerfile. Durable data belongs in the existing Neon Paperclip database and the private R2 bucket `quiknation-paperclip`; Container disk is ephemeral. Only the Container's existing S3 provider accesses R2, and its bucket setting stays `quiknation-paperclip`. The Worker has no native R2 bucket binding.

## Review and deployment gates

This change prepares deployment; it does not deploy anything. Before deployment, Gran and Mary must both PASS the re-pinned PR head through live Orca, and CI must be green. The operator then handles merge and deployment.

`Deploy QuikNation Paperclip` is manual-only and runs only on `master`. Supply the full authorized master commit as `expected_sha`; the workflow rejects a mismatch with the selected workflow revision. It reruns repository checks and the Worker bundle check before the `production` environment job can assume an approved AWS OIDC role. Configure protection on that environment before using it; an environment name alone does not establish an approval gate. The workflow does not configure IAM, mint keys, provision a database, create a bucket, or delete bucket contents.

No AWS OIDC role currently trusts this repository. Deployment is **blocked** until Mo approves role trust for the exact GitHub OIDC subject `repo:imaginationeverywhere/paperclip:environment:production` and the required `secretsmanager:GetSecretValue` permissions scoped to the seven approved Secrets Manager names listed below. `AWS_ROLE_ARN` must identify that approved role after these prerequisites are fulfilled; the variable alone does not establish trust or read permissions. This PR does not create or modify a role, its trust policy, or IAM permissions.

Required repository/environment variables, still to be configured by the authorized owner:

| Variable | Purpose |
| --- | --- |
| `AWS_ROLE_ARN` | Mo-approved role with trust for `repo:imaginationeverywhere/paperclip:environment:production` and scoped Secrets Manager read permissions |
| `AWS_REGION` | Region containing the approved Secrets Manager names |
| `PAPERCLIP_AUTH_PUBLIC_BASE_URL` | Final HTTPS Paperclip origin, with no credentials, path, query or fragment |

Public exposure requires explicit auth base-URL mode. The workflow supplies the validated public URL to Wrangler; the Container forwards it into Paperclip. Strict secret-reference mode is enabled. Local disk database backups are disabled because they would disappear on restart; backup/restore of Neon remains an operator responsibility. No migration override is enabled: a Neon schema with pending migrations can block startup and must be handled as a separately authorized operation.

## Closed registration and first-admin bootstrap

`PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` is set in Wrangler and forwarded to the Container. Public email/password registration stays disabled throughout bootstrap and normal operation. Existing-account sign-in remains available. Never temporarily enable registration to create the first admin, and never switch the public Container to `local_trusted`.

First-admin setup is **blocked until an approved authenticated human account exists**. The existing bootstrap CLI creates a one-use **admin invitation**, not a user account. `/api/invites/:token/accept` requires an already authenticated human account before it can promote that account. A bootstrap link alone cannot register a user or bypass disabled sign-up. No account-provisioning method is established by this rollout.

1. Verify that an individually approved human Better Auth account already exists and can sign in to this instance. If no such account exists, first-admin setup is **blocked** pending a separately reviewed, private operator account-provisioning procedure. This repository does not expose a closed-registration account-creation command; do not invent one or open registration as a workaround.
2. In an authorized private operator session with the existing runtime database connection injected securely, use an authenticated Paperclip CLI config with sign-up disabled and the correct public base URL. Run `pnpm paperclipai auth bootstrap-ceo --expires-hours 1`. Do not use `--force` for initial bootstrap. The CLI refuses to issue another initial invite when an admin already exists.
3. Deliver the generated invite link privately to the approved account owner. Treat the link as a credential; never put it or account passwords into CI logs, Git, tickets or this document. The owner signs in with their existing account and accepts the invitation before expiry.
4. Verify the human account's `instance_admin` role and required company memberships. The consumed bootstrap invite cannot be accepted again. Subsequent human invites must be issued by the authorized board and accepted by pre-provisioned, signed-in accounts; human company joins follow the existing board approval flow.

This is an operator procedure for a later authorized rollout. No account, invitation or admin-role change was made while preparing this PR. Account readiness and completed first-admin acceptance are release prerequisites, not facts established by the signup configuration test.

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

Local validation on 2026-10-06 passed `pnpm -r typecheck`, `pnpm build`, and `pnpm test:run`: **941 tests passed across 185 files, with one existing Windows-only test skipped on macOS**. Focused Container, registration and deploy-script tests passed: 10 tests across three files. Worker typecheck, Wrangler dry-run bundle, shellcheck and workflow YAML parsing also passed. These are local results; CI and Container-image verification remain blocked.

This rollout has an explicitly authorized exception to the default lockfile policy in `doc/DEVELOPING.md`. Its reviewed `pnpm-lock.yaml` dependency changes are committed, and installs in PR and deploy jobs are frozen. Other branches retain the existing lockfile ownership policy. All `pnpm/action-setup` references are pinned to the verified upstream `v4.3.0` commit `b906affcce14559ad1aafd4ab0e942779e9f58b1`. Deployment pins `aws-actions/configure-aws-credentials` to the upstream `v4.3.1` commit `7474bc4690e29a8392af63c5b98e7449536d5c3a`; both were checked against their official Git refs and commit metadata.

On 2026-10-06, the fork reported GitHub Actions disabled, no configured Actions variables and no environments. CI/deployment remain blocked on organization/repository Actions enablement, an allowlist permitting the pinned action references, the required role/region/public-URL variables, protected production environment configuration, and Mo-approved OIDC trust plus scoped Secrets Manager read permissions. No organization Actions settings or IAM changes were made here. Docker is unavailable on QCS1, so CI/image verification also remains outstanding. First-admin account/bootstrap readiness, Neon schema readiness and existing token/credential permission verification remain operator prerequisites. No merge, workflow dispatch or deployment was performed during this preparation.

References: [Container class](https://developers.cloudflare.com/containers/api/container-class/) and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
