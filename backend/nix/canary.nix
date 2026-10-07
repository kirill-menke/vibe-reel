# NixOS module for reel-api-canary: read-only health checks of the media stack
# (reel-api, Jellyfin + Intro Skipper, Prowlarr, Sonarr, Radarr, qBittorrent,
# yt-dlp) on a timer. Import it next to nixosModules.default and set
# services.reel-api.canary.enable; backend/README.md ("Canary") has the snippet.
#
# The unit runs `reel-api-canary` once per `interval`. Every check is a GET
# (plus, only when QBIT_USERNAME is set and no API key is, qBittorrent's
# POST /api/v2/auth/login). services.reel-api.qbittorrentApiKeyFile reaches the
# canary the way it reaches reel-api: LoadCredential= + QBIT_API_KEY_FILE. Any failed check fails the unit, which triggers
# `onFailure`; warnings only show in the journal and the status file
# (/var/lib/reel-api-canary/canary.json).
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  reel = config.services.reel-api;
  cfg = reel.canary;
  reelEnabled = reel.enable or false;

  checkNames = [
    "reel-api"
    "jellyfin"
    "intro-skipper"
    "segments"
    "trickplay"
    "prowlarr"
    "sonarr"
    "radarr"
    "qbittorrent"
    "yt-dlp"
  ];
  enabledChecks = lib.filter (n: cfg.checks.${n}) checkNames;
  reelYtdlp = lib.filter (p: lib.getName p == "yt-dlp") (
    lib.optionals reelEnabled config.systemd.services.reel-api.path
  );
  trickplayItem = if cfg.trickplayItemId != null then cfg.trickplayItemId else cfg.segmentsItemId;
  # reel-api's key file, when its module is imported and one is set.
  qbitKeyFile = reel.qbittorrentApiKeyFile or null;
