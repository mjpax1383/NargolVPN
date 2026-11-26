"""Country lookup for config names: NargolVPN|4821|DE flag.

Runs only for configs that survived the test, so a typical hour is 10-40 lookups.
Every provider is free and key-less; if all of them fail we simply omit the flag.
"""
from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = "vpnbot-tester/1.0"


def _json_country(url: str, key: str, timeout: float = 5.0) -> str:
    request = urllib.request.Request(url, headers={"user-agent": UA, "accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8", "ignore"))
    if not isinstance(payload, dict):
        return ""
    if key == "country_code" and payload.get("success") is False:
        return ""
    return str(payload.get(key) or "").strip().upper()[:2]


def _text_country(url: str, timeout: float = 5.0) -> str:
    request = urllib.request.Request(url, headers={"user-agent": UA})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", "ignore").strip().upper()[:2]


PROVIDERS = (
    ("https://api.country.is/{}", "country"),
    ("https://ipwho.is/{}", "country_code"),
    ("https://ipapi.co/{}/country/", ""),
)


def country_of_ip(ip: str, timeout: float = 5.0) -> str:
    """Best-effort ISO-3166 alpha-2 for one address."""
    for template, key in PROVIDERS:
        url = template.format(ip)
        try:
            code = _text_country(url, timeout) if not key else _json_country(url, key, timeout)
        except (urllib.error.URLError, ValueError, OSError):
            continue
        if len(code) == 2 and code.isalpha():
            return code
    return ""


def resolve(host: str) -> str:
    """Return an IPv4 for a hostname, or the host itself when it is already an IP."""
    host = (host or "").strip().strip("[]")
    if not host:
        return ""
    try:
        socket.inet_aton(host)
        return host
    except OSError:
        pass
    try:
        infos = socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM)
    except socket.gaierror:
        return ""
    for info in infos:
        ip = info[4][0]
        if ip:
            return ip
    return ""


def flag(code: str) -> str:
    code = (code or "").strip().upper()
    if len(code) != 2 or not code.isalpha():
        return ""
    return chr(0x1F1E6 + ord(code[0]) - 65) + chr(0x1F1E6 + ord(code[1]) - 65)


def countries_for(hosts, workers: int = 16, timeout: float = 4.0) -> dict:
    """Map host -> ISO code for the given hosts (deduplicated, parallel, never raises).

    Resolution and lookup are split so a hostname is resolved once and an address is
    queried once: a family of 600 configs usually shares a few hundred addresses.
    """
    wanted = sorted({str(h or "").strip().lower() for h in hosts if str(h or "").strip()})
    if not wanted:
        return {}
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        resolved = dict(zip(wanted, pool.map(resolve, wanted)))
    addresses = sorted({ip for ip in resolved.values() if ip})
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        looked_up = dict(zip(addresses, pool.map(lambda ip: country_of_ip(ip, timeout), addresses)))
    return {host: looked_up.get(ip, "") for host, ip in resolved.items()}