#!/usr/bin/env bash
# Called only by the manually authorized production workflow.
set -euo pipefail
set +x
umask 077

: "${PAPERCLIP_AUTH_PUBLIC_BASE_URL:?Set the existing public Paperclip URL in repository variables}"
node --input-type=module - <<'JS'
let url;
try { url = new URL(process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL); }
catch { throw new Error('Paperclip public base URL must be a valid HTTPS origin'); }
if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
  throw new Error('Paperclip public base URL must be an HTTPS origin without credentials');
}
JS

secret_dir="$(mktemp -d "${RUNNER_TEMP:?}/quiknation-paperclip-secrets.XXXXXX")"
trap 'rm -f "$secret_dir"/*.json "$secret_dir/cloudflare-token"; rmdir "$secret_dir"' EXIT

write_secret_binding() {
  local secret_id="$1"
  local binding_name="$2"
  aws secretsmanager get-secret-value --secret-id "$secret_id" --output json \
    | jq --arg name "$binding_name" \
        'if (.SecretString | type) != "string" or (.SecretString | length) == 0 then error("SecretString is missing") else {($name): .SecretString} end' \
        > "$secret_dir/$binding_name.json"
}

write_secret_binding 'quik-nation/quiknation/paperclip/DATABASE_URL' 'DATABASE_URL'
write_secret_binding 'quik-nation/quiknation/paperclip/BETTER_AUTH_SECRET' 'BETTER_AUTH_SECRET'
write_secret_binding 'quik-nation/quiknation/paperclip/PAPERCLIP_AGENT_JWT_SECRET' 'PAPERCLIP_AGENT_JWT_SECRET'
write_secret_binding 'quik-nation/quiknation/paperclip/PAPERCLIP_SECRETS_MASTER_KEY' 'PAPERCLIP_SECRETS_MASTER_KEY'
write_secret_binding 'quik-nation/quiknation/paperclip/R2_ACCESS_KEY_ID' 'AWS_ACCESS_KEY_ID'
write_secret_binding 'quik-nation/quiknation/paperclip/R2_SECRET_ACCESS_KEY' 'AWS_SECRET_ACCESS_KEY'
aws secretsmanager get-secret-value \
  --secret-id 'quik-nation/shared/CLOUDFLARE_CONTAINERS_TOKEN' \
  --query SecretString --output text > "$secret_dir/cloudflare-token"
CLOUDFLARE_API_TOKEN="$(cat "$secret_dir/cloudflare-token")"
export CLOUDFLARE_API_TOKEN
test -n "$CLOUDFLARE_API_TOKEN" && test "$CLOUDFLARE_API_TOKEN" != 'None'

jq -s 'add' "$secret_dir"/*.json > "$secret_dir/bindings.json"
pnpm exec wrangler deploy --config wrangler.paperclip.jsonc \
  --var "PAPERCLIP_AUTH_PUBLIC_BASE_URL:$PAPERCLIP_AUTH_PUBLIC_BASE_URL" \
  --secrets-file "$secret_dir/bindings.json"
