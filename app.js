function $(selector) {
  return document.querySelector(selector);
}

function ensureTrailingSlash(pathOrUrl) {
  if (!pathOrUrl) return "/";
  return pathOrUrl.endsWith("/") ? pathOrUrl : `${pathOrUrl}/`;
}

function formatTime(seconds) {
  if (!isFinite(seconds)) return "0:00";
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function normalizePathname(input) {
  try {
    const u = new URL(String(input || '/'), window.location.origin);
    const p = u.pathname || '/';
    return ensureTrailingSlash(p);
  } catch {
    return ensureTrailingSlash(String(input || '/'));
  }
}

// URL params helper (for deep links)
function getQueryParam(name) {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  } catch { return null; }
}

function setStatus(message, type = "") {
  const el = $("#status");
  el.textContent = message || "";
  el.className = `status ${type}`.trim();
}

function updateUrlParam() { /* deprecated */ }

function findFolderCoverFromAnchors(anchors, baseUrl) {
  const candidates = ["folder.jpg", "folder.jpeg", "folder.png", "Folder.jpg", "Folder.jpeg", "Folder.png"];
  for (const a of anchors) {
    const href = (a.getAttribute("href") || "").trim();
    if (candidates.includes(href)) {
      try { return new URL(href, baseUrl).href; } catch { /* ignore */ }
    }
  }
  return null;
}

// Settings persistence
const SETTINGS_KEY = "folderAudioPlayerSettings";
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch { return {}; }
}
function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

function loadPlaylistStatsCache() {
  try { return JSON.parse(localStorage.getItem('playlistStatsCache') || '{}'); } catch { return {}; }
}
function savePlaylistStatsCache(cache) {
  try { localStorage.setItem('playlistStatsCache', JSON.stringify(cache)); } catch {}
}

class FolderPlaylistPlayer {
  constructor() {
    this.audio = $("#audio");
    this.tracksList = $("#tracks");
    this.foldersWrap = null;
    this.playlistTitle = $("#playlist-title");
    this.playButton = $("#playpause-btn");
    this.prevButton = $("#prev-btn");
    this.nextButton = $("#next-btn");
    this.shuffleButton = $("#shuffle-btn");
    this.loopButton = $("#loop-btn");
    this.seek = $("#seek");
    this.currentTimeEl = $("#current-time");
    this.durationEl = $("#duration");
    this.nowTitle = $("#now-title");
    this.artworkImg = $("#artwork-img");
    this.playIcon = this.playButton ? this.playButton.querySelector('.material-symbols-rounded') : null;
    this.currentCoverUrl = null;
    this.currentPlaylistPath = null;
    this._lastPersistSecond = -1;

    this.playlist = [];
    this.currentIndex = -1;
    this.autoplay = true;
    this.isShuffling = false;
    this.isLooping = false; // loop playlist

    this.#wireEvents();
  }

  #wireEvents() {
    this.playButton.addEventListener("click", () => {
      if (this.audio.paused) this.audio.play(); else this.audio.pause();
      this.#updatePlayIcon();
    });
    this.prevButton.addEventListener("click", () => this.playPrevious());
    this.nextButton.addEventListener("click", () => this.playNext());
    if (this.shuffleButton) {
      this.shuffleButton.addEventListener("click", () => {
        this.isShuffling = !this.isShuffling;
        this.shuffleButton.classList.toggle("active", this.isShuffling);
      });
    }
    if (this.loopButton) {
      this.loopButton.addEventListener("click", () => {
        this.isLooping = !this.isLooping;
        this.loopButton.classList.toggle("active", this.isLooping);
      });
    }

    this.audio.addEventListener("play", () => {
      this.#updatePlayIcon();
      this.#highlight();
    });
    this.audio.addEventListener("pause", () => {
      this.#updatePlayIcon();
      this.#highlight();
    });
    this.audio.addEventListener("timeupdate", () => {
      const { currentTime, duration } = this.audio;
      if (isFinite(duration) && duration > 0) {
        this.seek.value = String((currentTime / duration) * 100);
      }
      this.currentTimeEl.textContent = formatTime(currentTime);
      this.durationEl.textContent = formatTime(duration);
      const s = Math.floor(currentTime || 0);
      if (s !== this._lastPersistSecond) {
        this._lastPersistSecond = s;
        this.#persistPlaybackState();
      }
    });
    this.audio.addEventListener("loadedmetadata", () => {
      this.#updateProgress();
    });
    this.audio.addEventListener("ended", () => this.playNext());
    this.audio.addEventListener("pause", () => this.#persistPlaybackState());
    this.seek.addEventListener("input", () => {
      const { duration } = this.audio;
      if (isFinite(duration) && duration > 0) {
        const pct = Number(this.seek.value) / 100;
        this.audio.currentTime = Math.max(0, Math.min(duration, duration * pct));
      }
    });

    $("#autoplay-input").addEventListener("change", (e) => {
      this.autoplay = Boolean(e.target.checked);
      const s = Object.assign({ rootPath: "/music/", autoplay: false }, loadSettings());
      s.autoplay = this.autoplay;
      saveSettings(s);
    });
  }

