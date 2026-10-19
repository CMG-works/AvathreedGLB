// ==UserScript==
// @name         AvathreedGLB
// @namespace    https://vectaria.io/
// @version      1.4
// @description  Export Vectaria.io 3D avatars to GLB format, optimized and recommended for Blender.
// @author       PIllagerJ88
// @match        https://vectaria.io/*
// @match        https://*.vectaria.io/*
// @icon         https://vectaria.io/favicon.ico
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  if (window.__AVATHREEDGLB_INITIALIZED__) return;
  window.__AVATHREEDGLB_INITIALIZED__ = true;

  console.log("[AvathreedGLB] Userscript v1.4 loaded.");

  let THREE = null;
  let GLTFExporter = null;
  let AvatarScene = null;
  let isModulesLoading = false;
  let selectedPlayerName = '';
  let initialPlayerListRequested = false;

  async function loadModules() {
    if (THREE && GLTFExporter && AvatarScene) return true;
    if (isModulesLoading) {
      while (isModulesLoading) await new Promise(r => setTimeout(r, 100));
      return !!(THREE && GLTFExporter && AvatarScene);
    }
    isModulesLoading = true;
    try {
      const resourceList = performance.getEntriesByType('resource').map(r => r.name);
      const avatarChunk = resourceList.find(u => u.includes('AvatarScene-') && u.endsWith('.js')) || '/assets/AvatarScene-nzpzhw5a.js';

      const [avatarModule, exporterModule, threeModule] = await Promise.all([
        import(avatarChunk),
        import('https://esm.sh/three@0.156.0/examples/jsm/exporters/GLTFExporter.js'),
        import('https://esm.sh/three@0.156.0')
      ]);

      AvatarScene = avatarModule.A || avatarModule.default || avatarModule.Wi;
      GLTFExporter = exporterModule.GLTFExporter;
      THREE = threeModule;
      isModulesLoading = false;
      return true;
    } catch (err) {
      console.error("Error loading 3D modules:", err);
      isModulesLoading = false;
      return false;
    }
  }

  // -------------------------------------------------------------------
  // GLTF 2.0 SANITIZER (Blender 5.2)
  // -------------------------------------------------------------
  function sanitizeGLB(arrayBuffer) {
    const dataView = new DataView(arrayBuffer);
    const magic = dataView.getUint32(0, true);
    if (magic !== 0x46546c67) return arrayBuffer;

    const totalLength = dataView.getUint32(8, true);
    const jsonChunkLen = dataView.getUint32(12, true);
    const jsonChunkType = dataView.getUint32(16, true);
    if (jsonChunkType !== 0x4e4f534a) return arrayBuffer;

    const decoder = new TextDecoder('utf-8');
    const encoder = new TextEncoder();
    const jsonBytes = new Uint8Array(arrayBuffer, 20, jsonChunkLen);
    const jsonText = decoder.decode(jsonBytes);
    const gltf = JSON.parse(jsonText);
    let modified = false;

    if (gltf.meshes) {
      for (const mesh of gltf.meshes) {
        for (const prim of mesh.primitives || []) {
          if (prim.attributes && prim.attributes.COLOR_0 !== undefined) {
            const accId = prim.attributes.COLOR_0;
            const acc = gltf.accessors?.[accId];
            if (acc && acc.type !== 'VEC3' && acc.type !== 'VEC4') {
              delete prim.attributes.COLOR_0;
              modified = true;
            }
          }
        }
      }
    }

    if (gltf.accessors) {
      for (const acc of gltf.accessors) {
        ['max', 'min'].forEach(key => {
          if (acc[key]) {
            if (!Array.isArray(acc[key]) || acc[key].some(v => typeof v !== 'number' || !Number.isFinite(v))) {
              delete acc[key];
              modified = true;
            }
          }
        });
      }
    }

    // auto-fix transparency for blender:
    if (gltf.materials) {
      for (const mat of gltf.materials) {
        if (mat.pbrMetallicRoughness?.baseColorTexture) {
          if (mat.alphaMode !== 'MASK' || mat.alphaCutoff !== 0.5 || !mat.doubleSided) {
            mat.alphaMode = 'MASK';
            mat.alphaCutoff = 0.5;
            mat.doubleSided = true;
            modified = true;
          }
        }
      }
    }

    if (!modified) return arrayBuffer;

    let newJsonText = JSON.stringify(gltf);
    const padLength = (4 - (encoder.encode(newJsonText).length % 4)) % 4;
    newJsonText += ' '.repeat(padLength);
    const newJsonBytes = encoder.encode(newJsonText);

    const binChunkOffset = 20 + jsonChunkLen;
    const hasBin = binChunkOffset < arrayBuffer.byteLength;
    const binLength = hasBin ? dataView.getUint32(binChunkOffset, true) : 0;
    const totalLengthNew = 12 + (8 + newJsonBytes.length) + (hasBin ? (8 + binLength) : 0);

    const newBuffer = new ArrayBuffer(totalLengthNew);
    const newView = new DataView(newBuffer);
    newView.setUint32(0, dataView.getUint32(0, true), true);
    newView.setUint32(4, dataView.getUint32(4, true), true);
    newView.setUint32(8, totalLengthNew, true);

    newView.setUint32(12, newJsonBytes.length, true);
    newView.setUint32(16, jsonChunkType, true);
    new Uint8Array(newBuffer, 20, newJsonBytes.length).set(newJsonBytes);

    if (hasBin) {
      const newBinOffset = 20 + newJsonBytes.length;
      newView.setUint32(newBinOffset, binLength, true);
      newView.setUint32(newBinOffset + 4, dataView.getUint32(binChunkOffset + 4, true), true);
      new Uint8Array(newBuffer, newBinOffset + 8, binLength).set(new Uint8Array(arrayBuffer, binChunkOffset + 8, binLength));
    }

    return newBuffer;
  }

  // -----------------------------------------------------------------------
  // GLB EXPORT ENGINE
  // --------------------------------------------------------------------------
  async function exportModelToGLB(model, baseName, animations = []) {
    const clone = model.clone(true);

    clone.position.set(0, 0, 0);
    clone.rotation.set(0, 0, 0);
    clone.scale.set(1, 1, 1);
    clone.updateMatrixWorld(true);

    clone.traverse(child => {
      if (child.isMesh) {
        if (child.geometry) {
          const col = child.geometry.getAttribute('color');
          if (col && col.itemSize < 3) child.geometry.deleteAttribute('color');
        }
        if (child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          const converted = mats.map(m => {
            const map = m.uniforms?.map?.value || m.map || null;
            if (m.type === 'ShaderMaterial' || m.isShaderMaterial) {
              return new THREE.MeshStandardMaterial({
                map: map,
                color: m.uniforms?.diffuse?.value || m.color || 0xffffff,
                roughness: 0.8,
                metalness: 0.1,
                transparent: false,
                alphaTest: 0.5,
                opacity: 1,
                side: THREE.DoubleSide
              });
            } else {
              m.transparent = false;
              m.alphaTest = 0.5;
              m.side = THREE.DoubleSide;
              m.needsUpdate = true;
              return m;
            }
          });
          child.material = Array.isArray(child.material) ? converted : converted[0];
        }
      }
    });

    const exporter = new GLTFExporter();
    const glbBuffer = await new Promise((resolve, reject) => {
      exporter.parse(
        clone,
        (res) => resolve(res),
        (err) => reject(err),
        { binary: true, onlyVisible: false, animations: animations || [] }
      );
    });

    const finalBuffer = sanitizeGLB(glbBuffer);
    const safeName = (baseName || 'AvathreedGLB_Player').replace(/[^a-zA-Z0-9_\-#]/g, '_');
    const filename = `${safeName}_3D.glb`;

    const blob = new Blob([finalBuffer], { type: 'model/gltf-binary' });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(downloadUrl);

    return filename;
  }

  async function buildFromSkinsAndExport(rawSkins, name) {
    await loadModules();
    const items = (rawSkins || []).map(r => {
      if (Array.isArray(r)) {
        return { link: r[1] || r[0], type: r[2], id: r[3] };
      }
      return r;
    });

    const tempCanvas = document.createElement('canvas');
    tempCanvas.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:128px;height:128px;';
    document.body.appendChild(tempCanvas);

    const avatar = new AvatarScene(items, tempCanvas, false, false);
    await avatar.modelLoadingPromise;

    if (!avatar.modelBuilder?.model) {
      tempCanvas.remove();
      try { avatar.destroy(); } catch(e) {}
      throw new Error(`Could not build the 3D geometry for ${name}`);
    }

    const model = avatar.modelBuilder.model;
    const anims = avatar.modelBuilder.animations || [];

    const filename = await exportModelToGLB(model, name, anims);

    tempCanvas.remove();
    try { avatar.destroy(); } catch(e) {}
    return filename;
  }

  // -------------------------------------------------------------
  // PINIA & VECTARIA ACCESS
  // ------------------------------------------------------------------
  function getPinia() {
    const appEl = document.getElementById("app");
    if (!appEl) return null;
    return (
      appEl._vnode?.component?.appContext?.config?.globalProperties?.$pinia ||
      appEl.__vue_app__?.config?.globalProperties?.$pinia ||
      appEl._vnode?.component?.appContext?.provides?.pinia ||
      (() => {
        for (const el of document.querySelectorAll('*')) {
          const p = el._vnode?.component?.appContext?.config?.globalProperties?.$pinia || el.__vue_app__?.config?.globalProperties?.$pinia;
          if (p) return p;
        }
        return null;
      })()
    );
  }

  function getStores() {
    const pinia = getPinia();
    let gameWorld = null;
    let profileStore = null;
    let userStore = null;

    if (pinia && pinia._s) {
      userStore = pinia._s.get('user') || null;
      for (const s of pinia._s.values()) {
        if (s?.gameWorld) gameWorld = s.gameWorld;
        if (s && ('getPlayerList' in s || 'getProfile' in s || 'profile' in s)) profileStore = s;
      }
    }
    return { pinia, gameWorld, profileStore, userStore };
  }

  // ---------------------------------------------------------------------------
  // FULL PLAYER LIST
  // -------------------------------------------------------------
  function getServerPlayers(profileStore, gameWorld) {
    const list = [];
    const seenNames = new Set();

    // official server list in Pinia
    if (profileStore?.players && Array.isArray(profileStore.players) && profileStore.players.length > 0) {
      for (const p of profileStore.players) {
        if (p && typeof p.name === 'string' && p.name.trim() !== '' && !seenNames.has(p.name)) {
          seenNames.add(p.name);
          list.push({
            id: p.id,
            name: p.name,
            activeSkins: p.activeSkins || null
          });
        }
      }
    }

    // 3D players rendered nearby in the world
    let server3DMap = gameWorld?.server?.players;
    if (server3DMap && server3DMap instanceof Map) {
      for (const [id, p] of server3DMap.entries()) {
        if (
          p &&
          typeof p.name === 'string' &&
          p.name.trim() !== '' &&
          !p.isRecordPlayer &&
          !seenNames.has(p.name)
        ) {
          seenNames.add(p.name);
          list.push({
            id: p.id || id,
            name: p.name,
            activeSkins: p.activeSkins || null,
            builder: p.builder || null
          });
        }
      }
    }

    return list;
  }

  // ------------------------------------------------------
  // FLOATING UI
  // -------------------------------------------------------------
  function createUI() {
    if (document.getElementById('avathreedglb-container')) return;

    const container = document.createElement('div');
    container.id = 'avathreedglb-container';

    container.innerHTML = `
      <style>
        /* minimalist dark theme: flat surfaces, square corners, neutral greys, single blue accent -lichess style >BD-*/
        #avathreedglb-container {
          --v3d-bg: #161512;
          --v3d-panel: #262421;
          --v3d-panel-2: #2f2d2a;
          --v3d-border: #3c3a37;
          --v3d-text: #bababa;
          --v3d-text-strong: #e6e6e6;
          --v3d-muted: #7c7a77;
          --v3d-accent: #3692e7;
          --v3d-accent-hover: #4aa0f0;
          --v3d-success: #759900;
          --v3d-error: #cc3333;
          position: fixed;
          top: 60px;
          right: 20px;
          z-index: 9999999;
          font-family: 'Noto Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          user-select: none;
        }
        #avathreedglb-container *,
        #avathreedglb-container *::before,
        #avathreedglb-container *::after {
          box-sizing: border-box;
        }
        #v3d-toggle-btn {
          display: none;
          background: var(--v3d-panel);
          color: var(--v3d-text-strong);
          padding: 7px 12px;
          border-radius: 3px;
          font-size: 13px;
          cursor: pointer;
          border: 1px solid var(--v3d-border);
          align-items: center;
          gap: 6px;
        }
        #v3d-toggle-btn:hover {
          background: var(--v3d-panel-2);
        }
        #v3d-window {
          width: 300px;
          background: var(--v3d-bg);
          border: 1px solid var(--v3d-border);
          border-radius: 3px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
          color: var(--v3d-text);
          overflow: hidden;
        }
        #v3d-header {
          padding: 9px 12px;
          background: var(--v3d-panel);
          border-bottom: 1px solid var(--v3d-border);
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: move;
        }
        .v3d-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--v3d-text-strong);
        }
        .v3d-icon-btn {
          background: transparent;
          border: none;
          color: var(--v3d-muted);
          width: 22px;
          height: 22px;
          border-radius: 3px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          line-height: 1;
        }
        .v3d-icon-btn:hover { background: var(--v3d-panel-2); color: var(--v3d-text-strong); }
        #v3d-body {
          padding: 8px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .v3d-section {
          background: var(--v3d-panel);
          border: 1px solid var(--v3d-border);
          border-radius: 3px;
          padding: 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .v3d-section-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--v3d-muted);
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        #v3d-detected-card {
          border-left: 3px solid var(--v3d-accent);
        }
        #v3d-detected-name {
          font-weight: 600;
          font-size: 14px;
          color: var(--v3d-text-strong);
        }
        .v3d-btn {
          background: var(--v3d-panel-2);
          color: var(--v3d-text-strong);
          border: 1px solid var(--v3d-border);
          border-radius: 3px;
          padding: 7px 12px;
          font-size: 12px;
          font-family: inherit;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        .v3d-btn:hover { background: #3a3835; }
        .v3d-btn-primary {
          background: var(--v3d-accent);
          border-color: var(--v3d-accent);
          color: #fff;
        }
        .v3d-btn-primary:hover { background: var(--v3d-accent-hover); border-color: var(--v3d-accent-hover); }
        .v3d-input, .v3d-select {
          background: var(--v3d-bg);
          border: 1px solid var(--v3d-border);
          border-radius: 3px;
          color: var(--v3d-text-strong);
          padding: 6px 8px;
          font-size: 12px;
          font-family: inherit;
          outline: none;
          width: 100%;
        }
        .v3d-input:focus, .v3d-select:focus { border-color: var(--v3d-accent); }
        .v3d-input::placeholder { color: var(--v3d-muted); }
        .v3d-select option {
          background: var(--v3d-bg);
          color: var(--v3d-text-strong);
        }
        #v3d-status {
          font-size: 11px;
          color: var(--v3d-muted);
          padding: 6px 8px;
          background: var(--v3d-panel);
          border-left: 3px solid var(--v3d-border);
          border-radius: 3px;
        }
        .v3d-status-success { color: var(--v3d-text-strong) !important; border-left-color: var(--v3d-success) !important; }
        .v3d-status-error { color: var(--v3d-text-strong) !important; border-left-color: var(--v3d-error) !important; }
        .v3d-status-loading { color: var(--v3d-text-strong) !important; border-left-color: var(--v3d-accent) !important; }
        #v3d-footer {
          padding: 5px 10px 7px;
          text-align: right;
          font-size: 9px;
          color: var(--v3d-muted);
          opacity: 0.7;
        }
        #avathreedglb-container button:focus-visible,
        #avathreedglb-container #v3d-toggle-btn:focus-visible {
          outline: 2px solid var(--v3d-accent);
          outline-offset: 1px;
        }
      </style>

      <div id="v3d-toggle-btn">AvathreedGLB</div>

      <div id="v3d-window">
        <div id="v3d-header">
          <div class="v3d-title">AvathreedGLB</div>
          <button class="v3d-icon-btn" id="v3d-btn-minimize" title="Minimize">&minus;</button>
        </div>

        <div id="v3d-body">
          <!-- Profile detected on screen -->
          <div class="v3d-section" id="v3d-detected-card" style="display: none;">
            <div class="v3d-section-title">
              <span>Profile open on screen</span>
            </div>
            <div id="v3d-detected-name">&mdash;</div>
            <button class="v3d-btn v3d-btn-primary" id="v3d-btn-dl-detected">
              <span>Download 3D model</span>
            </button>
          </div>

          <!-- My character -->
          <div class="v3d-section">
            <div class="v3d-section-title">
              <span>My character</span>
            </div>
            <button class="v3d-btn v3d-btn-primary" id="v3d-btn-dl-me">
              <span>Download my 3D skin</span>
            </button>
          </div>

          <!-- Players in match -->
          <div class="v3d-section" id="v3d-section-match" style="display: none;">
            <div class="v3d-section-title">
              <span id="v3d-match-title">Players on server (0)</span>
              <button class="v3d-icon-btn" id="v3d-btn-refresh-players" title="Refresh list">&#8635;</button>
            </div>
            <select class="v3d-select" id="v3d-player-select">
              <option value="">Select a player...</option>
            </select>
            <div style="display: flex; gap: 6px;">
              <button class="v3d-btn v3d-btn-primary" id="v3d-btn-dl-selected" style="flex: 1;">
                <span>Download</span>
              </button>
              <button class="v3d-btn" id="v3d-btn-dl-all" title="Download all players">
                <span>All</span>
              </button>
            </div>
          </div>

          <!-- Remote search -->
          <div class="v3d-section">
            <div class="v3d-section-title">
              <span>Search any player (admin)</span>
            </div>
            <div style="display: flex; gap: 6px;">
              <input type="text" class="v3d-input" id="v3d-search-input" placeholder="Nickname or ID..." />
              <button class="v3d-btn" id="v3d-btn-search">Search</button>
            </div>
          </div>

          <div id="v3d-status">Ready to export</div>
        </div>
        <div id="v3d-footer">by PIllagerJ88</div>
      </div>
    `;

    document.body.appendChild(container);

    const winEl = container.querySelector('#v3d-window');
    const toggleBtn = container.querySelector('#v3d-toggle-btn');
    const btnMinimize = container.querySelector('#v3d-btn-minimize');
    const header = container.querySelector('#v3d-header');
    const select = container.querySelector('#v3d-player-select');

    select.addEventListener('change', () => {
      selectedPlayerName = select.value;
    });

    btnMinimize.addEventListener('click', () => {
      winEl.style.display = 'none';
      toggleBtn.style.display = 'flex';
    });
    toggleBtn.addEventListener('click', () => {
      winEl.style.display = 'block';
      toggleBtn.style.display = 'none';
    });

    let isDragging = false;
    let startX, startY, initLeft, initTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.id === 'v3d-btn-minimize') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = container.getBoundingClientRect();
      initLeft = rect.left;
      initTop = rect.top;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
      if (!isDragging) return;
      container.style.right = 'auto';
      container.style.left = `${Math.max(10, initLeft + (e.clientX - startX))}px`;
      container.style.top = `${Math.max(10, initTop + (e.clientY - startY))}px`;
    }

    function onMouseUp() {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    function setStatus(text, type = '') {
      const statusEl = document.getElementById('v3d-status');
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.className = type ? `v3d-status-${type}` : '';
    }

    // manual player list refresh button
    let lastRefreshTime = 0;
    document.getElementById('v3d-btn-refresh-players').addEventListener('click', () => {
      const now = Date.now();
      if (now - lastRefreshTime < 3000) {
        setStatus("Please wait before refreshing again.", "loading");
        return;
      }
      lastRefreshTime = now;
      const { profileStore } = getStores();
      if (profileStore && typeof profileStore.getPlayerList === 'function') {
        profileStore.getPlayerList();
      }
      setStatus("Requesting player list from the server...", "loading");
      setTimeout(() => updatePlayersDropdown(true), 800);
    });

    // download detected profile
    document.getElementById('v3d-btn-dl-detected').addEventListener('click', async () => {
      try {
        const { profileStore } = getStores();
        if (!profileStore?.profile) throw new Error("No profile is open on screen.");
        const p = profileStore.profile;
        const name = p.name || p.username || 'Detected_Profile';
        setStatus(`Assembling model for ${name}...`, 'loading');
        const filename = await buildFromSkinsAndExport(p.activeSkins, name);
        setStatus(`Downloaded: ${filename}`, 'success');
      } catch (err) {
        setStatus(`Error: ${err.message}`, 'error');
      }
    });

    // download my character
    document.getElementById('v3d-btn-dl-me').addEventListener('click', async () => {
      try {
        setStatus("Getting your character...", "loading");
        const { pinia } = getStores();

        function findLiveAvatar(node) {
          if (!node) return null;
          if (node.component?.setupState) {
            const s = node.component.setupState;
            for (const k in s) {
              if (s[k]?.threeScene && s[k]?.modelBuilder) return s[k];
            }
          }
          if (node.component?.subTree) {
            const res = findLiveAvatar(node.component.subTree);
            if (res) return res;
          }
          if (Array.isArray(node.children)) {
            for (const child of node.children) {
              const res = findLiveAvatar(child);
              if (res) return res;
            }
          }
          return null;
        }

        const liveAvatar = findLiveAvatar(document.getElementById("app")?._vnode);
        if (liveAvatar?.modelBuilder?.model) {
          await loadModules();
          const filename = await exportModelToGLB(liveAvatar.modelBuilder.model, "My_Character", liveAvatar.modelBuilder.animations || []);
          setStatus(`Downloaded: ${filename}`, 'success');
          return;
        }

        const userStore = pinia?._s?.get('user');
        if (userStore?.activeItems) {
          const filename = await buildFromSkinsAndExport(userStore.activeItems, userStore.user?.name || "My_Character");
          setStatus(`Downloaded: ${filename}`, 'success');
          return;
        }

        throw new Error("Could not find your skin data.");
      } catch (err) {
        setStatus(`Error: ${err.message}`, 'error');
      }
    });

    // download selected player
    document.getElementById('v3d-btn-dl-selected').addEventListener('click', async () => {
      try {
        const targetName = selectedPlayerName || select.value;
        if (!targetName) throw new Error("Select a player from the list.");

        const { profileStore, gameWorld } = getStores();
        const players = getServerPlayers(profileStore, gameWorld);
        const player = players.find(p => p.name === targetName);
        if (!player) throw new Error(`Player "${targetName}" was not found in the list.`);

        setStatus(`Fetching 3D model for ${player.name}...`, 'loading');

        let activeSkins = player.activeSkins;

        // if we don't have their skins live, request them from the server via getProfile
        if (!activeSkins || activeSkins.length === 0) {
          if (profileStore) {
            profileStore.profile = null;
            if (player.id !== undefined && player.id !== null) {
              profileStore.getProfile(player.id);
            } else {
              profileStore.getProfileByName(player.name);
            }

            const start = Date.now();
            while (!profileStore.profile && (Date.now() - start < 4500)) {
              await new Promise(r => setTimeout(r, 200));
            }

            if (profileStore.profile) {
              activeSkins = profileStore.profile.activeSkins;
            }
          }
        }

        if (!activeSkins || activeSkins.length === 0) {
          if (player.builder?.model) {
            await loadModules();
            const filename = await exportModelToGLB(player.builder.model, player.name);
            setStatus(`Downloaded: ${filename}`, 'success');
            return;
          }
          throw new Error(`The server did not return cosmetics for ${player.name}.`);
        }

        setStatus(`Assembling textures for ${player.name}...`, 'loading');
        const filename = await buildFromSkinsAndExport(activeSkins, player.name);
        setStatus(`Downloaded: ${filename}`, 'success');
      } catch (err) {
        setStatus(`Error: ${err.message}`, 'error');
      }
    });

    // download ALL players on the server
    document.getElementById('v3d-btn-dl-all').addEventListener('click', async () => {
      try {
        const { profileStore, gameWorld } = getStores();
        const players = getServerPlayers(profileStore, gameWorld);
        if (players.length === 0) throw new Error("There are no other players on the server.");

        setStatus(`Downloading ${players.length} players...`, 'loading');
        for (let i = 0; i < players.length; i++) {
          const p = players[i];
          setStatus(`[${i + 1}/${players.length}] Downloading ${p.name}...`, 'loading');

          let activeSkins = p.activeSkins;
          if (!activeSkins || activeSkins.length === 0) {
            if (profileStore) {
              profileStore.profile = null;
              if (p.id !== undefined && p.id !== null) {
                profileStore.getProfile(p.id);
              } else {
                profileStore.getProfileByName(p.name);
              }
              const start = Date.now();
              while (!profileStore.profile && (Date.now() - start < 3000)) {
                await new Promise(r => setTimeout(r, 150));
              }
              if (profileStore.profile) activeSkins = profileStore.profile.activeSkins;
            }
          }

          if (activeSkins && activeSkins.length > 0) {
            await buildFromSkinsAndExport(activeSkins, p.name);
          } else if (p.builder?.model) {
            await loadModules();
            await exportModelToGLB(p.builder.model, p.name);
          }
        }
        setStatus(`All ${players.length} players downloaded.`, 'success');
      } catch (err) {
        setStatus(`Error: ${err.message}`, 'error');
      }
    });

    // remote search by nickname or ID
    async function handleSearch() {
      const input = document.getElementById('v3d-search-input');
      const query = input.value.trim();
      if (!query) return;

      try {
        const { profileStore } = getStores();
        if (!profileStore) throw new Error("You must be in a match to search for players.");

        setStatus(`Asking the server for "${query}"...`, 'loading');
        profileStore.profile = null;

        if (/^\d+$/.test(query)) {
          profileStore.getProfile(query);
        } else {
          profileStore.getProfileByName(query);
        }

        const start = Date.now();
        while (!profileStore.profile && (Date.now() - start < 4500)) {
          await new Promise(r => setTimeout(r, 200));
        }

        if (!profileStore.profile) {
          throw new Error(`The server did not respond with data for "${query}".`);
        }

        const res = profileStore.profile;
        const name = res.name || res.username || query;
        setStatus(`Assembling model for ${name}...`, 'loading');
        const filename = await buildFromSkinsAndExport(res.activeSkins, name);
        setStatus(`Downloaded: ${filename}`, 'success');
      } catch (err) {
        setStatus(`Error: ${err.message}`, 'error');
      }
    }

    document.getElementById('v3d-btn-search').addEventListener('click', handleSearch);
    document.getElementById('v3d-search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSearch();
    });
  }

  // -------------------------------------------------------
  // PLAYER DROPDOWN UPDATE
  // -------------------------------------------------------------
  function updatePlayersDropdown(force = false) {
    const select = document.getElementById('v3d-player-select');
    const matchTitle = document.getElementById('v3d-match-title');
    if (!select) return;

    if (!force && document.activeElement === select) return;

    const { profileStore, gameWorld } = getStores();
    const players = getServerPlayers(profileStore, gameWorld);

    if (matchTitle) matchTitle.textContent = `Players on server (${players.length})`;

    const currentNames = [...select.options].slice(1).map(o => o.value).join('|');
    const newNames = players.map(p => p.name).join('|');

    if (force || currentNames !== newNames) {
      const activeValue = selectedPlayerName || select.value;

      select.innerHTML = '<option value="">Select a player...</option>';
      players.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        if (p.name === activeValue) opt.selected = true;
        select.appendChild(opt);
      });

      if (players.some(p => p.name === activeValue)) {
        select.value = activeValue;
      }
    }
  }

  // -------------------------------------------------------------
  // LIVE DETECTOR
  // ----------------------------------------------------------------
  function startLiveDetector() {
    setInterval(() => {
      try {
        createUI();
        const { gameWorld, profileStore } = getStores();

        // live detection of the profile open on screen (U menu -> search)
        const detectedCard = document.getElementById('v3d-detected-card');
        const detectedName = document.getElementById('v3d-detected-name');

        if (profileStore && profileStore.profile) {
          const pName = profileStore.profile.name || profileStore.profile.username || 'Unknown';
          if (detectedName) detectedName.textContent = pName;
          if (detectedCard && detectedCard.style.display !== 'flex') {
            detectedCard.style.display = 'flex';
          }
        } else {
          if (detectedCard && detectedCard.style.display !== 'none') {
            detectedCard.style.display = 'none';
          }
        }

        // match detection and player sync
        const sectionMatch = document.getElementById('v3d-section-match');
        if (gameWorld || (profileStore?.players && profileStore.players.length > 0)) {
          if (sectionMatch && sectionMatch.style.display !== 'flex') {
            sectionMatch.style.display = 'flex';
          }
          updatePlayersDropdown(false);

          // one time safe request 3.5 seconds after joining to prevent packet rate limit (4110)
          if (gameWorld && !initialPlayerListRequested) {
            initialPlayerListRequested = true;
            setTimeout(() => {
              const { profileStore: pStore } = getStores();
              if (pStore && (!pStore.players || pStore.players.length === 0)) {
                if (typeof pStore.getPlayerList === 'function') {
                  pStore.getPlayerList();
                }
              }
            }, 3500);
          }
        } else {
          initialPlayerListRequested = false;
          if (sectionMatch && sectionMatch.style.display !== 'none') {
            sectionMatch.style.display = 'none';
          }
        }
      } catch (err) {}
    }, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startLiveDetector);
  } else {
    startLiveDetector();
  }

})();