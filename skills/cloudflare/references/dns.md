# Cloudflare DNS Reference

## Idempotent Upsert Pattern (keyed by name + type)

Cloudflare allows duplicate DNS records with the same name and type, so always
check before creating.

```bash
# 1. Look up existing record by name and type
EXISTING=$(curl -sS \
  "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=api.example.com&type=A" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

RECORD_ID=$(echo "$EXISTING" | jq -r '.result[0].id // empty')

if [ -n "$RECORD_ID" ]; then
  # 2a. Record exists — update it (PATCH for partial, PUT for full replace)
  curl -sS -X PATCH \
    "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records/$RECORD_ID" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"content":"203.0.113.1","ttl":3600,"proxied":false}'
else
  # 2b. Record does not exist — create it
  curl -sS -X POST \
    "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"type":"A","name":"api.example.com","content":"203.0.113.1","ttl":3600,"proxied":false}'
fi
```

## Common Record Types

| Type | Use case | `content` field | Cloudflare proxiable? |
|------|----------|-----------------|----------------------|
| A | IPv4 address | `"203.0.113.1"` | Yes |
| AAAA | IPv6 address | `"2001:db8::1"` | Yes |
| CNAME | Alias to another hostname | `"target.example.com"` | Yes (if not root) |
| MX | Mail server | `"mail.example.com"` (+ `priority`) | No |
| TXT | Verification / SPF / DKIM | `"v=spf1 include:... ~all"` | No |
| NS | Name server delegation | `"ns1.example.com"` | No |
| SRV | Service discovery | uses `data` sub-object | No |
| CAA | Certificate Authority Authorization | uses `data` sub-object | No |

## TTL Guidance

| TTL value | Meaning |
|-----------|---------|
| `1` | Automatic (Cloudflare-managed, applies when `proxied: true`) |
| `120` | 2 minutes — use during migrations |
| `3600` | 1 hour — typical default |
| `86400` | 24 hours — stable production records |

When `proxied: true`, TTL is forced to `1` (automatic) regardless of what you set.

## Pagination

Cloudflare paginates DNS records at 100 per page by default. For zones with
many records, iterate pages:

```bash
PAGE=1
while true; do
  RESP=$(curl -sS \
    "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?per_page=100&page=$PAGE" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
  echo "$RESP" | jq '.result[] | {id, type, name, content}'
  TOTAL_PAGES=$(echo "$RESP" | jq '.result_info.total_pages')
  [ "$PAGE" -ge "$TOTAL_PAGES" ] && break
  PAGE=$((PAGE + 1))
done
```

## Filter by Name or Type

```bash
# Filter by record name
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=sub.example.com" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# Filter by record type
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?type=MX" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# Both
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=example.com&type=TXT" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

## SRV and CAA Records (structured `data` field)

```bash
# SRV record
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "SRV",
    "name": "_xmpp._tcp.example.com",
    "data": {
      "service": "_xmpp",
      "proto": "_tcp",
      "name": "example.com",
      "priority": 10,
      "weight": 5,
      "port": 5222,
      "target": "xmpp.example.com"
    },
    "ttl": 3600
  }'

# CAA record
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "CAA",
    "name": "example.com",
    "data": { "flags": 0, "tag": "issue", "value": "letsencrypt.org" },
    "ttl": 3600
  }'
```

## Import DNS Records from BIND Zone File

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records/import" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -F "file=@zonefile.txt" \
  -F 'proxied=false'
```

## Export DNS Records as BIND Zone File

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records/export" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" > zone_export.txt
```
