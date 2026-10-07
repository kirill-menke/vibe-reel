# NixOS module for reel-api. Import it and set services.reel-api.enable.
#
# It runs the façade over Sonarr, Radarr and qBittorrent as a hardened systemd
# service. FlareSolverr is enabled here too (opt out with enableFlaresolverr =
# false): not for reel-api itself, but for the Prowlarr indexers behind a
# Cloudflare challenge that Sonarr/Radarr search through — see the note at the
# bottom, the one manual step after the first rebuild if you use such an indexer.
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.reel-api;
  removed =
    name: why:
    lib.mkRemovedOptionModule [ "services" "reel-api" name ] (
      why
      + " reel-api's own search and download endpoints (/api/search, /api/torrents/{id}/magnet,"
      + " POST and GET /api/downloads, GET and DELETE /api/downloads/{id}) were removed in 2026-10:"
      + " Sonarr and Radarr add every grab; reel-api only reads and streams them, by info-hash."
    );
in
{
  # Settings of the removed search/download API: a host that still sets one
  # gets this error at evaluation instead of a silent no-op.
  imports = [
    (removed "prowlarrUrl" "reel-api no longer talks to Prowlarr (configure Prowlarr in Sonarr/Radarr; the canary has its own services.reel-api.canary.prowlarrUrl).")
    (removed "prowlarrIndexerIds" "reel-api no longer searches Prowlarr.")
    (removed "qbittorrentCategory" "reel-api no longer adds torrents, so it has no qBittorrent category of its own.")
  ];

  options.services.reel-api = {
    enable = lib.mkEnableOption "reel-api, VibeReel's backend (Sonarr/Radarr/qBittorrent façade)";

    package = lib.mkOption {
      type = lib.types.package;
      # Built with the host's nixpkgs (not reel-api's own input), so importing
      # this module does not pull a second nixpkgs into the system closure.
      default = pkgs.callPackage (self + "/package.nix") { };
      description = "The reel-api package to run.";
    };

    listenAddresses = lib.mkOption {
      type = lib.types.nonEmptyListOf lib.types.str;
      default = [ "127.0.0.1" ];
      example = [ "127.0.0.1" "192.168.1.10" ];
      description = ''
        Addresses to bind. Loopback serves local reverse proxies; add the
        host's LAN address for clients that connect directly (the TV). Avoid
        0.0.0.0: it also listens on VPN namespaces, the tailnet, etc.
      '';
    };

    allowedHosts = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        config.networking.hostName
        "${config.networking.hostName}.local"
      ];
      example = [ "nas" "nas.local" "nas.example.ts.net" ];
      description = ''
        Host names clients may use to reach the service (IP literals and
        localhost always work). Requests naming any other host, and browser
        requests from web origins on other hosts, are refused: this is what
        stops DNS-rebinding and cross-site requests from LAN browsers.
      '';
    };

    jellyfinUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:8096";
      description = ''
        Jellyfin base URL. Every request must carry a Jellyfin access token
        of a signed-in user (the clients send theirs); it is checked against
        this server's /Users/Me. Push also looks titles up here.
      '';
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

    qbittorrentUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:8080";
    };

    qbittorrentApiKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/var/lib/nixos-secrets/reel-api-qbittorrent-api-key";
      description = ''
        File holding qBittorrent's WebUI API key (qBittorrent 5.2+, Options >
        WebUI > API key: "qbt_" + 28 letters/digits, one line). When set,
        reel-api sends it as `Authorization: Bearer <key>` on every call and
        never logs in with QBIT_USERNAME/QBIT_PASSWORD: no session to expire,
        no failed-login IP ban. The key wins over a username/password in
        environmentFile.

        Handed over as a systemd credential (LoadCredential=, read through
        QBIT_API_KEY_FILE=%d/qbittorrent-api-key), so the file can stay
        root-only 0600: the DynamicUser never opens it itself. Give it as a
        string outside the store, not a Nix path literal (./key): in a flake
        that is a world-readable store path.

        A MISSING file stops the whole unit, not just the downloads: systemd
        reads LoadCredential= before reel-api starts, fails it with
        243/CREDENTIALS and restarts it in a loop, so lookup, activity,
        metadata and the rest are down too until the file exists
        (the journal shows systemd's credential error). A file that is
        there but empty, whitespace only or not a usable key starts reel-api
        normally: the problem is logged and every qBittorrent call fails
        closed — the stream, probe and live-HLS routes answer 503, activity
        shows the arrs' own progress — with no fall-back to the password.

        null (default): no key — the cookie login from environmentFile's
        QBIT_USERNAME/QBIT_PASSWORD, or none at all when qBittorrent skips
        auth for loopback.
      '';
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

    movieQuota = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 10;
      description = ''
        How many movies a normal Jellyfin user may have added (and not yet
        deleted) at once through VibeReel; 0 turns adding movies off for them.
        Jellyfin administrators (Policy.IsAdministrator) have no limit.
      '';
    };

    seriesQuota = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 10;
      description = ''
        How many series a normal Jellyfin user may have added (and not yet
        deleted) at once; a series counts once, whatever its seasons. 0 turns
        adding series off for them. Administrators have no limit.
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Secrets file with, to enable the add-to-library endpoints,
        SONARR_API_KEY=... / RADARR_API_KEY=... (optionally
        QBIT_USERNAME/QBIT_PASSWORD, or QBIT_API_KEY — qbittorrentApiKeyFile
        is the better home for that). A media type whose key is unset is simply
        omitted from /api/lookup + /api/library. PROWLARR_API_KEY is obsolete
        for reel-api since 2026-10 (it is ignored, nothing is logged about it);
        keep it only if the canary's prowlarr check reads this file. Kept off
        the (public) config repo; provision out of band, e.g.:
          install -d -m700 /var/lib/nixos-secrets
          cat > /var/lib/nixos-secrets/reel-api.env <<EOF
          SONARR_API_KEY=...
          RADARR_API_KEY=...
          EOF
          chmod 600 /var/lib/nixos-secrets/reel-api.env
      '';
    };

    enableFlaresolverr = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Run FlareSolverr locally (127.0.0.1:8191) for Prowlarr's
        Cloudflare-gated indexers, which Sonarr/Radarr search through.
        reel-api itself never calls it.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Cloudflare solver for Prowlarr. Loopback-only; Prowlarr reaches it at
    # 127.0.0.1:8191 (its default port). Not exposed to the LAN.
    # It stays here although reel-api no longer searches anything itself (its
    # scraper/Prowlarr search went in 2026-10): Prowlarr's 1337x indexer proxy
    # points at it, and the arrs' grabs depend on that indexer. It belongs with
    # the host's arr config and could move there later — then set
    # enableFlaresolverr = false here.
    services.flaresolverr.enable = lib.mkIf cfg.enableFlaresolverr true;

    systemd.services.reel-api = {
      description = "reel-api, VibeReel's backend (Sonarr/Radarr/qBittorrent façade)";
      wantedBy = [ "multi-user.target" ];
      # Everything it talks to over loopback; best-effort ordering, not a hard
      # dependency (it degrades to 503 for whatever is not yet up).
      after = [
        "network.target"
        "qbittorrent.service"
        "sonarr.service"
        "radarr.service"
        "jellyfin.service"
      ];

      # Watch-while-downloading: /api/downloads/{id}/probe shells out to
      # ffprobe against the partially downloaded file. Trailers (trailers.py)
      # fetch with yt-dlp and remux to HLS with ffmpeg. yt-dlp ages fast
      # against YouTube: a failing trailer usually means a flake bump.
      path = [ pkgs.ffmpeg-headless pkgs.yt-dlp ];

      environment = {
        HOST = lib.concatStringsSep "," cfg.listenAddresses;
        REEL_API_ALLOWED_HOSTS = lib.concatStringsSep "," cfg.allowedHosts;
        JELLYFIN_URL = cfg.jellyfinUrl;
        PORT = toString cfg.port;
        QBIT_URL = cfg.qbittorrentUrl;
        SONARR_URL = cfg.sonarrUrl;
        RADARR_URL = cfg.radarrUrl;
        SONARR_QUALITY_PROFILE = cfg.sonarrQualityProfile;
        RADARR_QUALITY_PROFILE = cfg.radarrQualityProfile;
        REEL_API_QUOTA_MOVIES = toString cfg.movieQuota;
        REEL_API_QUOTA_SERIES = toString cfg.seriesQuota;
        # yt-dlp solves YouTube's JS challenges with deno, which wants a
        # writable cache; the hardened unit only has its CacheDirectory.
        DENO_DIR = "/var/cache/reel-api/deno";
        XDG_CACHE_HOME = "/var/cache/reel-api/xdg";
      }
      // lib.optionalAttrs (cfg.qbittorrentApiKeyFile != null) {
        # %d = the unit's credentials directory ($CREDENTIALS_DIRECTORY).
        QBIT_API_KEY_FILE = "%d/qbittorrent-api-key";
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        EnvironmentFile = cfg.environmentFile;
        # Read by root at start and copied, readable only by this unit, to %d.
        # A missing source file is fatal for the unit (243/CREDENTIALS).
        LoadCredential = lib.optional (
          cfg.qbittorrentApiKeyFile != null
        ) "qbittorrent-api-key:${toString cfg.qbittorrentApiKeyFile}";
        DynamicUser = true;
        # The stream/probe endpoints read qBittorrent's in-progress files
        # straight off disk; the download dirs are group-`users` (0775), so the
        # dynamic user needs that group. Read-only: ProtectSystem=strict below
        # already forbids writes everywhere.
        SupplementaryGroups = [ "users" ];
        # /var/cache/reel-api: remuxed trailers (HLS), LRU-capped by the app.
        CacheDirectory = "reel-api";
        # /var/lib/reel-api: Web Push subscriptions + the watcher's state
        # (push.json, push.py) and who added which title (owners.json,
        # ownership.py) — must survive restarts, unlike the cache.
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
  # give it a tag, and put the same tag on those indexers.
}
