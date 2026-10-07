{
  description = "reel-api — VibeReel's LAN backend over Sonarr, Radarr and qBittorrent";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: {
        default = pkgs.callPackage ./package.nix { };
      });

      nixosModules.default = import ./nix/module.nix self;
      # Read-only health checks on a timer; import next to `default`.
      nixosModules.canary = import ./nix/canary.nix self;
    };
}
