#!/usr/bin/env python3
"""vpnbot tester agent.

One script, three homes: GitHub Actions (global vantage), a home PC / old Android
phone via Termux (Iran vantage), or your laptop for a manual run.

    python agent.py run --vantage global --publish
    python agent.py run --vantage ir --claim
    python agent.py loop --vantage ir --interval 45
    python agent.py sources
    python agent.py selftest
"""
from __future__ import annotations

import argparse
import hashlib
import hmac as hmac_lib
import json
import os
import random
import sys
import time
import traceback
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import collect as collector  # noqa: E402
import geo as geo_mod  # noqa: E402
import score as scoring  # noqa: E402
import xray as xray_mod  # noqa: E402
import urllib.parse  # noqa: E402

from uri import Config, b64decode_loose, parse_uri  # noqa: E402

VERSION = "1.0.0"
# Subscription split: more than this many configs per family opens /sub/global2, ...
CHUNK_SIZE = 50
# Selection looks at this many extra configs per family so the protocol mix and the
# country spread have room to pick from.
POOL_FACTOR = 2.5
# Share of the hourly new-test slots reserved for the preferred protocols.
FRESH_PREFERRED_SHARE = 0.75
PREFERRED_PROTOS = ("vless", "vmess")
RUN_ID = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + str(random.randint(1000, 9999))


def log(message: str) -> None:
    stamp = time.strftime("%H:%M:%S", time.gmtime())
    print("[" + stamp + "Z] " + message, flush=True)


class WorkerClient:
    """HMAC-signed client for the Cloudflare Worker."""

    def __init__(self, base: str, secret: str, timeout: float = 40.0) -> None:
        cleaned = (base or "").strip().rstrip("/")
        # A bare host makes urllib fail with a cryptic "unknown url type"; be forgiving.
        if cleaned and "://" not in cleaned:
            cleaned = "https://" + cleaned
        self.base = cleaned
        self.secret = (secret or "").strip()
        self.timeout = timeout
        if not self.base:
            raise SystemExit(
                "WORKER_URL is empty. Set the repository secret WORKER_URL to "
                "https://<your-worker>.workers.dev"
            )
        if not self.secret:
            raise SystemExit(
                "TESTER_SECRET is empty. Set the repository secret TESTER_SECRET to the "
                "same 64-character key you uploaded with wrangler secret put."
            )

    def _headers(self, body: bytes) -> dict:
        stamp = str(int(time.time()))
        message = (stamp + ".").encode("utf-8") + body
        signature = hmac_lib.new(self.secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
        return {
            "X-Ts": stamp,
            "X-Sig": signature,
            "content-type": "application/json",
            "user-agent": "vpnbot-tester/" + VERSION,
        }

    def _request(self, method: str, path: str, payload=None, signed: bool = True, retries: int = 3):
        body = b""
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        url = self.base + path
        last_error = None
        for attempt in range(retries):
            try:
                headers = self._headers(body) if signed else {"user-agent": "vpnbot-tester/" + VERSION}
                request = urllib.request.Request(
                    url,
                    data=body if method == "POST" else None,
                    headers=headers,
                    method=method,
                )
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    raw = response.read()
                    return json.loads(raw.decode("utf-8")) if raw else {}
            except urllib.error.HTTPError as error:
                detail = ""
                try:
                    detail = error.read()[:300].decode("utf-8", "ignore")
                except Exception:
                    pass
                last_error = "HTTP %s %s" % (error.code, detail)
                if error.code in (400, 401, 404):
                    break
            except Exception as error:  # noqa: BLE001
                last_error = str(error)
            time.sleep(1.5 * (attempt + 1))
        raise RuntimeError("worker " + method + " " + path + " failed: " + str(last_error))

    def get(self, path: str, signed: bool = True):
        return self._request("GET", path, None, signed)

    def post(self, path: str, payload, signed: bool = True):
        return self._request("POST", path, payload, signed)


def seen_path(state_dir: str) -> str:
    return os.path.join(state_dir, "seen.json")


def load_seen(state_dir: str, ttl_hours: float) -> dict:
    """Ids tested in the last `ttl_hours`. Kept locally: zero D1 reads, zero cost.

    Without this the agent re-tests the same dead configs every hour, because the
    Worker only remembers what is currently alive.
    """
    path = seen_path(state_dir)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError):
        return {}
    cutoff = time.time() - max(1.0, ttl_hours) * 3600.0
    fresh = {}
    for cfg_id, stamp in raw.items():
        try:
            when = float(stamp)
        except (TypeError, ValueError):
            continue
        if when >= cutoff:
            fresh[cfg_id] = when
    return fresh


