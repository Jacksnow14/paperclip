#!/usr/bin/env bash
# Shared board-API helper (AUR-3963 / Defect 4 of AUR-3956).
#
# `curl -s` against the board API silently returns 0 on 4xx/5xx, and a
# rejected PATCH /api/issues/{id} has no top-level status/assigneeAgentId —
# only `details.status`, which is the pre-write status, not the write result.
# Callers that did `curl -s ... | jq .status` therefore read a plausible but
# wrong value instead of failing. pc_api makes non-2xx unmissable: it returns
# non-zero and puts the full {error,details} body on stderr, so a `set -e`
# caller stops instead of treating the error JSON as a success payload.
#
# Usage:
#   source scripts/lib/paperclip-api.sh
#   body="$(pc_api GET "/api/issues/$id")" || exit 1
#   body="$(pc_api PATCH "/api/issues/$id" '{"status":"done"}')" || exit 1
#   issue="$(pc_api_patch_issue "$id" '{"status":"done"}')" || exit 1
#
# Env:
#   PAPERCLIP_API_URL          base URL (required)
#   PAPERCLIP_API_KEY          bearer token (required)
#   PAPERCLIP_RUN_ID           optional; sent as X-Paperclip-Run-Id when set

pc_api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"

  if [[ -z "${PAPERCLIP_API_URL:-}" ]]; then
    printf 'pc_api: PAPERCLIP_API_URL is not set\n' >&2
    return 1
  fi
  if [[ -z "${PAPERCLIP_API_KEY:-}" ]]; then
    printf 'pc_api: PAPERCLIP_API_KEY is not set\n' >&2
    return 1
  fi

  local -a curl_args=(
    -sS -X "$method"
    "${PAPERCLIP_API_URL%/}${path}"
    -H "Authorization: Bearer ${PAPERCLIP_API_KEY}"
    -H 'Content-Type: application/json'
    -w '\n%{http_code}'
  )
  if [[ -n "${PAPERCLIP_RUN_ID:-}" ]]; then
    curl_args+=(-H "X-Paperclip-Run-Id: ${PAPERCLIP_RUN_ID}")
  fi
  if [[ -n "$body" ]]; then
    curl_args+=(--data-binary "$body")
  fi

  local raw
  if ! raw="$(curl "${curl_args[@]}")"; then
    printf 'pc_api: curl failed contacting %s %s\n' "$method" "$path" >&2
    return 1
  fi

  local http_code="${raw##*$'\n'}"
  local resp_body="${raw%$'\n'*}"

  if [[ ! "$http_code" =~ ^2 ]]; then
    printf 'pc_api: %s %s -> HTTP %s\n%s\n' "$method" "$path" "$http_code" "$resp_body" >&2
    return 1
  fi

  printf '%s' "$resp_body"
}

# Never read a mutation's success off its response body: PATCH, then re-fetch
# and return the re-read issue. A 409 body has no top-level status/
# assigneeAgentId, so the ordinary `.get('status')` idiom silently reports
# success — re-fetching after a confirmed-2xx PATCH is the only trustworthy
# read of what the write actually did.
pc_api_patch_issue() {
  local issue_id="$1"
  local body="$2"

  pc_api PATCH "/api/issues/${issue_id}" "$body" >/dev/null || return 1
  pc_api GET "/api/issues/${issue_id}"
}
