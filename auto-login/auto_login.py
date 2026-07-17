#!/usr/bin/env python3
"""
Auto-login for opencode-multi-auth-codex plugin.
Automates ChatGPT OAuth via Playwright, including email verification via Outlook Web.

Usage:
    python3 auto_login.py                 # Login all enabled accounts
    python3 auto_login.py --account 0     # Login specific account by index
    python3 auto_login.py --email user@x  # Login specific account by email
    python3 auto_login.py --check         # Check which accounts need login
    python3 auto_login.py --visible       # Run browser in visible mode
    python3 auto_login.py --email user@x --auth-url <url>  # Browser-only login for dashboard
"""

import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import ssl
import sys
import time
import threading
import urllib.parse
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timezone
from pathlib import Path

# ── Constants (matching opencode-multi-auth-codex plugin exactly) ───────────
OPENAI_ISSUER = "https://auth.openai.com"
AUTHORIZE_URL = f"{OPENAI_ISSUER}/oauth/authorize"
TOKEN_URL = f"{OPENAI_ISSUER}/oauth/token"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
SCOPES = ["openid", "profile", "email", "offline_access"]
REDIRECT_PORT = 1455

# Store paths (matching the plugin)
STORE_DIR = Path.home() / ".config" / "opencode"
STORE_FILE = STORE_DIR / "opencode-multi-auth-codex-accounts.json"

# Credentials file
SCRIPT_DIR = Path(__file__).resolve().parent
CREDENTIALS_FILE = SCRIPT_DIR / "credentials.json"

# Timing
BETWEEN_ACCOUNTS_DELAY = 5  # seconds between accounts


def find_system_browser():
    override = os.environ.get("OPENCODE_MULTI_AUTH_BROWSER")
    if override and Path(override).is_file():
        return override
    for candidate in (
        "google-chrome-stable",
        "google-chrome",
        "chrome",
        "chromium",
        "chromium-browser",
        "microsoft-edge-stable",
        "microsoft-edge",
        "msedge",
    ):
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    return None


def find_playwright_chromium():
    cache_dir = Path.home() / ".cache" / "ms-playwright"
    patterns = [
        "chromium-*/chrome-linux64/chrome",
        "chromium-*/chrome-linux/chrome",
    ]
    candidates = []
    for pattern in patterns:
        candidates.extend(cache_dir.glob(pattern))
    existing = [path for path in candidates if path.is_file()]
    if not existing:
        return None
    return str(sorted(existing)[-1])


def find_browser_executable():
    return find_system_browser() or find_playwright_chromium()


def has_graphical_session():
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


# ── PKCE (RFC 7636) ────────────────────────────────────────────────────────
def generate_pkce():
    raw = secrets.token_bytes(32)
    code_verifier = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


def generate_state():
    return (
        base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")
    )


def build_auth_url(code_challenge, state, redirect_uri):
    params = {
        "client_id": CLIENT_ID,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "audience": "https://api.openai.com/v1",
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "state": state,
        "originator": "codex_cli_rs",
    }
    return f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


# ── JWT helpers ─────────────────────────────────────────────────────────────
def decode_jwt_payload(token):
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        payload = parts[1].replace("-", "+").replace("_", "/")
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += "=" * padding
        return json.loads(base64.b64decode(payload).decode("utf-8"))
    except Exception:
        return None


def get_email_from_claims(claims):
    if not claims:
        return None
    if isinstance(claims.get("email"), str):
        return claims["email"]
    profile = claims.get("https://api.openai.com/profile")
    if profile and isinstance(profile.get("email"), str):
        return profile["email"]
    return None


def get_account_id_from_claims(claims):
    if not claims:
        return None
    auth = claims.get("https://api.openai.com/auth")
    return auth.get("chatgpt_account_id") if auth else None


def get_expiry_from_claims(claims):
    if not claims:
        return None
    exp = claims.get("exp")
    return int(exp * 1000) if isinstance(exp, (int, float)) else None


