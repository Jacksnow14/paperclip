#!/usr/bin/env python3
"""
browser_bridge.py — agent-callable browser capability (predictor host)
AUR-2402 Phase 1

A general-purpose browser automation script backed by persisted Chromium profiles.
No Chrome-extension dependency. Profiles survive across runs (sessions, cookies, localStorage).

Usage:
    python3 /home/ievgen/browser-bridge/browser_bridge.py '<json>'
    python3 /home/ievgen/browser-bridge/browser_bridge.py --file input.json
    echo '<json>' | python3 /home/ievgen/browser-bridge/browser_bridge.py

Input JSON schema:
    {
      "command": "navigate|fill_form|fill_and_submit|read_page|screenshot|run_js|read_shadow_dom",
      "url": "https://...",
      "profile": "default",          // optional; persisted profile name (default: "default")
      "wait_for_cloudflare": false,  // optional; wait up to 30 s for CF JS challenge
      "timeout_ms": 30000,           // optional; nav timeout (default: 30000)
      "evidence_dir": "...",         // optional; screenshot dir
      // command-specific:
      "selector": "...",             // for read_shadow_dom, fill_form single field
      "fields": [                    // for fill_form / fill_and_submit
        {"selector": "css-selector", "value": "...", "action": "type|select|check"}
      ],
      "submit_selector": "...",      // for fill_and_submit (optional)
      "js_code": "...",              // for run_js — MUST return serialisable value
      "pierce_shadow": true,         // for read_page — pierce shadow DOM roots
      "max_text_chars": 8000         // for read_page (default: 8000)
    }

Output JSON:
    {
      "status": "ok" | "error" | "blocked",
      "url": "...",
      "data": { ... },   // command-specific payload
      "evidence_path": null | "/path/to/screenshot.png",
      "error": null | "..."
    }

data shapes by command:
    navigate:         {"title": "...", "page_text": "...", "cloudflare_passed": bool}
    fill_form:        {"title": "...", "page_text": "..."}
    fill_and_submit:  {"title": "...", "page_text": "..."}
    read_page:        {"title": "...", "html": "...", "page_text": "...", "shadow_texts": [...]}
    screenshot:       {"title": "...", "screenshot_path": "..."}
    run_js:           {"result": <any serialisable JS return value>}
    read_shadow_dom:  {"texts": [...]}   // text from each shadow root found

Profile storage: /home/ievgen/browser-profiles/<profile>/
Evidence storage: /home/ievgen/browser-bridge/evidence/ (override with evidence_dir)
"""

import sys
import json
import os
import time
import hashlib
import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

