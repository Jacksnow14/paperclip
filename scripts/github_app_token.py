#!/usr/bin/env python3
"""
Mint a GitHub App installation token and cache it for ~50 min.

Usage:
  python3 scripts/github_app_token.py              # print token to stdout
  python3 scripts/github_app_token.py --git-credential  # emit credential-helper protocol
  python3 scripts/github_app_token.py --app-id ID --installation-id ID

Secrets:
  PEM private key: secret_vault.py get github-app-key  (parses the "value   :" line)
  App config:      scripts/github-app.config.json       (keys: app_id, installation_id)
                   or env vars: GITHUB_APP_ID, GITHUB_INSTALLATION_ID
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

CACHE_FILE = Path("/home/ievgen/secret-vault/.github-app-token-cache")
CACHE_TTL_SECONDS = 50 * 60  # 50 minutes (tokens expire after 60 min)
CONFIG_FILE = Path(__file__).parent / "github-app.config.json"
VAULT_SCRIPT = Path(__file__).parent / "secret_vault.py"
ROTATION_CMD = (
    "python3 scripts/secret_vault.py seed github-app-key "
    "--scopes contents:write pull_requests:write\n"
    "rm -f /home/ievgen/secret-vault/.github-app-token-cache"
)


def _die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def _read_pem_from_vault() -> str:
    """Run secret_vault.py get github-app-key and extract the 'value :' line."""
    env = dict(os.environ)
    if "PAPERCLIP_AGENT_ID" not in env:
        env["PAPERCLIP_AGENT_ID"] = "github_app_token"
    try:
        result = subprocess.run(
            [sys.executable, str(VAULT_SCRIPT), "get", "github-app-key"],
            capture_output=True,
            text=True,
            env=env,
            timeout=15,
        )
    except FileNotFoundError:
        _die(f"Vault script not found: {VAULT_SCRIPT}")
    except subprocess.TimeoutExpired:
        _die("Vault script timed out")

    if result.returncode != 0:
        _die(
            f"Vault lookup failed (exit {result.returncode}): {result.stderr.strip()}\n"
            f"Run the rotation command:\n{ROTATION_CMD}"
        )

    for line in result.stdout.splitlines():
        if line.startswith("value"):
            _, _, pem = line.partition(":")
            return pem.strip()

    _die(
        "Vault returned no 'value :' line for github-app-key.\n"
        f"Run the rotation command:\n{ROTATION_CMD}"
    )


def _load_config(app_id_override: str | None, installation_id_override: str | None) -> tuple[str, str]:
    """Return (app_id, installation_id) from config file, env, or CLI overrides."""
    app_id = app_id_override or os.environ.get("GITHUB_APP_ID")
    installation_id = installation_id_override or os.environ.get("GITHUB_INSTALLATION_ID")

    if not app_id or not installation_id:
        if CONFIG_FILE.exists():
            try:
                cfg = json.loads(CONFIG_FILE.read_text())
                app_id = app_id or str(cfg.get("app_id", ""))
                installation_id = installation_id or str(cfg.get("installation_id", ""))
            except (json.JSONDecodeError, OSError) as exc:
                _die(f"Failed to read {CONFIG_FILE}: {exc}")

    if not app_id:
        _die("GitHub App ID not found. Set --app-id, GITHUB_APP_ID env, or github-app.config.json")
    if not installation_id:
        _die("Installation ID not found. Set --installation-id, GITHUB_INSTALLATION_ID env, or github-app.config.json")

    return app_id, installation_id


def _make_jwt(pem: str, app_id: str) -> str:
    """Sign a 10-minute RS256 JWT using PyJWT + cryptography."""
    now = int(time.time())
    payload = {
        "iat": now - 60,   # backdate 60s to account for clock skew
        "exp": now + (10 * 60),
        "iss": app_id,
    }
    try:
        import jwt as pyjwt
        from cryptography.hazmat.backends import default_backend
        from cryptography.hazmat.primitives.serialization import load_pem_private_key

        private_key = load_pem_private_key(pem.encode(), password=None, backend=default_backend())
        token = pyjwt.encode(payload, private_key, algorithm="RS256")
        if isinstance(token, bytes):
            token = token.decode()
        return token
    except ImportError:
        pass

    # Fallback: hand-roll RS256 with cryptography only (no PyJWT)
    import base64
    import hashlib
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    def _b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    body = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header}.{body}".encode()

    private_key = load_pem_private_key(pem.encode(), password=None, backend=default_backend())
    signature = private_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return f"{header}.{body}.{_b64url(signature)}"


def _exchange_jwt_for_token(app_jwt: str, installation_id: str) -> tuple[str, str]:
    """POST the JWT to GitHub and return (token, expires_at)."""
    import urllib.request
    import urllib.error

    url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    req = urllib.request.Request(
        url,
        method="POST",
        headers={
            "Authorization": f"Bearer {app_jwt}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "paperclip-github-app-token/1.0",
        },
        data=b"{}",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        _die(
            f"GitHub API error {exc.code}: {body_text}\n"
            f"If the App key is invalid or revoked, run:\n{ROTATION_CMD}"
        )
    except Exception as exc:
        _die(f"Network error contacting GitHub: {exc}")

    token = body.get("token")
    if not token:
        _die(f"GitHub API returned no token. Response: {body}")
    return token, body.get("expires_at", "")


def _read_cache() -> str | None:
    """Return cached token string if still fresh, else None."""
    if not CACHE_FILE.exists():
        return None
    try:
        raw = CACHE_FILE.read_text().strip()
        lines = {k.strip(): v.strip() for k, v in (l.split("=", 1) for l in raw.splitlines() if "=" in l)}
        token = lines.get("token")
        cached_at = float(lines.get("cached_at", "0"))
        if token and (time.time() - cached_at) < CACHE_TTL_SECONDS:
            return token
    except Exception:
        pass
    return None


def _write_cache(token: str) -> None:
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        CACHE_FILE.write_text(f"token={token}\ncached_at={time.time()}\n")
        CACHE_FILE.chmod(0o600)
    except Exception as exc:
        print(f"[github_app_token] Warning: could not write cache: {exc}", file=sys.stderr)


def mint_token(app_id: str, installation_id: str) -> str:
    """Mint (or return cached) installation token."""
    cached = _read_cache()
    if cached:
        return cached

    pem = _read_pem_from_vault()
    app_jwt = _make_jwt(pem, app_id)
    token, _expires = _exchange_jwt_for_token(app_jwt, installation_id)
    _write_cache(token)
    return token


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Mint a GitHub App installation token (cached ~50 min)."
    )
    parser.add_argument("--app-id", help="GitHub App numeric ID (overrides config/env)")
    parser.add_argument("--installation-id", help="GitHub App installation ID (overrides config/env)")
    parser.add_argument(
        "--git-credential",
        action="store_true",
        help="Emit git credential-helper protocol (username + password lines)",
    )
    args = parser.parse_args()

    app_id, installation_id = _load_config(args.app_id, args.installation_id)
    token = mint_token(app_id, installation_id)

    if args.git_credential:
        print("username=x-access-token")
        print(f"password={token}")
    else:
        print(token)


if __name__ == "__main__":
    main()
