{
  lib,
  python3Packages,
}:
# The service build. Runtime deps are the façade set only (fastapi/uvicorn/
# httpx); the scraper fallback's curl_cffi/beautifulsoup4 are optional and not
# needed on a Prowlarr deployment, so they are left out of the closure.
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
  pythonImportsCheck = [ "reel_api.app" ];

  meta = {
    description = "VibeReel's LAN backend over Sonarr, Radarr, Prowlarr and qBittorrent";
    mainProgram = "reel-api";
  };
}
