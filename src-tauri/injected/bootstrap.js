(function () {
  if (window.__TRASH_MUSIC_BOOTSTRAPPED__) {
    return;
  }
  window.__TRASH_MUSIC_BOOTSTRAPPED__ = true;

  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args || {});
  const state = {
    descriptors: [],
    instances: new Map(),
    panelOpen: false,
    panel: null,
    panelBody: null,
    toggleButton: null,
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
      const descriptors = await invoke("plugin_list");
      state.descriptors = descriptors;
      renderPluginPanel();
      syncRendererPlugins();
    } catch (error) {
      console.error("trash-music plugin sync failed", error);
    }
  };

  const pluginApi = {
    async setEnabled(pluginId, enabled) {
      await invoke("plugin_set_enabled", { pluginId, enabled });
      await syncPlugins();
    },
    async setConfig(pluginId, config) {
      await invoke("plugin_set_config", { pluginId, config });
      await syncPlugins();
    },
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
        let saveTimer = 0;
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

        const saveConfig = () => {
          window.clearTimeout(saveTimer);
          saveTimer = window.setTimeout(() => {
            api.setConfig("precise-volume-control", config);
          }, 400);
        };

        const setVolume = (value) => {
          const player = getPlayerApi();
          if (!player || typeof player.setVolume !== "function") {
            return;
          }

          const nextValue = clamp(Math.round(value), 0, 100);
          player.setVolume(nextValue);
          config.savedVolume = nextValue;
          saveConfig();
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
            window.clearTimeout(saveTimer);
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

  const togglePanel = (force) => {
    state.panelOpen = typeof force === "boolean" ? force : !state.panelOpen;
    if (state.panel) {
      state.panel.style.display = state.panelOpen ? "flex" : "none";
    }
  };

  const renderFieldControl = (descriptor, field) => {
    const value = descriptor.config[field.key];
    const wrapper = createElement("label");
    setStyle(wrapper, {
      display: "grid",
      gap: "6px",
      marginTop: "8px",
    });

    const label = createElement("span", field.label);
    setStyle(label, {
      color: "rgba(255, 255, 255, 0.72)",
      fontSize: "12px",
      fontWeight: "600",
      letterSpacing: "0.02em",
    });
    wrapper.appendChild(label);

    if (field.kind === "boolean") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(value);
      setStyle(input, {
        width: "16px",
        height: "16px",
      });
      input.addEventListener("change", () => {
        const nextConfig = { ...descriptor.config, [field.key]: input.checked };
        pluginApi.setConfig(descriptor.id, nextConfig);
      });
      wrapper.appendChild(input);
      return wrapper;
    }

    const input = document.createElement("input");
    input.type = field.kind === "number" ? "number" : "text";
    input.value =
      value === undefined || value === null
        ? ""
        : field.kind === "number"
          ? String(Number(value))
          : String(value);
    if (field.placeholder) {
      input.placeholder = field.placeholder;
    }
    if (field.min !== null && field.min !== undefined) {
      input.min = String(field.min);
    }
    if (field.max !== null && field.max !== undefined) {
      input.max = String(field.max);
    }
    if (field.step !== null && field.step !== undefined) {
      input.step = String(field.step);
    }
    setStyle(input, {
      width: "100%",
      boxSizing: "border-box",
      padding: "10px 12px",
      borderRadius: "10px",
      border: "1px solid rgba(255, 255, 255, 0.12)",
      background: "rgba(255, 255, 255, 0.06)",
      color: "#fff",
      outline: "none",
      fontSize: "14px",
    });
    input.addEventListener("change", () => {
      const nextValue =
        field.kind === "number"
          ? Number(input.value || field.min || 0)
          : input.value.trim();
      const nextConfig = { ...descriptor.config, [field.key]: nextValue };
      pluginApi.setConfig(descriptor.id, nextConfig);
    });
    wrapper.appendChild(input);
    return wrapper;
  };

  const renderPluginPanel = () => {
    if (!state.panelBody) {
      return;
    }

    state.panelBody.replaceChildren();

    for (const descriptor of state.descriptors) {
      const card = createElement("section");
      setStyle(card, {
        display: "grid",
        gap: "10px",
        padding: "16px",
        borderRadius: "16px",
        background: "rgba(255, 255, 255, 0.06)",
        border: "1px solid rgba(255, 255, 255, 0.09)",
      });

      const header = createElement("div");
      setStyle(header, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
      });

      const titleBox = createElement("div");
      const title = createElement("strong", descriptor.name);
      setStyle(title, {
        fontSize: "15px",
        fontWeight: "700",
      });
      const description = createElement("p", descriptor.description);
      setStyle(description, {
        margin: "6px 0 0 0",
        color: "rgba(255, 255, 255, 0.72)",
        fontSize: "13px",
        lineHeight: "1.45",
      });
      titleBox.appendChild(title);
      titleBox.appendChild(description);

      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = Boolean(descriptor.enabled);
      setStyle(enabled, {
        width: "18px",
        height: "18px",
        flexShrink: "0",
      });
      enabled.addEventListener("change", () => {
        pluginApi.setEnabled(descriptor.id, enabled.checked);
      });

      header.appendChild(titleBox);
      header.appendChild(enabled);
      card.appendChild(header);

      for (const field of descriptor.fields) {
        card.appendChild(renderFieldControl(descriptor, field));
      }

      state.panelBody.appendChild(card);
    }
  };

  const ensurePanel = () => {
    if (state.panel) {
      return;
    }

    const button = createElement("button", "Plugins");
    setStyle(button, {
      position: "fixed",
      right: "24px",
      bottom: "24px",
      zIndex: "2147483647",
      border: "0",
      borderRadius: "999px",
      padding: "10px 14px",
      background: "rgba(17, 17, 17, 0.9)",
      color: "#fff",
      fontWeight: "700",
      fontSize: "13px",
      letterSpacing: "0.02em",
      boxShadow: "0 18px 40px rgba(0, 0, 0, 0.35)",
      cursor: "pointer",
    });
    button.addEventListener("click", () => togglePanel());
    state.toggleButton = button;

    const panel = createElement("aside");
    setStyle(panel, {
      position: "fixed",
      top: "84px",
      right: "24px",
      zIndex: "2147483647",
      width: "360px",
      maxWidth: "calc(100vw - 32px)",
      maxHeight: "calc(100vh - 128px)",
      display: "none",
      flexDirection: "column",
      gap: "16px",
      padding: "18px",
      overflow: "auto",
      borderRadius: "22px",
      background: "rgba(10, 10, 10, 0.94)",
      color: "#fff",
      border: "1px solid rgba(255, 255, 255, 0.09)",
      boxShadow: "0 26px 80px rgba(0, 0, 0, 0.42)",
      backdropFilter: "blur(16px)",
    });

    const header = createElement("div");
    setStyle(header, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "12px",
    });
    const title = createElement("strong", "Trash Music plugins");
    setStyle(title, {
      fontSize: "16px",
      fontWeight: "800",
      letterSpacing: "0.01em",
    });
    const close = createElement("button", "Close");
    setStyle(close, {
      border: "0",
      borderRadius: "999px",
      padding: "8px 12px",
      background: "rgba(255, 255, 255, 0.1)",
      color: "#fff",
      cursor: "pointer",
      fontWeight: "600",
    });
    close.addEventListener("click", () => togglePanel(false));
    header.appendChild(title);
    header.appendChild(close);

    const subtitle = createElement(
      "p",
      "Toggle plugins and adjust their defaults without leaving the player.",
    );
    setStyle(subtitle, {
      margin: "0",
      color: "rgba(255, 255, 255, 0.7)",
      fontSize: "13px",
      lineHeight: "1.45",
    });

    const body = createElement("div");
    setStyle(body, {
      display: "grid",
      gap: "12px",
    });

    panel.appendChild(header);
    panel.appendChild(subtitle);
    panel.appendChild(body);

    document.documentElement.appendChild(button);
    document.documentElement.appendChild(panel);

    state.panel = panel;
    state.panelBody = body;
  };

  const bootstrap = async () => {
    ensurePanel();
    document.addEventListener(
      "keydown",
      (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === ",") {
          event.preventDefault();
          togglePanel();
        }
        if (event.key === "Escape" && state.panelOpen) {
          togglePanel(false);
        }
      },
      true,
    );

    await syncPlugins();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
