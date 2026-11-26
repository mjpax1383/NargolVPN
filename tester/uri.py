"""Share-link parsing and canonical identity.

Mirrored (deliberately) by the Worker: the id computed here is the primary key
everywhere else. Keep the canonical string byte-identical if you ever touch it.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import urllib.parse
from dataclasses import dataclass, field
from typing import Optional

SUPPORTED = ("vless", "vmess", "trojan", "ss")

URI_RE = re.compile(r"(?:vless|vmess|trojan|ss)://[^\s<>\x22\x27]+", re.IGNORECASE)
B64_RE = re.compile(r"[A-Za-z0-9+/]{120,}={0,2}")
TRAILING = "\x22\x27)]}>,.;"


def b64decode_loose(value: str) -> bytes:
    value = value.strip().replace("-", "+").replace("_", "/")
    value += "=" * ((-len(value)) % 4)
    return base64.b64decode(value)


def b64encode_text(value: str) -> str:
    return base64.b64encode(value.encode("utf-8")).decode("ascii")


@dataclass
class Config:
    uri: str
    proto: str
    host: str
    port: int
    secret: str = ""
    network: str = "tcp"
    path: str = ""
    sni: str = ""
    service: str = ""
    host_header: str = ""
    flow: str = ""
    security: str = ""
    alpn: str = ""
    fingerprint: str = ""
    public_key: str = ""
    short_id: str = ""
    method: str = ""
    alter_id: int = 0
    tag: str = ""
    extra: dict = field(default_factory=dict)

    def canonical(self) -> str:
        parts = [
            self.proto,
            self.host.lower(),
            str(self.port),
            self.secret,
            self.network or "tcp",
            self.path or "",
            (self.sni or self.host).lower(),
        ]
        return "|".join(parts)

    @property
    def id(self) -> str:
        return hashlib.sha256(self.canonical().encode("utf-8")).hexdigest()[:32]

    def label(self) -> str:
        return "%s %s:%s" % (self.proto, self.host, self.port)


def _clean(value: Optional[str]) -> str:
    if not value:
        return ""
    return urllib.parse.unquote(str(value)).strip()


def _port(value) -> int:
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        return 0
    return port if 0 < port < 65536 else 0


def _first(qs: dict, *names: str) -> str:
    for name in names:
        values = qs.get(name)
        if values and values[0] not in ("", "0"):
            return _clean(values[0])
    return ""


def _parse_vless(uri: str, body: str) -> Optional[Config]:
    parsed = urllib.parse.urlsplit(uri)
    secret = _clean(parsed.username)
    host = (parsed.hostname or "").strip("[]")
    port = _port(parsed.port)
    if not secret or not host or not port:
        return None
    qs = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    cfg = Config(uri=uri, proto="vless", host=host, port=port, secret=secret)
    cfg.network = _first(qs, "type", "net") or "tcp"
    cfg.path = _first(qs, "path")
    cfg.host_header = _first(qs, "host", "sni") if _first(qs, "host") else ""
    cfg.sni = _first(qs, "sni", "peer", "host")
    cfg.service = _first(qs, "serviceName", "servicename")
    cfg.flow = _first(qs, "flow")
    cfg.security = (_first(qs, "security") or "none").lower()
    cfg.fingerprint = _first(qs, "fp", "fingerprint")
    cfg.public_key = _first(qs, "pbk", "publicKey")
    cfg.short_id = _first(qs, "sid", "shortId")
    cfg.alpn = _first(qs, "alpn")
    cfg.tag = _clean(parsed.fragment)
    return cfg


def _parse_trojan(uri: str, body: str) -> Optional[Config]:
    parsed = urllib.parse.urlsplit(uri)
    secret = _clean(parsed.username)
    host = (parsed.hostname or "").strip("[]")
    port = _port(parsed.port)
    if not secret or not host or not port:
        return None
    qs = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    cfg = Config(uri=uri, proto="trojan", host=host, port=port, secret=secret)
    cfg.network = _first(qs, "type", "net") or "tcp"
    cfg.path = _first(qs, "path")
    cfg.host_header = _first(qs, "host")
    cfg.sni = _first(qs, "sni", "peer", "host")
    cfg.service = _first(qs, "serviceName")
    cfg.security = (_first(qs, "security") or "tls").lower()
    cfg.alpn = _first(qs, "alpn")
    cfg.fingerprint = _first(qs, "fp")
    cfg.tag = _clean(parsed.fragment)
    return cfg


def _parse_vmess(uri: str, body: str) -> Optional[Config]:
    try:
        payload = json.loads(b64decode_loose(body).decode("utf-8", "ignore"))
    except Exception:
        return None
    host = str(payload.get("add") or "").strip().strip("[]")
    port = _port(payload.get("port"))
    secret = str(payload.get("id") or "").strip()
    if not host or not port or not secret:
        return None
    cfg = Config(uri=uri, proto="vmess", host=host, port=port, secret=secret)
    cfg.network = (str(payload.get("net") or "tcp")).lower()
    cfg.path = str(payload.get("path") or "")
    cfg.host_header = str(payload.get("host") or "")
    cfg.sni = str(payload.get("sni") or payload.get("host") or "")
    cfg.service = str(payload.get("path") or "") if cfg.network == "grpc" else ""
    cfg.fingerprint = str(payload.get("fp") or "")
    cfg.alpn = str(payload.get("alpn") or "")
    tls = str(payload.get("tls") or "").lower()
    cfg.security = "tls" if tls in ("tls", "reality", "true", "1") else "none"
    try:
        cfg.alter_id = int(payload.get("aid") or 0)
    except (TypeError, ValueError):
        cfg.alter_id = 0
    cfg.tag = str(payload.get("ps") or "")
    return cfg


def _parse_ss(uri: str, body: str) -> Optional[Config]:
    raw = body.split("#", 1)[0].split("?", 1)[0].strip()
    if not raw:
        return None
    if "@" in raw:
        userinfo, hostport = raw.rsplit("@", 1)
        if ":" not in userinfo:
            try:
                userinfo = b64decode_loose(userinfo).decode("utf-8", "ignore")
            except Exception:
                return None
    else:
        try:
            decoded = b64decode_loose(raw).decode("utf-8", "ignore")
        except Exception:
            return None
        if "@" not in decoded:
            return None
        userinfo, hostport = decoded.rsplit("@", 1)
    if ":" not in userinfo or ":" not in hostport:
        return None
    method, password = userinfo.split(":", 1)
    host, port_text = hostport.rsplit(":", 1)
    port = _port(port_text)
    host = host.strip().strip("[]")
    if not host or not port or not method or not password:
        return None
    cfg = Config(uri=uri, proto="ss", host=host, port=port, secret=password)
    cfg.method = method.strip().lower()
    cfg.network = "tcp"
    cfg.tag = _clean(uri.split("#", 1)[1]) if "#" in uri else ""
    return cfg


def parse_uri(uri: str) -> Optional[Config]:
    uri = uri.strip()
    if len(uri) < 12 or "://" not in uri:
        return None
    scheme = uri.split("://", 1)[0].lower()
    body = uri.split("://", 1)[1]
    try:
        if scheme == "vless":
            return _parse_vless(uri, body)
        if scheme == "trojan":
            return _parse_trojan(uri, body)
        if scheme == "vmess":
            return _parse_vmess(uri, body)
        if scheme == "ss":
            return _parse_ss(uri, body)
    except Exception:
        return None
    return None


def _trim(token: str) -> str:
    while token and token[-1] in TRAILING:
        token = token[:-1]
    return token


def extract_tokens(text: str) -> list:
    """Every candidate share link in a blob of text, including base64-wrapped ones."""
    if not text:
        return []
    found = []
    for match in URI_RE.finditer(text):
        token = _trim(match.group(0))
        if len(token) > 12:
            found.append(token)
    for match in B64_RE.finditer(text):
        try:
            decoded = b64decode_loose(match.group(0)).decode("utf-8", "ignore")
        except Exception:
            continue
        if "://" not in decoded:
            continue
        for inner in URI_RE.finditer(decoded):
            token = _trim(inner.group(0))
            if len(token) > 12:
                found.append(token)
    return found