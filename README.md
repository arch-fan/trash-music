# Trash Music

Desktop wrapper for `https://music.youtube.com/` built with Tauri 2 and packaged with Nix.

## Development

```bash
direnv allow
bun install
bun run dev
```

## Nix

```bash
nix develop
nix build
nix run
```

The flake also exposes `homeManagerModules.default`.

By default the launcher sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` to avoid the
WebKitGTK Wayland/GBM startup crash seen on some Linux graphics stacks. If your
system works without that workaround and you want to try the faster renderer
path, override it with `WEBKIT_DISABLE_DMABUF_RENDERER=0 nix run` or
`WEBKIT_DISABLE_DMABUF_RENDERER=0 bun run dev`.

## Plugins

The app now ships with two built-in plugins enabled by default:

- `Discord RPC`
- `Precise Volume Control`

Open the in-app plugin panel with the floating `Plugins` button or `Ctrl+,`.
From there you can enable or disable plugins and adjust their exposed settings.

Plugin settings are stored separately from the YouTube Music web session.
The web session itself continues to live under:

```bash
~/.local/share/com.archfan.trashmusic
```

The plugin settings file lives alongside that session data at:

```bash
~/.local/share/com.archfan.trashmusic/plugin-settings.json
```

## Home Manager

The flake exports `homeManagerModules.default`, which installs the package and
materializes the plugin settings file for you.

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    trash-music.url = "path:/home/juan/Code/trash-music";
  };

  outputs = { nixpkgs, home-manager, trash-music, ... }: {
    homeConfigurations.juan = home-manager.lib.homeManagerConfiguration {
      pkgs = import nixpkgs { system = "x86_64-linux"; };
      modules = [
        trash-music.homeManagerModules.default
        {
          programs.trash-music = {
            enable = true;

            plugins.discordRpc = {
              clientId = "1177081335727267940";
              showPlayButton = true;
            };

            plugins.preciseVolumeControl = {
              steps = 2;
              arrowShortcuts = true;
              mouseWheel = true;
            };
          };
        }
      ];
    };
  };
}
```
