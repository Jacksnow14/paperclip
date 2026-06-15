# browser-bridge: Agent-callable Browser Capability

**Host:** predictor VPS (`78.153.195.107`)  
**Script:** `/home/ievgen/paperclip/scripts/browser_bridge.py`  
**Evidence dir:** `/home/ievgen/browser-bridge/evidence/`  
**Profile storage:** `/home/ievgen/browser-profiles/<profile-name>/` (outside repo, not in git)

Backed by Playwright 1.58 + Chromium headless on the predictor host. No Chrome-extension dependency. Persistent profiles survive session cookies, localStorage, and Cloudflare JS-cookie challenges across runs.

---

## Invocation contract

```bash
python3 /home/ievgen/paperclip/scripts/browser_bridge.py '<json>'
python3 /home/ievgen/paperclip/scripts/browser_bridge.py --file input.json
echo '<json>' | python3 /home/ievgen/paperclip/scripts/browser_bridge.py
```

### Input schema

```json
{
  "command":            "navigate|read_page|screenshot|fill_form|fill_and_submit|run_js|read_shadow_dom",
  "url":                "https://...",
  "profile":            "default",       // optional; selects persistent Chromium profile
  "wait_for_cloudflare": false,          // optional; poll up to 30 s for CF JS challenge to pass
  "timeout_ms":         30000,           // optional; navigation timeout ms (default: 30000)
  "evidence_dir":       "...",           // optional; screenshot output dir
  "fields": [                            // fill_form / fill_and_submit
    {"selector": "css", "value": "...", "action": "type|select|check"}
  ],
  "submit_selector":    "...",           // fill_and_submit; optional, auto-detects common patterns
  "js_code":            "...",           // run_js; must return a serialisable value
  "pierce_shadow":      false,           // read_page; collect text from shadow DOM roots
  "selector":           "...",           // read_shadow_dom; narrow to one host element
  "max_text_chars":     8000             // read_page / navigate (default: 8000)
}
```

### Output schema

```json
{
  "status":         "ok" | "error" | "blocked",
  "url":            "https://...",     // final URL after redirects
  "data":           { ... },           // command-specific payload (see below)
  "evidence_path":  null | "/path/to/screenshot.png",
  "error":          null | "..."
}
```

**data shapes per command:**

| command | data keys |
|---|---|
| `navigate` | `title`, `page_text`, `cloudflare_passed` |
| `read_page` | `title`, `html`, `page_text`, `shadow_texts` |
| `screenshot` | `title`, `screenshot_path` |
| `fill_form` | `title`, `page_text` |
| `fill_and_submit` | `title`, `page_text` |
| `run_js` | `result` (serialised JS return value) |
| `read_shadow_dom` | `texts` (list of shadow root text content) |

---

## Profile registry

Profiles are stored at `/home/ievgen/browser-profiles/<name>/`. Each profile is a Chromium `user-data-dir` — it stores cookies, localStorage, IndexedDB, and Cloudflare clearance tokens.

| Profile name | Service | Seeded | Notes |
|---|---|---|---|
| `default` | General browsing | No seed needed | Fresh profile; use for anonymous public pages |
| `form-test` | quotes.toscrape.com | Auto-seeded on first run | Demo login; validates fill_and_submit pipeline |
| `cf-test` | CF-gated pages | No | Headless-only; re-challenges on hard CF bot management |

### How to seed a profile interactively

For services with Cloudflare bot management or OAuth login, seed the profile once via VNC or `claude-in-chrome`, then subsequent headless runs reuse the stored cookies.

**Option A — VNC (predictor host, port 5900):**

```bash
# On the predictor host, launch Chromium with the target profile
DISPLAY=:1 chromium-browser \
  --user-data-dir=/home/ievgen/browser-profiles/<profile-name> \
  https://target-service.com

# Complete login / solve CF challenge / accept cookies
# Close the browser — cookies are persisted to the profile directory
```

**Option B — `claude-in-chrome` (from Claude Code):**

Use the `claude-in-chrome` skill to navigate to the target service, complete any challenge or login, and then note the session is stored in the matching profile directory. This requires manually specifying the `--user-data-dir` flag in the claude-in-chrome config to match the profile path.

**Option C — headless auto-seed for public APIs:**

For public REST APIs behind Cloudflare (e.g. thesportsdb.com), the headless browser often resolves the CF JS-cookie challenge automatically on first request. No manual seeding required.

---

## Security boundary

- **Profiles outside the repo.** `/home/ievgen/browser-profiles/` is not tracked in git. No cookies, tokens, or credentials can leak via a git push.
- **No secrets in the script.** `browser_bridge.py` contains zero credentials. If a seeded profile stores OAuth tokens, they remain on the host filesystem only.
- **Phase 2 out of scope.** Do NOT seed admin-write profiles (Google Workspace Admin delegated write, YouTube brand-account tokens, Shopify app secrets). Phase 2 design is board-gated (AUR-2398).

---

## Examples

### Fetch a Cloudflare-protected page

```bash
python3 /home/ievgen/paperclip/scripts/browser_bridge.py '{
  "command": "read_page",
  "url": "https://www.thesportsdb.com/api/v1/json/3/all_leagues.php",
  "wait_for_cloudflare": true,
  "profile": "default"
}'
```

### Fill and submit a form

```bash
python3 /home/ievgen/paperclip/scripts/browser_bridge.py '{
  "command": "fill_and_submit",
  "url": "https://quotes.toscrape.com/login",
  "profile": "default",
  "fields": [
    {"selector": "input#username", "value": "admin"},
    {"selector": "input#password", "value": "12345"}
  ],
  "submit_selector": "input[type=submit]"
}'
```

### Take a screenshot

```bash
python3 /home/ievgen/paperclip/scripts/browser_bridge.py '{
  "command": "screenshot",
  "url": "https://example.com",
  "profile": "default"
}'
```

### Run arbitrary JS on a page

```bash
python3 /home/ievgen/paperclip/scripts/browser_bridge.py '{
  "command": "run_js",
  "url": "https://example.com",
  "js_code": "document.title + ' | ' + document.querySelectorAll('a').length + ' links'"
}'
```

### Read shadow DOM text

```bash
python3 /home/ievgen/paperclip/scripts/browser_bridge.py '{
  "command": "read_page",
  "url": "https://component-library.example.com",
  "pierce_shadow": true
}'
```

---

## Relation to other tools

| Tool | Role |
|---|---|
| `form_runner.py` (`/home/ievgen/outreach/`) | Narrow outreach form filler; superseded by `browser_bridge.py` for new work |
| `reel_extract.py` | yt-dlp + whisper pipeline; not browser-automation — separate tool |
| `nlm` CLI | NotebookLM specific; uses CDP; continues to work alongside bridge |
| `claude-in-chrome` extension | Interactive browser control from Claude Code; requires live extension; use for profile seeding |
