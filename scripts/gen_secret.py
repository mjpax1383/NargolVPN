#!/usr/bin/env python3
"""Generate the shared HMAC secret and (optionally) a local .dev.vars file.

    python scripts/gen_secret.py
    python scripts/gen_secret.py --write
"""
import argparse
import hashlib
import hmac
import os
import secrets

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="also write worker/.dev.vars")
    parser.add_argument("--bytes", type=int, default=32)
    args = parser.parse_args()

    token = secrets.token_hex(max(16, args.bytes))
    print(token)

    # Self-check: the same formula lives in the Worker (net.js) and the agent.
    sample_ts = "1700000000"
    sample_body = b'{"vantage":"global"}'
    signature = hmac.new(token.encode(), (sample_ts + ".").encode() + sample_body, hashlib.sha256).hexdigest()
    print("expect-sig " + signature, file=os.sys.stderr)

    if args.write:
        path = os.path.join(ROOT, "worker", ".dev.vars")
        if os.path.exists(path):
            print("refusing to overwrite " + path, file=os.sys.stderr)
            return 1
        with open(path, "w", encoding="utf-8") as handle:
            handle.write('TESTER_SECRET="' + token + '"\n')
            handle.write('TELEGRAM_BOT_TOKEN=""\n')
            handle.write('TELEGRAM_CHAT_ID=""\n')
            handle.write('GITHUB_TOKEN=""\n')
            handle.write('WORKFLOW_FILE="hourly.yml"\n')
        print("wrote " + path, file=os.sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())