PROFILE_BASE = Path("/home/ievgen/browser-profiles")
DEFAULT_EVIDENCE_DIR = Path("/home/ievgen/browser-bridge/evidence")
CF_CHALLENGE_MARKERS = [
    "just a moment",
    "checking your browser",
    "enable javascript and cookies",
    "cloudflare ray id",
    "cf-browser-verification",
    "please stand by",
    "ddos-guard",
]
CAPTCHA_MARKERS = [
    "g-recaptcha", "grecaptcha", "recaptcha/api.js",
    "hcaptcha.com", "h-captcha",
    "cf-turnstile", "challenges.cloudflare.com",
    "i am not a robot", "verify you are human", "verify you're human",
    "perimeterx", "datadome", "imperva", "incapsula", "akamai bot manager",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def profile_dir(profile_name: str) -> str:
    p = PROFILE_BASE / profile_name
    p.mkdir(parents=True, exist_ok=True)
    return str(p)


def evidence_path(evidence_dir: str, prefix: str, url: str) -> str:
    ts = int(time.time())
    h = hashlib.md5(url.encode()).hexdigest()[:8]
    return str(Path(evidence_dir) / f"{prefix}_{ts}_{h}.png")


def is_cf_challenge(page) -> bool:
    try:
        text = page.inner_text("body").lower()
        for m in CF_CHALLENGE_MARKERS:
            if m in text:
                return True
    except Exception:
        pass
    return False


def wait_for_cloudflare(page, timeout_ms: int = 30000) -> bool:
    """Poll until the CF JS-challenge page resolves. Returns True if passed."""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        if not is_cf_challenge(page):
            return True
        time.sleep(1.5)
    return not is_cf_challenge(page)


def detect_bot_block(page) -> tuple[bool, str]:
    try:
        html = page.content().lower()
        text = page.inner_text("body").lower() if page.query_selector("body") else ""
    except Exception:
        return False, ""
    for m in CAPTCHA_MARKERS:
        if m in html or m in text:
            return True, f"Anti-bot gate detected: '{m}'"
    return False, ""


def collect_shadow_texts(page) -> list:
    """Collect text from all shadow DOM roots on the page."""
    return page.evaluate("""() => {
        const texts = [];
        function pierce(root) {
            const nodes = root.querySelectorAll('*');
            for (const n of nodes) {
                if (n.shadowRoot) {
                    const t = n.shadowRoot.textContent || '';
                    if (t.trim()) texts.push(t.trim().substring(0, 2000));
                    pierce(n.shadowRoot);
                }
            }
        }
        pierce(document);
        return texts;
    }""")


def fill_fields(page, fields: list, timeout_ms: int = 5000) -> dict | None:
    """Fill form fields. Returns error dict on failure, None on success."""
    for field in fields:
        selector = field.get("selector", "")
        value = field.get("value", "")
        action = field.get("action", "").lower()
        if not selector:
            continue
        try:
            element = page.wait_for_selector(selector, timeout=timeout_ms)
            if not element:
                return {"status": "error", "message": f"Selector not found: {selector}"}
            tag = element.evaluate("el => el.tagName.toLowerCase()")
            input_type = element.evaluate("el => (el.getAttribute('type') || '').toLowerCase()")

            if action == "select" or tag == "select":
                element.select_option(value=value)
            elif action == "check" or input_type in ("checkbox", "radio"):
                if value.lower() in ("true", "1", "yes", "on"):
                    element.check()
                else:
                    element.uncheck()
            else:
                element.click(click_count=3)
                element.type(value, delay=25)
            time.sleep(0.15)
        except PlaywrightTimeoutError:
            return {"status": "error", "message": f"Timeout waiting for selector: {selector}"}
    return None


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------

def cmd_navigate(page, inp: dict, ev_dir: str) -> dict:
    url = inp["url"]
    timeout_ms = int(inp.get("timeout_ms", 30000))
    do_cf = bool(inp.get("wait_for_cloudflare", False))
    ev = None

    page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    time.sleep(0.5)

    cf_passed = True
    if do_cf and is_cf_challenge(page):
        cf_passed = wait_for_cloudflare(page, timeout_ms=30000)

    blocked, reason = detect_bot_block(page)
    title = page.title()
    page_text = page.inner_text("body") if page.query_selector("body") else ""

    return {
        "status": "blocked" if (blocked and not do_cf) else "ok",
        "url": page.url,
        "data": {
            "title": title,
            "page_text": page_text[:int(inp.get("max_text_chars", 8000))],
            "cloudflare_passed": cf_passed,
        },
        "evidence_path": ev,
        "error": reason if blocked and not do_cf else None,
    }


def cmd_read_page(page, inp: dict, ev_dir: str) -> dict:
    url = inp["url"]
    timeout_ms = int(inp.get("timeout_ms", 30000))
    do_cf = bool(inp.get("wait_for_cloudflare", False))
    pierce = bool(inp.get("pierce_shadow", False))
    max_chars = int(inp.get("max_text_chars", 8000))

    page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    time.sleep(0.5)

    if do_cf and is_cf_challenge(page):
        wait_for_cloudflare(page, 30000)

    title = page.title()
    html = page.content()
    page_text = page.inner_text("body") if page.query_selector("body") else ""
    shadow_texts = collect_shadow_texts(page) if pierce else []

    return {
        "status": "ok",
        "url": page.url,
        "data": {
            "title": title,
            "html": html[:max_chars],
            "page_text": page_text[:max_chars],
            "shadow_texts": shadow_texts,
        },
        "evidence_path": None,
        "error": None,
    }


def cmd_screenshot(page, inp: dict, ev_dir: str) -> dict:
    url = inp["url"]
    timeout_ms = int(inp.get("timeout_ms", 30000))
    do_cf = bool(inp.get("wait_for_cloudflare", False))
    path = evidence_path(ev_dir, "screenshot", url)

    page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    time.sleep(0.8)

    if do_cf and is_cf_challenge(page):
        wait_for_cloudflare(page, 30000)

    page.screenshot(path=path, full_page=True)
    title = page.title()

    return {
        "status": "ok",
        "url": page.url,
        "data": {"title": title, "screenshot_path": path},
        "evidence_path": path,
        "error": None,
    }


def cmd_fill_form(page, inp: dict, ev_dir: str) -> dict:
    url = inp["url"]
    timeout_ms = int(inp.get("timeout_ms", 30000))
    do_cf = bool(inp.get("wait_for_cloudflare", False))
    fields = inp.get("fields", [])
    path = evidence_path(ev_dir, "fill_form", url)

    page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    time.sleep(0.5)

    if do_cf and is_cf_challenge(page):
        wait_for_cloudflare(page, 30000)

    err = fill_fields(page, fields, timeout_ms=5000)
    if err:
        return {**err, "url": page.url, "data": {}, "evidence_path": None}

    time.sleep(0.3)
    page.screenshot(path=path, full_page=True)
    title = page.title()
    page_text = page.inner_text("body") if page.query_selector("body") else ""

    return {
        "status": "ok",
        "url": page.url,
        "data": {"title": title, "page_text": page_text[:4000]},
        "evidence_path": path,
        "error": None,
    }


def cmd_fill_and_submit(page, inp: dict, ev_dir: str) -> dict:
    url = inp["url"]
    timeout_ms = int(inp.get("timeout_ms", 30000))
    do_cf = bool(inp.get("wait_for_cloudflare", False))
    fields = inp.get("fields", [])
    submit_selector = inp.get("submit_selector", None)
    path = evidence_path(ev_dir, "submit", url)

    page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    time.sleep(0.5)

    if do_cf and is_cf_challenge(page):
        wait_for_cloudflare(page, 30000)

    blocked, reason = detect_bot_block(page)
    if blocked:
        return {"status": "blocked", "url": page.url, "data": {}, "evidence_path": None, "error": reason}

    err = fill_fields(page, fields, timeout_ms=5000)
    if err:
        return {**err, "url": page.url, "data": {}, "evidence_path": None}

    time.sleep(0.4)

    if submit_selector:
        try:
            btn = page.wait_for_selector(submit_selector, timeout=5000)
            if btn:
                btn.click()
        except PlaywrightTimeoutError:
            return {"status": "error", "url": page.url, "data": {}, "evidence_path": None,
                    "error": f"Submit selector not found: {submit_selector}"}
    else:
        for fallback in [
            "input[type='submit']", "button[type='submit']",
            "button:has-text('Submit')", "button:has-text('Send')",
            "button:has-text('Contact')", "input[value='Submit']",
        ]:
            btn = page.query_selector(fallback)
            if btn:
                btn.click()
                break
        else:
            if fields:
                el = page.query_selector(fields[-1].get("selector", ""))
                if el:
                    el.press("Enter")

    try:
        page.wait_for_load_state("networkidle", timeout=8000)
    except PlaywrightTimeoutError:
        pass

    time.sleep(0.8)
    page.screenshot(path=path, full_page=True)
    title = page.title()
    page_text = page.inner_text("body") if page.query_selector("body") else ""
    blocked2, reason2 = detect_bot_block(page)

    return {
        "status": "blocked" if blocked2 else "ok",
        "url": page.url,
        "data": {"title": title, "page_text": page_text[:4000]},
        "evidence_path": path,
        "error": reason2 if blocked2 else None,
    }


def cmd_run_js(page, inp: dict, ev_dir: str) -> dict:
    url = inp.get("url")
    js_code = inp.get("js_code", "")
    timeout_ms = int(inp.get("timeout_ms", 30000))
    do_cf = bool(inp.get("wait_for_cloudflare", False))

    if url:
        page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        time.sleep(0.5)
        if do_cf and is_cf_challenge(page):
            wait_for_cloudflare(page, 30000)

    result = page.evaluate(js_code)
    return {
        "status": "ok",
        "url": page.url,
        "data": {"result": result},
        "evidence_path": None,
        "error": None,
    }


def cmd_read_shadow_dom(page, inp: dict, ev_dir: str) -> dict:
    url = inp["url"]
    timeout_ms = int(inp.get("timeout_ms", 30000))
    do_cf = bool(inp.get("wait_for_cloudflare", False))
    selector = inp.get("selector", None)

    page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    time.sleep(0.5)
    if do_cf and is_cf_challenge(page):
        wait_for_cloudflare(page, 30000)

    if selector:
        texts = page.evaluate(f"""() => {{
            const root = document.querySelector({json.dumps(selector)});
            if (!root || !root.shadowRoot) return [];
            return [root.shadowRoot.textContent || ''];
        }}""")
    else:
        texts = collect_shadow_texts(page)

    return {
        "status": "ok",
        "url": page.url,
        "data": {"texts": texts},
        "evidence_path": None,
        "error": None,
    }


COMMANDS = {
    "navigate": cmd_navigate,
    "read_page": cmd_read_page,
    "screenshot": cmd_screenshot,
    "fill_form": cmd_fill_form,
    "fill_and_submit": cmd_fill_and_submit,
    "run_js": cmd_run_js,
    "read_shadow_dom": cmd_read_shadow_dom,
}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run_bridge(inp: dict) -> dict:
    command = inp.get("command", "navigate")
    if command not in COMMANDS:
        return {"status": "error", "url": "", "data": {}, "evidence_path": None,
                "error": f"Unknown command '{command}'. Valid: {list(COMMANDS)}"}

    url = inp.get("url", "")
    if not url and command not in ("run_js",):
        return {"status": "error", "url": "", "data": {}, "evidence_path": None,
                "error": "Missing required field: url"}

    profile_name = inp.get("profile", "default")
    user_data = profile_dir(profile_name)
    ev_dir = str(inp.get("evidence_dir", DEFAULT_EVIDENCE_DIR))
    Path(ev_dir).mkdir(parents=True, exist_ok=True)

    timeout_ms = int(inp.get("timeout_ms", 30000))

    with sync_playwright() as p:
        # Launch with persistent profile so sessions/cookies survive
        context = p.chromium.launch_persistent_context(
            user_data_dir=user_data,
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-blink-features=AutomationControlled",
                "--disable-extensions",
                "--lang=en-US,en",
            ],
            viewport={"width": 1280, "height": 800},
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            java_script_enabled=True,
            locale="en-US",
            timezone_id="America/New_York",
        )

        try:
            page = context.new_page()
            # Mask automation signals
            page.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                window.chrome = { runtime: {} };
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5]
                });
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en']
                });
            """)

            result = COMMANDS[command](page, inp, ev_dir)
            context.close()
            return result

        except PlaywrightTimeoutError as e:
            ev = evidence_path(ev_dir, "error", url or "nourl")
            try:
                page.screenshot(path=ev, full_page=True)
            except Exception:
                ev = None
            try:
                context.close()
            except Exception:
                pass
            return {"status": "error", "url": url, "data": {}, "evidence_path": ev,
                    "error": f"Navigation timeout: {e}"}

        except Exception as e:
            ev = evidence_path(ev_dir, "error", url or "nourl")
            try:
                page.screenshot(path=ev, full_page=True)
            except Exception:
                ev = None
            try:
                context.close()
            except Exception:
                pass
            return {"status": "error", "url": url, "data": {}, "evidence_path": ev,
                    "error": f"Unexpected error: {e}"}


def main():
    parser = argparse.ArgumentParser(description="Browser bridge — agent-callable browser automation")
    parser.add_argument("json_input", nargs="?", help="JSON input string")
    parser.add_argument("--file", "-f", help="Path to JSON input file")
    args = parser.parse_args()

    if args.file:
        with open(args.file) as fh:
            inp = json.load(fh)
    elif args.json_input:
        inp = json.loads(args.json_input)
    else:
        raw = sys.stdin.read().strip()
        if raw:
            inp = json.loads(raw)
        else:
            print(json.dumps({"status": "error", "error": "No input. Pass JSON as argument or via --file."}))
            sys.exit(1)

    result = run_bridge(inp)
    print(json.dumps(result, indent=2))
    sys.exit(0 if result.get("status") in ("ok", "blocked") else 1)


if __name__ == "__main__":
    main()
