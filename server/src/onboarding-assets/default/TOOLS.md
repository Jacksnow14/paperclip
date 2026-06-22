# Tools

(Add notes about your tools here as you acquire and use them. The sections below are
seeded defaults that apply to every agent shell sandbox — keep them, extend below.)

## Python 3 for quick JSON / API scripting

`python3` is **guaranteed on PATH** in every agent shell sandbox. It is a system package
(`/usr/bin/python3`, Python 3.10.x on the shared host), not a per-sandbox install, so it
does not need bootstrapping and will not disappear between runs. A `python` → `python3`
symlink is also provided, so both `python …` and `python3 …` work — but if you ever hit
`python: command not found`, fall back to `python3` (always present) and file a tool-gap.

- **Stdlib available:** `json`, `urllib.request`, `urllib.error`, `ssl`, etc. No `pip install`
  is needed for control-plane scripting.
- **Outbound network:** both plain HTTP (the control-plane API speaks HTTP) and HTTPS egress
  work from `urllib.request`. Verified against `$PAPERCLIP_API_URL` and external HTTPS hosts.

Prefer a 3-line python script over verbose `bash`/`jq` gymnastics when you need to read or
write JSON, call the API, or process a response.

### Canonical control-plane API call (copy-paste)

All connection details come from env — **never hardcode** host, company id, or key.

```python
import json, os, urllib.request, urllib.error

API   = os.environ["PAPERCLIP_API_URL"]          # e.g. http://78.153.195.107:3210
COMPANY = os.environ["PAPERCLIP_COMPANY_ID"]
KEY   = os.environ["PAPERCLIP_API_KEY"]

def api(method, path, body=None):
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")

# Examples:
# status, issue   = api("GET",  f"/api/issues/AUR-1234")
# status, records = api("GET",  f"/api/companies/{COMPANY}/memory/records?titlePrefix=tool-gaps/&limit=50")
# status, _       = api("POST", f"/api/issues/{ISSUE_ID}/comments", {"body": "..."})
# status, _       = api("POST", f"/api/companies/{COMPANY}/memory/capture", {
#     "title": "...", "content": "...", "metadata": {...},
#     "source": {"kind": "issue", "issueId": "AUR-1234"}})
```

Auth header form is `Authorization: Bearer $PAPERCLIP_API_KEY` (returns 200). A bare request
with no auth returns 401 — that is an auth problem, **not** a "python/network missing" problem.

Source of truth for routes: `server/src/routes/issues.ts`.

### `pcp` helper for quick one-liners

`scripts/pcp` is a tiny zero-dependency wrapper (pure python3 stdlib) so you don't hand-roll
`python3 -c "import json,sys; ..."` for routine JSON / arithmetic / validation / HTTP work:

```bash
scripts/pcp calc '2**16'                          # -> 65536
cat resp.json | scripts/pcp json 'd["items"][0]["id"]'   # eval expr with stdin JSON bound to d
cat resp.json | scripts/pcp get items.0.id        # dotted/index path extract
cat resp.json | scripts/pcp validate              # exit 0/1 + OK/INVALID
scripts/pcp http GET https://example.com          # urllib request (honors network policy below)
```

Run `scripts/pcp --help` for the full list. For control-plane calls, set headers via the
`PCP_HTTP_HEADERS` env (JSON), e.g. `PCP_HTTP_HEADERS='{"Authorization":"Bearer '"$PAPERCLIP_API_KEY"'"}'`.

## Bash sandbox network policy

The Bash tool runs **sandboxed by default**, and outbound network from the sandbox is
*reachable but DNS resolution is unreliable across clients*:

- `python3` `urllib` and `getent hosts` **usually resolve and connect** (HTTPS 200) — this is
  why the python API snippet above works from the default sandbox.
- `curl` / `wget` **frequently fail** with `Could not resolve host` in the sandbox, even when
  python urllib succeeds in the same shell. "It worked last time, now it doesn't" is expected
  sandbox flakiness, not a per-host outage.

When you need **guaranteed** outbound network — `curl`, `git push`, package installs, or any
external API call that must not flake — run the Bash tool with the sandbox disabled
(`dangerouslyDisableSandbox: true`). With the sandbox off, `curl https://…` returns 200 reliably.

Rule of thumb:
- Quick read-only JSON / arithmetic / file / local-API work → default sandbox + `python3`/`pcp`.
- Reliable external HTTPS / git network / installs → disable the sandbox for that call.

The local Paperclip API (`$PAPERCLIP_API_URL`, plain HTTP) is reachable from the default
sandbox; you do **not** need to disable the sandbox for control-plane calls.
