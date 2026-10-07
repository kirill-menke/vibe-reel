{
  lib,
  python3Packages,
}:
# The service build. Runtime deps: fastapi/uvicorn/httpx, pywebpush +
# cryptography for push.
python3Packages.buildPythonApplication {
  pname = "reel-api";
  version = "0.1.0";
  pyproject = true;

  src = ./.;

  build-system = [ python3Packages.hatchling ];

  dependencies = with python3Packages; [
    fastapi
    uvicorn
    httpx
    # push.py: Web Push (VAPID + aes128gcm) to the iPhone app
    pywebpush
    cryptography
  ];

  # No test suite; import-check the package so a broken build fails here.
  pythonImportsCheck = [ "reel_api.app" "reel_api.canary" ];

  meta = {
    description = "VibeReel's LAN backend over Sonarr, Radarr and qBittorrent";
    mainProgram = "reel-api";
  };
}
