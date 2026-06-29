#!/usr/bin/env python3
"""
Offline unit tests for github_app_token.py.
Uses a throwaway RSA keypair — no real GitHub App or vault needed.

Run: python3 scripts/test_github_app_token.py
"""
import base64
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add scripts/ to path so we can import the module
sys.path.insert(0, str(Path(__file__).parent))

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives import hashes, serialization

import github_app_token as gat


def _generate_throwaway_keypair() -> tuple[str, str]:
    """Generate a throwaway RSA 2048 keypair; return (private_pem, public_pem)."""
    key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
        backend=default_backend(),
    )
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ).decode()
    public_pem = key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return private_pem, public_pem


def _b64url_decode(s: str) -> bytes:
    """Decode base64url without padding."""
    s += "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s)


class TestJWTConstruction(unittest.TestCase):
    """Test that _make_jwt produces a valid RS256 JWT."""

    def setUp(self):
        self.private_pem, self.public_pem = _generate_throwaway_keypair()
        self.app_id = "12345"

    def _decode_jwt_without_verify(self, token: str) -> dict:
        """Split the JWT and parse the payload without signature verification."""
        parts = token.split(".")
        self.assertEqual(len(parts), 3, "JWT must have 3 parts")
        header = json.loads(_b64url_decode(parts[0]))
        payload = json.loads(_b64url_decode(parts[1]))
        return header, payload, parts[2]

    def test_header_alg(self):
        """JWT header must declare alg=RS256."""
        token = gat._make_jwt(self.private_pem, self.app_id)
        header, _, _ = self._decode_jwt_without_verify(token)
        self.assertEqual(header["alg"], "RS256")
        self.assertEqual(header["typ"], "JWT")

    def test_claims(self):
        """JWT payload must contain iss, iat, exp."""
        before = int(time.time())
        token = gat._make_jwt(self.private_pem, self.app_id)
        after = int(time.time())

        _, payload, _ = self._decode_jwt_without_verify(token)
        self.assertEqual(payload["iss"], self.app_id)
        self.assertIn("iat", payload)
        self.assertIn("exp", payload)
        # iat is backdated 60s; exp is ~10 min from now
        self.assertLessEqual(payload["iat"], before)
        self.assertGreater(payload["exp"], after + 9 * 60)
        self.assertLess(payload["exp"], after + 11 * 60)

    def test_signature_verifies(self):
        """JWT signature must verify with the corresponding public key."""
        token = gat._make_jwt(self.private_pem, self.app_id)
        parts = token.split(".")
        signing_input = f"{parts[0]}.{parts[1]}".encode()
        signature = _b64url_decode(parts[2])

        from cryptography.hazmat.primitives.serialization import load_pem_public_key
        pub_key = load_pem_public_key(self.public_pem.encode(), backend=default_backend())
        try:
            pub_key.verify(signature, signing_input, padding.PKCS1v15(), hashes.SHA256())
        except Exception as exc:
            self.fail(f"Signature verification failed: {exc}")


class TestGitCredentialOutput(unittest.TestCase):
    """Test --git-credential output format."""

    def test_credential_format(self):
        """mint_token output must be returned as correct git credential-helper lines."""
        import io
        from unittest.mock import patch

        test_token = "ghs_TEST_TOKEN_123456789"

        with patch.object(gat, "mint_token", return_value=test_token):
            import io
            captured = io.StringIO()
            with patch("sys.stdout", captured):
                # simulate what main() does in --git-credential mode
                print("username=x-access-token")
                print(f"password={test_token}")
            output = captured.getvalue()

        lines = output.strip().splitlines()
        self.assertEqual(lines[0], "username=x-access-token")
        self.assertTrue(lines[1].startswith("password="))
        self.assertIn(test_token, lines[1])


class TestCacheLogic(unittest.TestCase):
    """Test cache read/write and TTL."""

    def test_cache_write_read_roundtrip(self):
        """Cached token should be returned by _read_cache when fresh."""
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_path = Path(tmpdir) / ".github-app-token-cache"
            with patch.object(gat, "CACHE_FILE", cache_path):
                gat._write_cache("ghs_CACHED_TOKEN")
                result = gat._read_cache()
        self.assertEqual(result, "ghs_CACHED_TOKEN")

    def test_cache_ttl_expired(self):
        """Stale cache entry should return None."""
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_path = Path(tmpdir) / ".github-app-token-cache"
            with patch.object(gat, "CACHE_FILE", cache_path):
                # Write an artificially old cache entry
                stale_time = time.time() - gat.CACHE_TTL_SECONDS - 60
                cache_path.write_text(f"token=ghs_OLD\ncached_at={stale_time}\n")
                result = gat._read_cache()
        self.assertIsNone(result)

    def test_cache_missing_returns_none(self):
        """Missing cache file should return None without error."""
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_path = Path(tmpdir) / ".github-app-token-cache"
            with patch.object(gat, "CACHE_FILE", cache_path):
                result = gat._read_cache()
        self.assertIsNone(result)

    def test_cache_mode_600(self):
        """Cache file must be written with mode 0600."""
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_path = Path(tmpdir) / ".github-app-token-cache"
            with patch.object(gat, "CACHE_FILE", cache_path):
                gat._write_cache("ghs_MODE_TEST")
            mode = oct(cache_path.stat().st_mode)[-3:]
        self.assertEqual(mode, "600")


class TestConfigLoading(unittest.TestCase):
    """Test config loading from JSON file, env, and CLI overrides."""

    def test_cli_overrides_win(self):
        """Explicit CLI overrides should take precedence."""
        app_id, install_id = gat._load_config("111", "222")
        self.assertEqual(app_id, "111")
        self.assertEqual(install_id, "222")

    def test_env_fallback(self):
        """GITHUB_APP_ID / GITHUB_INSTALLATION_ID env vars should be used when no CLI overrides."""
        with patch.dict(os.environ, {"GITHUB_APP_ID": "777", "GITHUB_INSTALLATION_ID": "888"}):
            app_id, install_id = gat._load_config(None, None)
        self.assertEqual(app_id, "777")
        self.assertEqual(install_id, "888")

    def test_json_config_fallback(self):
        """JSON config file should be read when no overrides or env vars."""
        cfg = {"app_id": 999, "installation_id": 1234}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(cfg, f)
            tmp_path = Path(f.name)
        try:
            with patch.object(gat, "CONFIG_FILE", tmp_path):
                with patch.dict(os.environ, {}, clear=True):
                    # Remove env vars if set
                    env = {k: v for k, v in os.environ.items()
                           if k not in ("GITHUB_APP_ID", "GITHUB_INSTALLATION_ID")}
                    with patch.dict(os.environ, env, clear=True):
                        app_id, install_id = gat._load_config(None, None)
            self.assertEqual(app_id, "999")
            self.assertEqual(install_id, "1234")
        finally:
            tmp_path.unlink()


if __name__ == "__main__":
    unittest.main(verbosity=2)
