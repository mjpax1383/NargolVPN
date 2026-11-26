"""Scoring, subscription assembly and the Telegram digest."""
from __future__ import annotations

import time
from typing import Iterable
from urllib.parse import quote

from uri import b64encode_text, Config

MAX_LATENCY_MS = 2500.0


def score_of(result: dict, works_ir: bool = False) -> float:
    """0..1. Success ratio dominates, speed breaks ties, IR reachability is a bonus."""
    if not result or not result.get("ok"):
        return 0.0
    tries = max(1, int(result.get("tries") or 1))
    success = min(1.0, float(result.get("ok_count") or 0) / tries)
    latency = float(result.get("latency_ms") or MAX_LATENCY_MS)
    speed = max(0.0, min(1.0, 1.0 - latency / MAX_LATENCY_MS))
    value = 0.55 * success + 0.40 * speed + (0.05 if works_ir else 0.0)
    return round(min(1.0, value), 4)


BRAND = "NargolVPN"


def brand_uri(uri: str, cid: str = "") -> str:
    """Name every config NargolVPN|<digits>. The number is derived from the config id,
    so it looks random but never changes between runs (clients keep their entry)."""
    text = str(uri or "").strip()
    if not text:
        return text
    try:
        number = int(str(cid or "")[:8], 16) % 9000 + 1000
    except ValueError:
        number = sum(ord(ch) for ch in text) % 9000 + 1000
    return text.split("#", 1)[0] + "#" + quote(BRAND + "|" + str(number), safe="|")


def armour(uris: Iterable[str]) -> dict:
    plain = "\n".join([uri for uri in uris if uri])
    return {"body": b64encode_text(plain), "plain": plain, "count": len([u for u in uris if u])}


def select(items: list, limit: int, predicate) -> list:
    chosen = [item for item in items if predicate(item)]
    chosen.sort(key=lambda item: (-float(item.get("score") or 0), float(item.get("latency_ms") or 99999)))
    seen = set()
    out = []
    for item in chosen:
        host = (item.get("host") or "").lower()
        if host in seen:
            continue
        seen.add(host)
        out.append(item)
        if len(out) >= limit:
            break
    return out


def build_digest(stats: dict, best: list, subs: dict, generated_at: float) -> str:
    fmt = lambda value: "{:,}".format(int(value or 0))
    stamp = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(generated_at))
    ir_url = str(subs.get("ir_url") or "").strip()
    ir_count = int(stats.get("ir") or 0)
    head = "🧪 تست‌شده: " + fmt(stats.get("tested")) + " · ✅ سالم: " + fmt(stats.get("alive"))
    if ir_url:
        head += " · 🇮🇷 سازگار با ایران: " + fmt(ir_count)
    lines = [
        "🔄 <b>بروزرسانی ساعتی کانفیگ‌ها</b>",
        "",
        head,
        "🌍 ساب جهانی: <code>" + subs.get("global_url", "") + "</code>",
    ]
    if ir_url:
        lines.append("🇮🇷 ساب ایران: <code>" + ir_url + "</code>")
    if best:
        lines.append("")
        lines.append("<b>🏆 سریع‌ترین‌ها</b>")
        for index, item in enumerate(best[:8], start=1):
            badge = "🇮🇷" if item.get("works_ir") else "🌍"
            host = str(item.get("host") or "")[:38]
            lines.append(
                "%d. %s <code>%s:%s</code> · %sms · %s"
                % (index, badge, host, item.get("port"), item.get("latency_ms") or 0, str(item.get("proto") or "").upper())
            )
    lines.append("")
    lines.append("⏱ " + stamp)
    return "\n".join(lines)


def top_payload(items: list, limit: int = 40) -> list:
    out = []
    for item in items[:limit]:
        out.append({
            "id": item.get("id"),
            "uri": brand_uri(item.get("uri"), item.get("id")),
            "proto": item.get("proto"),
            "host": item.get("host"),
            "port": item.get("port"),
            "sni": item.get("sni"),
            "latency_ms": item.get("latency_ms"),
            "score": item.get("score"),
            "works_ir": 1 if item.get("works_ir") else 0,
            "works_global": 1 if item.get("works_global", True) else 0,
        })
    return out