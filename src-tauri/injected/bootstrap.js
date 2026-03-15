(function () {
  if (window.__TRASH_MUSIC_BOOTSTRAPPED__) {
    return;
  }
  window.__TRASH_MUSIC_BOOTSTRAPPED__ = true;

  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args || {});
  const state = {
    descriptors: [],
    instances: new Map(),
  };

  const descriptorById = () =>
    new Map(state.descriptors.map((descriptor) => [descriptor.id, descriptor]));

  const setStyle = (element, style) => Object.assign(element.style, style);

  const createElement = (tag, text) => {
    const element = document.createElement(tag);
    if (text) {
      element.textContent = text;
    }
    return element;
  };

  const isEditableTarget = (target) => {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    if (target.isContentEditable) {
      return true;
    }

    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  };

  const getPlayerApi = () => document.querySelector("#movie_player");
  const getVideoElement = () => document.querySelector("video");

  const getPlaybackSnapshot = () => {
    const player = getPlayerApi();
    if (!player || typeof player.getPlayerResponse !== "function") {
      return null;
    }

    const response = player.getPlayerResponse();
    const details = response && response.videoDetails;
    if (!details) {
      return null;
    }

    const videoData =
      typeof player.getVideoData === "function" ? player.getVideoData() : {};
    const video = getVideoElement();
    const videoId = details.videoId || videoData.video_id || videoData.videoId;

    if (!videoId || !details.title || !details.author) {
      return null;
    }

    const thumbnails =
      details.thumbnail && Array.isArray(details.thumbnail.thumbnails)
        ? details.thumbnail.thumbnails
        : [];
    const thumbnail = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1] : null;
    const elapsedSeconds = Math.floor(
      video && Number.isFinite(video.currentTime)
        ? video.currentTime
        : Number(details.elapsedSeconds || 0),
    );
    const songDuration = Math.floor(
      Number(details.lengthSeconds || (video && video.duration) || 0),
    );

    return {
      title: details.title,
      artist: details.author,
      album: details.album || "",
      videoId,
      url: `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      imageUrl: thumbnail && thumbnail.url ? thumbnail.url : "",
      songDuration: songDuration > 0 ? songDuration : 0,
      elapsedSeconds: elapsedSeconds > 0 ? elapsedSeconds : 0,
      isPaused: video ? video.paused : player.getPlayerState?.() !== 1,
    };
  };

  const syncPlugins = async () => {
    try {
      state.descriptors = await invoke("plugin_list");
      syncRendererPlugins();
    } catch (error) {
      console.error("trash-music plugin sync failed", error);
    }
  };

  const pluginApi = {
    async dispatch(pluginId, event, payload) {
      try {
        await invoke("plugin_dispatch", { pluginId, event, payload });
      } catch (error) {
        console.error(`trash-music plugin dispatch failed for ${pluginId}:${event}`, error);
      }
    },
    getDescriptor(pluginId) {
      return descriptorById().get(pluginId) || null;
    },
  };

  const rendererPlugins = {
    "discord-rpc": {
      start(api, descriptor) {
        let currentDescriptor = descriptor;
        let lastSignature = "";
        let lastWasEmpty = false;

        const tick = () => {
          currentDescriptor = api.getDescriptor("discord-rpc") || currentDescriptor;
          if (!currentDescriptor || !currentDescriptor.enabled) {
            return;
          }

          const snapshot = getPlaybackSnapshot();
          if (!snapshot) {
            if (!lastWasEmpty) {
              lastWasEmpty = true;
              lastSignature = "";
              api.dispatch("discord-rpc", "playback:clear", {});
            }
            return;
          }

          lastWasEmpty = false;
          const progressBucket = Math.floor((snapshot.elapsedSeconds || 0) / 15);
          const signature = [
            snapshot.videoId,
            snapshot.title,
            snapshot.artist,
            snapshot.isPaused ? "paused" : "playing",
            progressBucket,
          ].join("|");

          if (signature !== lastSignature) {
            lastSignature = signature;
            api.dispatch("discord-rpc", "playback:update", snapshot);
          }
        };

        const interval = window.setInterval(tick, 1000);
        tick();

        return {
          update(nextDescriptor) {
            currentDescriptor = nextDescriptor;
            tick();
          },
          stop() {
            window.clearInterval(interval);
            api.dispatch("discord-rpc", "playback:clear", {});
          },
        };
      },
    },
    "precise-volume-control": {
      start(api, descriptor) {
        let currentDescriptor = descriptor;
        let config = { ...(descriptor.config || {}) };
        let hudTimer = 0;
        let restoreApplied = false;
        let currentPlayerBar = null;
        let currentVideo = null;

        const hud = createElement("div");
        hud.id = "trash-music-volume-hud";
        hud.textContent = "0%";
        setStyle(hud, {
          position: "fixed",
          top: "88px",
          right: "24px",
          zIndex: "2147483647",
          padding: "8px 12px",
          borderRadius: "999px",
          background: "rgba(17, 17, 17, 0.88)",
          color: "#fff",
          fontSize: "14px",
          fontWeight: "700",
          letterSpacing: "0.02em",
          opacity: "0",
          pointerEvents: "none",
          transition: "opacity 140ms ease",
          boxShadow: "0 12px 30px rgba(0, 0, 0, 0.35)",
        });
        document.documentElement.appendChild(hud);

        const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

        const getStep = () => {
          const numeric = Number(config.steps || 1);
          if (!Number.isFinite(numeric) || numeric < 1) {
            return 1;
          }
          return numeric;
        };

        const showHud = (value) => {
          hud.textContent = `${value}%`;
          hud.style.opacity = "1";
          window.clearTimeout(hudTimer);
          hudTimer = window.setTimeout(() => {
            hud.style.opacity = "0";
          }, 1200);
        };

        const setVolume = (value) => {
          const player = getPlayerApi();
          if (!player || typeof player.setVolume !== "function") {
            return;
          }

          const nextValue = clamp(Math.round(value), 0, 100);
          player.setVolume(nextValue);
          showHud(nextValue);
        };

        const changeVolume = (increase) => {
          const player = getPlayerApi();
          if (!player || typeof player.getVolume !== "function") {
            return;
          }

          const currentVolume = Number(player.getVolume() || 0);
          const nextVolume = increase
            ? currentVolume + getStep()
            : currentVolume - getStep();
          setVolume(nextVolume);
        };

        const handleWheel = (event) => {
          if (!config.mouseWheel) {
            return;
          }

          event.preventDefault();
          changeVolume(event.deltaY < 0);
        };

        const handleKeyDown = (event) => {
          if (!config.arrowShortcuts) {
            return;
          }
          if (event.defaultPrevented || isEditableTarget(event.target)) {
            return;
          }

          const searchBox = document.querySelector("ytmusic-search-box");
          if (searchBox && searchBox.opened) {
            return;
          }

          if (event.code === "ArrowUp") {
            event.preventDefault();
            changeVolume(true);
          } else if (event.code === "ArrowDown") {
            event.preventDefault();
            changeVolume(false);
          }
        };

        const attachListeners = () => {
          const playerBar = document.querySelector("ytmusic-player-bar");
          const video = getVideoElement();
          const player = getPlayerApi();

          if (playerBar !== currentPlayerBar) {
            if (currentPlayerBar) {
              currentPlayerBar.removeEventListener("wheel", handleWheel, {
                passive: false,
              });
            }
            currentPlayerBar = playerBar;
            if (currentPlayerBar) {
              currentPlayerBar.addEventListener("wheel", handleWheel, {
                passive: false,
              });
            }
          }

          if (video !== currentVideo) {
            if (currentVideo) {
              currentVideo.removeEventListener("wheel", handleWheel, { passive: false });
            }
            currentVideo = video;
            if (currentVideo) {
              currentVideo.addEventListener("wheel", handleWheel, { passive: false });
            }
          }

          if (
            !restoreApplied &&
            player &&
            typeof player.setVolume === "function" &&
            typeof config.savedVolume === "number"
          ) {
            restoreApplied = true;
            player.setVolume(clamp(config.savedVolume, 0, 100));
          }
        };

        window.addEventListener("keydown", handleKeyDown, true);
        attachListeners();
        const interval = window.setInterval(attachListeners, 1000);

        return {
          update(nextDescriptor) {
            currentDescriptor = nextDescriptor;
            config = { ...(nextDescriptor.config || {}) };
            attachListeners();
          },
          stop() {
            window.clearInterval(interval);
            window.clearTimeout(hudTimer);
            window.removeEventListener("keydown", handleKeyDown, true);
            if (currentPlayerBar) {
              currentPlayerBar.removeEventListener("wheel", handleWheel, {
                passive: false,
              });
            }
            if (currentVideo) {
              currentVideo.removeEventListener("wheel", handleWheel, { passive: false });
            }
            hud.remove();
          },
        };
      },
    },
  };

  const syncRendererPlugins = () => {
    const activeDescriptors = descriptorById();

    for (const [pluginId, instance] of state.instances.entries()) {
      const descriptor = activeDescriptors.get(pluginId);
      if (!descriptor || !descriptor.enabled) {
        instance.stop();
        state.instances.delete(pluginId);
      }
    }

    for (const descriptor of state.descriptors) {
      const rendererPlugin = rendererPlugins[descriptor.id];
      if (!rendererPlugin) {
        continue;
      }

      const existing = state.instances.get(descriptor.id);
      if (descriptor.enabled) {
        if (existing) {
          existing.update(descriptor);
        } else {
          state.instances.set(descriptor.id, rendererPlugin.start(pluginApi, descriptor));
        }
      } else if (existing) {
        existing.stop();
        state.instances.delete(descriptor.id);
      }
    }
  };

  const bootstrap = async () => {
    await syncPlugins();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
