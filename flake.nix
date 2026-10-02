{
  description = "VibeReel — a webOS Jellyfin client for the living-room TV";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      forAllSystems = f: nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] f;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_22 # npx @webos-tools/cli (ares-package)
              imagemagick # launcher icons
              openssh
              sshpass # TV ssh with the webosbrew default password
              jq
            ];
            shellHook = ''
              echo "VibeReel webOS shell — ./build-ipk.sh, ./deploy.sh (TV= in .env.local)"
            '';
          };
        }
      );
    };
}