  async loadFromFolder(pathOrUrl) {
    const resolvedUrl = new URL(ensureTrailingSlash(pathOrUrl), window.location.origin).href;
    setStatus("Loading playlist...");
    try {
      const res = await fetch(resolvedUrl, { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const anchors = Array.from(parsed.querySelectorAll("a"));
      const mp3Anchors = anchors.filter(a => {
        const href = (a.getAttribute("href") || "").trim();
        return /\.mp3$/i.test(href);
      });
      const folderAnchors = anchors.filter(a => {
        const href = (a.getAttribute("href") || "").trim();
        // folders typically end with '/'; exclude parent link
        return href && href !== "../" && /\/$/.test(href);
      });

      const base = new URL(resolvedUrl);
      const coverUrl = findFolderCoverFromAnchors(anchors, base);
      const tracks = mp3Anchors.map((a) => {
        const href = a.getAttribute("href");
        const url = new URL(href, base).href;
        const name = decodeURIComponent(href.split("/").pop() || href);
        return { name, url };
      });
      const folders = folderAnchors.map((a) => {
        const href = a.getAttribute("href");
        const url = new URL(href, base).href;
        const name = decodeURIComponent(href.replace(/\/$/, "").split("/").pop() || href);
        return { name, url };
      });

      if (tracks.length === 0) {
        this.#renderTracks([]);
        setStatus("No .mp3 files found in folder.", "error");
        return;
      }

      this.playlist = tracks;
      this.currentIndex = 0;
      // folders UI removed from playlist view
      this.#renderTracks(tracks);
      this.currentCoverUrl = coverUrl;
      this.#setArtwork(this.currentCoverUrl);
      // Remember current playlist path
      this.currentPlaylistPath = new URL(resolvedUrl).pathname;

      // Attempt restore of last played track/time for this playlist
      const settings = loadSettings();
      let restored = false;
      if (settings && settings.last) {
        try {
          const normCurrent = normalizePathname(this.currentPlaylistPath);
          const normLast = normalizePathname(settings.last.playlistPath);
          const shouldRestore = normCurrent === normLast;
          if (shouldRestore) {
            const lastUrlRaw = settings.last.trackUrl || '';
            let idx = typeof settings.last.index === 'number' ? settings.last.index : 0;
            let found = -1;
            if (lastUrlRaw) {
              try {
                const lastUrl = new URL(lastUrlRaw, window.location.origin);
                const lastPath = lastUrl.pathname;
                found = tracks.findIndex(t => {
                  try { return new URL(t.url, window.location.origin).pathname === lastPath; } catch { return false; }
                });
                if (found < 0) {
                  const lastFile = decodeURIComponent(lastPath.split('/').pop() || '');
                  found = tracks.findIndex(t => {
                    try { return decodeURIComponent(new URL(t.url, window.location.origin).pathname.split('/').pop() || '') === lastFile; } catch { return false; }
                  });
                }
              } catch {}
            }
            if (found >= 0) idx = found;
            idx = Math.max(0, Math.min(tracks.length - 1, idx));
            this.currentIndex = idx;
            this.#loadIndexSeek(idx, settings.last.time || 0, false);
            restored = true;
          }
        } catch {}
      }
      if (!restored) {
        this.#loadIndex(0, this.autoplay);
      }
      if (this.playlistTitle) {
        const folderName = decodeURIComponent(base.pathname.replace(/\/$/, '').split('/').pop() || 'playlist');
        this.playlistTitle.textContent = folderName || 'playlist';
      }

      // URL param disabled; persistence handled via localStorage
      setStatus(`Loaded ${tracks.length} tracks`, "ok");
    } catch (err) {
      console.error(err);
      const crossOrigin = (() => {
        try { return new URL(pathOrUrl, window.location.href).origin !== window.location.origin; } catch { return false; }
      })();
      const hint = crossOrigin
        ? " Potential CORS issue: serve the SPA from the same origin/port as your folder."
        : "";
      setStatus(`Failed to load folder: ${err.message}.${hint}`, "error");
    }
  }

  playIndex(index) {
    if (!this.playlist.length) return;
    const safeIndex = Math.max(0, Math.min(this.playlist.length - 1, index));
    this.currentIndex = safeIndex;
    this.#loadIndex(safeIndex, true);
  }

  playNext() {
    if (!this.playlist.length) return;
    if (this.isShuffling) {
      const nextIndex = this.#randomNextIndex();
      this.playIndex(nextIndex);
      return;
    }
    const next = this.currentIndex + 1;
    if (next < this.playlist.length) return this.playIndex(next);
    if (this.isLooping) return this.playIndex(0);
    // Stop at end
    this.audio.pause();
    this.audio.currentTime = 0;
    this.#highlight();
  }

  playPrevious() {
    if (!this.playlist.length) return;
    const prev = this.currentIndex - 1;
    this.playIndex(prev < 0 ? 0 : prev);
  }

  #loadIndex(index, autoPlay) {
    const track = this.playlist[index];
    if (!track) return;
    this.audio.src = track.url;
    this.nowTitle.textContent = track.name;
    if (this.currentCoverUrl) {
      this.#setArtwork(this.currentCoverUrl);
    } else {
      this.#setArtworkFromName(track.name);
    }
    if (autoPlay) {
      const playPromise = this.audio.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {/* ignore autoplay block */});
      }
    }
    this.#setMediaSession(track.name, this.currentCoverUrl);
    this.#updatePlayIcon();
    this.#highlight();
    this.#persistPlaybackState();
  }

  #loadIndexSeek(index, seconds, autoPlay) {
    const track = this.playlist[index];
    if (!track) return;
    this.audio.src = track.url;
    this.nowTitle.textContent = track.name;
    if (this.currentCoverUrl) this.#setArtwork(this.currentCoverUrl); else this.#setArtworkFromName(track.name);
    const seekTo = Math.max(0, Number(seconds) || 0);
    const onMeta = () => {
      try {
        if (isFinite(this.audio.duration)) {
          this.audio.currentTime = Math.min(this.audio.duration - 0.25, seekTo);
        }
      } catch {}
    };
    this.audio.addEventListener('loadedmetadata', onMeta, { once: true });
    if (autoPlay) {
      const p = this.audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
    this.#setMediaSession(track.name, this.currentCoverUrl);
    this.currentIndex = index;
    this.#updatePlayIcon();
    this.#highlight();
    this.#persistPlaybackState();
  }

  #randomNextIndex() {
    if (this.playlist.length <= 1) return this.currentIndex;
    let idx = this.currentIndex;
    while (idx === this.currentIndex) {
      idx = Math.floor(Math.random() * this.playlist.length);
    }
    return idx;
  }

  #setArtworkFromName(name) {
    if (!this.artworkImg) return;
    // Simple placeholder artwork using a color hash from the name
    const seed = Array.from(name).reduce((a, c) => a + c.charCodeAt(0), 0);
    const hue = seed % 360;
    const canvas = document.createElement("canvas");
    canvas.width = 400; canvas.height = 400;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createRadialGradient(200, 200, 40, 200, 200, 200);
    grad.addColorStop(0, `hsl(${hue}, 85%, 55%)`);
    grad.addColorStop(1, `hsl(${(hue+40)%360}, 70%, 20%)`);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 400, 400);
    // Text initials
    const initials = name.replace(/\.[^/.]+$/, "").split(/\s+|[-_]/).filter(Boolean).slice(0,2).map(w => w[0].toUpperCase()).join("");
    ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.fillRect(0, 340, 400, 60);
    ctx.fillStyle = "white"; ctx.font = "bold 120px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(initials || "♪", 200, 210);
    this.artworkImg.src = canvas.toDataURL("image/png");
    delete this.artworkImg.dataset.fromCover;
  }

  #setArtwork(url) {
    if (!this.artworkImg) return;
    if (url) {
      this.artworkImg.src = url;
      this.artworkImg.dataset.fromCover = 'true';
    } else {
      delete this.artworkImg.dataset.fromCover;
    }
  }

  #setMediaSession(title, coverUrl) {
    try {
      if (!('mediaSession' in navigator)) return;
      const artwork = coverUrl ? [{ src: coverUrl, sizes: '400x400', type: 'image/png' }] : [];
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'AudioPlayer', artwork });
      navigator.mediaSession.setActionHandler('play', () => this.audio.play());
      navigator.mediaSession.setActionHandler('pause', () => this.audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.playPrevious());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.playNext());
    } catch {}
  }

  #updatePlayIcon() {
    if (!this.playIcon) return;
    this.playIcon.textContent = this.audio && !this.audio.paused ? "pause" : "play_arrow";
  }

  #updateProgress() {
    const { currentTime, duration } = this.audio;
    if (isFinite(duration) && duration > 0) {
      this.seek.value = String((currentTime / duration) * 100);
    } else {
      this.seek.value = "0";
    }
    this.currentTimeEl.textContent = formatTime(currentTime);
    this.durationEl.textContent = formatTime(duration);
  }
  #renderTracks(tracks) {
    this.tracksList.innerHTML = "";
    tracks.forEach((t, i) => {
      const li = document.createElement("li");
      li.className = "track";
      li.innerHTML = `
        <span class="index">${String(i + 1).padStart(2, "0")}</span>
        <span class="name" title="${t.name}">${t.name}</span>
        <span class="actions"><span class="material-symbols-rounded track-icon" aria-hidden="true"></span></span>
      `;
      li.addEventListener("click", () => this.playIndex(i));
      this.tracksList.appendChild(li);
    });
    this.#highlight();
  }

  // folders UI removed

  #highlight() {
    const items = Array.from(this.tracksList.querySelectorAll(".track"));
    items.forEach((el, i) => {
      const icon = el.querySelector(".track-icon");
      if (i === this.currentIndex && this.audio.src) {
        el.classList.add("playing");
        if (icon) icon.textContent = this.audio.paused ? "pause" : "play_arrow"; // per request: show play when playing, pause when paused
      } else {
        el.classList.remove("playing");
        if (icon) icon.textContent = "";
      }
    });
  }

  #persistPlaybackState() {
    try {
      const track = this.playlist[this.currentIndex];
      if (!track) return;
      const settings = Object.assign({ rootPath: "/music/", autoplay: false }, loadSettings());
      settings.last = {
        playlistPath: normalizePathname(this.currentPlaylistPath || getQueryParam('playlist') || new URL(window.location.href).pathname),
        index: this.currentIndex,
        trackUrl: track.url,
        time: this.audio.currentTime || 0
      };
      saveSettings(settings);
    } catch {}
  }
}