in
{
  options.services.reel-api.canary = {
    enable = lib.mkEnableOption "reel-api-canary, read-only health checks of the media stack on a timer";

    package = lib.mkOption {
      type = lib.types.package;
      default = reel.package or (pkgs.callPackage (self + "/package.nix") { });
      defaultText = lib.literalExpression "config.services.reel-api.package";
      description = "The reel-api package (it ships the `reel-api-canary` program).";
    };

    interval = lib.mkOption {
      type = lib.types.str;
      default = "00/6:00";
      example = "hourly";
      description = "When to run, as a systemd OnCalendar expression (default: every 6 h).";
    };

    randomizedDelay = lib.mkOption {
      type = lib.types.str;
      default = "30m";
      description = "RandomizedDelaySec of the timer, so the probe never lines up with other jobs.";
    };

    environmentFile = lib.mkOption {
      type = with lib.types; coercedTo path lib.singleton (listOf path);
      default = lib.optional reelEnabled reel.environmentFile;
      defaultText = lib.literalExpression "[ config.services.reel-api.environmentFile ]";
      description = ''
        Secrets, as EnvironmentFile= lines. reel-api's own file already holds
        SONARR_API_KEY, RADARR_API_KEY (and QBIT_USERNAME / QBIT_PASSWORD, if
        used). The prowlarr check wants PROWLARR_API_KEY, which reel-api
        itself no longer reads (it may still sit in reel-api's file from
        before 2026-10). The canary also wants JELLYFIN_API_KEY
        (Jellyfin > Dashboard > API Keys; intro-skipper, segments, trickplay),
        REEL_API_TOKEN (a Jellyfin *user* access token: reel-api's request
        guard wants a signed-in user on every route; the reel-api check fails
        its config without it) and optionally QBIT_API_KEY (qBittorrent's
        WebUI API key, sent as a Bearer header). With
        services.reel-api.qbittorrentApiKeyFile set, the canary gets that file
        as a credential too (QBIT_API_KEY_FILE), which wins over QBIT_API_KEY;
        a missing file fails the unit before the canary runs (243/CREDENTIALS,
        so `onFailure` fires), an empty or unusable one fails the qbittorrent
        check. Setting this replaces the default, so list reel-api's file too.
      '';
    };

    checks = lib.genAttrs checkNames (
      name:
      lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Run the `${name}` check.";
      }
    );

    segmentsItemId = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "0123456789abcdef0123456789abcdef";
      description = ''
        Jellyfin id of an episode that has an intro: the segments check wants
        /MediaSegments/<id> non-empty. Required while checks.segments is on.
      '';
    };

    trickplayItemId = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Jellyfin id of an item with trickplay sheets (default: segmentsItemId).";
    };

    trickplayWidth = lib.mkOption {
      type = lib.types.ints.positive;
      default = 320;
      description = "Trickplay width the sheet is fetched at (the library's setting).";
    };

    youtubeId = lib.mkOption {
      type = lib.types.str;
      default = "aqz-KE-bpKQ";
      description = "A YouTube video id that yt-dlp must resolve (default: Blender's Big Buck Bunny).";
    };

    minIndexers = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 1;
      description = "Fewest enabled, non-disabled Prowlarr indexers that still pass.";
    };

    reelApiUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:${toString (reel.port or 8790)}";
      defaultText = lib.literalExpression ''"http://127.0.0.1:''${toString config.services.reel-api.port}"'';
      description = ''
        Where reel-api answers. Its host must pass reel-api's request guard:
        an IP literal, localhost, or a name in REEL_API_ALLOWED_HOSTS.
      '';
    };

    jellyfinUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:8096";
      description = "Jellyfin base URL.";
    };

    prowlarrUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:9696";
      description = ''
        Prowlarr base URL, for the prowlarr check (the arrs' indexers).
        reel-api itself no longer talks to Prowlarr, so this is the canary's
        own setting (it used to come from services.reel-api.prowlarrUrl).
      '';
    };

    extraEnvironment = lib.mkOption {
      type = with lib.types; attrsOf str;
      default = { };
      example = {
        CANARY_TIMEOUT = "60";
      };
      description = "More environment for the canary (CANARY_TIMEOUT, CANARY_SLOW_TIMEOUT, ...).";
    };

    onFailure = lib.mkOption {
      type = with lib.types; listOf str;
      default = [ ];
      example = [ "notify-ntfy@%n.service" ];
      description = ''
        Units to start when a run fails (OnFailure=). The alert channel is up
        to you: an ntfy push, an email, ... (backend/README.md, "Canary").
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = enabledChecks != [ ];
        message = "services.reel-api.canary: every check is turned off.";
      }
      {
        assertion = !cfg.checks.segments || cfg.segmentsItemId != null;
        message = "services.reel-api.canary.segmentsItemId must be set (or checks.segments = false).";
      }
      {
        assertion = !cfg.checks.trickplay || trickplayItem != null;
        message = "services.reel-api.canary: trickplay needs trickplayItemId or segmentsItemId (or checks.trickplay = false).";
      }
    ];

    systemd.services.reel-api-canary = {
      description = "reel-api canary: read-only health checks of the media stack";
      wants = [ "network-online.target" ];
      after = [
        "network-online.target"
        "reel-api.service"
        "jellyfin.service"
        "prowlarr.service"
        "sonarr.service"
        "radarr.service"
        "qbittorrent.service"
      ];
      onFailure = cfg.onFailure;

      # The yt-dlp check must run the binary reel-api runs: the yt-dlp on
      # reel-api's PATH when it is enabled here.
      path = if reelYtdlp != [ ] then reelYtdlp else [ pkgs.yt-dlp ];

      environment =
        {
          REEL_API_URL = cfg.reelApiUrl;
          JELLYFIN_URL = cfg.jellyfinUrl;
          PROWLARR_URL = cfg.prowlarrUrl;
          SONARR_URL = reel.sonarrUrl or "http://127.0.0.1:8989";
          RADARR_URL = reel.radarrUrl or "http://127.0.0.1:7878";
          QBIT_URL = reel.qbittorrentUrl or "http://127.0.0.1:8080";
          CANARY_CHECKS = lib.concatStringsSep "," enabledChecks;
          CANARY_TRICKPLAY_WIDTH = toString cfg.trickplayWidth;
          CANARY_YOUTUBE_ID = cfg.youtubeId;
          CANARY_MIN_INDEXERS = toString cfg.minIndexers;
          # yt-dlp (and the deno it solves YouTube's JS with) want a writable
          # cache; the unit's only writable places are /tmp and its state dir.
          XDG_CACHE_HOME = "/tmp/xdg";
          DENO_DIR = "/tmp/deno";
        }
        // lib.optionalAttrs (cfg.segmentsItemId != null) { CANARY_SEGMENTS_ITEM_ID = cfg.segmentsItemId; }
        // lib.optionalAttrs (trickplayItem != null) { CANARY_TRICKPLAY_ITEM_ID = trickplayItem; }
        // lib.optionalAttrs (qbitKeyFile != null) {
          # %d = the unit's credentials directory, as in reel-api's unit.
          QBIT_API_KEY_FILE = "%d/qbittorrent-api-key";
        }
        // cfg.extraEnvironment;

      serviceConfig = {
        Type = "oneshot";
        ExecStart = lib.getExe' cfg.package "reel-api-canary";
        EnvironmentFile = cfg.environmentFile;
        # reel-api's qBittorrent key, copied by root into %d for this run only
        # (the DynamicUser never opens the root-only file). A missing source
        # file fails the unit (243/CREDENTIALS).
        LoadCredential = lib.optional (qbitKeyFile != null) "qbittorrent-api-key:${toString qbitKeyFile}";
        # The checks plus a cold yt-dlp, with room to spare; each check has
        # its own deadline inside.
        TimeoutStartSec = "10min";

        DynamicUser = true;
        # /var/lib/reel-api-canary/canary.json: the last run's verdicts.
        StateDirectory = "reel-api-canary";

        # Outbound HTTP and one subprocess; writes nothing but its state dir.
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        SystemCallArchitectures = "native";
        UMask = "0077";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
        ];
      };
    };

    systemd.timers.reel-api-canary = {
      description = "reel-api canary, every ${cfg.interval}";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = cfg.interval;
        RandomizedDelaySec = cfg.randomizedDelay;
        # No catch-up run at boot: the stack (Jellyfin's plugins, the VPN
        # namespace) is still coming up then, and that alert would be noise.
        Persistent = false;
      };
    };
  };
}