# ── Token exchange ──────────────────────────────────────────────────────────
def exchange_code_for_tokens(code, redirect_uri, code_verifier):
    data = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": CLIENT_ID,
            "code_verifier": code_verifier,
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        TOKEN_URL,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30, context=ssl._create_unverified_context()) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_userinfo_email(access_token):
    try:
        req = urllib.request.Request(
            f"{OPENAI_ISSUER}/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        with urllib.request.urlopen(req, timeout=10, context=ssl._create_unverified_context()) as resp:
            return json.loads(resp.read().decode("utf-8")).get("email")
    except Exception:
        return None


# ── Account store (v2 format compatible with plugin) ───────────────────────
def load_store():
    if not STORE_FILE.exists():
        return {
            "version": 2,
            "accounts": [],
            "activeIndex": -1,
            "rotationIndex": 0,
            "lastRotation": int(time.time() * 1000),
        }
    with open(STORE_FILE, "r") as f:
        return json.load(f)


def save_store(store):
    STORE_DIR.mkdir(parents=True, exist_ok=True)
    if STORE_FILE.exists():
        shutil.copy2(STORE_FILE, STORE_FILE.with_suffix(".json.bak"))
    tmp = STORE_FILE.with_suffix(f".tmp-{os.getpid()}-{int(time.time() * 1000)}")
    with open(tmp, "w") as f:
        json.dump(store, f, indent=2)
    tmp.rename(STORE_FILE)
    os.chmod(STORE_FILE, 0o600)


def add_account_to_store(tokens):
    now = int(time.time() * 1000)
    access_claims = decode_jwt_payload(tokens["access_token"])
    id_claims = (
        decode_jwt_payload(tokens["id_token"]) if tokens.get("id_token") else None
    )

    expires_at = (
        get_expiry_from_claims(access_claims)
        or get_expiry_from_claims(id_claims)
        or now + tokens.get("expires_in", 3600) * 1000
    )
    email = (
        get_email_from_claims(id_claims)
        or get_email_from_claims(access_claims)
        or fetch_userinfo_email(tokens["access_token"])
    )
    account_id = get_account_id_from_claims(id_claims) or get_account_id_from_claims(
        access_claims
    )

    new_account = {
        "accessToken": tokens["access_token"],
        "refreshToken": tokens["refresh_token"],
        "idToken": tokens.get("id_token"),
        "accountId": account_id,
        "expiresAt": expires_at,
        "email": email,
        "lastRefresh": datetime.now(timezone.utc).isoformat(),
        "lastSeenAt": now,
        "addedAt": now,
        "source": "opencode",
        "authInvalid": False,
        "usageCount": 0,
        "enabled": True,
    }

    store = load_store()
    if email:
        for i, acc in enumerate(store["accounts"]):
            if acc.get("email") == email:
                store["accounts"][i] = {
                    **acc,
                    **new_account,
                    "usageCount": acc.get("usageCount", 0),
                    "addedAt": acc.get("addedAt", now),
                    "rateLimitHistory": acc.get("rateLimitHistory", []),
                }
                save_store(store)
                return email, i, False

    store["accounts"].append(new_account)
    idx = len(store["accounts"]) - 1
    if store["activeIndex"] < 0:
        store["activeIndex"] = idx
    save_store(store)
    return email, idx, True


# ── Credentials ─────────────────────────────────────────────────────────────
def load_credentials(credentials_path=None):
    path = Path(credentials_path).expanduser() if credentials_path else CREDENTIALS_FILE
    if not path.exists():
        print(f"[ERROR] Credentials file not found: {path}")
        sys.exit(1)
    with open(path, "r") as f:
        return json.load(f)


def _human_type(element, value, delay_ms=85):
    element.click()
    try:
        element.press("Control+A")
        element.press("Backspace")
    except Exception:
        pass
    element.type(value, delay=delay_ms)


# ── Outlook email verification code retrieval ──────────────────────────────
def _outlook_login(context, outlook_email, outlook_password):
    """Login to Outlook Web and get past all Microsoft interstitials.
    Returns the mail_page with inbox loaded, or None on failure."""
    mail_page = context.new_page()
    try:
        mail_page.goto(
            "https://login.live.com/login.srf?"
            "wa=wsignin1.0&wreply=https://outlook.live.com/mail/",
            wait_until="networkidle",
            timeout=30000,
        )
        time.sleep(2)

        # Enter email
        print(f"    [outlook] Entering email...")
        email_input = mail_page.wait_for_selector(
            "input[name='loginfmt'], input[type='email'], input#i0116",
            timeout=15000,
        )
        _human_type(email_input, outlook_email)
        time.sleep(0.8)
        mail_page.wait_for_selector(
            "input#idSIButton9, button#idSIButton9, button:has-text('Next')",
            timeout=10000,
        ).click()
        mail_page.wait_for_timeout(3000)

        # Enter password
        print(f"    [outlook] Entering password...")
        pw_input = mail_page.wait_for_selector(
            "input[name='passwd'], input[type='password'], input#i0118",
            timeout=15000,
        )
        _human_type(pw_input, outlook_password)
        time.sleep(0.8)
        mail_page.wait_for_selector(
            "input#idSIButton9, button#idSIButton9, "
            "button:has-text('Sign in'), button:has-text('Next')",
            timeout=10000,
        ).click()
        mail_page.wait_for_timeout(3000)

        # Handle "Stay signed in?"
        try:
            mail_page.wait_for_selector(
                "input#idSIButton9, button:has-text('Yes')",
                timeout=5000,
            ).click()
            mail_page.wait_for_timeout(2000)
        except Exception:
            pass

        # Handle all Microsoft interstitial prompts
        for _ in range(8):
            mail_page.wait_for_timeout(1500)
            current_url = mail_page.url.lower()

            # Already at inbox?
            if "outlook.live.com/mail" in current_url or "outlook.office.com" in current_url:
                break

            try:
                # FIDO / passkey creation page
                if "fido/create" in current_url or "passkey" in current_url:
                    fido_skip = mail_page.query_selector(
                        "button:has-text('Not now'), a:has-text('Not now'), "
                        "button:has-text('Skip for now'), a:has-text('Skip for now'), "
                        "button:has-text('Cancel'), a:has-text('Cancel'), "
                        "button:has-text('Skip'), a:has-text('Skip'), "
                        "#cancelBtn, button[data-testid='cancelBtn'], "
                        "button[data-testid='notNowBtn']"
                    )
                    if fido_skip:
                        print(f"    [outlook] Skipping FIDO/passkey prompt...")
                        fido_skip.click()
                        mail_page.wait_for_timeout(2000)
                        continue

                # Generic "Skip for now" / "Cancel" / "Not now" on any interstitial
                skip = mail_page.query_selector(
                    "a:has-text('Skip for now'), button:has-text('Skip for now'), "
                    "a[id='iCancel'], #iCancel, "
                    "button:has-text('Not now'), a:has-text('Not now'), "
                    "a:has-text('Skip'), button:has-text('Skip')"
                )
                if skip:
                    print(f"    [outlook] Skipping security prompt...")
                    skip.click()
                    mail_page.wait_for_timeout(2000)
                    continue

                cancel = mail_page.query_selector(
                    "button:has-text('Cancel'), a:has-text('Cancel'), "
                    "button:has-text('No thanks'), a:has-text('Not now'), "
                    "button:has-text('I don\\'t want to'), a:has-text('I don\\'t want to')"
                )
                if cancel:
                    print(f"    [outlook] Clicking '{cancel.inner_text().strip()}'...")
                    cancel.click()
                    mail_page.wait_for_timeout(2000)
                    continue

            except Exception:
                pass

        # If still not on inbox, force-navigate there
        if "outlook.live.com/mail" not in mail_page.url.lower():
            print(f"    [outlook] Not on inbox yet ({mail_page.url[:60]}), navigating...")
            try:
                mail_page.goto(
                    "https://outlook.live.com/mail/0/",
                    wait_until="domcontentloaded",
                    timeout=20000,
                )
                mail_page.wait_for_timeout(5000)
            except Exception as e:
                print(f"    [outlook] Navigation to inbox failed: {e}")

        print(f"    [outlook] Inbox loaded. URL: {mail_page.url[:80]}")
        mail_page.wait_for_timeout(3000)
        return mail_page

    except Exception as e:
        print(f"    [outlook] Login failed: {e}")
        _save_debug_screenshot_page(mail_page, outlook_email, "outlook_login_fail")
        mail_page.close()
        return None


def _outlook_read_latest_code(mail_page, max_attempts=4):
    """Refresh Outlook inbox and extract the verification code from the latest email.
    Returns the 6-digit code or None."""
    for attempt in range(max_attempts):
        if attempt > 0:
            print(f"    [outlook] Attempt {attempt + 1}/{max_attempts}...")

        # Refresh inbox (use "load" - webmail never reaches networkidle)
        try:
            mail_page.reload(wait_until="load", timeout=20000)
        except Exception:
            pass  # reload might timeout but page is still usable
        mail_page.wait_for_timeout(5000)

        # Try to click the first (newest) email
        clicked = False
        selectors = [
            "[role='option']:first-child",
            "[data-convid]:first-child",
            "[role='listbox'] [role='option']:first-child",
            "[role='list'] [role='listitem']:first-child",
        ]
        for sel in selectors:
            try:
                el = mail_page.query_selector(sel)
                if el:
                    el.click()
                    clicked = True
                    break
            except Exception:
                continue

        if not clicked:
            # Fallback: click any mail item
            items = mail_page.query_selector_all("[role='option'], [data-convid]")
            if items:
                items[0].click()
                clicked = True

        if clicked:
            mail_page.wait_for_timeout(2000)

        # Extract code from visible content
        body_text = mail_page.evaluate("() => document.body.innerText")

        # Precise patterns for OpenAI verification emails
        patterns = [
            r"(?:verification\s+code\s*(?:is)?[:\s]+)(\d{6})",
            r"(?:your\s+code\s*(?:is)?[:\s]+)(\d{6})",
            r"(?:enter\s+(?:this\s+)?code[:\s]+)(\d{6})",
            r"(?:code[:\s]+)(\d{6})",
        ]
        for pat in patterns:
            matches = re.findall(pat, body_text, re.IGNORECASE)
            if matches:
                return matches[-1]  # Last match = most recent

        # Fallback: any 6-digit number (skip year-like numbers)
        all_codes = re.findall(r"\b(\d{6})\b", body_text)
        valid = [c for c in all_codes if not c.startswith("20")]
        if valid:
            return valid[-1]
        if all_codes:
            return all_codes[-1]

        if attempt < max_attempts - 1:
            print(f"    [outlook] Code not found yet, waiting 6s...")
            mail_page.wait_for_timeout(6000)

    return None


def _save_debug_screenshot_page(page, identifier, step):
    safe_name = identifier.split("@")[0]
    path = SCRIPT_DIR / f"debug_{safe_name}_{step}.png"
    try:
        page.screenshot(path=str(path))
        print(f"    [DEBUG] Screenshot: {path}")
    except Exception:
        pass


class CallbackServer(BaseHTTPRequestHandler):
    """HTTP handler that captures the OAuth callback code into a shared list."""

    captured_codes = []  # Class-level shared storage

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        code = query.get("code", [None])[0]
        if code:
            CallbackServer.captured_codes.append(code)
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h1>Login successful!</h1><p>Close this window.</p>")
        else:
            self.send_response(400)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"No code found in URL.")

    def log_message(self, format, *args):
        pass


