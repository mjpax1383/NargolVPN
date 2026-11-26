"""Xray-core plumbing: URI -> config JSON, process lifecycle, and a real HTTP probe.

We never trust a TCP handshake alone. A config is alive only if xray can build a
tunnel and a request completes through it.
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from typing import Optional

from uri import Config

TARGETS = (
    "http://cp.cloudflare.com/generate_204",
    "http://www.gstatic.com/generate_204",
)

RELEASES = "https://github.com/XTLS/Xray-core/releases/latest/download/"


def _asset_name() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arm = machine in ("arm64", "aarch64")
    if system == "windows":
        return "Xray-windows-64.zip" if not arm else "Xray-windows-arm64-v8a.zip"
    if system == "darwin":
        return "Xray-macos-arm64-v8a.zip" if arm else "Xray-macos-64.zip"
    if system == "linux":
        return "Xray-linux-arm64-v8a.zip" if arm else "Xray-linux-64.zip"
    raise RuntimeError("unsupported platform: " + system + "/" + machine)


def ensure_xray(dest_dir: str, explicit: Optional[str] = None) -> str:
    """Return a usable xray path, downloading the official release when needed."""
    if explicit:
        if not os.path.exists(explicit):
            raise RuntimeError("xray binary not found: " + explicit)
        return explicit
    if shutil.which("xray"):
        return shutil.which("xray")
    os.makedirs(dest_dir, exist_ok=True)
    binary = os.path.join(dest_dir, "xray.exe" if os.name == "nt" else "xray")
    if os.path.exists(binary):
        return binary
    asset = _asset_name()
    url = RELEASES + asset
    archive = os.path.join(dest_dir, asset)
    print("[xray] downloading " + url, flush=True)
    with urllib.request.urlopen(url, timeout=120) as response, open(archive, "wb") as handle:
        shutil.copyfileobj(response, handle)
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.namelist():
            if member.endswith("xray.exe") or member.endswith("/xray") or member == "xray":
                with bundle.open(member) as source, open(binary, "wb") as target:
                    shutil.copyfileobj(source, target)
                break
    if not os.path.exists(binary):
        raise RuntimeError("xray binary missing inside " + asset)
    if os.name != "nt":
        os.chmod(binary, 0o755)
    return binary


def _stream_settings(cfg: Config) -> dict:
    network = (cfg.network or "tcp").lower()
    stream = {"network": network}
    if network == "ws":
        headers = {"Host": cfg.host_header} if cfg.host_header else {}
        stream["wsSettings"] = {"path": cfg.path or "/", "headers": headers}
    elif network == "grpc":
        stream["grpcSettings"] = {"serviceName": cfg.service or "", "multiMode": False}
    elif network in ("httpupgrade", "h2"):
        stream["httpupgradeSettings" if network == "httpupgrade" else "httpSettings"] = {
            "path": cfg.path or "/",
            "host": cfg.host_header or cfg.host,
        }
    elif network == "xhttp":
        stream["xhttpSettings"] = {"path": cfg.path or "/", "host": cfg.host_header or cfg.host, "mode": "auto"}
    elif cfg.host_header:
        stream["tcpSettings"] = {
            "header": {
                "type": "http",
                "request": {"path": [cfg.path or "/"], "headers": {"Host": [cfg.host_header]}},
            }
        }
    security = (cfg.security or "none").lower()
    if security == "reality":
        stream["security"] = "reality"
        stream["realitySettings"] = {
            "serverName": cfg.sni or cfg.host,
            "fingerprint": cfg.fingerprint or "chrome",
            "publicKey": cfg.public_key,
            "shortId": cfg.short_id or "",
            "spiderX": "/",
        }
    elif security in ("tls", "xtls"):
        stream["security"] = "tls"
        tls = {"serverName": cfg.sni or cfg.host, "allowInsecure": False}
        if cfg.alpn:
            tls["alpn"] = [item.strip() for item in cfg.alpn.split(",") if item.strip()]
        if cfg.fingerprint:
            tls["fingerprint"] = cfg.fingerprint
        stream["tlsSettings"] = tls
    return stream


def build_outbound(cfg: Config) -> dict:
    stream = _stream_settings(cfg)
    if cfg.proto == "vless":
        user = {"id": cfg.secret, "encryption": "none"}
        if cfg.flow:
            user["flow"] = cfg.flow
        return {
            "protocol": "vless",
            "settings": {"vnext": [{"address": cfg.host, "port": cfg.port, "users": [user]}]},
            "streamSettings": stream,
        }
    if cfg.proto == "vmess":
        return {
            "protocol": "vmess",
            "settings": {
                "vnext": [
                    {
                        "address": cfg.host,
                        "port": cfg.port,
                        "users": [{"id": cfg.secret, "alterId": cfg.alter_id, "security": "auto"}],
                    }
                ]
            },
            "streamSettings": stream,
        }
    if cfg.proto == "trojan":
        return {
            "protocol": "trojan",
            "settings": {"servers": [{"address": cfg.host, "port": cfg.port, "password": cfg.secret}]},
            "streamSettings": stream,
        }
    if cfg.proto == "ss":
        return {
            "protocol": "shadowsocks",
            "settings": {
                "servers": [
                    {"address": cfg.host, "port": cfg.port, "method": cfg.method or "aes-256-gcm", "password": cfg.secret}
                ]
            },
            "streamSettings": {"network": "tcp"},
        }
    raise RuntimeError("unsupported protocol " + cfg.proto)


def build_config(cfg: Config, socks_port: int) -> dict:
    return {
        "log": {"loglevel": "none"},
        "inbounds": [
            {
                "tag": "socks",
                "listen": "127.0.0.1",
                "port": socks_port,
                "protocol": "socks",
                "settings": {"auth": "noauth", "udp": False},
            }
        ],
        "outbounds": [build_outbound(cfg)],
    }


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_port(port: int, deadline: float) -> bool:
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.25)
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.05)
    return False


def probe(socks_port: int, timeout: float) -> dict:
    null_device = "NUL" if os.name == "nt" else "/dev/null"
    last = {"ok": False, "latency_ms": None, "err": "no_target"}
    for target in TARGETS:
        command = [
            "curl",
            "-sS",
            "-o",
            null_device,
            "-w",
            "%{http_code} %{time_total}",
            "--socks5-hostname",
            "127.0.0.1:%d" % socks_port,
            "--max-time",
            "%.1f" % timeout,
            "--connect-timeout",
            "%.1f" % min(5.0, timeout),
            "-A",
            "Mozilla/5.0",
            target,
        ]
        try:
            done = subprocess.run(command, capture_output=True, text=True, timeout=timeout + 4)
        except subprocess.TimeoutExpired:
            last = {"ok": False, "latency_ms": None, "err": "curl_timeout"}
            continue
        except FileNotFoundError:
            return {"ok": False, "latency_ms": None, "err": "curl_missing"}
        output = (done.stdout or "").strip().split()
        if done.returncode != 0 or len(output) < 2:
            error = (done.stderr or "").strip().splitlines()
            last = {"ok": False, "latency_ms": None, "err": ("curl:" + (error[-1] if error else str(done.returncode)))[:110]}
            continue
        code = output[0]
        try:
            seconds = float(output[1])
        except ValueError:
            seconds = 0.0
        if code in ("204", "200"):
            return {"ok": True, "latency_ms": int(seconds * 1000), "err": ""}
        last = {"ok": False, "latency_ms": None, "err": "http_" + code}
    return last


def test_config(xray_path: str, cfg: Config, timeout: float = 6.0, tries: int = 2, workdir: Optional[str] = None) -> dict:
    socks = free_port()
    payload = build_config(cfg, socks)
    handle, path = tempfile.mkstemp(prefix="xray-", suffix=".json", dir=workdir)
    ok_count = 0
    best = None
    last_error = ""
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(payload, stream)
        process = subprocess.Popen(
            [xray_path, "run", "-c", path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            if not wait_port(socks, time.time() + 4.0):
                detail = ""
                if process.poll() is not None:
                    detail = (process.stderr.read() or "")[:200] if process.stderr else ""
                return {"ok": False, "latency_ms": None, "ok_count": 0, "tries": 0, "err": ("xray_start:" + detail).strip()[:110]}
            for _ in range(max(1, tries)):
                result = probe(socks, timeout)
                if result["ok"]:
                    ok_count += 1
                    if best is None or result["latency_ms"] < best:
                        best = result["latency_ms"]
                else:
                    last_error = result["err"]
        finally:
            try:
                process.terminate()
                process.wait(timeout=3)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    return {
        "ok": ok_count > 0,
        "latency_ms": best,
        "ok_count": ok_count,
        "tries": max(1, tries),
        "err": "" if ok_count else last_error,
    }