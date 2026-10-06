# QuikNation Paperclip Cloudflare Container

The `quiknation-paperclip` Worker routes all requests to one named production Container, `quiknation-production`, on port 3100. `max_instances` is 1, the instance type is `basic`, and the idle timeout is 30 minutes. Deployment uses the root Dockerfile. Durable data belongs in the existing Neon Paperclip database and the private R2 bucket `quiknation-paperclip`; Container disk is ephemeral. The Worker R2 binding and the Container S3 bucket setting both name only `quiknation-paperclip`.

## Review and deployment gates

This change prepares deployment; it does not deploy anything. Before deployment, Gran and Mary must both PASS the re-pinned PR head through live Orca, and CI must be green. The operator then handles merge and deployment.

`Deploy QuikNation Paperclip` is manual-only and runs only on `master`. Supply the full authorized master commit as `expected_sha`; the workflow rejects a mismatch with the selected workflow revision. It reruns repository checks and the Worker bundle check before the `production` environment job can assume the existing AWS OIDC role. Configure protection on that environment before using it; an environment name alone does not establish an approval gate. The workflow does not configure IAM, mint keys, provision a database, create a bucket, or delete bucket contents.

Required existing repository/environment variables:

| Variable | Purpose |
| --- | --- |
| `AWS_ROLE_ARN` | Existing OIDC role with the existing required secret-read permissions |
| `AWS_REGION` | Region containing the approved Secrets Manager names |
| `PAPERCLIP_AUTH_PUBLIC_BASE_URL` | Final HTTPS Paperclip origin, with no credentials, path, query or fragment |

Public exposure requires explicit auth base-URL mode. The workflow supplies the validated public URL to Wrangler; the Container forwards it into Paperclip. Strict secret-reference mode is enabled. Local disk database backups are disabled because they would disappear on restart; backup/restore of Neon remains an operator responsibility. No migration override is enabled: a Neon schema with pending migrations can block startup and must be handled as a separately authorized operation.

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
pnpm install --no-frozen-lockfile
pnpm -r typecheck
pnpm typecheck:paperclip-worker
pnpm test:run
pnpm build
pnpm check:paperclip-worker
shellcheck scripts/deploy-quiknation-paperclip.sh
```

The Worker check uses `--dry-run --containers-rollout=none`; it validates configuration and bundles the Worker without uploading or building the Container image. PR CI also builds the root Dockerfile without deploying. For a local image check on a host with Docker, run `docker build --tag quiknation-paperclip:review .`. Memory and env files are excluded from the Docker build context.

`doc/DEVELOPING.md` prohibits lockfile changes in PRs. Keep local `pnpm-lock.yaml` changes unstaged. PR and deploy jobs resolve dependencies in their ephemeral checkout; the existing lockfile-refresh workflow owns committed lockfile updates.

On 2026-10-06, the fork reported GitHub Actions disabled, no configured Actions variables and no environments. Docker is unavailable on QCS1. CI/image verification and production protection/configuration remain rollout blockers until the operator addresses them. No merge, workflow dispatch or deployment was performed during this preparation.

References: [Container class](https://developers.cloudflare.com/containers/api/container-class/) and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