# ── Main Playwright login flow ─────────────────────────────────────────────
def login_account(
    email,
    chatgpt_password,
    outlook_password=None,
    headless=True,
    auth_url_override=None,
    external_callback=False,
):
    """
    Full OAuth login. Strategy:
    1. Navigate to OpenAI auth
    2. Enter email
    3. Try "Log in with a one-time code" (sends code to email → read from Outlook)
    4. Fallback: password + handle email verification if needed
    """
    from playwright.sync_api import sync_playwright

    code_verifier = None
    redirect_uri = f"http://localhost:{REDIRECT_PORT}/auth/callback"
    auth_url = auth_url_override

    if not auth_url:
        code_verifier, code_challenge = generate_pkce()
        state = generate_state()
        auth_url = build_auth_url(code_challenge, state, redirect_uri)

    with sync_playwright() as p:
        chromium_path = find_browser_executable()
        browser_name = Path(chromium_path).name if chromium_path else "playwright-chromium"
        effective_headless = headless
        if headless and chromium_path and has_graphical_session():
            lowered_name = browser_name.lower()
            if "chrome" in lowered_name or "edge" in lowered_name:
                effective_headless = False
                print(
                    "  [0/5] Launching headed browser because OpenAI auth blocks headless sessions."
                )
        browser = p.chromium.launch(
            headless=effective_headless,
            executable_path=chromium_path,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--no-sandbox",
            ],
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
            locale="en-US",
            viewport={"width": 1280, "height": 800},
        )
        context.add_init_script(
            """
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = window.chrome || { runtime: {} };
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            """
        )

        server = None
        if not external_callback:
            # Start the callback server before navigation
            CallbackServer.captured_codes = []  # Reset for this run
            server = HTTPServer(("localhost", REDIRECT_PORT), CallbackServer)
            server.timeout = 1
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()

        page = context.new_page()

        otp_selector = (
            "button:has-text('one-time code'), a:has-text('one-time code'), "
            "button:has-text('Log in with a one-time code'), "
            "a:has-text('Log in with a one-time code')"
        )

        def _on_local_callback():
            current = page.url.lower()
            return (
                current.startswith("http://localhost:")
                or current.startswith("http://127.0.0.1:")
                or current.startswith("http://[::1]:")
            )

        def _has_callback():
            return _on_local_callback() if external_callback else bool(CallbackServer.captured_codes)

        def _page_title_lower():
            try:
                return page.title().lower()
            except Exception:
                return ""

        def _body_text_lower():
            try:
                return page.inner_text("body").lower()
            except Exception:
                return ""

        def _is_cloudflare_gate():
            title = _page_title_lower()
            body = _body_text_lower()
            current_url = page.url.lower()
            return (
                "just a moment" in title
                or "security verification" in body
                or "__cf_chl_rt_tk=" in current_url
                or "challenge-platform" in body
            )

        def _is_manual_verification_gate():
            body = _body_text_lower()
            return _is_cloudflare_gate() and (
                "verify you are human" in body
                or "verify that you are human" in body
                or "i am human" in body
                or bool(page.query_selector("input[type='checkbox']"))
            )

        def _is_timeout_screen():
            title = _page_title_lower()
            body = _body_text_lower()
            return (
                "oops, an error occurred" in body
                or "operation timed out" in body
                or "operation timed out" in title
            )

        def _retry_timeout_page():
            retry_button = page.query_selector(
                "button:has-text('Try again'), a:has-text('Try again')"
            )
            if retry_button:
                retry_button.click()
            else:
                page.goto(auth_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(3000)

        def _wait_for_auth_entry(timeout_ms=5 * 60 * 1000):
            deadline = time.time() + (timeout_ms / 1000)
            noted_cloudflare = False
            noted_manual_verification = False
            cloudflare_since = None
            while time.time() < deadline:
                if _has_callback():
                    return
                if page.query_selector(
                    "input[name='email'], input[type='email'], "
                    "input#email, input[name='username']"
                ):
                    return
                if page.query_selector("input[name='password'], input[type='password']"):
                    return
                if _is_cloudflare_gate():
                    if cloudflare_since is None:
                        cloudflare_since = time.time()
                    if _is_manual_verification_gate():
                        if not noted_manual_verification:
                            print(
                                "  [1/5] Manual Cloudflare verification required. Complete it in the Chrome window."
                            )
                            try:
                                page.bring_to_front()
                            except Exception:
                                pass
                            noted_manual_verification = True
                    elif (
                        not noted_manual_verification
                        and cloudflare_since
                        and time.time() - cloudflare_since >= 12
                    ):
                        print(
                            "  [1/5] Manual Cloudflare verification may be required. Complete it in the Chrome window if prompted."
                        )
                        try:
                            page.bring_to_front()
                        except Exception:
                            pass
                        noted_manual_verification = True
                    elif not noted_cloudflare:
                        print("  [1/5] Waiting for Cloudflare verification...")
                        noted_cloudflare = True
                elif _is_timeout_screen():
                    print("  [1/5] OpenAI auth timed out before login form, retrying...")
                    _retry_timeout_page()
                    continue
                else:
                    cloudflare_since = None
                page.wait_for_timeout(1000)
            _save_debug_screenshot_page(page, email, "auth_entry")
            if noted_manual_verification:
                raise RuntimeError(
                    "Auth entry page did not become ready because Cloudflare verification was not completed"
                )
            raise RuntimeError("Auth entry page did not become ready")

        def _wait_for_next_auth_stage(timeout_ms=5 * 60 * 1000):
            deadline = time.time() + (timeout_ms / 1000)
            noted_manual_verification = False
            cloudflare_since = None
            while time.time() < deadline:
                current_url = page.url.lower()
                if _has_callback():
                    return "ready"
                if page.query_selector(otp_selector):
                    return "ready"
                if page.query_selector("input[name='password'], input[type='password']"):
                    return "ready"
                if "consent" in current_url or "email-verification" in current_url:
                    return "ready"
                if _is_timeout_screen():
                    return "retry-email"
                if _is_cloudflare_gate():
                    if cloudflare_since is None:
                        cloudflare_since = time.time()
                    if _is_manual_verification_gate() or (
                        not noted_manual_verification
                        and cloudflare_since
                        and time.time() - cloudflare_since >= 12
                    ):
                        if not noted_manual_verification:
                            print(
                                "  [2/5] Manual Cloudflare verification required. Complete it in the Chrome window."
                            )
                            try:
                                page.bring_to_front()
                            except Exception:
                                pass
                            noted_manual_verification = True
                else:
                    cloudflare_since = None
                try:
                    heading = page.query_selector("h1, h2, h3")
                    if heading:
                        heading_text = heading.inner_text().lower()
                        if (
                            "check your inbox" in heading_text
                            or "continue" in heading_text
                            or "authorize" in heading_text
                            or "allow" in heading_text
                        ):
                            return "ready"
                except Exception:
                    pass
                page.wait_for_timeout(750)
            return "timeout"

        # ── Step 1: Navigate to OpenAI auth
        print(f"  [1/5] Navigating to OpenAI auth...")
        page.goto(auth_url, wait_until="domcontentloaded", timeout=30000)
        _wait_for_auth_entry()

        # ── Step 2: Enter email
        email_step_error = None
        for attempt in range(1, 4):
            print(f"  [2/5] Entering email (attempt {attempt}/3)...")
            try:
                _wait_for_auth_entry(timeout_ms=20000)
                email_input = page.wait_for_selector(
                    "input[name='email'], input[type='email'], "
                    "input#email, input[name='username']",
                    timeout=15000,
                )
                _human_type(email_input, email)
                time.sleep(0.8)
                page.wait_for_selector(
                    "button[type='submit'], button:has-text('Continue')",
                    timeout=10000,
                ).click()
                page.wait_for_timeout(3000)
                next_stage = _wait_for_next_auth_stage(timeout_ms=20000)
                if next_stage == "ready":
                    email_step_error = None
                    break
                if next_stage == "retry-email" and attempt < 3:
                    print("  [2/5] OpenAI returned a timeout page after email submit, retrying...")
                    _retry_timeout_page()
                    continue
                email_step_error = RuntimeError(
                    f"Email step stalled while waiting for the next auth stage ({next_stage})"
                )
            except Exception as e:
                email_step_error = e
                if attempt < 3:
                    print(f"  [2/5] Email step failed: {e}. Retrying...")
                    try:
                        page.goto(auth_url, wait_until="domcontentloaded", timeout=30000)
                        _wait_for_auth_entry(timeout_ms=20000)
                    except Exception:
                        pass
                    continue
            if email_step_error:
                break

        if email_step_error:
            _save_debug_screenshot_page(page, email, "email_step")
            raise RuntimeError(f"Email step failed: {email_step_error}")

        # ── Step 3: Try "Log in with a one-time code" (preferred method)
        otp_login_done = False
        otp_link = page.query_selector(otp_selector)

        if otp_link and outlook_password:
            print(f"  [3/5] Using one-time code login (preferred)...")
            try:
                otp_link.click()
                page.wait_for_timeout(3000)

                # Check if we need to enter email again on OTP page
                otp_email_input = page.query_selector(
                    "input[name='email'], input[type='email']"
                )
                if otp_email_input:
                    _human_type(otp_email_input, email)
                    time.sleep(0.6)
                    submit = page.query_selector(
                        "button[type='submit'], button:has-text('Continue')"
                    )
                    if submit:
                        submit.click()
                        page.wait_for_timeout(3000)

                # Now OpenAI should send a one-time code to the email
                # Login to Outlook and read the code
                print(f"  [3/5] Logging into Outlook to read one-time code...")
                mail_page = _outlook_login(context, email, outlook_password)
                if mail_page:
                    # Wait for the email to arrive
                    print(f"  [3/5] Waiting 10s for code email to arrive...")
                    page.wait_for_timeout(10000)

                    print(f"  [3/5] Reading code from Outlook...")
                    otp_code = _outlook_read_latest_code(mail_page)
                    mail_page.close()

                    if otp_code:
                        print(f"  [3/5] Entering one-time code...")
                        code_input = page.wait_for_selector(
                            "input[name='code'], input[type='text'], "
                            "input[inputmode='numeric'], "
                            "input[placeholder*='ode']",
                            timeout=10000,
                        )
                        _human_type(code_input, otp_code, delay_ms=110)
                        time.sleep(0.8)
                        page.wait_for_selector(
                            "button[type='submit'], button:has-text('Continue')",
                            timeout=10000,
                        ).click()
                        page.wait_for_timeout(5000)
                        otp_login_done = True
                    else:
                        print(
                            f"  [3/5] Could not read OTP from Outlook, trying password..."
                        )
                else:
                    print(f"  [3/5] Outlook login failed, trying password...")
            except Exception as e:
                print(f"  [3/5] OTP login error: {e}, trying password...")

        # ── Fallback: Password login
        if not otp_login_done and not _has_callback():
            # Check if we're still on a page that needs password
            if "password" in page.url or page.query_selector("input[type='password']"):
                print(f"  [3/5] Entering password (fallback)...")
                try:
                    pw_input = page.wait_for_selector(
                        "input[name='password'], input[type='password']",
                        timeout=10000,
                    )
                    _human_type(pw_input, chatgpt_password)
                    time.sleep(0.8)
                    page.wait_for_selector(
                        "button[type='submit'], button:has-text('Continue'), "
                        "button:has-text('Log in'), button:has-text('Sign in')",
                        timeout=10000,
                    ).click()
                    page.wait_for_timeout(5000)

                    # Check for "Incorrect password" error
                    error_el = page.query_selector("[class*='error'], [role='alert']")
                    if error_el:
                        err_text = error_el.inner_text().strip()
                        if "incorrect" in err_text.lower():
                            print(f"  [WARNING] {err_text}")
                            print(f"  [3/5] Password rejected. Trying one-time code...")
                            # Try one-time code as last resort
                            otp_link2 = page.query_selector(
                                "button:has-text('one-time code'), a:has-text('one-time code')"
                            )
                            if otp_link2 and outlook_password:
                                otp_link2.click()
                                page.wait_for_timeout(3000)
                                mail_page = _outlook_login(
                                    context, email, outlook_password
                                )
                                if mail_page:
                                    page.wait_for_timeout(10000)
                                    otp_code = _outlook_read_latest_code(mail_page)
                                    mail_page.close()
                                    if otp_code:
                                        print(f"  [3/5] Entering OTP code...")
                                        ci = page.wait_for_selector(
                                            "input[name='code'], input[type='text']",
                                            timeout=10000,
                                        )
                                        _human_type(ci, otp_code, delay_ms=110)
                                        time.sleep(0.8)
                                        page.wait_for_selector(
                                            "button[type='submit'], button:has-text('Continue')",
                                            timeout=10000,
                                        ).click()
                                        page.wait_for_timeout(5000)
                                        otp_login_done = True

                except Exception as e:
                    _save_debug_screenshot_page(page, email, "password_step")
                    raise RuntimeError(f"Password step failed: {e}")

        # ── Step 4: Handle email verification (after password login)
        if not _has_callback() and not otp_login_done:
            current_url = page.url
            needs_verification = "email-verification" in current_url
            if not needs_verification:
                try:
                    h = page.query_selector("h1, h2")
                    if h and "check your inbox" in h.inner_text().lower():
                        needs_verification = True
                except Exception:
                    pass

            if needs_verification and outlook_password:
                print(
                    f"  [4/5] Email verification required, getting code from Outlook..."
                )
                mail_page = _outlook_login(context, email, outlook_password)
                if mail_page:
                    # Resend for fresh code
                    resend = page.query_selector(
                        "button:has-text('Resend'), a:has-text('Resend')"
                    )
                    if resend:
                        resend.click()
                    page.wait_for_timeout(10000)

                    vcode = _outlook_read_latest_code(mail_page)
                    mail_page.close()
                    if vcode:
                        print(f"  [4/5] Entering verification code...")
                        ci = page.wait_for_selector(
                            "input[name='code'], input[type='text']",
                            timeout=10000,
                        )
                        _human_type(ci, vcode, delay_ms=110)
                        time.sleep(0.8)
                        page.wait_for_selector(
                            "button[type='submit'], button:has-text('Continue')",
                            timeout=10000,
                        ).click()
                        page.wait_for_timeout(5000)

        # ── Step 5: Wait for OAuth callback
        print(f"  [5/5] Waiting for OAuth callback...")

        # First, handle consent page if present
        def _try_handle_consent():
            """Check if we're on a consent page and click Continue. Returns True if clicked."""
            try:
                current = page.url
                # Check URL pattern
                on_consent = "consent" in current.lower()
                if not on_consent:
                    # Also check page content
                    heading = page.query_selector("h1, h2, h3")
                    if heading:
                        text = heading.inner_text().lower()
                        if (
                            "authorize" in text
                            or "consent" in text
                            or "allow" in text
                            or "access" in text
                        ):
                            on_consent = True

                if on_consent:
                    btn = page.query_selector(
                        "button:has-text('Continue'), button:has-text('Allow'), "
                        "button:has-text('Authorize'), button[type='submit'], "
                        "input[type='submit']"
                    )
                    if btn:
                        print(
                            f"  [5/5] Consent page detected, clicking '{btn.inner_text().strip()}'..."
                        )
                        btn.click()
                        return True
            except Exception:
                pass
            return False

        # Try consent immediately (common case after OTP)
        page.wait_for_timeout(2000)
        _try_handle_consent()

        # Poll for callback, periodically re-checking for consent/interstitials
        deadline = time.time() + 45
        checks = 0
        while (
            (external_callback and not _on_local_callback())
            or (not external_callback and not CallbackServer.captured_codes)
        ) and time.time() < deadline:
            page.wait_for_timeout(1500)
            checks += 1

            # Every few iterations, re-check for consent or other buttons
            if checks % 3 == 0 and (
                (external_callback and not _on_local_callback())
                or (not external_callback and not CallbackServer.captured_codes)
            ):
                _try_handle_consent()
                if _is_timeout_screen():
                    print("  [5/5] OpenAI auth timed out after login, retrying current page...")
                    _retry_timeout_page()

            # Also check for any stray "Continue" / "Accept" buttons on unknown pages
            if checks % 5 == 0 and (
                (external_callback and not _on_local_callback())
                or (not external_callback and not CallbackServer.captured_codes)
            ):
                try:
                    stray = page.query_selector(
                        "button:has-text('Continue'), button:has-text('Accept')"
                    )
                    if stray and "consent" not in page.url.lower():
                        # Only click if page is NOT localhost (callback already handled)
                        if "localhost" not in page.url:
                            print(
                                f"  [5/5] Clicking stray button: '{stray.inner_text().strip()}'..."
                            )
                            stray.click()
                except Exception:
                    pass

        if external_callback and _on_local_callback():
            print(f"  [DONE] Browser flow completed, callback reached local server.")
            browser.close()
            return email

        if not external_callback and not CallbackServer.captured_codes:
            _save_debug_screenshot_page(page, email, "no_callback")
            print(f"  [ERROR] No OAuth code. URL: {page.url[:200]}")
            server.shutdown()
            browser.close()
            return None

        if external_callback:
            _save_debug_screenshot_page(page, email, "no_callback")
            print(f"  [ERROR] No callback redirect. URL: {page.url[:200]}")
            browser.close()
            return None

        captured_code = CallbackServer.captured_codes[0]
        print(f"  [CALLBACK] OAuth code captured.")
        server.shutdown()
        browser.close()

    # ── Exchange code for tokens
    if external_callback:
        return email

    print(f"  [DONE] Exchanging code for tokens...")
    tokens = exchange_code_for_tokens(captured_code, redirect_uri, code_verifier)

    stored_email, index, is_new = add_account_to_store(tokens)
    action = "Added new" if is_new else "Updated existing"
    print(f"  {action} account #{index}: {stored_email}")
    return stored_email


# ── Commands ────────────────────────────────────────────────────────────────
def cmd_check(accounts):
    store = load_store()
    now = int(time.time() * 1000)

    print(f"\n  Credentials file: {len(accounts)} account(s)")
    print(f"  Plugin store:     {len(store['accounts'])} account(s)\n")

    for i, acc in enumerate(accounts):
        email = acc["email"]
        enabled = acc.get("enabled", True)
        store_acc = next(
            (s for s in store["accounts"] if s.get("email") == email), None
        )

        if not store_acc:
            status = "NOT IN STORE"
        elif store_acc.get("authInvalid"):
            status = "AUTH INVALID"
        elif store_acc.get("expiresAt", 0) < now:
            status = "EXPIRED"
        else:
            exp = datetime.fromtimestamp(store_acc["expiresAt"] / 1000, tz=timezone.utc)
            status = f"OK (expires {exp.strftime('%Y-%m-%d %H:%M')} UTC)"

        print(f"  #{i} [{'ON' if enabled else 'OFF'}] {email}")
        print(f"       -> {status}")
    print()


def cmd_login(targets, defaults, headless=True, auth_url=None):
    if auth_url and len(targets) != 1:
        print("[ERROR] --auth-url mode requires exactly one target account")
        return 0, len(targets)

    print(f"\n{'=' * 55}")
    print(f"  Auto-Login: {len(targets)} account(s)")
    print(f"{'=' * 55}\n")

    success, failed = 0, 0

    for i, acc in enumerate(targets):
        email = acc["email"]
        chatgpt_pw = acc.get("chatgpt_password") or defaults.get("chatgpt_password")
        outlook_pw = acc.get("outlook_password")

        if not chatgpt_pw:
            print(f"[{i + 1}/{len(targets)}] {email}: SKIPPED (no ChatGPT password)")
            failed += 1
            continue

        print(f"[{i + 1}/{len(targets)}] {email}")

        try:
            result = login_account(
                email,
                chatgpt_pw,
                outlook_password=outlook_pw,
                headless=headless,
                auth_url_override=auth_url,
                external_callback=bool(auth_url),
            )
            if result:
                print(f"  -> SUCCESS\n")
                success += 1
            else:
                print(f"  -> FAILED\n")
                failed += 1
        except Exception as e:
            print(f"  -> ERROR: {e}\n")
            failed += 1

        if i < len(targets) - 1:
            print(f"  (waiting {BETWEEN_ACCOUNTS_DELAY}s...)\n")
            time.sleep(BETWEEN_ACCOUNTS_DELAY)

    print(f"{'=' * 55}")
    print(f"  Results: {success} success, {failed} failed")
    print(f"{'=' * 55}\n")
    return success, failed


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Auto-login for opencode-multi-auth-codex"
    )
    parser.add_argument("--account", type=int, help="Login by credential index")
    parser.add_argument("--email", type=str, help="Login by email")
    parser.add_argument("--check", action="store_true", help="Check account status")
    parser.add_argument("--visible", action="store_true", help="Show browser window")
    parser.add_argument(
        "--auth-url",
        type=str,
        help="Use an existing OAuth URL and only complete the browser flow",
    )
    parser.add_argument(
        "--credentials-file",
        type=str,
        help="Override the credentials file path",
    )
    args = parser.parse_args()

    creds = load_credentials(args.credentials_file)
    accounts = creds.get("accounts", [])
    defaults = creds.get("defaults", {})

    if not accounts:
        print("[ERROR] No accounts in credentials.json")
        sys.exit(1)

    if args.check:
        cmd_check(accounts)
        return

    if args.email:
        targets = [a for a in accounts if a["email"] == args.email]
        if not targets:
            print(f"[ERROR] Email '{args.email}' not found")
            sys.exit(1)
    elif args.account is not None:
        if not (0 <= args.account < len(accounts)):
            print(f"[ERROR] Index {args.account} out of range")
            sys.exit(1)
        targets = [accounts[args.account]]
    else:
        targets = [a for a in accounts if a.get("enabled", True)]

    if not targets:
        print("No enabled accounts to login.")
        return

    if args.auth_url and len(targets) != 1:
        print("[ERROR] --auth-url mode requires exactly one selected account")
        sys.exit(1)

    headless = not args.visible
    success, failed = cmd_login(targets, defaults, headless=headless, auth_url=args.auth_url)
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
