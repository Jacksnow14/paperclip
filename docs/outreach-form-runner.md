# Outreach Form Automation Runner

Browser-form-automation script for the CMO outreach channel. Runs on the predictor host **78.153.195.107** using Playwright/Chromium. Built for [AUR-2011](/AUR/issues/AUR-2011).

---

## Where the script lives

```
/home/ievgen/outreach/form_runner.py
```

Chromium binary:
```
~/.cache/ms-playwright/chromium-1223/chrome-linux/chrome
```

---

## Invocation

```bash
# Inline JSON
python3 /home/ievgen/outreach/form_runner.py '<json>'

# From file
python3 /home/ievgen/outreach/form_runner.py --file /path/to/input.json

# Via stdin
echo '<json>' | python3 /home/ievgen/outreach/form_runner.py
```

**No extra env vars required.** The script uses the Playwright install at `~/.cache/ms-playwright` which is on the system PATH for the `ievgen` user.

---

## JSON Input Contract

```json
{
  "url": "https://target.com/contact",
  "fields": [
    { "selector": "input[name='email']",    "value": "hello@example.com" },
    { "selector": "input[name='name']",     "value": "Alice" },
    { "selector": "textarea#message",       "value": "Hi there..." }
  ],
  "submit_selector": "button[type='submit']",
  "evidence_dir":    "/home/ievgen/outreach/evidence",
  "timeout_ms":      15000
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `url` | **yes** | Full URL of the page with the form |
| `fields` | no | Array of `{selector, value}` pairs. Selector is any CSS selector. |
| `submit_selector` | no | CSS selector for the submit button. Auto-detects common patterns if omitted. |
| `evidence_dir` | no | Directory for screenshots. Default: `/home/ievgen/outreach/evidence` |
| `timeout_ms` | no | Navigation timeout in ms. Default: 15000 |

**Selector types supported:** text inputs, `<textarea>`, `<select>` (by value), checkboxes/radios (value `true`/`false`).

---

## JSON Output Contract

```json
{
  "status":        "submitted" | "captcha_blocked" | "error",
  "final_url":     "https://target.com/thank-you",
  "evidence_path": "/home/ievgen/outreach/evidence/form_run_1781044905_bcce1b49.png",
  "page_text":     "Thank you for your message...",
  "message":       "Form submitted successfully"
}
```

| Status | Meaning |
|--------|---------|
| `submitted` | Form filled and submitted; final URL and screenshot captured |
| `captcha_blocked` | Anti-bot gate detected (reCAPTCHA, hCaptcha, Cloudflare Turnstile, etc.); screenshot captured for human handoff |
| `error` | Unexpected failure (selector not found, timeout, network error); screenshot attempted |

Exit code: `0` for `submitted`/`captcha_blocked`, `1` for `error`.

---

## CAPTCHA / Anti-bot Detection

The runner detects (but **never attempts to solve or bypass**) the following:

- reCAPTCHA v2/v3 (Google)
- hCaptcha
- Cloudflare Turnstile / "Just a moment" challenges
- DDoS-Guard, Imperva, DataDome, PerimeterX, Akamai Bot Manager
- Generic "verify you're human / are you a robot" pages

When a gate is detected, the runner returns `captcha_blocked` and a screenshot so a human can take over.

---

## Out of scope (never implement)

- LinkedIn DM automation
- Mailbox-existence / email-validation probing
- CAPTCHA solving or third-party solver integration

---

## Chromium profile / auth model

- Runs in a fresh incognito context per call (no persistent cookies/sessions).
- No login credentials stored; contacts public or semi-public forms only.
- User-agent is set to a real Chrome string to avoid trivial bot fingerprinting.

---

## Demo runs (AUR-2011)

### Demo 1 — successful form submission

```bash
python3 /home/ievgen/outreach/form_runner.py '{
  "url": "https://httpbin.org/forms/post",
  "fields": [
    {"selector": "input[name=\"custname\"]",  "value": "Paperclip Test"},
    {"selector": "input[name=\"custtel\"]",   "value": "555-0100"},
    {"selector": "input[name=\"custemail\"]", "value": "test@paperclip.ing"},
    {"selector": "textarea[name=\"comments\"]","value": "Automated outreach test"}
  ],
  "evidence_dir": "/home/ievgen/outreach/evidence"
}'
```

Result: `{"status":"submitted","final_url":"https://httpbin.org/post",...}`

### Demo 2 — CAPTCHA detection

```bash
python3 /home/ievgen/outreach/form_runner.py '{
  "url": "https://nowsecure.nl",
  "fields": [],
  "evidence_dir": "/home/ievgen/outreach/evidence"
}'
```

Result: `{"status":"captcha_blocked","message":"Detected anti-bot gate marker: 'cf-turnstile'",...}`

---

## Using from an agent heartbeat

The script is non-interactive and safe to call unattended. From a heartbeat running on the predictor host or any host with SSH access:

```bash
# Direct (on predictor host)
RESULT=$(python3 /home/ievgen/outreach/form_runner.py "$INPUT_JSON")
STATUS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['status'])")

if [ "$STATUS" = "captcha_blocked" ]; then
  echo "Human handoff needed — CAPTCHA gate at $(echo $RESULT | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"final_url\"])')"
elif [ "$STATUS" = "error" ]; then
  echo "Error: $(echo $RESULT | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"message\"])')"
fi
```

Memory key for stable invocation path: `outreach/form-runner/invocation-path` (see Paperclip Memory).