function init() {
  const player = new FolderPlaylistPlayer();

  const input = $("#playlist-input");
  const loadBtn = $("#load-btn");
  const useCurrentBtn = null; // removed from UI
  const autoplayInput = $("#autoplay-input");
  const settingsBtn = $("#settings-btn");
  const settingsModal = $("#settings-modal");
  const settingsClose = $("#settings-close");
  const sleepBtn = $("#sleep-btn");
  const sleepModal = $("#sleep-modal");
  const sleepClose = $("#sleep-close");
  const sleepGauge = document.getElementById('sleep-gauge');
  const sleepProgress = document.getElementById('sleep-progress');
  const sleepKnob = document.getElementById('sleep-knob');
  const sleepMinutesEl = document.getElementById('sleep-minutes');
  const sleepStart = document.getElementById('sleep-start');
  const sleepCancel = document.getElementById('sleep-cancel');
  const sleepStatus = document.getElementById('sleep-status');
  const sleepRemaining = document.getElementById('sleep-remaining');
  const backBtn = $("#back-btn");
  const homeSection = $("#home-section");
  const playlistGrid = $("#playlist-grid");
  const controlsSection = document.querySelector('.controls');
  const playlistSection = document.querySelector('.playlist');
  const installBtn = $("#install-btn");
  const resetBtn = $("#reset-btn");

  // Load settings or defaults
  const settings = Object.assign({ rootPath: "/music/", autoplay: false }, loadSettings());
  player.autoplay = Boolean(settings.autoplay);
  autoplayInput.checked = player.autoplay;

  loadBtn.addEventListener("click", () => {
    const value = input.value.trim();
    if (!value) {
      setStatus("Enter a folder path or URL", "error");
      return;
    }
    player.loadFromFolder(value);
    settings.currentPlaylistPath = ensureTrailingSlash(value);
    saveSettings(settings);
    // Reflect in URL for deep-linkability
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('playlist', ensureTrailingSlash(value));
      history.replaceState(null, '', url.toString());
    } catch {}
  });

  // 'Use current' removed

  // Simple view toggling
  let currentView = 'home'; // 'home' | 'player'
  function setView(view) {
    currentView = view;
    if (homeSection) homeSection.style.display = view === 'home' ? '' : 'none';
    if (controlsSection) controlsSection.style.display = view === 'player' ? '' : 'none';
    if (playlistSection) playlistSection.style.display = view === 'player' ? '' : 'none';
    if (backBtn) backBtn.classList.toggle('hide', view === 'home');
  }

  async function renderHomePlaylists(forceRefresh = false) {
    if (!playlistGrid) return;
    playlistGrid.innerHTML = "";
    const basePath = ensureTrailingSlash(settings.rootPath);
    try {
      const res = await fetch(basePath, { headers: { 'Accept': 'text/html' } });
      if (!res.ok) return;
      const html = await res.text();
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const anchors = Array.from(parsed.querySelectorAll('a'));
      const folderAnchors = anchors.filter(a => {
        const href = (a.getAttribute('href') || '').trim();
        return href && href !== '../' && /\/$/.test(href);
      });
      const base = new URL(basePath, window.location.origin);
      const folders = folderAnchors.map(a => {
        const href = a.getAttribute('href');
        const url = new URL(href, base).href;
        const name = decodeURIComponent(href.replace(/\/$/, '').split('/').pop() || href);
        return { name, url };
      });
      // Include the root itself as first playlist
      folders.unshift({ name: decodeURIComponent(base.pathname.replace(/\/$/, '').split('/').pop() || 'music'), url: base.href });

      const cache = loadPlaylistStatsCache();
      const now = Date.now();
      const TTL = 5 * 60 * 1000;
      const EXCLUDED = [/^system volume information$/i, /^system volum information$/i];
      for (const f of folders) {
        try {
          const n = (f.name || '').trim();
          if (EXCLUDED.some(rx => rx.test(n))) continue;
          let stats = cache[f.url];
          const isStale = !stats || (now - (stats.ts || 0)) > TTL || forceRefresh;
          if (isStale) {
            const r = await fetch(f.url, { headers: { 'Accept': 'text/html' } });
            if (!r.ok) throw new Error();
            const h = await r.text();
            const p = new DOMParser().parseFromString(h, 'text/html');
            const as = Array.from(p.querySelectorAll('a'));
            const count = as.filter(a => /\.mp3$/i.test(a.getAttribute('href') || '')).length;
            const u = new URL(f.url);
            const coverUrl = findFolderCoverFromAnchors(as, u) || '';
            stats = { count, coverUrl, ts: now };
            cache[f.url] = stats;
          }
          if (!stats || !stats.count) continue;
          const li = document.createElement('li');
          li.className = 'playlist-card';
          const u = new URL(f.url);
          const path = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
          li.innerHTML = `<span class="cover">${stats.coverUrl ? `<img src="${stats.coverUrl}" alt="Cover" loading="lazy" decoding="async"/>` : ''}</span><div class="meta"><span class="name">${f.name}</span><span class="count">${stats.count}</span></div>`;
          li.addEventListener('click', () => enterPlaylist(path));
          playlistGrid.appendChild(li);
        } catch {}
      }
      savePlaylistStatsCache(cache);
    } catch {}
  }

  function enterPlaylist(path) {
    const normalized = ensureTrailingSlash(path);
    if (input) input.value = normalized;
    settings.currentPlaylistPath = normalized;
    saveSettings(settings);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('playlist', normalized);
      history.replaceState(null, '', url.toString());
    } catch {}
    player.loadFromFolder(normalized);
    setView('player');
  }

  function goHome() {
    setView('home');
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('playlist');
      history.replaceState(null, '', url.toString());
    } catch {}
    renderHomePlaylists();
  }

  // Initial view: deep link > last played > home grid
  const queryPlaylist = getQueryParam('playlist');
  if (queryPlaylist) {
    enterPlaylist(queryPlaylist);
  } else if (settings && settings.last && settings.last.playlistPath) {
    enterPlaylist(settings.last.playlistPath);
  } else {
    setView('home');
    renderHomePlaylists();
  }

  function openSettings() {
    if (settingsModal) settingsModal.setAttribute('aria-hidden', 'false');
  }
  function closeSettings() {
    if (settingsModal) settingsModal.setAttribute('aria-hidden', 'true');
  }
  if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
  if (settingsClose) settingsClose.addEventListener('click', closeSettings);
  if (settingsModal) settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });

  // Sleep modal open/close
  async function openSleep() {
    if (sleepModal) sleepModal.setAttribute('aria-hidden', 'false');
    const granted = await ensureNotificationPermission();
    if (!granted) setSleepStatus('Enable notifications to get 30s warning');
  }
  function closeSleep() { if (sleepModal) sleepModal.setAttribute('aria-hidden', 'true'); }
  if (sleepBtn) sleepBtn.addEventListener('click', openSleep);
  if (sleepClose) sleepClose.addEventListener('click', closeSleep);
  if (sleepModal) sleepModal.addEventListener('click', (e) => { if (e.target === sleepModal) closeSleep(); });

  // Sleep timer logic
  let sleepTimerId = null;
  let sleepTargetEpoch = 0;
  let sleepTickerId = null;
  let sleepPreNotifyId = null;
  function setSleepStatus(text, type = '') {
    if (sleepStatus) { sleepStatus.textContent = text || ''; sleepStatus.className = `status ${type}`.trim(); }
  }
  function setSleepMinutes(min) {
    const minutes = Math.max(1, Math.min(180, Math.round(min)));
    if (sleepMinutesEl) sleepMinutesEl.textContent = String(minutes);
    const total = 264; // circumference from stroke-dasharray in SVG
    const ratio = minutes / 180; // 0..1 across 180 minutes max
    const offset = total * (1 - ratio);
    if (sleepProgress) sleepProgress.setAttribute('stroke-dashoffset', String(offset));
    // Position knob along circle
    const angle = ratio * 360 - 90; // start at top
    const rad = (angle * Math.PI) / 180;
    const cx = 50 + 42 * Math.cos(rad);
    const cy = 50 + 42 * Math.sin(rad);
    if (sleepKnob) { sleepKnob.setAttribute('cx', cx.toFixed(2)); sleepKnob.setAttribute('cy', cy.toFixed(2)); }
    return minutes;
  }
  // Fade out helper: lower volume smoothly, then pause and restore volume
  function fadeOutAndPause(audio, durationMs = 3000) {
    try {
      if (!audio) return;
      const startVolume = Math.max(0, Math.min(1, Number(audio.volume) || 1));
      if (audio.paused || startVolume <= 0) { audio.pause(); return; }
      const steps = 30;
      const stepMs = Math.max(20, Math.floor(durationMs / steps));
      let currentStep = 0;
      const timer = setInterval(() => {
        currentStep += 1;
        const factor = Math.max(0, 1 - (currentStep / steps));
        audio.volume = Math.max(0, startVolume * factor);
        if (currentStep >= steps) {
          clearInterval(timer);
          try { audio.pause(); } catch {}
          // Restore volume for next playback
          audio.volume = startVolume;
        }
      }, stepMs);
    } catch {}
  }
  function finishSleep() {
    try { fadeOutAndPause(player.audio, 3000); } catch {}
    setSleepStatus('Sleep timer finished', 'ok');
    sleepTargetEpoch = 0;
    clearInterval(sleepTickerId); sleepTickerId = null;
    clearTimeout(sleepPreNotifyId); sleepPreNotifyId = null;
    if (sleepRemaining) { sleepRemaining.style.display = 'none'; sleepRemaining.textContent = '0:00'; }
    const s = loadSettings() || {}; if (s.sleep) delete s.sleep; saveSettings(s);
  }
  async function ensureNotificationPermission() {
    try {
      if (!('Notification' in window)) return false;
      if (Notification.permission === 'granted') return true;
      if (Notification.permission === 'denied') return false;
      const res = await Notification.requestPermission();
      return res === 'granted';
    } catch { return false; }
  }
  async function showSleepNotification(title, body) {
    try {
      const granted = await ensureNotificationPermission();
      if (!granted) return false;
      const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.ready.catch(() => null));
      if (reg && reg.showNotification) {
        await reg.showNotification(title, {
          body,
          tag: 'sleep-timer-prenotify',
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-192.png',
          requireInteraction: false,
          vibrate: [100, 60, 100],
        });
        return true;
      } else if ('Notification' in window) {
        new Notification(title, { body });
        return true;
      }
    } catch {}
    return false;
  }

  function fallbackSleepAlert() {
    try { if (navigator.vibrate) navigator.vibrate([100, 60, 100]); } catch {}
    setSleepStatus('Sleep in 30 seconds');
  }

  // Soft "pling" without affecting current track
  let plingCtx = null;
  async function playPling() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!plingCtx) plingCtx = new Ctx();
      if (plingCtx.state === 'suspended') { try { await plingCtx.resume(); } catch {} }
      const osc = plingCtx.createOscillator();
      const gain = plingCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880; // A5
      gain.gain.setValueAtTime(0.0001, plingCtx.currentTime);
      gain.gain.linearRampToValueAtTime(0.25, plingCtx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, plingCtx.currentTime + 0.6);
      osc.connect(gain).connect(plingCtx.destination);
      osc.start();
      osc.stop(plingCtx.currentTime + 0.65);
    } catch {}
  }

  async function ensurePlingUnlocked() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!plingCtx) plingCtx = new Ctx();
      if (plingCtx.state === 'suspended') { try { await plingCtx.resume(); } catch {} }
      // Prime with inaudible tick to satisfy user-gesture policies
      const osc = plingCtx.createOscillator();
      const gain = plingCtx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(plingCtx.destination);
      osc.start();
      osc.stop(plingCtx.currentTime + 0.02);
    } catch {}
  }
  // Motion permission + shake-to-extend
  async function ensureMotionPermission() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        const res = await DeviceMotionEvent.requestPermission();
        return res === 'granted';
      }
      return true;
    } catch { return false; }
  }
  let lastShakeTs = 0;
  function setupShakeListener() {
    if (typeof window === 'undefined') return;
    if (!('ondevicemotion' in window)) return;
    if (setupShakeListener._installed) return;
    const handler = (e) => {
      const now = Date.now();
      if (!sleepTargetEpoch || sleepTargetEpoch <= now) return;
      const a = e.accelerationIncludingGravity || e.acceleration || {};
      const ax = Number(a.x) || 0, ay = Number(a.y) || 0, az = Number(a.z) || 0;
      const magnitude = Math.sqrt(ax*ax + ay*ay + az*az);
      if (magnitude > 22 && (now - lastShakeTs) > 1500) {
        lastShakeTs = now;
        extendSleepByMinutes(5);
      }
    };
    window.addEventListener('devicemotion', handler, { passive: true });
    setupShakeListener._installed = true;
  }
  function extendSleepByMinutes(minutes) {
    try {
      if (!sleepTargetEpoch || sleepTargetEpoch <= Date.now()) return;
      sleepTargetEpoch += Math.max(1, minutes) * 60000;
      setSleepStatus(`Extended +${minutes} min`, 'ok');
      resumeSleepFromTarget(sleepTargetEpoch);
    } catch {}
  }
  function startSleep(minutes) {
    clearTimeout(sleepTimerId);
    clearInterval(sleepTickerId);
    clearTimeout(sleepPreNotifyId); sleepPreNotifyId = null;
    const ms = Math.max(0, (minutes || 0) * 60 * 1000);
    sleepTargetEpoch = Date.now() + ms;
    sleepTimerId = setTimeout(finishSleep, ms);
    setSleepStatus(`Sleep in ${minutes} min`);
    // Persist target and last used minutes
    const settingsAll = Object.assign(loadSettings() || {}, { sleep: { target: sleepTargetEpoch, lastMinutes: minutes } });
    saveSettings(settingsAll);
    // Show and start header ticker
    if (sleepRemaining) sleepRemaining.style.display = '';
    const updateTicker = () => {
      const remainingMs = Math.max(0, sleepTargetEpoch - Date.now());
      const totalSeconds = Math.ceil(remainingMs / 1000);
      const m = Math.floor(totalSeconds / 60);
      const s = String(totalSeconds % 60).padStart(2, '0');
      if (sleepRemaining) sleepRemaining.textContent = `${m}:${s}`;
      if (remainingMs <= 0) finishSleep();
    };
    updateTicker();
    sleepTickerId = setInterval(updateTicker, 1000);
    // Schedule 30s pre-notification
    (async () => {
      const delay = sleepTargetEpoch - Date.now() - 30000;
      if (delay > 0) {
        sleepPreNotifyId = setTimeout(async () => { const ok = await showSleepNotification('Sleep in 30 seconds', 'Playback will pause soon.'); if (!ok) fallbackSleepAlert(); playPling(); }, delay);
      } else if (delay > -5000) {
        // If less than 30s remain (e.g., after resume), notify immediately
        const ok = await showSleepNotification('Sleep in 30 seconds', 'Playback will pause soon.'); if (!ok) fallbackSleepAlert(); playPling();
      }
    })();
  }
  function cancelSleep() {
    clearTimeout(sleepTimerId); sleepTimerId = null; sleepTargetEpoch = 0; setSleepStatus('Sleep timer canceled');
    clearInterval(sleepTickerId); sleepTickerId = null; if (sleepRemaining) { sleepRemaining.style.display = 'none'; sleepRemaining.textContent = '0:00'; }
    clearTimeout(sleepPreNotifyId); sleepPreNotifyId = null;
    // Preserve lastMinutes while removing target
    const s = loadSettings() || {};
    const lastMin = s.sleep && typeof s.sleep.lastMinutes === 'number' ? s.sleep.lastMinutes : (Number(sleepMinutesEl && sleepMinutesEl.textContent) || 30);
    s.sleep = { lastMinutes: lastMin };
    saveSettings(s);
  }
  function resumeSleepFromTarget(targetEpoch) {
    clearTimeout(sleepTimerId);
    clearInterval(sleepTickerId);
    clearTimeout(sleepPreNotifyId); sleepPreNotifyId = null;
    sleepTargetEpoch = Number(targetEpoch) || 0;
    const remainingMs = Math.max(0, sleepTargetEpoch - Date.now());
    if (remainingMs <= 0) { finishSleep(); return; }
    // Header ticker
    if (sleepRemaining) sleepRemaining.style.display = '';
    const updateTicker = () => {
      const ms = Math.max(0, sleepTargetEpoch - Date.now());
      const totalSeconds = Math.ceil(ms / 1000);
      const m = Math.floor(totalSeconds / 60);
      const s = String(totalSeconds % 60).padStart(2, '0');
      if (sleepRemaining) sleepRemaining.textContent = `${m}:${s}`;
      if (ms <= 0) finishSleep();
    };
    updateTicker();
    sleepTickerId = setInterval(updateTicker, 1000);
    setSleepStatus(`Sleep in ${Math.ceil(remainingMs/60000)} min`);
    // Schedule finish at exact timestamp
    sleepTimerId = setTimeout(finishSleep, remainingMs);
    // Pre-notification in 30s before end
    (async () => {
      const delay = remainingMs - 30000;
      if (delay > 0) {
        sleepPreNotifyId = setTimeout(async () => { const ok = await showSleepNotification('Sleep in 30 seconds', 'Playback will pause soon.'); if (!ok) fallbackSleepAlert(); playPling(); }, delay);
      } else if (delay > -5000) {
        const ok = await showSleepNotification('Sleep in 30 seconds', 'Playback will pause soon.'); if (!ok) fallbackSleepAlert(); playPling();
      }
    })();
    // Ensure persistence remains
    saveSettings(Object.assign(loadSettings() || {}, { sleep: { target: sleepTargetEpoch } }));
  }
  if (sleepStart) sleepStart.addEventListener('click', async () => { await ensurePlingUnlocked(); startSleep(Number(sleepMinutesEl && sleepMinutesEl.textContent || 30)); try { await ensureMotionPermission(); setupShakeListener(); } catch {} closeSleep(); });
  if (sleepCancel) sleepCancel.addEventListener('click', cancelSleep);
  Array.from(document.querySelectorAll('.sleep-preset')).forEach(btn => {
    btn.addEventListener('click', async () => { await ensurePlingUnlocked(); setSleepMinutes(Number(btn.getAttribute('data-min') || '30')); });
  });
  // Drag interaction on gauge
  if (sleepGauge) {
    const onPoint = (clientX, clientY) => {
      const rect = sleepGauge.getBoundingClientRect();
      const cx = rect.left + rect.width / 2; const cy = rect.top + rect.height / 2;
      const dx = clientX - cx; const dy = clientY - cy;
      let angle = Math.atan2(dy, dx) * 180 / Math.PI; // -180..180, 0 at 3 o'clock
      angle = (angle + 90 + 360) % 360; // 0 at top
      const minutes = Math.round((angle / 360) * 180); // map full circle to 180 minutes
      setSleepMinutes(minutes < 1 ? 1 : minutes);
    };
    const onMove = (e) => { const t = e.touches && e.touches[0]; onPoint((t||e).clientX, (t||e).clientY); e.preventDefault(); };
    const onDown = (e) => { onMove(e); window.addEventListener('mousemove', onMove, { passive: false }); window.addEventListener('touchmove', onMove, { passive: false }); };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('touchmove', onMove); };
    sleepGauge.addEventListener('mousedown', onDown);
    sleepGauge.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
  }
  // Initialize gauge from persisted sleep target if exists
  (function initSleepFromSettings(){
    try {
      const s = loadSettings();
      if (s && s.sleep && s.sleep.target && s.sleep.target > Date.now()) {
        const remainMs = s.sleep.target - Date.now();
        const remainMin = Math.ceil(remainMs / 60000);
        setSleepMinutes(Math.min(remainMin, 180));
        resumeSleepFromTarget(s.sleep.target);
      } else {
        const lastMin = s && s.sleep && typeof s.sleep.lastMinutes === 'number' ? s.sleep.lastMinutes : 30;
        setSleepMinutes(Math.min(Math.max(1, lastMin), 180));
      }
    } catch { setSleepMinutes(30); }
  })();

  // PWA install flow
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.disabled = false;
  });
  if (installBtn) installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    installBtn.disabled = true;
    try { await deferredPrompt.prompt(); await deferredPrompt.userChoice; } finally { deferredPrompt = null; }
  });

  // Reset settings to defaults
  if (resetBtn) resetBtn.addEventListener('click', () => {
    const defaults = { rootPath: '/music/', autoplay: false };
    saveSettings(defaults);
    input.value = defaults.rootPath;
    autoplayInput.checked = true;
    player.autoplay = true;
    player.loadFromFolder(defaults.rootPath);
  });

  // Back button is now Home
  if (backBtn) backBtn.addEventListener('click', goHome);

  // playlists modal removed; home grid used instead

  // Keyboard shortcuts (space: play/pause, arrows: seek, n/p: next/prev)
  window.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
    if (e.isComposing) return;
    switch (e.key) {
      case ' ': {
        e.preventDefault();
        if (player.audio.paused) player.audio.play(); else player.audio.pause();
        break;
      }
      case 'ArrowRight': {
        const t = Math.min((player.audio.currentTime || 0) + 5, player.audio.duration || Number.MAX_SAFE_INTEGER);
        player.audio.currentTime = t;
        break;
      }
      case 'ArrowLeft': {
        const t = Math.max((player.audio.currentTime || 0) - 5, 0);
        player.audio.currentTime = t;
        break;
      }
      case 'n': case 'N': {
        player.playNext();
        break;
      }
      case 'p': case 'P': {
        player.playPrevious();
        break;
      }
    }
  });
}

window.addEventListener("DOMContentLoaded", init);


