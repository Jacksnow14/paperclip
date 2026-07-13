#!/usr/bin/env python3
"""
Paperclip Secret Vault — Phase 2a foundation
Encrypted at-rest credential storage with per-operation audit log.

Guardrails implemented:
  1. Encrypted at rest — Fernet (AES-128-CBC + HMAC-SHA256), key outside repo.
  2. Per-service least-scope — put/seed reject records with no --scopes.
  3. Audit log — every operation appended to vault-audit.log (timestamp, agent, service, action).
  4. Revocation — revoke removes ciphertext + writes audit entry; doc covers upstream revoke.
  5. Human-seeded consent — vault never mints/refreshes tokens; seed is interactive only.
"""
import argparse
import datetime
import getpass
import json
import os
import sys
from pathlib import Path

from cryptography.fernet import Fernet

VAULT_DIR = Path("/home/ievgen/secret-vault")
KEY_FILE = VAULT_DIR / "vault.key"
SECRETS_FILE = VAULT_DIR / "secrets.json.enc"
AUDIT_LOG = VAULT_DIR / "vault-audit.log"

# Set PAPERCLIP_AGENT_ID in env to identify the calling agent in audit entries.
AGENT_ID = os.environ.get("PAPERCLIP_AGENT_ID", "unknown")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _ensure_vault_dir():
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    VAULT_DIR.chmod(0o700)


def _load_key() -> Fernet:
    _ensure_vault_dir()
    if not KEY_FILE.exists():
        key = Fernet.generate_key()
        KEY_FILE.write_bytes(key)
        KEY_FILE.chmod(0o600)
        print(f"[vault] Generated new encryption key at {KEY_FILE}", file=sys.stderr)
    return Fernet(KEY_FILE.read_bytes())


def _load_secrets(f: Fernet) -> dict:
    if not SECRETS_FILE.exists():
        return {}
    return json.loads(f.decrypt(SECRETS_FILE.read_bytes()))


def _save_secrets(f: Fernet, secrets: dict):
    _ensure_vault_dir()
    ciphertext = f.encrypt(json.dumps(secrets, indent=2).encode())
    SECRETS_FILE.write_bytes(ciphertext)
    SECRETS_FILE.chmod(0o600)


def _audit(action: str, service: str, extra: str = ""):
    _ensure_vault_dir()
    ts = datetime.datetime.utcnow().isoformat() + "Z"
    line = f"{ts}  agent={AGENT_ID}  service={service}  action={action}"
    if extra:
        line += f"  {extra}"
    with open(AUDIT_LOG, "a") as fh:
        fh.write(line + "\n")


def _require_scopes(scopes):
    if not scopes:
        print("ERROR: --scopes is required; put rejected without declared scope.", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

def cmd_seed(args):
    """Interactive consent flow — human pastes the token; value never appears in shell history."""
    _require_scopes(args.scopes)
    service = args.service
    scopes = args.scopes
    print(f"Seeding credential: service={service}  scopes={','.join(scopes)}")
    print("Paste the token/secret (input hidden, not logged):")
    try:
        value = getpass.getpass("> ")
    except (EOFError, KeyboardInterrupt):
        print("\nAborted.", file=sys.stderr)
        sys.exit(1)
    if not value.strip():
        print("ERROR: empty secret rejected.", file=sys.stderr)
        sys.exit(1)
    _store(service, scopes, value.strip())
    print(f"[vault] Stored {service} — encrypted at {SECRETS_FILE}")


def cmd_put(args):
    """Non-interactive put (for automation; still requires --scopes)."""
    _require_scopes(args.scopes)
    _store(args.service, args.scopes, args.value)
    print(f"[vault] Stored {args.service}")


def _store(service: str, scopes: list, value: str):
    f = _load_key()
    secrets = _load_secrets(f)
    secrets[service] = {
        "scopes": scopes,
        "value": value,
        "stored_at": datetime.datetime.utcnow().isoformat() + "Z",
    }
    _save_secrets(f, secrets)
    _audit("put", service, f"scopes={','.join(scopes)}")


def cmd_get(args):
    """Retrieve and display a stored credential. Logged in audit trail."""
    f = _load_key()
    secrets = _load_secrets(f)
    service = args.service
    if service not in secrets:
        print(f"ERROR: no secret found for service={service}", file=sys.stderr)
        sys.exit(1)
    _audit("get", service)
    rec = secrets[service]
    print(f"service : {service}")
    print(f"scopes  : {','.join(rec['scopes'])}")
    print(f"stored  : {rec['stored_at']}")
    print(f"value   : {rec['value']}")


def cmd_list(args):
    """List all services in the vault (no secret values shown)."""
    f = _load_key()
    secrets = _load_secrets(f)
    _audit("list", "*")
    if not secrets:
        print("Vault is empty.")
        return
    print(f"{'SERVICE':<30}  {'SCOPES':<40}  STORED")
    print("-" * 90)
    for svc, rec in sorted(secrets.items()):
        print(f"{svc:<30}  {','.join(rec['scopes']):<40}  {rec['stored_at']}")


def cmd_revoke(args):
    """Remove a secret from the vault and log the revocation.

    IMPORTANT: this only removes the local copy. You must also revoke the token
    upstream in the provider console (Google, Shopify, etc.) to fully kill it.
    See docs/secret-vault.md for the two-step procedure.
    """
    f = _load_key()
    secrets = _load_secrets(f)
    service = args.service
    if service not in secrets:
        print(f"ERROR: no secret found for service={service}", file=sys.stderr)
        sys.exit(1)
    del secrets[service]
    _save_secrets(f, secrets)
    _audit("revoke", service)
    print(f"[vault] Local secret for {service} deleted.")
    print("ACTION REQUIRED: Also revoke the token upstream in the provider console.")
    print("See docs/secret-vault.md § Revocation for the two-step procedure.")


def cmd_audit(args):
    """Print the last N lines of the audit log."""
    if not AUDIT_LOG.exists():
        print("No audit log yet.")
        return
    lines = AUDIT_LOG.read_text().splitlines()
    for line in lines[-args.tail:]:
        print(line)


# ---------------------------------------------------------------------------
# CLI wiring
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Paperclip Secret Vault — encrypted, audited, revocable credential storage."
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    # seed
    p = sub.add_parser("seed", help="Interactively seed a credential (human consent flow)")
    p.add_argument("service", help="Service identifier, e.g. google-workspace")
    p.add_argument("--scopes", nargs="+", required=True, help="Declared OAuth/API scopes")
    p.set_defaults(func=cmd_seed)

    # put
    p = sub.add_parser("put", help="Store a credential non-interactively (requires --scopes)")
    p.add_argument("service")
    p.add_argument("--scopes", nargs="+", required=True)
    p.add_argument("--value", required=True, help="The secret value to store")
    p.set_defaults(func=cmd_put)

    # get
    p = sub.add_parser("get", help="Retrieve a stored credential")
    p.add_argument("service")
    p.set_defaults(func=cmd_get)

    # list
    p = sub.add_parser("list", help="List all services (no secret values)")
    p.set_defaults(func=cmd_list)

    # revoke
    p = sub.add_parser("revoke", help="Delete a local secret + audit-log the revocation")
    p.add_argument("service")
    p.set_defaults(func=cmd_revoke)

    # audit
    p = sub.add_parser("audit", help="Show the audit log")
    p.add_argument("--tail", type=int, default=20, metavar="N", help="Last N lines (default 20)")
    p.set_defaults(func=cmd_audit)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
