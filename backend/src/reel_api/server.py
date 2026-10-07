"""Console entry point: `reel-api` runs the ASGI app under uvicorn.

HOST/PORT come from the environment (the systemd unit sets them). HOST is one
address or a comma-separated list — bind only what the clients need, e.g.
`127.0.0.1,192.168.1.10`: loopback for the local reverse proxies plus the LAN
address the TV uses. 0.0.0.0 also works but exposes the service on every
interface (VPN namespaces, the tailnet, ...).
"""

import ipaddress
import os
import socket

import uvicorn

# Linux IP_FREEBIND: bind a LAN address that isn't configured yet (this starts
# before the network is necessarily up). Not in the socket module everywhere.
_IP_FREEBIND = getattr(socket, "IP_FREEBIND", 15)


def _bind(addr: str, port: int) -> socket.socket:
    ip = ipaddress.ip_address(addr)
    sock = socket.socket(socket.AF_INET6 if ip.version == 6 else socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if ip.version == 6:
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    if not ip.is_loopback and not ip.is_unspecified:
        try:
            sock.setsockopt(socket.SOL_IP, _IP_FREEBIND, 1)
        except OSError:
            pass
    sock.bind((addr, port))
    sock.set_inheritable(True)
    return sock


def main() -> None:
    hosts = [h.strip() for h in os.environ.get("HOST", "127.0.0.1").split(",") if h.strip()]
    port = int(os.environ.get("PORT", "8790"))
    config = uvicorn.Config(
        "reel_api.app:app",
        host=hosts[0],
        port=port,
        log_level=os.environ.get("LOG_LEVEL", "info"),
    )
    server = uvicorn.Server(config)
    server.run(sockets=[_bind(h, port) for h in hosts])


if __name__ == "__main__":
    main()
