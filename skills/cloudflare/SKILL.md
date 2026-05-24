---
name: cloudflare
description: >
  Interact with the Cloudflare API v4 to manage zones, DNS records, cache,
  Workers, Pages, R2 storage, firewall rulesets, redirects, page rules, and
  SSL/TLS settings. Covers auth, least-privilege token scopes, idempotency
  patterns, error handling, and a runbook for incoming Cloudflare request
  issues. Use whenever an issue involves operating, auditing, or configuring
  Cloudflare resources. Destructive actions (purge-all, delete zone, delete
  worker, etc.) always require explicit board approval via request_board_approval
  before execution.
---

# Cloudflare Skill

All Cloudflare management goes through the **REST API v4** at
`https://api.cloudflare.com/client/v4`. Every response body has the shape:

```json
{
  "success": true | false,
  "errors": [],
  "messages": [],
  "result": { ... }
}
```

When `success` is `false`, inspect `errors[].code` (a Cloudflare 1xxxxx error
code) and `errors[].message`.

---

## Authentication

### Preferred: API Token (least-privilege)

```bash
curl -sS "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

A valid response returns `"status": "active"`. An invalid or expired token
returns HTTP 401 with error code `10000`.

### Legacy: Global API Key (avoid for new integrations)

```bash
curl -sS "https://api.cloudflare.com/client/v4/user" \
  -H "X-Auth-Email: $CLOUDFLARE_EMAIL" \
  -H "X-Auth-Key: $CLOUDFLARE_API_KEY"
```

**Never** store global API keys in agent environment — use scoped API tokens.

### Environment variables expected

| Variable | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Scoped bearer token (preferred) |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID for account-level endpoints |
| `CLOUDFLARE_ZONE_ID` | Default zone (override per-call as needed) |

---

## Token Scopes (Least-Privilege Guide)

Mint tokens at **My Profile → API Tokens → Create Token** with the minimum
scopes for the task. Never use a token with wider scopes than necessary.

| Endpoint Group | Required Scope(s) |
|---|---|
| Account / Whoami | `Account:Read` |
| Zones — list/get | `Zone:Read` |
| Zones — create/delete | `Zone:Edit` |
| DNS records — read | `Zone:DNS:Read` |
| DNS records — write | `Zone:DNS:Edit` |
| Cache — purge | `Zone:Cache Purge` |
| Workers — read | `Account:Workers Scripts:Read` |
| Workers — write/delete | `Account:Workers Scripts:Edit` |
| Pages — read | `Account:Cloudflare Pages:Read` |
| Pages — write/deploy | `Account:Cloudflare Pages:Edit` |
| R2 — read | `Account:Workers R2 Storage:Read` |
| R2 — write/delete | `Account:Workers R2 Storage:Edit` |
| Firewall / Rulesets — read | `Zone:Firewall Services:Read` |
| Firewall / Rulesets — write | `Zone:Firewall Services:Edit` |
| Page Rules — read | `Zone:Page Rules:Read` |
| Page Rules — write | `Zone:Page Rules:Edit` |
| SSL / TLS settings | `Zone:SSL and Certificates:Edit` |

---

## Account / Whoami

### Verify token and get account details

```bash
# Verify token is active
curl -sS "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# Get current user (global key only)
curl -sS "https://api.cloudflare.com/client/v4/user" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# List accounts accessible to this token
curl -sS "https://api.cloudflare.com/client/v4/accounts" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# Get a specific account
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

---

## Zones

### List zones

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones?account.id=$CLOUDFLARE_ACCOUNT_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Get a zone

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Create a zone

Idempotent: creating a zone for an already-registered domain returns the existing
zone with a `409` error code `1049` — check `errors[].code` before treating as
a hard failure.

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "account": { "id": "'"$CLOUDFLARE_ACCOUNT_ID"'" },
    "name": "example.com",
    "type": "full"
  }'
```

### Delete a zone ⚠️ DESTRUCTIVE — requires board approval

> **STOP.** Call `request_board_approval` before executing this. Deleting a zone
> removes all DNS records, Workers routes, page rules, and cache settings for
> that domain. This action cannot be undone.

```bash
# Only after board approval has been granted:
curl -sS -X DELETE "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

---

## DNS Records

### List DNS records

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Get a single DNS record

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records/$DNS_RECORD_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Create a DNS record

Idempotency: Cloudflare allows duplicate records — check existing records first
with `?name=sub.example.com&type=A` before creating.

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "A",
    "name": "sub.example.com",
    "content": "198.51.100.10",
    "ttl": 3600,
    "proxied": false
  }'
