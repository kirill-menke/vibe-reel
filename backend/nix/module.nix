# NixOS module for reel-api. Import it and set services.reel-api.enable.
#
# It runs the façade (search via Prowlarr, downloads via qBittorrent) as a
# hardened systemd service. FlareSolverr is enabled here too (opt out with
# enableFlaresolverr = false), for Prowlarr indexers behind a Cloudflare
# challenge — see the Prowlarr-proxy note at the bottom, the one manual step
# after the first rebuild if you use such an indexer.
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.reel-api;
in
{
  options.services.reel-api = {
    enable = lib.mkEnableOption "reel-api, VibeReel's backend (Sonarr/Radarr/Prowlarr/qBittorrent façade)";

    package = lib.mkOption {
      type = lib.types.package;
      # Built with the host's nixpkgs (not reel-api's own input), so importing
      # this module does not pull a second nixpkgs into the system closure.
      default = pkgs.callPackage (self + "/package.nix") { };
      description = "The reel-api package to run.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "0.0.0.0";
      description = "Bind address. 0.0.0.0 makes it reachable from the LAN (e.g. the TV).";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8790;
      description = "Listen port.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open `port` in the firewall so LAN devices (the TV) can reach it.";
    };

    prowlarrUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:9696";
    };

    qbittorrentUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:8080";
    };

    qbittorrentCategory = lib.mkOption {
      type = lib.types.str;
      default = "reel";
      description = "qBittorrent category for manual grabs, kept apart from Sonarr/Radarr.";
    };

    prowlarrIndexerIds = lib.mkOption {
      type = lib.types.listOf lib.types.int;
      default = [ ];
      description = "Restrict search to these Prowlarr indexer ids; empty = all enabled.";
    };

    sonarrUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:8989";
      description = "Sonarr base URL (the /api/lookup?type=tv and /api/library backend).";
    };

    radarrUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:7878";
      description = "Radarr base URL (the /api/lookup?type=movie and /api/library backend).";
    };

    sonarrQualityProfile = lib.mkOption {
      type = lib.types.str;
      default = "Reel 4K (DV/Atmos)";
      description = "Quality profile name used when adding a series (falls back to the first).";
    };

    radarrQualityProfile = lib.mkOption {
      type = lib.types.str;
      default = "Reel 4K (DV/Atmos)";
      description = "Quality profile name used when adding a movie (falls back to the first).";
    };

    environmentFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Secrets file with PROWLARR_API_KEY=... and, to enable the add-to-library
        endpoints, SONARR_API_KEY=... / RADARR_API_KEY=... (optionally
        QBIT_USERNAME/QBIT_PASSWORD). A media type whose key is unset is simply
        omitted from /api/lookup + /api/library. Kept off the (public) config
        repo; provision out of band, e.g.:
          install -d -m700 /var/lib/nixos-secrets
          cat > /var/lib/nixos-secrets/reel-api.env <<EOF
          PROWLARR_API_KEY=...
          SONARR_API_KEY=...
          RADARR_API_KEY=...
          EOF
          chmod 600 /var/lib/nixos-secrets/reel-api.env
      '';
    };

    enableFlaresolverr = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Run FlareSolverr locally for Prowlarr's Cloudflare-gated indexers.";
    };
  };

  config = lib.mkIf cfg.enable {
    # Cloudflare solver for Prowlarr. Loopback-only; Prowlarr reaches it at
    # 127.0.0.1:8191 (its default port). Not exposed to the LAN.
    services.flaresolverr.enable = lib.mkIf cfg.enableFlaresolverr true;

    systemd.services.reel-api = {
      description = "reel-api, VibeReel's backend (Sonarr/Radarr/Prowlarr/qBittorrent façade)";
      wantedBy = [ "multi-user.target" ];
      # Everything it talks to over loopback; best-effort ordering, not a hard
      # dependency (it degrades to 503 for whatever is not yet up).
      after = [
        "network.target"
        "prowlarr.service"
        "qbittorrent.service"
        "sonarr.service"
        "radarr.service"
      ];

      # Watch-while-downloading: /api/downloads/{id}/probe shells out to
      # ffprobe against the partially downloaded file. Trailers (trailers.py)
      # fetch with yt-dlp and remux to HLS with ffmpeg. yt-dlp ages fast
      # against YouTube: a failing trailer usually means a flake bump.
      path = [ pkgs.ffmpeg-headless pkgs.yt-dlp ];

      environment = {
        HOST = cfg.host;
        PORT = toString cfg.port;
        PROWLARR_URL = cfg.prowlarrUrl;
        QBIT_URL = cfg.qbittorrentUrl;
        QBIT_CATEGORY = cfg.qbittorrentCategory;
        PROWLARR_INDEXER_IDS = lib.concatMapStringsSep "," toString cfg.prowlarrIndexerIds;
        SONARR_URL = cfg.sonarrUrl;
        RADARR_URL = cfg.radarrUrl;
        SONARR_QUALITY_PROFILE = cfg.sonarrQualityProfile;
        RADARR_QUALITY_PROFILE = cfg.radarrQualityProfile;
        # yt-dlp solves YouTube's JS challenges with deno, which wants a
        # writable cache; the hardened unit only has its CacheDirectory.
        DENO_DIR = "/var/cache/reel-api/deno";
        XDG_CACHE_HOME = "/var/cache/reel-api/xdg";
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        EnvironmentFile = cfg.environmentFile;
        DynamicUser = true;
        # The stream/probe endpoints read qBittorrent's in-progress files
        # straight off disk; the download dirs are group-`users` (0775), so the
        # dynamic user needs that group. Read-only: ProtectSystem=strict below
        # already forbids writes everywhere.
        SupplementaryGroups = [ "users" ];
        # /var/cache/reel-api: remuxed trailers (HLS), LRU-capped by the app.
        CacheDirectory = "reel-api";
        # /var/lib/reel-api: Web Push subscriptions + the watcher's state
        # (push.py) — must survive restarts, unlike the cache.
        StateDirectory = "reel-api";
        StateDirectoryMode = "0700";
        Restart = "on-failure";
        RestartSec = 5;

        # Outbound HTTP only; writes nothing but its CacheDirectory.
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        NoNewPrivileges = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" ];
      };
    };

    # One-shot rename migration: until 2026-10 this service was called
    # leetx-api, so its DynamicUser state (push subscriptions + watcher state)
    # and cache (trailers, ~12 GB) live under /var/{lib,cache}/private/leetx-api.
    # Move them to the new names before the first start — a rename on the same
    # filesystem, so instant and atomic. It only acts when the old directory
    # exists and the new one does not, so it is a no-op on every later boot and
    # on fresh installs, and never overwrites anything. systemd then re-chowns
    # the moved trees to the new dynamic user when reel-api starts (it does that
    # whenever a StateDirectory/CacheDirectory's owner doesn't match).
    # switch-to-configuration stops the removed leetx-api.service before it
    # starts new units, so nothing is writing the old directories meanwhile.
    systemd.services.reel-api-migrate = {
      description = "Move leetx-api state/cache to reel-api (one-time rename)";
      # Required, not wanted: if the move fails, reel-api must not start and
      # create empty directories that would make the move skip next time.
      requiredBy = [ "reel-api.service" ];
      before = [ "reel-api.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        for base in /var/lib /var/cache; do
          old=$base/private/leetx-api new=$base/private/reel-api
          if [ -d "$old" ] && [ ! -L "$old" ] && [ ! -e "$new" ]; then
            mv -T "$old" "$new"
            echo "moved $old -> $new"
          fi
          # The old unit's /var/{lib,cache}/leetx-api -> private/leetx-api link.
          if [ -L "$base/leetx-api" ] && [ ! -e "$base/leetx-api" ]; then
            rm "$base/leetx-api"
          fi
        done
      '';
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };

  # Only if one of your Prowlarr indexers sits behind a Cloudflare challenge
  # (e.g. a public tracker such as 1337x): after the first rebuild, add a
  # FlareSolverr indexer proxy in Prowlarr pointing at http://127.0.0.1:8191/,
  # give it a tag, and put the same tag on those indexers. For the manual
  # /api/search → magnet path, set the indexer's preferMagnetUrl so Prowlarr's
  # download link redirects to the magnet.
}
