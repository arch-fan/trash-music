{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.trash-music;
  inherit (lib) mkEnableOption mkIf mkOption types;

  pluginSettings = {
    plugins = {
      "discord-rpc" = {
        enabled = cfg.plugins.discordRpc.enable;
        config = {
          clientId = cfg.plugins.discordRpc.clientId;
          showPlayButton = cfg.plugins.discordRpc.showPlayButton;
          showRemainingTime = cfg.plugins.discordRpc.showRemainingTime;
        };
      };
      "precise-volume-control" = {
        enabled = cfg.plugins.preciseVolumeControl.enable;
        config = {
          steps = cfg.plugins.preciseVolumeControl.steps;
          arrowShortcuts = cfg.plugins.preciseVolumeControl.arrowShortcuts;
          mouseWheel = cfg.plugins.preciseVolumeControl.mouseWheel;
          savedVolume = cfg.plugins.preciseVolumeControl.savedVolume;
        };
      };
    };
  };
in
{
  options.programs.trash-music = {
    enable = mkEnableOption "Trash Music";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.trash-music;
      defaultText = lib.literalExpression "inputs.trash-music.packages.\${pkgs.stdenv.hostPlatform.system}.trash-music";
      description = "Trash Music package to install.";
    };

    plugins.discordRpc = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Enable the Discord RPC plugin.";
      };

      clientId = mkOption {
        type = types.str;
        default = "1177081335727267940";
        description = "Discord application client ID used for Rich Presence.";
      };

      showPlayButton = mkOption {
        type = types.bool;
        default = true;
        description = "Expose a Play on YouTube Music button in Rich Presence.";
      };

      showRemainingTime = mkOption {
        type = types.bool;
        default = true;
        description = "Show the remaining song time in Rich Presence.";
      };
    };

    plugins.preciseVolumeControl = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Enable the precise volume control plugin.";
      };

      steps = mkOption {
        type = types.ints.between 1 25;
        default = 1;
        description = "Volume change step in percent.";
      };

      arrowShortcuts = mkOption {
        type = types.bool;
        default = true;
        description = "Enable Arrow Up and Arrow Down shortcuts for volume.";
      };

      mouseWheel = mkOption {
        type = types.bool;
        default = true;
        description = "Enable mouse wheel volume changes over the player.";
      };

      savedVolume = mkOption {
        type = types.nullOr (types.ints.between 0 100);
        default = null;
        description = "Optional initial saved volume to seed into the plugin state.";
      };
    };
  };

  config = mkIf cfg.enable {
    home.packages = [ cfg.package ];

    xdg.dataFile."com.archfan.trashmusic/plugin-settings.json".text =
      builtins.toJSON pluginSettings;
  };
}
