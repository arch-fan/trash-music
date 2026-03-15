{
  description = "Trash Music - Tauri YouTube Music wrapper with a flake-parts + fenix toolchain";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    fenix.url = "github:nix-community/fenix";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    inputs@{
      self,
      flake-parts,
      fenix,
      ...
    }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      flake.homeManagerModules.default = import ./nix/home-manager.nix { inherit self; };

      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      perSystem =
        {
          pkgs,
          self',
          system,
          ...
        }:
        let
          lib = pkgs.lib;
          fenixPkgs = fenix.packages.${system};
          rustToolchain = fenixPkgs.combine [
            fenixPkgs.stable.cargo
            fenixPkgs.stable.clippy
            fenixPkgs.stable.rust-analyzer
            fenixPkgs.stable.rust-src
            fenixPkgs.stable.rustc
            fenixPkgs.stable.rustfmt
          ];
          rustPlatform = pkgs.makeRustPlatform {
            cargo = fenixPkgs.stable.cargo;
            rustc = fenixPkgs.stable.rustc;
          };
          tauriRuntime = [
            pkgs.cairo
            pkgs.gdk-pixbuf
            pkgs.glib
            pkgs.glib-networking
            pkgs.gtk3
            pkgs.librsvg
            pkgs.libsoup_3
            pkgs.pango
            pkgs.webkitgtk_4_1
            pkgs.gst_all_1.gstreamer
            pkgs.gst_all_1."gst-plugins-base"
            pkgs.gst_all_1."gst-plugins-good"
            pkgs.gst_all_1."gst-plugins-bad"
          ];
          xdgDataDirs = lib.makeSearchPath "share" [
            pkgs.gsettings-desktop-schemas
            pkgs.gtk3
            pkgs.shared-mime-info
          ];
        in
        {
          packages.default = rustPlatform.buildRustPackage {
            pname = "trash-music";
            version = "0.1.0";
            src = lib.cleanSource ./.;
            cargoRoot = "src-tauri";
            buildAndTestSubdir = "src-tauri";

            cargoLock = {
              lockFile = ./src-tauri/Cargo.lock;
            };

            nativeBuildInputs = [
              pkgs.autoPatchelfHook
              pkgs.cargo-tauri.hook
              pkgs.pkg-config
              pkgs.wrapGAppsHook3
            ];
            buildInputs = tauriRuntime;

            postInstall = ''
              if [ -f "$out/share/applications/Trash Music.desktop" ]; then
                mv "$out/share/applications/Trash Music.desktop" \
                  "$out/share/applications/trash-music.desktop"
              fi
            '';

            preFixup = ''
              gappsWrapperArgs+=(
                --set-default WEBKIT_DISABLE_DMABUF_RENDERER 1
              )
            '';

            meta = with lib; {
              description = "YouTube Music desktop wrapper built with Tauri";
              desktopFileName = "trash-music.desktop";
              homepage = "https://music.youtube.com/";
              license = licenses.mit;
              mainProgram = "trash-music";
              maintainers = [ ];
              platforms = platforms.linux;
            };
          };

          packages.trash-music = self'.packages.default;

          apps.default = {
            type = "app";
            program = "${self'.packages.default}/bin/trash-music";
          };

          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.pkg-config
              rustToolchain
            ]
            ++ tauriRuntime;

            LD_LIBRARY_PATH = lib.makeLibraryPath tauriRuntime;
            GIO_EXTRA_MODULES = "${pkgs.glib-networking}/lib/gio/modules";
            RUST_SRC_PATH = "${fenixPkgs.stable.rust-src}/lib/rustlib/src/rust/library";
            WEBKIT_DISABLE_DMABUF_RENDERER = "1";
            XDG_DATA_DIRS = xdgDataDirs;

            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              echo "trash-music dev shell ready"
            '';
          };

          formatter = pkgs.nixfmt;
        };
    };
}