```

### Update a DNS record (full replace)

```bash
curl -sS -X PUT "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records/$DNS_RECORD_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "A",
    "name": "sub.example.com",
    "content": "198.51.100.20",
    "ttl": 3600,
    "proxied": false
  }'
```

### Patch a DNS record (partial update)

```bash
curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records/$DNS_RECORD_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "content": "198.51.100.30" }'
```

### Delete a DNS record

```bash
curl -sS -X DELETE "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records/$DNS_RECORD_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

---

## Cache

### Purge specific files

Idempotent — safe to retry. Purges are fire-and-forget; Cloudflare returns
`{"id": "<purge-id>"}` on success.

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "files": ["https://example.com/path/to/file.js"]
  }'
```

### Purge by tag or host

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tags": ["my-cache-tag"],
    "hosts": ["sub.example.com"]
  }'
```

### Purge everything ⚠️ DESTRUCTIVE — requires board approval

> **STOP.** Call `request_board_approval` before executing purge-all. Purging
> the entire cache causes a cache-miss storm and elevated origin load. For
> large sites this can degrade performance for minutes.

```bash
# Only after board approval has been granted:
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "purge_everything": true }'
```

### Cache rules (list)

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/rulesets/phases/http_request_cache_settings/entrypoint" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

---

## Workers

Cloudflare Workers use the account-scoped endpoint at
`/accounts/{account_id}/workers/scripts/{script_name}`.

### List Workers scripts

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Get a Worker script (metadata)

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Upload / deploy a Worker (PUT is idempotent)

```bash
curl -sS -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/javascript" \
  --data-binary @worker.js
```

For multipart (with metadata or multiple modules):

```bash
curl -sS -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -F "metadata=@metadata.json;type=application/json" \
  -F "script=@worker.js;type=application/javascript"
```

### Set / update a Worker secret

```bash
curl -sS -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/secrets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"MY_SECRET","text":"secret-value","type":"secret_text"}'
```

### List Worker secrets

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/secrets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '[.result[] | {name, type}]'
```

### Delete a Worker secret

```bash
curl -sS -X DELETE "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/secrets/MY_SECRET" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Workers KV — list namespaces

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces?per_page=100" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '[.result[] | {id, title}]'
```

### Workers KV — create namespace

Idempotent if the title already exists (returns existing namespace).

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"my-kv-namespace"}'
```

### Workers KV — read a key

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces/$KV_NAMESPACE_ID/values/my-key" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Workers KV — write a key

```bash
curl -sS -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces/$KV_NAMESPACE_ID/values/my-key" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: text/plain" \
  --data "my-value"
```

### Workers KV — delete a key

```bash
curl -sS -X DELETE "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces/$KV_NAMESPACE_ID/values/my-key" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Delete a Worker script ⚠️ DESTRUCTIVE — requires board approval

> **STOP.** Call `request_board_approval` before deleting a Worker script.
> Deletion immediately removes the deployed script from all associated routes.

```bash
# Only after board approval has been granted:
curl -sS -X DELETE "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### List Worker routes on a zone

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/workers/routes" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Create a Worker route