def save_seen(state_dir: str, seen: dict, ttl_hours: float, cap: int = 40000) -> None:
    path = seen_path(state_dir)
    try:
        os.makedirs(state_dir, exist_ok=True)
        cutoff = time.time() - max(1.0, ttl_hours) * 3600.0
        kept = {key: value for key, value in seen.items() if float(value) >= cutoff}
        if len(kept) > cap:
            ordered = sorted(kept.items(), key=lambda pair: pair[1], reverse=True)[:cap]
            kept = dict(ordered)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(kept, handle)
    except OSError as error:
        log("could not persist seen-cache: " + str(error))


def pick_candidates(found: dict, alive_rows: list, seen: dict, max_new: int, max_retest: int) -> tuple:
    """Survivors first (oldest check first), then configs we have never tested.

    Retests lead on purpose: when a run hits its time budget, a new config is worth
    postponing; the check that removes a dead server is not.
    """
    known = set(seen.keys())
    retest = []
    for row in alive_rows:
        uri = row.get("uri") or ""
        cfg = parse_uri(uri)
        if cfg is None:
            continue
        known.add(cfg.id)
        retest.append((float(row.get("last_ok_at") or 0), cfg))
    retest.sort(key=lambda pair: pair[0])
    fresh = [cfg for cfg_id, cfg in found.items() if cfg_id not in known]
    random.shuffle(fresh)
    ordered = [cfg for _, cfg in retest[:max_retest]] + pick_fresh(fresh, max_new)
    return ordered, len(fresh)


def pick_fresh(fresh: list, max_new: int) -> list:
    """Reserve most new-test slots for vless/vmess, the protocols clients like best.

    Public feeds are full of Shadowsocks, so uniform sampling would keep the alive
    pool mostly ss. The leftover slots stay random, and when one side runs out the
    other fills in, so nothing is wasted.
    """
    if not fresh or max_new <= 0:
        return []
    quota = int(max_new * FRESH_PREFERRED_SHARE)
    preferred = [cfg for cfg in fresh if str(getattr(cfg, "proto", "")).lower() in PREFERRED_PROTOS]
    others = [cfg for cfg in fresh if str(getattr(cfg, "proto", "")).lower() not in PREFERRED_PROTOS]
    random.shuffle(preferred)
    head = preferred[:quota]
    tail = preferred[quota:] + others
    random.shuffle(tail)
    return head + tail[: max(0, max_new - len(head))]


def run_tests(configs: list, xray_bin: str, workers: int, timeout: float, tries: int, max_seconds: float) -> dict:
    results = {}
    total = len(configs)
    if not total:
        return results
    started = time.time()
    completed = 0
    pool = ThreadPoolExecutor(max_workers=max(1, workers))
    futures = {pool.submit(xray_mod.test_config, xray_bin, cfg, timeout, tries): cfg for cfg in configs}
    try:
        for future in as_completed(futures):
            cfg = futures[future]
            try:
                outcome = future.result()
            except Exception as error:  # noqa: BLE001
                outcome = {"ok": False, "latency_ms": None, "ok_count": 0, "tries": tries, "err": str(error)[:110]}
            results[cfg.id] = (cfg, outcome)
            completed += 1
            if completed % 25 == 0 or completed == total:
                alive = len([1 for _, item in results.values() if item["ok"]])
                log("  tested %d/%d | alive %d | %.0fs" % (completed, total, alive, time.time() - started))
            if max_seconds and time.time() - started > max_seconds:
                log("  time budget hit, stopping early")
                break
    finally:
        for future in futures:
            future.cancel()
        pool.shutdown(wait=False, cancel_futures=True)
    return results


def fetch_state(wc: WorkerClient, pages: int = 2, page_size: int = 300) -> list:
    """Alive configs, best score first.

    The Worker clamps one page to 300 rows, so the pool is read in pages: the mix
    and country caps need spares from below the top 300 to fill a subscription.
    """
    rows, seen_ids = [], set()
    for page in range(max(1, pages)):
        chunk = wc.get("/api/state?limit=%d&offset=%d" % (page_size, page * page_size)).get("configs") or []
        for row in chunk:
            config_id = row.get("id")
            if config_id and config_id in seen_ids:
                continue
            seen_ids.add(config_id)
            rows.append(row)
        if len(chunk) < page_size:
            break
    return rows


