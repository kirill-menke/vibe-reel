"""Console entry point: `reel-api` runs the ASGI app under uvicorn.

HOST/PORT come from the environment (the systemd unit sets them). Binding is
the deployer's choice — 127.0.0.1 for loopback-only, 0.0.0.0 to reach it from
other LAN devices such as the TV.
"""

import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "reel_api.app:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8790")),
        log_level=os.environ.get("LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