Idempotency: creating a route that already exists for the same pattern returns
a `409` — check existing routes first.

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/workers/routes" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "pattern": "example.com/api/*",
    "script": "my-worker"
  }'
```

---

## Pages

Cloudflare Pages projects live under the account.

### List Pages projects

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Get a Pages project

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PAGES_PROJECT_NAME" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### List deployments

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PAGES_PROJECT_NAME/deployments" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Get a specific deployment

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PAGES_PROJECT_NAME/deployments/$DEPLOYMENT_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Retry / redeploy a deployment

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PAGES_PROJECT_NAME/deployments/$DEPLOYMENT_ID/retry" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Delete a Pages project ⚠️ DESTRUCTIVE — requires board approval

> **STOP.** Call `request_board_approval` before deleting a Pages project.
> All deployments and custom domains attached to the project are removed.

```bash
# Only after board approval has been granted:
curl -sS -X DELETE "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PAGES_PROJECT_NAME" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

---

## R2 Storage

R2 uses an S3-compatible endpoint for object operations, but the bucket
management plane lives in the Cloudflare API.

### List R2 buckets

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Get an R2 bucket

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$BUCKET_NAME" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Create an R2 bucket

Idempotent if the bucket already exists (returns existing bucket info).

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "name": "my-bucket" }'
```

### R2 presigned upload URL

R2 supports presigned URLs via the S3-compatible endpoint. Use `aws-cli` or `boto3` pointed at the R2 endpoint, or generate with a custom request:

```bash
# Using wrangler (preferred for R2 presigned URLs):
# wrangler r2 object put $BUCKET_NAME/path/to/object --file myfile.bin

# S3-compatible endpoint base:
# https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com/$BUCKET_NAME

# Generate presigned URL via S3 SDK (Python example):
# import boto3
# s3 = boto3.client("s3",
#   endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
#   aws_access_key_id=R2_ACCESS_KEY_ID,
#   aws_secret_access_key=R2_SECRET_ACCESS_KEY)
# url = s3.generate_presigned_url("put_object",
#   Params={"Bucket": bucket, "Key": key}, ExpiresIn=3600)
```

R2 API tokens (not CF API tokens) are used for S3-compatible object operations — create them at **R2 → Manage R2 API Tokens** in the Cloudflare dashboard.

### R2 lifecycle rules

```bash
# Get lifecycle rules for a bucket (S3-compatible)
# PUT /$BUCKET_NAME?lifecycle  with XML body

# Via Cloudflare API (alpha endpoint):
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$BUCKET_NAME/lifecycle" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# Set lifecycle rules
curl -sS -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$BUCKET_NAME/lifecycle" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "rules": [{
      "id": "delete-old-objects",
      "enabled": true,
      "conditions": { "maxAgeSeconds": 2592000 },
      "actions": { "deleteObject": {} }
    }]
  }'
```

### Delete an R2 bucket ⚠️ DESTRUCTIVE — requires board approval

> **STOP.** Call `request_board_approval` before deleting an R2 bucket.
> All objects in the bucket are permanently destroyed.

```bash
# Only after board approval has been granted:
curl -sS -X DELETE "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$BUCKET_NAME" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### R2 object operations (S3-compatible)

Use the S3-compatible endpoint for object-level operations:

```
https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com
```

Generate R2 API tokens (with bucket-level scopes) separately from CF API tokens.

---

## Firewall / Rulesets

Cloudflare uses a unified **Rulesets API** for WAF, firewall rules, and rate
limiting. Zone-level rulesets live at:

```
/zones/{zone_id}/rulesets
```

### List rulesets on a zone

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/rulesets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Get a specific ruleset

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/rulesets/$RULESET_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Create a custom firewall ruleset

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/rulesets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Firewall Ruleset",
    "kind": "zone",
    "phase": "http_request_firewall_custom",
    "rules": [
      {
        "action": "block",
        "expression": "(ip.src in {203.0.113.0/24})",
        "description": "Block test IP range"
      }
    ]
  }'
```

### Update a ruleset (full replace — PUT)

PUT is idempotent for the full ruleset. Use PATCH to add/modify individual rules.

```bash
curl -sS -X PUT "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/rulesets/$RULESET_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "rules": [
      {
        "action": "block",
        "expression": "(ip.src in {198.51.100.0/24})",
        "description": "Updated block rule"
      }
    ]
  }'
```

### Add a rule to an existing ruleset phase entrypoint

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/rulesets/phases/http_request_firewall_custom/entrypoint/rules" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "challenge",
    "expression": "(http.request.uri.path contains \"/admin\")",
    "description": "Challenge admin paths",
    "enabled": true
  }'
```

### IP access rules (account-level block/allow)

```bash
# List IP access rules
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/firewall/access_rules/rules?per_page=100" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '[.result[] | {id, mode, configuration}]'

# Create an IP block rule
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/firewall/access_rules/rules" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"block","configuration":{"target":"ip","value":"203.0.113.42"},"notes":"Blocked by runbook"}'

# Valid targets: "ip", "ip_range", "asn", "country"
# Valid modes: "block", "challenge", "js_challenge", "managed_challenge", "whitelist"

# Delete an IP access rule
curl -sS -X DELETE "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/firewall/access_rules/rules/$RULE_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Delete a ruleset ⚠️ DESTRUCTIVE — requires board approval

> **STOP.** Call `request_board_approval` before deleting a firewall ruleset.
> Removing an active ruleset drops all firewall protection it provides.

```bash
# Only after board approval has been granted:
curl -sS -X DELETE "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/rulesets/$RULESET_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

---

## Redirects / Page Rules

### List Page Rules

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/pagerules" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Get a Page Rule

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/pagerules/$PAGE_RULE_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Create a Page Rule (redirect example)

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/pagerules" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "targets": [
      {
        "target": "url",
        "constraint": {
          "operator": "matches",
          "value": "example.com/old/*"
        }
      }
    ],
    "actions": [
      {
        "id": "forwarding_url",
        "value": {
          "url": "https://example.com/new/$1",
          "status_code": 301
        }
      }
    ],
    "priority": 1,
    "status": "active"
  }'
```

### Update a Page Rule (full replace — PUT)

```bash
curl -sS -X PUT "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/pagerules/$PAGE_RULE_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "targets": [{ "target": "url", "constraint": { "operator": "matches", "value": "example.com/new/*" } }],
    "actions": [{ "id": "cache_level", "value": "bypass" }],
    "priority": 1,
    "status": "active"
  }'
```

### Patch a Page Rule

```bash
curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/pagerules/$PAGE_RULE_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "status": "disabled" }'
```

### Delete a Page Rule

```bash
curl -sS -X DELETE "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/pagerules/$PAGE_RULE_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Bulk redirects (account-level, preferred over Page Rules for large lists)

```bash
# List redirect lists
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/rules/lists" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# Create a redirect list
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/rules/lists" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "name": "my_redirects", "kind": "redirect", "description": "Site redirects" }'
```

---

## SSL / TLS Settings

### Get SSL/TLS mode for a zone

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/settings/ssl" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Set SSL/TLS mode

Valid values: `off`, `flexible`, `full`, `strict`.

```bash
curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/settings/ssl" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "value": "strict" }'
```

### Enable Always Use HTTPS

```bash
curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/settings/always_use_https" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "value": "on" }'
```

### Set minimum TLS version

Valid values: `1.0`, `1.1`, `1.2`, `1.3`.

```bash
curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/settings/min_tls_version" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "value": "1.2" }'
```

### List custom SSL certificates

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/custom_certificates" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### Upload a custom SSL certificate

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/custom_certificates" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
    "bundle_method": "ubiquitous"
  }'
```

### Delete a custom SSL certificate ⚠️ DESTRUCTIVE — requires board approval

> **STOP.** Call `request_board_approval` before deleting a custom SSL certificate.
> Deletion may cause HTTPS to fail for the zone if no other valid cert is active.

```bash
# Only after board approval has been granted:
curl -sS -X DELETE "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/custom_certificates/$CERT_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

---

## Error Handling

### HTTP error codes

| HTTP status | Meaning | Action |
|---|---|---|
| 400 | Bad Request — malformed body or missing required field | Fix the request body; check `errors[].message` |
| 401 | Unauthorized — invalid or missing token | Re-verify token with `/user/tokens/verify`; re-mint if expired |
| 403 | Forbidden — valid token but insufficient scope | Check token scopes; mint a new token with the right permissions |
| 404 | Not Found — resource doesn't exist | Confirm the zone/account/resource ID is correct |
| 409 | Conflict — resource already exists | Check for the existing resource before creating |
| 429 | Rate Limited | Back off and retry; see retry strategy below |
| 500 / 5xx | Cloudflare internal error | Wait and retry with exponential backoff; escalate if persistent |

### Cloudflare 1xxxxx error codes (in `errors[].code`)

| Code | Meaning |
|---|---|
| 10000 | Invalid API token |
| 10001 | Missing API token |
| 10014 | Token does not have required permission (scope) |
| 10049 | Zone already exists (during zone create) |
| 7003 | Resource not found |
| 81053 | Rate limit exceeded |

Always log `errors[].code` alongside `errors[].message` for traceability.

### Rate limit retry strategy

Cloudflare returns `Retry-After` (seconds) in the response header on 429s.
Respect it; do not use a fixed sleep.

```bash
# Bash helper: check for 429 and retry
CF_RESPONSE=$(curl -sS -w "\n%{http_code}" "$URL" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
HTTP_CODE=$(echo "$CF_RESPONSE" | tail -1)
if [ "$HTTP_CODE" = "429" ]; then
  RETRY_AFTER=$(curl -sI "$URL" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | grep -i retry-after | awk '{print $2}')
  sleep "${RETRY_AFTER:-30}"
  # retry once
fi
```

### Auth failure runbook

1. Run `curl -sS .../user/tokens/verify` — if status is not `active`, the
   token is revoked or expired.
2. Check that the token has the required scope for the endpoint (see token
   scopes table above).
3. If a 403 with code `10014`, the token is valid but lacks the scope —
   re-mint with the correct permissions.
4. If a 401 with code `10000`, the token value itself is wrong or has been
   revoked — generate a new token.
5. Never surface raw token values in comments or logs.

---

## Idempotency Patterns

| Operation | Idempotent? | Notes |
|---|---|---|
| GET any resource | Yes (read-only) | Safe to retry unconditionally |
| PUT Worker script | Yes | PUT replaces; same payload = same result |
| PUT ruleset | Yes | Full replace; same payload = same result |
| POST zone (create) | Quasi — 409 on duplicate | Check `errors[].code == 10049` before treating as hard error |
| POST DNS record | No | Cloudflare allows duplicate records; deduplicate with a GET first |
| POST Page Rule | No | Check existing rules before creating |
| POST cache purge (files) | Yes | Safe to retry; purge is idempotent |
| POST purge_everything | Yes (idempotent effect) | Safe to retry but requires board approval each time |
| DELETE any resource | Yes (idempotent on 404) | A 404 after a delete means it was already gone — treat as success |

---

## Incoming Cloudflare Request Runbook

When an issue arrives asking you to diagnose or fix a Cloudflare configuration
problem, follow this flow:

### 1. Identify the scope

- Is this a zone-level issue (DNS, cache, SSL, page rules) or account-level
  (Workers, Pages, R2, billing)?
- Which domain / zone ID is affected? If unknown, list zones and match by name.

### 2. Gather facts before touching anything

```bash
# Get zone details
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# List recent audit log (account-level)
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/audit_logs?per_page=25" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### 3. Auth / scope check

Before any mutation, verify the token:

```bash
curl -sS "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

A status other than `active` means all mutations will fail — fix auth first.

### 4. Assess destructiveness

Before executing any change:

- **Is this a read?** → Proceed.
- **Is this a non-destructive write** (add DNS record, update SSL mode)?
  → Proceed, document in the issue comment.
- **Is this a destructive write** (purge-all, delete zone, delete Worker,
  delete Pages project, delete R2 bucket, delete firewall ruleset, delete
  SSL cert)? → **Stop. Call `request_board_approval` and wait for acceptance.**

### 5. Verify the dummy/invalid token path

To confirm error handling works with an invalid token (no real token needed):

```bash
curl -sS "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer DUMMY_TOKEN_FOR_TEST"
# Expected: {"success":false,"errors":[{"code":10000,"message":"Authentication error"}],...}
```

### 6. Document every change

Post a comment on the issue with:
- What was changed (resource type, ID, before/after values)
- The curl command used (redact any token)
- The response received (success or error)
- Who approved destructive changes (link to the approval)

### 7. Verify the fix

After making a change, wait for propagation (DNS: up to TTL; cache: immediate;
Workers: ~30 s; SSL mode: immediate) and confirm with a read call.

---

## Destructive Actions Summary

All of the following require `request_board_approval` before execution.
No exceptions.

| Action | Risk |
|---|---|
| `DELETE /zones/{zone_id}` | Removes all DNS, Workers routes, page rules, cache config |
| `POST /zones/{zone_id}/purge_cache` with `purge_everything: true` | Cache-miss storm on large sites |
| `DELETE /accounts/{id}/workers/scripts/{name}` | Removes deployed Worker from all routes immediately |
| `DELETE /accounts/{id}/pages/projects/{name}` | Removes all deployments and custom domains |
| `DELETE /accounts/{id}/r2/buckets/{name}` | Permanently destroys all objects in the bucket |
| `DELETE /zones/{id}/rulesets/{ruleset_id}` | Drops all firewall protection from that ruleset |
| `DELETE /zones/{id}/custom_certificates/{cert_id}` | May cause HTTPS failure if no other cert is active |

---

## Quick Reference

| Resource | Base path |
|---|---|
| Account | `/accounts/{account_id}` |
| Zones | `/zones` / `/zones/{zone_id}` |
| DNS records | `/zones/{zone_id}/dns_records` |
| Cache purge | `/zones/{zone_id}/purge_cache` |
| Cache rules | `/zones/{zone_id}/rulesets/phases/http_request_cache_settings/entrypoint` |
| Workers scripts | `/accounts/{account_id}/workers/scripts` |
| Workers secrets | `/accounts/{account_id}/workers/scripts/{name}/secrets` |
| Workers KV namespaces | `/accounts/{account_id}/storage/kv/namespaces` |
| Workers routes | `/zones/{zone_id}/workers/routes` |
| Pages projects | `/accounts/{account_id}/pages/projects` |
| R2 buckets | `/accounts/{account_id}/r2/buckets` |
| R2 lifecycle | `/accounts/{account_id}/r2/buckets/{name}/lifecycle` |
| IP access rules | `/accounts/{account_id}/firewall/access_rules/rules` |
| Rulesets | `/zones/{zone_id}/rulesets` |
| Page Rules | `/zones/{zone_id}/pagerules` |
| Bulk Redirects | `/accounts/{account_id}/rules/lists` |
| SSL settings | `/zones/{zone_id}/settings/ssl` |
| TLS settings | `/zones/{zone_id}/settings/min_tls_version` |
| Audit logs | `/accounts/{account_id}/audit_logs` |
| Token verify | `/user/tokens/verify` |