def build_items(wc: WorkerClient) -> list:
    items = []
    for row in fetch_state(wc):
        items.append({
            "id": row.get("id"),
            "uri": row.get("uri"),
            "proto": row.get("proto"),
            "host": row.get("host"),
            "port": row.get("port"),
            "sni": row.get("sni"),
            "latency_ms": row.get("latency_ms"),
            "score": row.get("score") or 0,
            "works_ir": bool(row.get("works_ir")),
            "works_global": True,
        })
    return items


def ingest(wc: WorkerClient, vantage: str, results: dict, source_stats: dict) -> int:
    items = []
    for cfg, outcome in results.values():
        items.append({
            "id": cfg.id,
            "uri": cfg.uri,
            "proto": cfg.proto,
            "host": cfg.host,
            "port": cfg.port,
            "sni": cfg.sni or "",
            "tag": cfg.tag or "",
            "ok": bool(outcome.get("ok")),
            "ok_count": int(outcome.get("ok_count") or 0),
            "tries": int(outcome.get("tries") or 0),
            "latency_ms": outcome.get("latency_ms"),
            "err": (outcome.get("err") or "")[:110],
            "score": scoring.score_of(outcome, works_ir=(vantage != "global" and bool(outcome.get("ok")))),
        })
    stored = 0
    chunk = 100
    for index in range(0, len(items), chunk):
        payload = {
            "vantage": vantage,
            "run_id": RUN_ID + "-" + str(index // chunk),
            "results": items[index : index + chunk],
            "sources_ok": source_stats.get("sources_ok", 0),
            "sources_fail": source_stats.get("sources_fail", 0),
        }
        response = wc.post("/api/ingest", payload)
        stored += int(response.get("stored") or 0)
    return stored


def publish(wc: WorkerClient, stats: dict, dry_run: bool) -> dict:
    info = wc.get("/api/info", signed=False)
    base = (info.get("base") or wc.base).rstrip("/")
    items = build_items(wc)
    # Caps keep the publish payload small enough for the Worker free plan (10ms CPU).
    # The IR family is real when an Iranian tester has fed the database; otherwise it
    # is a shape-based shortlist so the button is never dead.
    ir_tested = any(item["works_ir"] for item in items)
    if ir_tested:
        ir_source, ir_predicate = items, (lambda item: item["works_ir"])
    else:
        for item in items:
            item["ir_fit"] = scoring.iran_fit(item)
        ir_source = [dict(item, score=item["ir_fit"]) for item in items]
        ir_predicate = lambda item: item.get("ir_fit", 0) >= scoring.IRAN_FIT_MIN
    wanted = (
        ("global", 200, lambda item: item["works_global"]),
        ("ir", 120, ir_predicate),
        ("all", 200, lambda item: True),
    )
    # A wider pool first: the mix/country pass needs spare configs to choose from.
    pools = {}
    for name, limit, predicate in wanted:
        source = ir_source if name == "ir" else items
        pools[name] = scoring.select(source, int(limit * POOL_FACTOR), predicate)
    hosts = []
    for pool in pools.values():
        hosts.extend(item.get("host") for item in pool if item.get("host"))
    try:
        codes = geo_mod.countries_for(hosts) if hosts else {}
    except Exception as error:  # noqa: BLE001
        log("geo lookup failed, publishing without flags: " + str(error)[:80])
        codes = {}
    picks = {}
    for name, limit, _ in wanted:
        picks[name] = scoring.diversify(pools[name], limit, codes)
        # Never hand out a short subscription: relax the mix caps first, then drop
        # them entirely when the pool really has nothing else to offer.
        if len(picks[name]) < int(limit * 0.6):
            picks[name] = scoring.diversify(pools[name], limit, codes, share=scoring.PROTO_SHARE_RELAXED)
        if len(picks[name]) < int(limit * 0.4):
            picks[name] = scoring.diversify(pools[name], limit, codes, share={})
    global_sel = picks["global"]
    ir_sel = picks["ir"]
    all_sel = picks["all"]

    def tagged(selection):
        out = []
        for item in scoring.interleave(selection):
            host = str(item.get("host") or "").strip().lower()
            out.append(scoring.brand_uri(item["uri"], item.get("id"), geo_mod.flag(codes.get(host, ""))))
        return out

    subs = {}
    families = {}
    published_at = time.time()
    status = scoring.status_uri(published_at)
    for family, selection in (("global", global_sel), ("ir", ir_sel), ("all", all_sel)):
        uris = tagged(selection)
        if not uris:
            continue
        groups = [uris[index:index + CHUNK_SIZE] for index in range(0, len(uris), CHUNK_SIZE)]
        families[family] = len(groups)
        for number, group in enumerate(groups, start=1):
            subs[family + str(number)] = scoring.armour(group, header=status)
        # The bare name is the whole family; /sub/global1, /sub/global2 are the chunks.
        subs[family] = scoring.armour(uris, header=status)

    stats = dict(stats)
    stats["ir"] = len(ir_sel)
    stats["ir_mode"] = "tested" if ir_tested else "heuristic"
    stats["alive"] = len(global_sel)
    stats["protos"] = scoring.protocol_mix(global_sel)
    stats["countries"] = len({codes[host] for host in (str(item.get("host") or "").lower() for item in global_sel) if codes.get(host)})
    ir_urls = ([base + "/sub/ir"] + [base + "/sub/ir" + str(n) for n in range(1, families.get("ir", 0) + 1)]) if ir_sel else []
    global_urls = [base + "/sub/global"] + [base + "/sub/global" + str(n) for n in range(1, families["global"] + 1)]
    digest = scoring.build_digest(
        stats,
        global_sel,
        {"global": global_urls, "ir": ir_urls},
        time.time(),
    )
    payload = {
        "subs": subs,
        "counts": {name: sub["count"] for name, sub in subs.items()},
        "chunks": families,
        "top": scoring.top_payload(global_sel),
        "digest_html": digest,
        "stats": stats,
        "best": scoring.top_payload(global_sel, 8),
    }
    if dry_run:
        log("dry-run: would publish " + str(payload["counts"]))
        return {"dry_run": True, "counts": payload["counts"]}
    response = wc.post("/api/publish", payload)
    log("published: " + json.dumps(response.get("counts", {})))
    telegram = response.get("telegram") or {}
    if telegram.get("posted"):
        log("telegram: posted")
    else:
        log("telegram: skipped (" + str(telegram.get("reason")) + ")")
    return response


def run_once(args) -> dict:
    wc = WorkerClient(args.worker, args.secret)
    summary = {"vantage": args.vantage, "run_id": RUN_ID, "ok": False}
    started = time.time()

    if args.vantage != "global":
        claim = wc.get("/api/claim?vantage=%s&limit=%d" % (args.vantage, args.max_new))
        rows = claim.get("configs") or []
        configs = []
        for row in rows:
            cfg = parse_uri(row.get("uri") or "")
            if cfg is not None:
                configs.append(cfg)
        log("claimed %d configs for vantage %s" % (len(configs), args.vantage))
        source_stats = {}
    else:
        sources = collector.load_sources(args.sources)
        log("harvesting %d telegram channels + %d raw feeds" % (len(sources.get("telegram_channels", [])), len(sources.get("raw_urls", []))))
        found, source_stats = collector.collect(sources, log=log)
        log("unique configs after parsing: %d" % len(found))
        seen = load_seen(args.state_dir, args.seen_ttl)
        log("seen-cache: %d ids from the last %sh" % (len(seen), args.seen_ttl))
        alive_rows = []
        if wc.base:
            try:
                alive_rows = fetch_state(wc)
            except Exception as error:  # noqa: BLE001
                log("state fetch failed, continuing cold: " + str(error))
        configs, fresh_count = pick_candidates(found, alive_rows, seen, args.max_new, args.max_retest)
        retest_count = max(0, len(configs) - min(fresh_count, args.max_new))
        log("candidates: %d untested available, %d retest queued, %d total" % (fresh_count, retest_count, len(configs)))

    if not configs:
        log("nothing to test, exiting")
        summary["seconds"] = round(time.time() - started, 1)
        return summary

    xray_bin = xray_mod.ensure_xray(args.cache_dir, args.xray or os.environ.get("XRAY_BIN"))
    log("xray: " + xray_bin)
    results = run_tests(configs, xray_bin, args.workers, args.timeout, args.tries, args.max_seconds)
    alive = len([1 for _, item in results.values() if item["ok"]])
    if args.vantage == "global" and results:
        now = time.time()
        for cfg_id in results:
            seen[cfg_id] = now
        save_seen(args.state_dir, seen, args.seen_ttl)
    log("tested %d | alive %d" % (len(results), alive))

    stored = 0
    ingest_error = ""
    publish_error = ""
    if args.dry_run:
        log("dry-run: skipping ingest/publish")
    else:
        try:
            stored = ingest(wc, args.vantage, results, source_stats)
            log("ingested %d results" % stored)
        except Exception as error:  # noqa: BLE001
            # A rejected write must not take the hourly publish with it: the Worker still
            # holds last hour's survivors, and the error is reported instead of hidden.
            ingest_error = str(error)[:200]
            log("ingest failed, publishing what the Worker already has: " + ingest_error)
        if args.vantage == "global" and args.publish:
            try:
                publish(wc, {"tested": len(results), "alive": alive}, False)
            except Exception as error:  # noqa: BLE001
                # Same rule as the ingest: report it, do not blow up the run.
                publish_error = str(error)[:200]
                log("publish failed: " + publish_error)

    summary.update({
        "ok": not (ingest_error or publish_error),
        "tested": len(results),
        "alive": alive,
        "stored": stored,
        "ingest_error": ingest_error,
        "publish_error": publish_error,
        "sources_ok": source_stats.get("sources_ok", 0),
        "sources_fail": source_stats.get("sources_fail", 0),
        "seconds": round(time.time() - started, 1),
    })
    return summary


def cmd_run(args) -> int:
    summary = run_once(args)
    log("done in %ss" % summary.get("seconds"))
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump(summary, handle, ensure_ascii=False, indent=2)
    return 0 if summary.get("ok") or summary.get("tested") == 0 else 1


def cmd_loop(args) -> int:
    log("loop mode: every %d min, vantage %s" % (args.interval, args.vantage))
    while True:
        try:
            run_once(args)
        except Exception as error:  # noqa: BLE001
            log("run failed: " + str(error))
            traceback.print_exc()
        sleep_for = max(60, args.interval * 60)
        log("sleeping %d s" % sleep_for)
        time.sleep(sleep_for)


def cmd_sources(args) -> int:
    sources = collector.load_sources(args.sources)
    rows = collector.probe_sources(sources, log=log)
    alive = len([row for row in rows if row["links"] > 0])
    log("%d/%d sources produced links" % (alive, len(rows)))
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump(rows, handle, ensure_ascii=False, indent=2)
    return 0 if alive else 2


SAMPLES = [
    "vless://11111111-2222-3333-4444-555555555555@example.com:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=abcdef123456&sid=1a&type=tcp&flow=xtls-rprx-vision#demo-reality",
    "trojan://secret-pass@trojan.example.com:443?sni=trojan.example.com&type=ws&path=%2Fws#demo-trojan",
    "ss://YWVzLTI1Ni1nY206c2VjcmV0LXBhc3M=@203.0.113.9:8388#demo-ss",
    "vmess://" + "eyJ2IjoiMiIsInBzIjoiZGVtbyIsImFkZCI6IjIwMy4wLjExMy4xMCIsInBvcnQiOiI0NDMiLCJpZCI6IjExMTExMTExLTIyMjItMzMzMy00NDQ0LTU1NTU1NTU1NTU1NSIsImFpZCI6IjAiLCJuZXQiOiJ3cyIsInR5cGUiOiJub25lIiwiaG9zdCI6ImV4YW1wbGUub3JnIiwicGF0aCI6Ii9yYXkiLCJ0bHMiOiJ0bHMifQ==",
]


def cmd_selftest(args) -> int:
    problems = []
    for sample in SAMPLES:
        cfg = parse_uri(sample)
        if cfg is None:
            problems.append("failed to parse " + sample[:40])
            continue
        if cfg.proto == "vmess":
            assert cfg.host == "203.0.113.10", cfg.host
            assert cfg.network == "ws", cfg.network
            assert cfg.security == "tls", cfg.security
        if cfg.proto == "vless":
            assert cfg.security == "reality", cfg.security
            assert cfg.public_key == "abcdef123456", cfg.public_key
            assert cfg.flow == "xtls-rprx-vision", cfg.flow
        if cfg.proto == "trojan":
            assert cfg.path == "/ws", cfg.path
        if cfg.proto == "ss":
            assert cfg.method == "aes-256-gcm", cfg.method
        payload = xray_mod.build_config(cfg, 1080)
        assert payload["outbounds"][0]["protocol"] in ("vless", "vmess", "trojan", "shadowsocks")
        print("ok  " + cfg.label() + " id=" + cfg.id[:12] + " net=" + cfg.network + " sec=" + (cfg.security or "none"))
    duplicate = parse_uri(SAMPLES[0])
    assert duplicate is not None and duplicate.id == parse_uri(SAMPLES[0]).id

    # Subscription assembly: the status line must never count as a server, and the
    # digest must offer the whole family on one link before the chunks.
    header = scoring.status_uri(1795700000)
    assert header.startswith("trojan://") and "127.0.0.1:1" in header, header
    assert "2026-11-26" in urllib.parse.unquote(header.split("#", 1)[1]), header
    packed = scoring.armour([SAMPLES[0], SAMPLES[2]], header=header)
    assert packed["count"] == 2, packed["count"]
    assert packed["plain"].split("\n")[0] == header, packed["plain"][:80]
    assert b64decode_loose(packed["body"]).decode("utf-8").startswith(header)
    fit_reality = scoring.iran_fit({"uri": SAMPLES[0]})
    fit_ss = scoring.iran_fit({"uri": SAMPLES[2]})
    assert fit_reality > 0.8 and fit_ss < 0.1, (fit_reality, fit_ss)
    digest = scoring.build_digest(
        {"alive": 3, "ir": 1, "ir_mode": "heuristic"},
        [],
        {"global": ["https://x/sub/global", "https://x/sub/global1"], "ir": ["https://x/sub/ir"]},
        1795700000,
    )
    assert "پیشنهادی برای ایران" in digest, digest
    assert digest.index("https://x/sub/global</code>") < digest.index("global1"), digest
    if args.worker:
        wc = WorkerClient(args.worker, args.secret)
        health = wc.get("/health", signed=False)
        print("worker health: " + json.dumps(health))
        if args.secret:
            state = wc.get("/api/state?limit=1")
            print("signed request ok, state rows: " + str(state.get("count")))
    if problems:
        for problem in problems:
            print("FAIL " + problem)
        return 1
    print("selftest: all good")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="vpnbot tester agent")
    parser.add_argument("command", choices=["run", "loop", "sources", "selftest"])
    parser.add_argument("--worker", default=os.environ.get("WORKER_URL", ""), help="https://<name>.<account>.workers.dev")
    parser.add_argument("--secret", default=os.environ.get("TESTER_SECRET", ""), help="shared HMAC secret")
    parser.add_argument("--vantage", default=os.environ.get("VANTAGE", "global"), help="global | ir | any label")
    parser.add_argument("--sources", default=os.path.join(HERE, "sources.json"))
    parser.add_argument("--xray", default="", help="path to an existing xray binary")
    parser.add_argument("--cache-dir", default=os.environ.get("XRAY_CACHE", os.path.join(HERE, "bin")))
    parser.add_argument("--state-dir", default=os.environ.get("STATE_DIR", os.path.join(HERE, "state")))
    parser.add_argument("--seen-ttl", type=float, default=float(os.environ.get("SEEN_TTL_HOURS", "36")))
    parser.add_argument("--workers", type=int, default=int(os.environ.get("CONCURRENCY", "40")))
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("TEST_TIMEOUT", "6")))
    parser.add_argument("--tries", type=int, default=int(os.environ.get("TEST_TRIES", "2")))
    parser.add_argument("--max-new", type=int, default=int(os.environ.get("MAX_NEW", "220")))
    parser.add_argument("--max-retest", type=int, default=int(os.environ.get("MAX_RETEST", "140")))
    parser.add_argument("--max-seconds", type=float, default=float(os.environ.get("MAX_SECONDS", "1500")))
    parser.add_argument("--interval", type=int, default=int(os.environ.get("LOOP_MIN", "45")))
    parser.add_argument("--publish", dest="publish", action="store_true", default=True)
    parser.add_argument("--no-publish", dest="publish", action="store_false")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json-out", default="")
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command in ("run", "loop") and not args.dry_run:
        if not args.worker or not args.secret:
            parser.error("--worker and --secret (or WORKER_URL / TESTER_SECRET) are required")
    handlers = {
        "run": cmd_run,
        "loop": cmd_loop,
        "sources": cmd_sources,
        "selftest": cmd_selftest,
    }
    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())