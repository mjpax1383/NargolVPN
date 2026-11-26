"""Source harvesting: public Telegram channel previews + raw aggregator feeds."""
from __future__ import annotations

import gzip
import html
import json
import os
import random
import re
import time
import urllib.error
import urllib.request
import zlib
from typing import Optional

from uri import Config, extract_tokens, parse_uri

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
TAG_RE = re.compile(r"<[^>]+>")


def load_sources(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def telegram_url(channel: str) -> str:
    channel = channel.strip().lstrip("@").strip("/")
    return "https://t.me/s/" + channel


def _decode(payload: bytes, encoding: str) -> str:
    encoding = (encoding or "").lower()
    if "gzip" in encoding:
        try:
            payload = gzip.decompress(payload)
        except OSError:
            pass
    elif "deflate" in encoding:
        try:
            payload = zlib.decompress(payload)
        except zlib.error:
            pass
    for codec in ("utf-8", "utf-16", "latin-1"):
        try:
            return payload.decode(codec)
        except (UnicodeDecodeError, LookupError):
            continue
    return payload.decode("utf-8", "ignore")


def fetch(url: str, timeout: float = 20.0, max_bytes: int = 2_500_000) -> tuple:
    """Return (text, status, error). Never raises: a dead source is not a crash."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read(max_bytes + 1)
            text = _decode(payload[:max_bytes], response.headers.get("Content-Encoding", ""))
            return text, response.status, ""
    except urllib.error.HTTPError as error:
        return "", error.code, "http_" + str(error.code)
    except urllib.error.URLError as error:
        return "", 0, str(error.reason)[:120]
    except Exception as error:  # noqa: BLE001 - defensive on purpose
        return "", 0, str(error)[:120]


def page_to_text(page: str) -> str:
    """Telegram preview pages wrap post bodies in divs; flatten to plain text first."""
    if not page:
        return ""
    text = re.sub(r"<br\s*/?>", "\n", page, flags=re.IGNORECASE)
    text = TAG_RE.sub("\n", text)
    text = html.unescape(text)
    return text


def harvest_text(raw: str) -> list:
    """Share links from either plain subscription text or an HTML page."""
    tokens = extract_tokens(html.unescape(raw))
    if "<" in raw and ">" in raw:
        tokens.extend(extract_tokens(page_to_text(raw)))
    return tokens


def collect(sources: dict, log=print) -> tuple:
    timeout = float(sources.get("timeout_sec", 20))
    max_bytes = int(sources.get("max_bytes_per_source", 2_500_000))
    targets = []
    for channel in sources.get("telegram_channels", []):
        if channel and not str(channel).startswith("#"):
            targets.append(("tg:" + str(channel).lstrip("@"), telegram_url(str(channel))))
    for url in sources.get("raw_urls", []):
        if url and not str(url).startswith("#"):
            targets.append(("raw:" + str(url).rsplit("/", 1)[-1], url))

    cap = int(sources.get("max_per_source", 700))
    found: dict = {}
    report = []
    started = time.time()
    for name, url in targets:
        text, status, error = fetch(url, timeout=timeout, max_bytes=max_bytes)
        tokens = harvest_text(text) if text else []
        if len(tokens) > cap * 4:
            tokens = random.sample(tokens, cap * 4)
        parsed = 0
        added = 0
        for token in tokens:
            cfg = parse_uri(token)
            if cfg is None:
                continue
            parsed += 1
            if cfg.id not in found:
                found[cfg.id] = cfg
                added += 1
            if added >= cap:
                break
        entry = {
            "source": name,
            "status": status,
            "bytes": len(text),
            "tokens": len(tokens),
            "parsed": parsed,
            "error": error,
        }
        report.append(entry)
        log("  %-46s %s %7d B  %4d links" % (name[:46], ("OK " if status == 200 else "ERR"), len(text), parsed))
    return found, {
        "sources_ok": len([item for item in report if item["status"] == 200]),
        "sources_fail": len([item for item in report if item["status"] != 200]),
        "elapsed_sec": round(time.time() - started, 1),
        "report": report,
    }


def probe_sources(sources: dict, log=print) -> list:
    """Cheap health-check used by `agent.py sources`."""
    out = []
    for channel in sources.get("telegram_channels", []):
        url = telegram_url(str(channel))
        text, status, error = fetch(url, timeout=15)
        links = len(harvest_text(text)) if text else 0
        out.append({"target": "tg:" + str(channel), "status": status, "links": links, "error": error})
        log("%-40s %s links=%d %s" % (("tg:" + str(channel))[:40], status, links, error))
    for url in sources.get("raw_urls", []):
        text, status, error = fetch(url, timeout=15)
        links = len(harvest_text(text)) if text else 0
        out.append({"target": url, "status": status, "links": links, "error": error})
        log("%-40s %s links=%d %s" % (url.rsplit("/", 1)[-1][:40], status, links, error))
    return out