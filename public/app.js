import { renderMimi, renderScene, sceneInfo, mimiCardSvg, paintStrokesMarkup, mimiSilhouetteMarkup } from './scenes.js';
import { TUNING } from './game-config.js';

const app = document.querySelector('#app');
const toastNode = document.querySelector('#toast');
const STORAGE_KEY = 'mimic-party-session-v1';
const SIZE_STEPS = TUNING.mimiSizes.map((item) => item.scale);
const AVATAR_COLORS = ['', 'coral', 'lime', 'blue'];
const VIEWBOX = { width: 1200, height: 760 };
const SCENE_GALLERY = ['greenhouse', 'workshop', 'arcade', 'forest', 'field', 'retropc'];
const ERASER_ICON = '<svg class="eraser-icon" viewBox="0 0 20 20" aria-hidden="true"><g transform="rotate(-45 10 10)"><rect x="4" y="5" width="12" height="8" rx="1.5" fill="#efb4a5" stroke="currentColor" stroke-width="1.2"/><path d="M10 5v8" stroke="#fffaf6" stroke-width="1.4"/></g></svg>';

let session = readSession();
let state = null;
let screen = null;
let phaseKey = '';
let lobbyKey = '';
let boardView = { zoom: 1, tx: 0, ty: 0 };
let editTool = 'move';
let paintColor = TUNING.defaultPaintColor;
let brushWidth = TUNING.paintBrushSizes[2];
let eraserActive = false;
let paintSummaryJob = 0;
let localTarget = null;
let gesture = null;
let pointers = new Map();
let pinch = null;
let pollTimer = null;
let pollBusy = false;
let clockOffset = 0;
let toastTimer = null;
let hideMoveTimer = null;
let feedback = null;
let pendingState = null;
let scoresCollapsed = false;
let sceneColorPixels = null;
let sceneColorPixelsFor = '';
let sceneSamplerActive = false;
let hidePromptDismissed = false;
let brushCursorClient = null;
let hideNoticeTriggered = false;
let hideNoticeTimer = null;
let shownHiderChangeNoticeId = '';
let shownSinglePlayerNoticeId = '';
let dismissedResultsKey = '';
const showPreview = false;

function readSession() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); }
  catch { return null; }
}

function saveSession(next) {
  session = next;
  if (next) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  else sessionStorage.removeItem(STORAGE_KEY);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
}

function toast(message, isError = false) {
  toastNode.textContent = message;
  toastNode.classList.toggle('error', isError);
  toastNode.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove('show'), 2600);
}

function setPaintColor(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color || '')) return;
  paintColor = color;
  eraserActive = false;
  syncEraserButton();
  const picker = app.querySelector('[data-paint-picker]');
  if (picker) picker.value = color;
  if (state?.self.isHider && state.status === 'hiding') setEditTool('paint');
}

async function buildSceneColorPixels() {
  const art = app.querySelector('#sceneArt');
  if (!art || !state?.sceneId) throw new Error('The scene is not ready yet.');
  if (sceneColorPixels && sceneColorPixelsFor === state.sceneId) return sceneColorPixels;
  const canvas = document.createElement('canvas');
  canvas.width = VIEWBOX.width;
  canvas.height = VIEWBOX.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not prepare the scene color picker.');
  const imageNode = art.querySelector('image[href], image[xlink\\:href]');
  if (imageNode) {
    const source = imageNode.getAttribute('href') || imageNode.getAttribute('xlink:href');
    if (!source) throw new Error('Could not prepare the scene color picker.');
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Could not load the scene image for color picking.'));
      image.src = source;
    });
    const imageRatio = image.naturalWidth / image.naturalHeight;
    const sceneRatio = VIEWBOX.width / VIEWBOX.height;
    const drawWidth = imageRatio > sceneRatio ? VIEWBOX.height * imageRatio : VIEWBOX.width;
    const drawHeight = imageRatio > sceneRatio ? VIEWBOX.height : VIEWBOX.width / imageRatio;
    context.drawImage(image, (VIEWBOX.width - drawWidth) / 2, (VIEWBOX.height - drawHeight) / 2, drawWidth, drawHeight);
    sceneColorPixels = canvas;
    sceneColorPixelsFor = state.sceneId;
    return canvas;
  }
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEWBOX.width}" height="${VIEWBOX.height}" viewBox="0 0 ${VIEWBOX.width} ${VIEWBOX.height}">${art.innerHTML}</svg>`;
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Could not prepare the scene color picker.'));
      image.src = url;
    });
    context.drawImage(image, 0, 0, VIEWBOX.width, VIEWBOX.height);
    sceneColorPixels = canvas;
    sceneColorPixelsFor = state.sceneId;
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function beginSceneColorPick() {
  if (sceneSamplerActive) {
    cancelSceneColorPick();
    return;
  }
  try {
    await buildSceneColorPixels();
    sceneSamplerActive = true;
    eraserActive = false;
    syncEraserButton();
    setEditTool('paint');
    const button = app.querySelector('[data-action="sample-color"]');
    if (button) {
      button.querySelector('[data-picker-label]')?.replaceChildren(document.createTextNode('Cancel pick'));
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
    }
    app.querySelector('#scene-frame')?.classList.add('sampling-color');
    const hint = app.querySelector('.tool-hint');
    if (hint) hint.textContent = 'Drag over a scene color and release to select it · Esc cancels';
    const mobileHint = app.querySelector('#mobile-instructions');
    if (mobileHint) mobileHint.innerHTML = '<span>Drag over a color</span><span>·</span><span>Release to select</span>';
    toast('Drag over the scene and release to choose a color.');
  } catch (error) {
    toast(error.message || 'Could not open the scene color picker.', true);
  }
}

function cancelSceneColorPick() {
  sceneSamplerActive = false;
  if (gesture?.kind === 'sample') gesture = null;
  pointers.clear();
  app.querySelector('#scene-frame')?.classList.remove('sampling-color');
  const loupe = app.querySelector('#scene-color-loupe');
  if (loupe) loupe.hidden = true;
  const button = app.querySelector('[data-action="sample-color"]');
  if (button) {
    button.querySelector('[data-picker-label]')?.replaceChildren(document.createTextNode('Pick from scene'));
    button.classList.remove('active');
    button.setAttribute('aria-pressed', 'false');
  }
  if (state?.self.isHider && state.status === 'hiding') setEditTool(editTool);
}

function sceneSampleAt(clientX, clientY) {
  if (!sceneColorPixels) return null;
  const point = scenePoint(clientX, clientY);
  const x = Math.max(0, Math.min(VIEWBOX.width - 1, Math.floor(point.x)));
  const y = Math.max(0, Math.min(VIEWBOX.height - 1, Math.floor(point.y)));
  const [r, g, b] = sceneColorPixels.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
  const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  return { point, hex };
}

function updateSceneColorLoupe(clientX, clientY) {
  const loupe = app.querySelector('#scene-color-loupe');
  const canvas = app.querySelector('#scene-color-loupe-canvas');
  const context = canvas?.getContext('2d');
  const frame = app.querySelector('#scene-frame');
  if (!loupe || !canvas || !context || !frame) return;
  const sample = sceneSampleAt(clientX, clientY);
  if (!sample) return;
  const cropSize = 64;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(sceneColorPixels,
    Math.max(0, Math.min(VIEWBOX.width - cropSize, sample.point.x - cropSize / 2)),
    Math.max(0, Math.min(VIEWBOX.height - cropSize, sample.point.y - cropSize / 2)),
    cropSize, cropSize, 0, 0, canvas.width, canvas.height);
  const rect = frame.getBoundingClientRect();
  const width = loupe.offsetWidth || 72;
  const height = (loupe.offsetHeight || 72) + 18;
  const left = Math.max(8, Math.min(rect.width - frame.clientLeft - width - 8, clientX - rect.left - frame.clientLeft + 10));
  const top = Math.max(8, Math.min(rect.height - frame.clientTop - height - 8, clientY - rect.top - frame.clientTop + 10));
  loupe.style.left = `${left}px`;
  loupe.style.top = `${top}px`;
  loupe.querySelector('[data-sample-hex]')?.replaceChildren(document.createTextNode(sample.hex));
  loupe.hidden = false;
}

function finishSceneColorPick(clientX, clientY) {
  const sample = sceneSampleAt(clientX, clientY);
  cancelSceneColorPick();
  if (!sample) return;
  setPaintColor(sample.hex);
  toast(`Scene color ${sample.hex} selected.`);
}

const GAME_FUNCTION_URL = '/.netlify/functions/game';

async function requestGame(body = null, query = null) {
  const url = new URL(GAME_FUNCTION_URL, location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  }
  const response = await fetch(`${url.pathname}${url.search}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'The game could not complete that action.');
    error.status = response.status;
    throw error;
  }
  return data;
}

async function action(type, details = {}) {
  if (!session) throw new Error('Your room connection has ended.');
  return requestGame({ code: session.code, playerId: session.playerId, type, ...details });
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  pollBusy = false;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, 650);
  poll();
}

async function poll() {
  if (!session || pollBusy) return;
  pollBusy = true;
  try {
    const next = await requestGame(null, { room: session.code, playerId: session.playerId });
    applyState(next);
  } catch (error) {
    if (error.status === 404 || error.status === 403) {
      stopPolling();
      saveSession(null);
      state = null;
      history.replaceState({}, '', location.pathname);
      mountHome();
      toast(error.status === 403 ? 'You were removed from that room by the host.' : 'That room is no longer available. Make a new one to play.', true);
    }
  } finally {
    pollBusy = false;
  }
}

function screenFor(next) {
  if (!next) return 'home';
  if (next.status === 'lobby') return 'lobby';
  if (next.status === 'finished') return 'finished';
  return 'game';
}

function applyState(next) {
  const joiningAfterRematch = next.status === 'lobby' && (state?.status === 'finished' || session?.rematchOptIn);
  if (joiningAfterRematch) {
    next = { ...next, players: next.players.map((player) => ({ ...player, ready: false })) };
    if (session) saveSession({ ...session, rematchOptIn: false });
  }
  clockOffset = Number(next.now) - Date.now();
  const nextScreen = screenFor(next);
  const nextPhaseKey = `${next.status}:${next.roundNumber}:${next.sceneId}:${next.self?.isHider}:${next.self?.found}`;
  const needsMount = nextScreen !== screen || (nextScreen === 'game' && nextPhaseKey !== phaseKey);
  state = next;
  if (next.singlePlayerNotice?.id && next.singlePlayerNotice.id !== shownSinglePlayerNoticeId) {
    shownSinglePlayerNoticeId = next.singlePlayerNotice.id;
    toast('Everyone left the room. You have been returned to the lobby.');
  }
  if (needsMount) {
    screen = nextScreen;
    phaseKey = nextPhaseKey;
    if (nextScreen === 'lobby') mountLobby();
    else if (nextScreen === 'game') mountGame();
    else if (nextScreen === 'finished') mountFinished();
    else mountHome();
    showHiderChangeNotice(next);
    if (joiningAfterRematch) action('ready', { value: false }).then(applyState).catch((error) => toast(error.message, true));
    return;
  }
  if (nextScreen === 'lobby') updateLobby();
  if (nextScreen === 'game') updateGame();
  if (nextScreen === 'finished') updateFinished();
  showHiderChangeNotice(next);
  if (joiningAfterRematch) action('ready', { value: false }).then(applyState).catch((error) => toast(error.message, true));
}

function appHeader(caption = 'A tiny game of hide & seek', captionLink = false) {
  const captionMarkup = captionLink
    ? `<a class="topbar-caption topbar-link" href="#how-to-play">${esc(caption)}</a>`
    : `<div class="topbar-caption"><span class="online-dot"></span>${esc(caption)}</div>`;
  return `<header class="topbar">
    <a href="#" class="brand" data-action="brand-home" aria-label="MIMIC home">
      <span class="brand-mark">m</span><span class="brand-name">MIMIC</span>
    </a>
    ${captionMarkup}
  </header>`;
}

function heroMimi() {
  return `<svg class="hero-mech" viewBox="-30 -48 60 82" aria-hidden="true">${renderMimi({ x: 0, y: 0, size: 1.3, outlineOpacity: .75 })}</svg>`;
}

function mountHome(prefill = '') {
  screen = 'home';
  phaseKey = '';
  localTarget = null;
  
  app.innerHTML = `<div class="app-shell">
    ${appHeader('How to play', true)}
    <section class="home-page">
      <div class="home-copy">
        <p class="eyebrow">A party game for sharp eyes</p>
        <h1 class="home-title">Hide in<br/><em>plain sight.</em></h1>
        <p class="home-subtitle">One tiny mech. Many curious scenes. Give Mimi a clever hiding spot, then see who can spot her first.</p>
        <div class="hero-scene" aria-hidden="true">
          <span class="hero-sun"></span><span class="hero-land"></span>
          <i class="hero-stem"></i><i class="hero-leaf l1"></i><i class="hero-leaf l2"></i><i class="hero-leaf l3"></i>
          <i class="hero-stem two"></i><i class="hero-leaf l4"></i><i class="hero-leaf l5"></i><i class="hero-leaf l6"></i>
          ${heroMimi()}<span class="hero-chip"><i class="hero-chip-dot"></i>Where's Mimi?</span>
        </div>
      </div>
      <div class="entry-card">
        <p class="card-kicker">Mimi wants to hide.</p>
        <h2 class="card-title">Find your hideout</h2>
        <p class="card-copy">Play now to join an open room, or create a private room for friends.</p>
        <label class="field-label" for="player-name">Your name</label>
        <input class="text-field" id="player-name" maxlength="18" autocomplete="nickname" placeholder="e.g. Moss" required />
        <div class="entry-create-actions">
          <form id="public-form"><button class="secondary-btn full" type="submit">Play now <span aria-hidden="true">◉</span></button></form>
          <form id="create-form"><button class="primary-btn full" type="submit">Create a room <span aria-hidden="true">↗</span></button></form>
        </div>
        <div class="join-divider">or join a friend</div>
        <form id="join-form">
          <label class="field-label" for="join-code">Room code</label>
          <div class="join-row">
            <input class="text-field code-field" id="join-code" name="code" maxlength="5" autocomplete="off" placeholder="ABCDE" value="${esc(prefill.toUpperCase())}" required />
            <button class="secondary-btn" type="submit">Join room</button>
          </div>
        </form>
      </div>
    </section>
    <section id="how-to-play" class="home-info-section how-to-section" aria-labelledby="how-to-title">
      <div class="home-section-heading"><div><p class="eyebrow">A simple game of hide and seek</p><h2 id="how-to-title">How to play</h2></div><p>Take turns hiding Mimi in a busy scene, then search carefully before the clock runs out.</p></div>
      <div class="how-steps">
        <article class="how-step"><span class="step-number">01</span><div class="step-icon hide-icon" aria-hidden="true">◉</div><h3>Hide Mimi</h3><p>Move her into the scene, choose a size, and paint her to blend in.</p></article>
        <article class="how-step"><span class="step-number">02</span><div class="step-icon seek-icon" aria-hidden="true">⌕</div><h3>Search together</h3><p>Pan and zoom around. Tap a spot when you think you’ve found her.</p></article>
        <article class="how-step"><span class="step-number">03</span><div class="step-icon swap-icon" aria-hidden="true">↻</div><h3>Swap turns</h3><p>Finders score for speed. A harder hide can earn the hider more points.</p></article>
      </div>
    </section>
    <section class="home-demo-section" aria-labelledby="demo-title">
      <div class="demo-copy"><p class="eyebrow">Try the hider’s view</p><h2 id="demo-title">Tuck Mimi into the scene.</h2><p>Practice with the same move and paint controls you’ll use in a round. Drag Mimi to move her. Switch to Paint to draw.</p></div>
      <div class="demo-card" id="home-demo">
        <div class="demo-card-heading"><div><span class="demo-kicker">HIDER PRACTICE</span><strong>The Greenhouse</strong></div><span class="demo-live"><i></i>Try it</span></div>
        <div class="demo-scene-wrap">
          <svg class="demo-scene-svg" id="home-demo-svg" viewBox="0 0 1200 760" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Interactive greenhouse scene with Mimi to move and paint">
            <g id="home-demo-view"><g id="home-demo-art">${renderScene('greenhouse')}</g>${renderMimi({ x: 610, y: 560, size: 1, interactive: true, layerId: 'home-demo-target' })}</g>
          </svg>
          <div class="mimi-shhh mimi-anchor-bubble demo-mimi-bubble" id="home-demo-prompt">Move and paint me</div>
          <div class="demo-brush-cursor" id="home-demo-brush-cursor" hidden aria-hidden="true"></div>
          <div class="scene-color-loupe demo-scene-color-loupe" id="home-demo-color-loupe" hidden aria-hidden="true"><canvas id="home-demo-color-loupe-canvas" width="144" height="144"></canvas><i class="loupe-crosshair"></i><span data-demo-sample-hex>#000000</span></div>
        </div>
        <div class="scene-controls-row demo-scene-controls-row"><div class="zoom-controls demo-zoom-controls" role="group" aria-label="Practice scene zoom"><button class="icon-btn" type="button" data-demo-zoom="out" aria-label="Zoom out">−</button><span class="zoom-level" id="home-demo-zoom">1.0×</span><button class="icon-btn" type="button" data-demo-zoom="in" aria-label="Zoom in">+</button><button class="icon-btn" type="button" data-demo-zoom="reset" aria-label="Reset scene view" style="font-size:12px">⌂</button></div></div>
        <div class="demo-controls">
          <div class="demo-control-row"><div class="demo-tool-switch" role="group" aria-label="Practice tools"><button type="button" class="demo-tool active" data-demo-tool="move" aria-pressed="true">↗ Move</button><button type="button" class="demo-tool" data-demo-tool="paint" aria-pressed="false">✎ Paint</button></div>
            <div class="demo-size-control"><span>Mimi size</span><div class="demo-size-steps" role="group" aria-label="Practice Mimi size"><button type="button" data-demo-size="0.9">S</button><button type="button" class="active" data-demo-size="1">M</button><button type="button" data-demo-size="1.15">L</button></div></div>
          </div>
          <div class="demo-control-row demo-paint-row">
            <label class="demo-color-label">Paint color <input id="home-demo-color" type="color" value="#7f956f" aria-label="Practice paint color"></label>
            <button class="demo-sample" type="button" data-demo-action="sample" aria-pressed="false"><span aria-hidden="true">⌕</span><span data-demo-picker-label>Pick from scene</span></button>
            <div class="demo-brushes" role="group" aria-label="Practice brush size"><button type="button" data-demo-brush="4" aria-label="Extra small brush">XS</button><button type="button" data-demo-brush="8" aria-label="Small brush">S</button><button class="active" type="button" data-demo-brush="18" aria-label="Medium brush">M</button><button type="button" data-demo-brush="32" aria-label="Large brush">L</button></div>
            <button class="demo-action demo-eraser" type="button" data-demo-action="eraser" aria-pressed="false">${ERASER_ICON}Eraser</button>
            <button class="demo-action" type="button" data-demo-action="undo" disabled>Undo</button><button class="demo-action" type="button" data-demo-action="clear" disabled>Clear</button>
            <button class="demo-reset" type="button" data-demo-action="reset">Reset</button>
          </div>
        </div>
        <p class="demo-status" id="home-demo-status" aria-live="polite">Drag Mimi by her body, or choose Paint and draw on her.</p>
      </div>
    </section>
    ${showPreview ?  
      `<section aria-labelledby="scene-gallery-title">
        <h2 id="scene-gallery-title">Scene gallery</h2>
        <p>Temporary preview of every scene.</p>
        ${SCENE_GALLERY.map((sceneId) => {
      const scene = sceneInfo(sceneId);
      return `<article>
            <h3>${esc(scene.title)}</h3>
            ${scene.attribution ? `<p>${esc(scene.attribution)}</p>` : ''}
            <svg width="600" viewBox="0 0 1200 760" role="img" aria-label="${esc(scene.title)}">${renderScene(sceneId)}</svg>
          </article>`;
    }).join('')}
      </section>`
    : ''}
    <footer class="home-footer"><span class="brand-mark">m</span><span>Made for Handshake's "Create a Multiplayer Game" challenge.</span></footer>
  </div>`;
  const nameField = app.querySelector('#player-name');
  if (prefill && nameField) nameField.focus({ preventScroll: true });
  app.querySelector('#player-name')?.addEventListener('input', (event) => event.target.setCustomValidity(''));
  initHomeDemo();
}

function initHomeDemo() {
  const svg = app.querySelector('#home-demo-svg');
  const layer = app.querySelector('#home-demo-target');
  const view = app.querySelector('#home-demo-view');
  const art = app.querySelector('#home-demo-art');
  const frame = app.querySelector('.demo-scene-wrap');
  if (!svg || !layer || !view || !art || !frame) return;

  const startTarget = { x: 610, y: 560, size: 1, paint: [] };
  const target = { ...startTarget, paint: [] };
  const camera = { zoom: 1, tx: 0, ty: 0 };
  let mode = 'move';
  let eraserActive = false;
  let color = app.querySelector('#home-demo-color')?.value || '#7f956f';
  let width = 18;
  let gesture = null;
  let samplerActive = false;
  let samplerCanvas = null;
  let promptDismissed = false;
  let pinch = null;
  const pointers = new Map();
  const status = app.querySelector('#home-demo-status');
  const bubble = app.querySelector('#home-demo-prompt');
  const cursor = app.querySelector('#home-demo-brush-cursor');
  const loupe = app.querySelector('#home-demo-color-loupe');
  const loupeCanvas = app.querySelector('#home-demo-color-loupe-canvas');
  const zoomLabel = app.querySelector('#home-demo-zoom');
  const undoButton = app.querySelector('[data-demo-action="undo"]');
  const clearButton = app.querySelector('[data-demo-action="clear"]');
  const updateEraserButton = () => {
    const button = app.querySelector('[data-demo-action="eraser"]');
    button?.classList.toggle('active', eraserActive);
    button?.setAttribute('aria-pressed', String(eraserActive));
  };

  const updateButtons = () => {
    if (undoButton) undoButton.disabled = target.paint.length === 0;
    if (clearButton) clearButton.disabled = target.paint.length === 0;
    app.querySelectorAll('[data-demo-size]').forEach((button) => {
      button.classList.toggle('active', Number(button.dataset.demoSize) === target.size);
    });
  };
  const pointFromEvent = (event) => {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(svg.getScreenCTM().inverse());
  };
  const scenePoint = (base) => ({ x: (base.x - camera.tx) / camera.zoom, y: (base.y - camera.ty) / camera.zoom });
  const localPoint = (point) => ({ x: (point.x - target.x) / target.size, y: (point.y - target.y) / target.size });
  const paintHit = (point) => point.x >= -30 && point.x <= 30 && point.y >= -47 && point.y <= 32;
  const applyCamera = () => {
    camera.tx = Math.min(0, Math.max(VIEWBOX.width * (1 - camera.zoom), camera.tx));
    camera.ty = Math.min(0, Math.max(VIEWBOX.height * (1 - camera.zoom), camera.ty));
    view.setAttribute('transform', `translate(${camera.tx} ${camera.ty}) scale(${camera.zoom})`);
    if (zoomLabel) zoomLabel.textContent = `${camera.zoom.toFixed(1)}×`;
    positionPrompt();
  };
  const zoomAt = (factor, clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    const base = pointFromEvent({ clientX: clientX ?? rect.left + rect.width / 2, clientY: clientY ?? rect.top + rect.height / 2 });
    const anchorX = (base.x - camera.tx) / camera.zoom;
    const anchorY = (base.y - camera.ty) / camera.zoom;
    camera.zoom = Math.max(TUNING.minZoom, Math.min(TUNING.maxZoom, camera.zoom * factor));
    camera.tx = base.x - anchorX * camera.zoom;
    camera.ty = base.y - anchorY * camera.zoom;
    applyCamera();
  };
  function positionPrompt() {
    if (!bubble || promptDismissed) return;
    const matrix = view.getScreenCTM();
    if (!matrix) return;
    const anchor = svg.createSVGPoint();
    anchor.x = target.x + 8 * target.size;
    anchor.y = target.y - 38 * target.size;
    const screen = anchor.matrixTransform(matrix);
    const bounds = frame.getBoundingClientRect();
    bubble.style.left = `${screen.x - bounds.left - frame.clientLeft + 7}px`;
    bubble.style.top = `${screen.y - bounds.top - frame.clientTop - 3}px`;
    bubble.hidden = false;
  }
  const updateTarget = () => {
    layer.setAttribute('transform', `translate(${target.x} ${target.y}) scale(${target.size})`);
    const paint = layer.querySelector('.mimi-paint');
    if (paint) paint.innerHTML = paintStrokesMarkup(target.paint);
    updateButtons();
    positionPrompt();
  };
  const setMode = (next) => {
    mode = next === 'paint' ? 'paint' : 'move';
    if (mode === 'move') eraserActive = false;
    updateEraserButton();
    svg.classList.toggle('demo-paint-mode', mode === 'paint');
    app.querySelectorAll('[data-demo-tool]').forEach((button) => {
      const active = button.dataset.demoTool === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (cursor) cursor.hidden = true;
    if (status && !samplerActive) status.textContent = mode === 'paint'
      ? 'Draw on Mimi to camouflage her. Pick a color or sample one from the scene.'
      : 'Drag Mimi to move her; drag the scene to pan. Zoom in for precise placement.';
  };
  const setSampler = (active) => {
    samplerActive = active;
    const button = app.querySelector('[data-demo-action="sample"]');
    button?.classList.toggle('active', active);
    button?.setAttribute('aria-pressed', String(active));
    button?.querySelector('[data-demo-picker-label]')?.replaceChildren(document.createTextNode(active ? 'Cancel pick' : 'Pick from scene'));
    frame.classList.toggle('demo-sampling', active);
    if (!active) {
      if (gesture?.type === 'sample') gesture = null;
      if (loupe) loupe.hidden = true;
    }
    if (active) {
      eraserActive = false;
      updateEraserButton();
      setMode('paint');
    }
  };
  const updateBrushCursor = (event) => {
    if (!cursor || event.pointerType !== 'mouse' || mode !== 'paint' || samplerActive) {
      if (cursor) cursor.hidden = true;
      return;
    }
    const svgBounds = svg.getBoundingClientRect();
    if (event.clientX < svgBounds.left || event.clientX > svgBounds.right || event.clientY < svgBounds.top || event.clientY > svgBounds.bottom) {
      cursor.hidden = true;
      return;
    }
    if (!paintHit(localPoint(scenePoint(pointFromEvent(event))))) {
      cursor.hidden = true;
      return;
    }
    const bounds = frame.getBoundingClientRect();
    const diameter = Math.max(7, Math.min(110, width * target.size * camera.zoom * svgBounds.width / VIEWBOX.width));
    cursor.style.width = `${diameter}px`;
    cursor.style.height = `${diameter}px`;
    cursor.style.left = `${event.clientX - bounds.left - frame.clientLeft}px`;
    cursor.style.top = `${event.clientY - bounds.top - frame.clientTop}px`;
    cursor.hidden = false;
  };
  const sampleAt = (point) => {
    if (!samplerCanvas) return null;
    const x = Math.max(0, Math.min(VIEWBOX.width - 1, Math.floor(point.x)));
    const y = Math.max(0, Math.min(VIEWBOX.height - 1, Math.floor(point.y)));
    const [r, g, b] = samplerCanvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
    return { point: { x, y }, hex: `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}` };
  };
  const updateDemoLoupe = (clientX, clientY) => {
    const context = loupeCanvas?.getContext('2d');
    if (!loupe || !loupeCanvas || !context || !samplerCanvas) return;
    const sample = sampleAt(scenePoint(pointFromEvent({ clientX, clientY })));
    if (!sample) return;
    const cropSize = 64;
    context.clearRect(0, 0, loupeCanvas.width, loupeCanvas.height);
    context.drawImage(samplerCanvas,
      Math.max(0, Math.min(VIEWBOX.width - cropSize, sample.point.x - cropSize / 2)),
      Math.max(0, Math.min(VIEWBOX.height - cropSize, sample.point.y - cropSize / 2)),
      cropSize, cropSize, 0, 0, loupeCanvas.width, loupeCanvas.height);
    const rect = frame.getBoundingClientRect();
    const width = loupe.offsetWidth || 72;
    const height = (loupe.offsetHeight || 72) + 18;
    const left = Math.max(8, Math.min(rect.width - frame.clientLeft - width - 8, clientX - rect.left - frame.clientLeft + 10));
    const top = Math.max(8, Math.min(rect.height - frame.clientTop - height - 8, clientY - rect.top - frame.clientTop + 10));
    loupe.style.left = `${left}px`;
    loupe.style.top = `${top}px`;
    loupe.querySelector('[data-demo-sample-hex]')?.replaceChildren(document.createTextNode(sample.hex));
    loupe.hidden = false;
  };
  const finishDemoColorPick = (basePoint) => {
    const sample = sampleAt(scenePoint(basePoint));
    setSampler(false);
    if (!sample) return;
    color = sample.hex;
    const picker = app.querySelector('#home-demo-color');
    if (picker) picker.value = color;
    setMode('paint');
    if (status) status.textContent = `Picked ${color} from the scene. Draw on Mimi to blend her in.`;
  };
  const toggleSampler = async () => {
    if (samplerActive) {
      setSampler(false);
      if (status) status.textContent = mode === 'paint'
        ? 'Color pick cancelled. Choose a color or keep painting.'
        : 'Color pick cancelled. Drag Mimi to move her; drag the scene to pan.';
      return;
    }
    try {
      if (!samplerCanvas) {
        const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEWBOX.width}" height="${VIEWBOX.height}" viewBox="0 0 ${VIEWBOX.width} ${VIEWBOX.height}">${art.innerHTML}</svg>`;
        const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
        try {
          const image = new Image();
          await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('Could not prepare the scene color picker.'));
            image.src = url;
          });
          samplerCanvas = document.createElement('canvas');
          samplerCanvas.width = VIEWBOX.width;
          samplerCanvas.height = VIEWBOX.height;
          samplerCanvas.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0, VIEWBOX.width, VIEWBOX.height);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      setSampler(true);
      if (status) status.textContent = 'Drag over the scene and release to pick its color.';
    } catch (error) {
      if (status) status.textContent = error.message || 'The scene color picker could not open.';
    }
  };

  svg.addEventListener('pointerdown', (event) => {
    const base = pointFromEvent(event);
    pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY, base });
    if (samplerActive) {
      if (gesture?.type === 'sample') {
        pointers.delete(event.pointerId);
        event.preventDefault();
        return;
      }
      svg.setPointerCapture(event.pointerId);
      gesture = { pointerId: event.pointerId, type: 'sample' };
      updateDemoLoupe(event.clientX, event.clientY);
      event.preventDefault();
      return;
    }
    if (pointers.size === 2) {
      gesture = null;
      const points = [...pointers.values()];
      pinch = {
        distance: Math.hypot(points[1].clientX - points[0].clientX, points[1].clientY - points[0].clientY),
        center: { x: (points[0].clientX + points[1].clientX) / 2, y: (points[0].clientY + points[1].clientY) / 2 },
      };
      svg.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const point = scenePoint(base);
    svg.setPointerCapture(event.pointerId);
    if (event.target.closest('[data-target-hit]')) {
      promptDismissed = true;
      if (bubble) bubble.hidden = true;
      if (mode === 'move') {
        gesture = { pointerId: event.pointerId, type: 'move', offsetX: target.x - point.x, offsetY: target.y - point.y };
        svg.classList.add('demo-moving');
      } else {
        const first = localPoint(point);
        if (paintHit(first)) {
          const stroke = { color, width, erase: eraserActive, points: [first] };
          target.paint.push(stroke);
          gesture = { pointerId: event.pointerId, type: 'paint', stroke };
          updateTarget();
        }
      }
    } else {
      gesture = { pointerId: event.pointerId, type: 'pan', last: base };
    }
    event.preventDefault();
  });
  svg.addEventListener('pointermove', (event) => {
    const base = pointFromEvent(event);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY, base });
    updateBrushCursor(event);
    if (samplerActive) {
      const bounds = svg.getBoundingClientRect();
      const inside = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      if (inside && (event.pointerType === 'mouse' || gesture?.type === 'sample' && gesture.pointerId === event.pointerId)) updateDemoLoupe(event.clientX, event.clientY);
      else if (gesture?.type !== 'sample' && loupe) loupe.hidden = true;
      event.preventDefault();
      return;
    }
    if (pinch && pointers.size >= 2) {
      const points = [...pointers.values()];
      const distance = Math.hypot(points[1].clientX - points[0].clientX, points[1].clientY - points[0].clientY);
      const center = { x: (points[0].clientX + points[1].clientX) / 2, y: (points[0].clientY + points[1].clientY) / 2 };
      if (pinch.distance > 0) zoomAt(distance / pinch.distance, pinch.center.x, pinch.center.y);
      const bounds = svg.getBoundingClientRect();
      camera.tx += (center.x - pinch.center.x) * VIEWBOX.width / bounds.width;
      camera.ty += (center.y - pinch.center.y) * VIEWBOX.height / bounds.height;
      applyCamera();
      pinch = { distance, center };
      event.preventDefault();
      return;
    }
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = scenePoint(base);
    if (gesture.type === 'move') {
      target.x = Math.max(38, Math.min(1162, point.x + gesture.offsetX));
      target.y = Math.max(48, Math.min(710, point.y + gesture.offsetY));
      updateTarget();
    } else if (gesture.type === 'pan') {
      camera.tx += base.x - gesture.last.x;
      camera.ty += base.y - gesture.last.y;
      gesture.last = base;
      applyCamera();
    } else {
      const next = localPoint(point);
      const last = gesture.stroke.points.at(-1);
      if (paintHit(next) && Math.hypot(next.x - last.x, next.y - last.y) >= 1.7) {
        gesture.stroke.points.push(next);
        updateTarget();
      }
    }
  });
  const endGesture = (event) => {
    pointers.delete(event.pointerId);
    if (pinch && pointers.size < 2) pinch = null;
    if (gesture?.pointerId === event.pointerId) {
      if (gesture.type === 'sample' && event.type === 'pointerup') finishDemoColorPick(pointFromEvent(event));
      else if (gesture.type === 'sample' && loupe) loupe.hidden = true;
      gesture = null;
      svg.classList.remove('demo-moving');
    }
  };
  svg.addEventListener('pointerup', endGesture);
  svg.addEventListener('pointercancel', endGesture);
  svg.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse' && cursor) cursor.hidden = true; });
  svg.addEventListener('wheel', (event) => {
    zoomAt(Math.exp(-event.deltaY * TUNING.wheelSensitivity), event.clientX, event.clientY);
    event.preventDefault();
  }, { passive: false });

  app.querySelectorAll('[data-demo-tool]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.demoTool)));
  app.querySelector('#home-demo-color')?.addEventListener('input', (event) => {
    color = event.target.value;
    eraserActive = false;
    updateEraserButton();
    setSampler(false);
    setMode('paint');
  });
  app.querySelectorAll('[data-demo-size]').forEach((button) => button.addEventListener('click', () => {
    target.size = Number(button.dataset.demoSize);
    updateTarget();
  }));
  app.querySelectorAll('[data-demo-brush]').forEach((button) => button.addEventListener('click', () => {
    width = Number(button.dataset.demoBrush);
    app.querySelectorAll('[data-demo-brush]').forEach((choice) => choice.classList.toggle('active', choice === button));
    setMode('paint');
  }));
  app.querySelectorAll('[data-demo-zoom]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.demoZoom === 'in') zoomAt(TUNING.zoomInStep);
    else if (button.dataset.demoZoom === 'out') zoomAt(TUNING.zoomOutStep);
    else {
      Object.assign(camera, { zoom: 1, tx: 0, ty: 0 });
      applyCamera();
    }
  }));
  app.querySelector('[data-demo-action="sample"]')?.addEventListener('click', toggleSampler);
  app.querySelector('[data-demo-action="eraser"]')?.addEventListener('click', () => {
    eraserActive = !eraserActive;
    updateEraserButton();
    setMode('paint');
    if (status) status.textContent = eraserActive ? 'Erase paint from Mimi. Choose Eraser again to paint.' : 'Draw on Mimi to camouflage her.';
  });
  undoButton?.addEventListener('click', () => { target.paint.pop(); updateTarget(); });
  clearButton?.addEventListener('click', () => { target.paint = []; updateTarget(); });
  app.querySelector('[data-demo-action="reset"]')?.addEventListener('click', () => {
    Object.assign(target, { ...startTarget, paint: [] });
    Object.assign(camera, { zoom: 1, tx: 0, ty: 0 });
    setSampler(false);
    applyCamera();
    updateTarget();
    setMode('move');
    if (status) status.textContent = 'Drag Mimi by her body, or choose Paint and draw on her.';
  });
  window.addEventListener('resize', positionPrompt);
  applyCamera();
  setMode('move');
  updateTarget();
}

function playerRows(players, lobby = false) {
  const canKick = lobby && players.some((player) => player.isSelf && player.isHost);
  const rows = players.map((player, index) => `<div class="player-row">
    <div class="player-avatar ${AVATAR_COLORS[index % AVATAR_COLORS.length]}">${esc(initials(player.name))}</div>
    <div class="player-details"><div class="player-name">${esc(player.name)}${player.isSelf ? ' <span style="color:#a1aa9f;font-weight:500">(you)</span>' : ''}</div>
      <div class="player-label">${player.isHost ? 'Room host' : 'In the hideout'}${!lobby && player.isHider ? ' · Hiding this round' : ''}</div></div>
    ${lobby ? `<span class="ready-pill ${player.ready ? 'yes' : ''}">${player.ready ? 'Ready' : 'Getting set'}</span>${canKick && !player.isSelf ? `<button class="kick-player-btn" type="button" data-action="kick-player" data-player-id="${esc(player.id)}">Kick</button>` : ''}` : `<span class="score-total">${player.score}<span style="font-size:8px;color:#8b978c"> pts</span></span>`}
  </div>`).join('');
  const freeSlots = lobby ? Math.max(0, 8 - players.length) : 0;
  return rows + (freeSlots ? `<div class="empty-slots"><span class="empty-slot-dot"></span><span>${freeSlots} more ${freeSlots === 1 ? 'seat' : 'seats'} open</span></div>` : '');
}

function inviteUrl() {
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(state?.code || session?.code || '')}`;
}

function mountLobby() {
  screen = 'lobby';
  const self = state.players.find((player) => player.isSelf);
  const allReady = state.players.length >= 2 && state.players.every((player) => player.ready);
  const isHost = self?.isHost;
  const resultsKey = state.lastResults ? JSON.stringify(state.lastResults) : '';
  const showResults = Boolean(resultsKey && resultsKey !== dismissedResultsKey);
  app.innerHTML = `<div class="app-shell">${appHeader('Your hideout is ready')}
    <section class="lobby-page"><div class="lobby-card">
      <div class="lobby-topline"><div><p class="lobby-overline">${state.visibility === 'public' ? 'Public room' : 'Private room'} · ${state.players.length}/8 players</p><h1 class="lobby-title">Gather your seekers.</h1></div>
        <div class="room-code-box"><span class="small-label">ROOM CODE</span><strong class="room-code">${esc(state.code)}</strong></div>
      </div>
      <div class="room-invite-row"><span>${state.visibility === 'public' ? 'Anyone can join this room.' : 'Send the link or code to your friends.'}</span><div class="room-invite-actions">${state.lastResults ? '<button class="secondary-btn" type="button" data-action="view-results">View last results</button>' : ''}${isHost ? `<button class="secondary-btn" type="button" data-action="toggle-visibility">${state.visibility === 'public' ? 'Make private' : 'Make public'}</button>` : ''}<button class="secondary-btn" type="button" data-action="copy-invite">Copy invite link <span aria-hidden="true">↗</span></button></div></div>
      <div class="section-divider">Players in the room <span>${state.players.length}/8</span></div>
      <div class="player-list" id="lobby-players">${playerRows(state.players, true)}</div>
      <div class="lobby-actions"><div class="lobby-status" id="lobby-status">${lobbyStatus(state)}</div>
        <div class="lobby-actions-right" id="lobby-actions">${lobbyActions(state, isHost, allReady)}</div></div>
    </div></section>${showResults ? resultsModal(state.lastResults) : ''}</div>`;
  if (showResults) app.querySelector('[data-results-modal]')?.focus();
}

function resultsModal(results) {
  return `<div class="confirm-backdrop results-backdrop" data-results-modal tabindex="-1">
    <section class="confirm-dialog results-dialog" role="dialog" aria-modal="true" aria-labelledby="results-title">
      <p class="confirm-kicker">Good game</p>
      <h2 id="results-title">Score leaderboard.</h2>
      <p class="results-dialog-copy">Mimi is done hiding, see how everyone did.</p>
      <div class="leaderboard results-leaderboard">${leaderRows(results)}</div>
      <div class="confirm-actions"><button class="primary-btn" type="button" data-action="close-results">Back to lobby</button></div>
    </section>
  </div>`;
}

function closeResultsModal() {
  if (state?.lastResults) dismissedResultsKey = JSON.stringify(state.lastResults);
  app.querySelector('[data-results-modal]')?.remove();
}

function openResultsModal() {
  if (!state?.lastResults || app.querySelector('[data-results-modal]')) return;
  app.insertAdjacentHTML('beforeend', resultsModal(state.lastResults));
  app.querySelector('[data-results-modal]')?.focus();
}

function lobbyStatus(current) {
  if (current.players.length < 2) return '<span class="waiting-pulse"></span>Waiting for at least one friend to join…';
  const waiting = current.players.filter((player) => !player.ready).length;
  if (waiting) return `<span class="waiting-pulse"></span>Waiting on ${waiting} ${waiting === 1 ? 'player' : 'players'} to get ready…`;
  return 'Everyone is ready. The first hider is up!';
}

function lobbyActions(current, isHost, allReady) {
  const self = current.players.find((player) => player.isSelf);
  if (!self?.ready) return `<button class="primary-btn" type="button" data-action="ready">I'm ready <span aria-hidden="true">✓</span></button><button class="quiet-btn" type="button" data-action="leave-room">Leave</button>`;
  if (isHost) return `<button class="quiet-btn" type="button" data-action="not-ready">Not ready</button><button class="primary-btn" type="button" data-action="start" ${allReady ? '' : 'disabled'}>Start the game <span aria-hidden="true">→</span></button><button class="quiet-btn" type="button" data-action="leave-room">Leave</button>`;
  return `<span class="lobby-status"><span class="waiting-pulse"></span>Waiting for the host…</span><button class="quiet-btn" type="button" data-action="not-ready">Change to not ready</button><button class="quiet-btn" type="button" data-action="leave-room">Leave</button>`;
}

function lobbySnapshot(current) {
  return JSON.stringify({ code: current.code, visibility: current.visibility, players: current.players.map(({ id, name, score, ready, isHost }) => [id, name, score, ready, isHost]) });
}

function updateLobby() {
  const key = lobbySnapshot(state);
  if (key === lobbyKey) return;
  lobbyKey = key;
  mountLobby();
}

function phaseContent(current) {
  const hider = current.players.find((player) => player.id === current.hiderId);
  const hiderName = hider?.name || 'The hider';
  if (current.status === 'hiding') {
    return current.self.isHider
      ? { title: 'Find Mimi a clever place.', subtitle: 'Take a look around. You have time to get the details right.', badge: 'YOUR TURN', badgeClass: '' }
      : { title: `${hiderName} is finding a hiding spot.`, subtitle: 'Look away for a moment. The scene is still a secret.', badge: 'HIDING', badgeClass: '' };
  }
  if (current.status === 'searching') {
    if (current.self.isHider) return { title: 'The search is on.', subtitle: 'Mimi is tucked in. See how many seekers she can fool.', badge: 'HIDING', badgeClass: '' };
    if (current.self.found) return { title: 'You found Mimi!', subtitle: 'The other seekers are still looking. Keep the spot secret.', badge: 'FOUND', badgeClass: '' };
    return { title: 'Where is Mimi?', subtitle: 'Drag to pan, tap to guess.', badge: 'YOUR TURN', badgeClass: 'seeking' };
  }
  return { title: 'There she is!', subtitle: `${current.missCount ?? 0} ${current.missCount === 1 ? 'seeker missed' : 'seekers missed'} · The next hider is up soon.`, badge: 'REVEAL', badgeClass: '' };
}

function sceneTargetMarkup(current) {
  const visible = current.target && (current.self.isHider || ['searching', 'reveal', 'finished'].includes(current.status));
  if (!visible) return '';
  const isHighlighted = current.status === 'reveal' || (current.status === 'searching' && current.self.found);
  return renderMimi({
    x: current.target.x * VIEWBOX.width,
    y: current.target.y * VIEWBOX.height,
    size: current.target.size,
    interactive: current.status === 'hiding' && current.self.isHider,
    paint: current.target.paint || [],
    outlineOpacity: isHighlighted ? 1 : undefined,
    outlineWidth: isHighlighted ? 2.8 : undefined,
    reveal: isHighlighted,
  });
}

function waitingCover(current) {
  if (current.status !== 'hiding' || current.self.isHider) return '';
  const hider = current.players.find((player) => player.id === current.hiderId);
  return `<div class="waiting-cover" id="waiting-cover"><div class="waiting-cover-art" aria-hidden="true">✳</div><div class="waiting-cover-title">The scene is getting ready.</div><div class="waiting-cover-copy">${esc(hider?.name || 'The hider')} is preparing a hiding spot. You’ll see the scene when searching begins.</div><div class="waiting-cover-dots"><i></i><i></i><i></i></div></div>`;
}

function scorePanel(current) {
  const seekers = current.players.filter((player) => !player.isHider);
  const found = seekers.filter((player) => player.found).length;
  const title = current.status === 'searching' ? `Found ${found} of ${seekers.length}` : 'Room score';
  return `<div class="panel-card score-card">
  <div class="panel-heading"><span>${title}</span><span class="score-heading-right"><span id="score-mini-count">${current.players.length} players</span></span></div>
    <div class="score-info-container">
      <div class="score-list" id="score-list">${scoreRows(current)}</div>
      ${roundScoreRundown(current) ? `<div class="round-scoring">${roundScoreRundown(current)}</div>` : ''}
    </div>
  </div>`;
}

function ordinal(value) {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  return `${value}${value % 10 === 1 ? 'st' : value % 10 === 2 ? 'nd' : value % 10 === 3 ? 'rd' : 'th'}`;
}

function roundScoreRundown(current) {
  const breakdown = current.status === 'reveal' ? current.roundScoreBreakdown : null;
  if (!breakdown) return '';
  const playersById = new Map(current.players.map((player) => [player.id, player]));
  const hider = playersById.get(breakdown.hiderId);
  const colorRows = breakdown.colorDistances?.length
    ? breakdown.colorDistances.slice(0, 10).map((entry) => `<span class="round-color-pair"><i style="--score-color:${entry.color}"></i> ${entry.color.toUpperCase()} → <i style="--score-color:${entry.nearestColor}"></i> ${entry.nearestColor.toUpperCase()} <b>${entry.deltaE.toFixed(1)}</b></span>`).join('')
    : '<span class="round-color-pair">Fewer than two meaningful colors · 0</span>';
  const extraColors = Math.max(0, (breakdown.colorDistances?.length || 0) - 10);
  const seekerRows = (breakdown.seekers || []).map((entry) => {
    const player = playersById.get(entry.playerId);
    const details = entry.found
      ? `<b>${ordinal(entry.place)}</b> | ${entry.placePoints} + ${entry.timeRemainingSeconds}s left = <b>${entry.points}</b> points`
      : `Missed · ${entry.timeSpentSeconds.toFixed(1)}s counted · <b>0</b>`;
    return `<div class="round-seeker-score"><span>${esc(player?.name || 'Seeker')}</span><span>${details}</span></div>`;
  }).join('');
  return `<section class="round-score-rundown" aria-label="Round score breakdown">
    <h3>Hider scoring</h3>
    <div class="round-hider-score"><strong>${esc(hider?.name || 'Hider')} | ${breakdown.points} points</strong>
      <p>Average seeker time = ${breakdown.averageSeekerSeconds.toFixed(1)}s</p>
      <div class="round-color-pairs"><span class="round-color-label">Color Score = ${breakdown.colorScore.toFixed(1)}</span>${colorRows}${extraColors ? `<span class="round-color-more">+ ${extraColors} more included</span>` : ''}</div>
      <p>Missed seekers = ${breakdown.missCount}</p>
      <p>${esc(breakdown.sizeLabel)} Mimi multiplier = ${breakdown.sizeMultiplier}</p>
      <p>(${breakdown.averageSeekerSeconds.toFixed(1)} + ${breakdown.colorScore.toFixed(1)}) × (${breakdown.repeatCount} + ${breakdown.missCount}) × ${breakdown.sizeMultiplier} = <b>${breakdown.points}</b></p>
    </div>
    <div class="round-seeker-scores"><h3>Seekers scoring</h3>${seekerRows}</div>
  </section>`;
}

function howScoringWorks() {
  return `<section class="how-scoring-card" aria-labelledby="how-scoring-title">
    <div class="how-scoring-heading"><span class="caption-leaf" aria-hidden="true">✳</span><h2 id="how-scoring-title">How scoring works</h2></div>
    <div class="how-scoring-grid">
      <p><strong>Seekers:</strong> A successful find earns place points (1st 100, then 80, 70, 60, 50, 40, 30) plus whole seconds left on the search timer. Missing Mimi earns 0.</p>
      <p><strong>Hider:</strong> Average seeker search time in seconds + <strong>color score*</strong>, multiplied by one plus each missed seeker, then by Mimi size (S ×0.8, M ×1, L ×1.5). The result is rounded.</p>
      <p><strong>Color score*:</strong> A color counts at S ≥8%, M ≥6%, or L ≥4% of Mimi’s total area. Each meaningful visible color earns its closest other color’s CIELAB ΔE distance, capped at 20. This is to reward flexible color usage, as it makes camouflage more challenging. Having only one color earns you 0. Original Mimi colors count where paint doesn’t cover her. In short, more colors = more score.</p>
    </div>
  </section>`;
}

function scoreRows(current) {
  const players = [...current.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return players.map((player, index) => `<div class="score-row ${player.isSelf ? 'self' : ''} ${player.isHider ? 'hider' : ''}">
    <div class="score-avatar" style="background:${AVATAR_COLORS[index % AVATAR_COLORS.length] === 'coral' ? '#fde8df' : AVATAR_COLORS[index % AVATAR_COLORS.length] === 'lime' ? '#eef4d6' : AVATAR_COLORS[index % AVATAR_COLORS.length] === 'blue' ? '#e5eef1' : '#e8eee3'}">${esc(initials(player.name))}</div>
    <div class="score-name">${esc(player.name)}${player.isSelf ? '<span class="score-tag">you</span>' : ''}${player.isHider ? '<span class="score-tag">hider</span>' : ''}</div>
    ${player.found && current.status === 'searching' ? '<span class="score-found">✓</span>' : ''}
    <div class="score-total">${player.score}</div>
  </div>`).join('');
}

function sizeControl(current) {
  const selected = localTarget?.size ?? current.target?.size ?? 1;
  return `<div class="size-control"><span class="size-label">Mimi size</span><div class="size-options" aria-label="Mimi size">${SIZE_STEPS.map((size, index) => `<button type="button" class="size-choice ${Math.abs(selected - size) < .001 ? 'active' : ''}" data-action="set-size" data-size="${size}" aria-label="${['Small', 'Normal', 'Large'][index]} size" title="${size.toFixed(size === 1 ? 0 : 2)}×">${['S', 'M', 'L'][index]}</button>`).join('')}</div></div>`;
}

function hiderToolbar(current) {
  if (current.status !== 'hiding' || !current.self.isHider) {
    if (current.status === 'hiding' || current.status === 'reveal') return '';
    if (current.status === 'searching' && current.self.isHider) return '';
    if (current.status === 'searching') return '';
    return `<div class="board-toolbar"><div class="tool-left"><span class="hide-legend">${current.self.isHider ? 'Reveal time' : 'Take a look at the hiding spot'}</span></div><div class="tool-right"><span class="size-label">Next hider soon</span></div></div>`;
  }
  const samplerButton = `<button class="eyedropper-btn ${sceneSamplerActive ? 'active' : ''}" type="button" data-action="sample-color" aria-pressed="${sceneSamplerActive}" title="Pick a color from the scene"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.8 2.8 4.4 4.4-2 2-4.4-4.4 2-2ZM10.1 5.5l4.4 4.4-6.8 6.8-5.1 1 1-5.1 6.5-7.1Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span data-picker-label>${sceneSamplerActive ? 'Cancel pick' : 'Pick from scene'}</span></button>`;
  return `<div class="board-toolbar hider-toolbar"><div class="hider-tool-row">
    <div class="mode-switch" role="group" aria-label="Mimi tools">
      <button type="button" class="mode-btn ${editTool === 'move' ? 'active' : ''}" data-action="set-tool" data-tool="move" aria-pressed="${editTool === 'move'}">↗ Move</button>
      <button type="button" class="mode-btn ${editTool === 'paint' ? 'active' : ''}" data-action="set-tool" data-tool="paint" aria-pressed="${editTool === 'paint'}">✎ Paint</button>
    </div>
    ${sizeControl(current)}
    <button class="primary-btn lock-btn" type="button" data-action="lock-in">Looks good <span aria-hidden="true">→</span></button>
  </div><div class="paint-tools ${editTool === 'paint' ? '' : 'muted'}">
    <span class="paint-label">Paint</span><label class="paint-color-label">Color <input type="color" data-paint-picker value="${paintColor}" aria-label="Paint color"></label>
    ${samplerButton}
    <div class="brush-options" role="group" aria-label="Brush size">${TUNING.paintBrushSizes.map((width, index) => `<button type="button" class="brush-choice ${brushWidth === width ? 'active' : ''}" data-action="brush-size" data-width="${width}" aria-pressed="${brushWidth === width}">${['XS', 'S', 'M', 'L'][index] || width}</button>`).join('')}</div>
    <button class="paint-action eraser-toggle ${eraserActive ? 'active' : ''}" type="button" data-action="toggle-eraser" aria-pressed="${eraserActive}" title="Erase paint">${ERASER_ICON}Eraser</button>
    <button class="paint-action" type="button" data-action="undo-paint" ${localTarget?.paint?.length ? '' : 'disabled'}>Undo</button><button class="paint-action" type="button" data-action="clear-paint" ${localTarget?.paint?.length ? '' : 'disabled'}>Clear</button>
  </div><div class="tool-hint">${editTool === 'paint' ? 'Draw on Mimi · drag the scene to pan' : 'Drag Mimi to move · drag the scene to pan'}</div></div>`;
}

function shouldShowPaintColorSummary(current) {
  return current.status === 'reveal' || (current.status === 'searching' && current.self.isHider);
}

function mountGame() {
  screen = 'game';
  const scene = sceneInfo(state.sceneId);
  const phase = phaseContent(state);
  const initialTarget = state.target ? { ...state.target } : { x: .5, y: .5, size: 1, paint: [] };
  localTarget = { ...initialTarget, paint: [...(initialTarget.paint || [])] };
  boardView = { zoom: 1, tx: 0, ty: 0 };
  editTool = 'move';
  hidePromptDismissed = false;
  brushCursorClient = null;
  hideNoticeTriggered = false;
  clearTimeout(hideNoticeTimer);
  sceneSamplerActive = false;
  scoresCollapsed = false;
  paintColor = TUNING.defaultPaintColor;
  brushWidth = TUNING.paintBrushSizes[2];
  eraserActive = false;
  paintSummaryJob += 1;
  pointers.clear();
  gesture = null;
  const isWaiting = state.status === 'hiding' && !state.self.isHider;
  const targetMarkup = sceneTargetMarkup(state);
  app.innerHTML = `<div class="app-shell">${appHeader('room ' + state.code)}
    <section class="game-page">
      <div class="game-topline"><div class="game-top-left"><span class="game-round-label">ROUND <span id="round-num">${state.roundNumber}</span> OF ${state.roundCount}</span></div>
        <div class="timer-pill" id="timer-pill"><i class="timer-icon"></i><span id="timer-value">--:--</span></div></div>
      <div class="game-layout"><div class="board-column">
        <div class="phase-banner ${state.self.isHider && state.status === 'hiding' ? 'hider-hide-banner' : ''}">${state.self.isHider && state.status === 'hiding' ? `<div class="phase-mimi" aria-hidden="true">${mimiCardSvg()}</div>` : ''}<div class="phase-copy"><div class="phase-title" id="phase-title">${esc(phase.title)}</div><div class="phase-subtitle" id="phase-subtitle">${esc(phase.subtitle)}</div></div><span class="phase-badge ${phase.badgeClass}" id="phase-badge">${esc(phase.badge)}</span></div>
        <div class="scene-heading"><div class="scene-caption"><span class="caption-leaf">✳</span><span id="scene-caption-text">${esc(scene.title)}</span></div></div>
        <div class="scene-frame" id="scene-frame">
          <svg class="scene-svg ${(state.self.isHider && ['hiding', 'searching'].includes(state.status)) || state.status === 'searching' && !state.self.found ? 'can-pan' : ''} ${editTool === 'paint' ? 'paint-mode' : ''}" id="scene-svg" viewBox="0 0 1200 760" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${isWaiting ? 'The hidden scene is not visible yet' : esc(scene.title)}" tabindex="0">
            <g id="sceneView" transform="translate(0 0) scale(1)"><g id="sceneArt">${renderScene(state.sceneId)}</g>${targetMarkup}</g>
            <g id="interactionLayer" pointer-events="none"></g>
          </svg>
          <div class="cooldown-overlay" id="cooldown-overlay" hidden aria-live="polite"><span>Next guess in <strong id="cooldown-countdown">0.8s</strong></span></div>
          ${state.status === 'searching' && state.self.isHider ? '<div class="mimi-shhh mimi-anchor-bubble" id="mimi-shhh" hidden aria-hidden="true">shhh</div>' : ''}
          ${state.self.found && ['searching', 'reveal'].includes(state.status) ? '<div class="mimi-shhh mimi-reveal-bubble mimi-anchor-bubble" id="mimi-you-found-me" aria-hidden="true">You found me!</div>' : ''}
          ${state.status === 'hiding' && state.self.isHider ? '<div class="mimi-shhh mimi-hide-prompt mimi-anchor-bubble" id="mimi-hide-prompt" aria-hidden="true">hide me!</div>' : ''}
          ${state.status === 'hiding' && state.self.isHider ? '<div class="mimi-shhh mimi-countdown-bubble mimi-anchor-bubble" id="mimi-ten-seconds" hidden aria-live="polite">10 seconds left!</div>' : ''}
          ${state.status === 'reveal' && !state.self.found ? '<div class="mimi-shhh mimi-reveal-bubble mimi-anchor-bubble" id="mimi-was-here" aria-hidden="true">I was here!</div>' : ''}
          <div class="scene-color-loupe" id="scene-color-loupe" hidden aria-hidden="true"><canvas id="scene-color-loupe-canvas" width="144" height="144"></canvas><i class="loupe-crosshair"></i><span data-sample-hex>#000000</span></div>
          <div class="brush-cursor" id="brush-cursor" hidden aria-hidden="true"></div>
          ${waitingCover(state)}
        </div>
        <div class="scene-controls-row">${scene.attribution ? `<small class="scene-attribution">${esc(scene.attribution)}</small>` : '<span></span>'}<div class="zoom-controls"><button class="icon-btn" data-action="zoom-out" aria-label="Zoom out">−</button><span class="zoom-level" id="zoom-level">1.0×</span><button class="icon-btn" data-action="zoom-in" aria-label="Zoom in">+</button><button class="icon-btn" data-action="reset-view" aria-label="Reset zoom" style="font-size:12px">⌂</button></div></div>
        ${shouldShowPaintColorSummary(state) ? '<section class="paint-color-summary" id="paint-color-summary" aria-live="polite"><div class="paint-color-summary-heading">Mimi’s colors</div><div class="paint-color-summary-content">Reading Mimi’s colors…</div></section>' : ''}
        ${hiderToolbar(state)}
      </div>
      <aside class="side-panel"><div id="score-panel">${scorePanel(state)}</div></aside>
      </div>
      ${howScoringWorks()}
    </section></div>`;
  syncGameDom();
  updateGame();
  if (shouldShowPaintColorSummary(state)) updatePaintColorSummary(state.target);
}

function showHiderChangeNotice(current) {
  const notice = current.hiderChangeNotice;
  if (!notice || !current.self?.isHider || notice.id === shownHiderChangeNoticeId) return;
  shownHiderChangeNoticeId = notice.id;
  const previousFocus = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'confirm-backdrop';
  backdrop.innerHTML = `<section class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="hider-change-title" aria-describedby="hider-change-copy">
    <div class="confirm-mark" aria-hidden="true">↻</div>
    <p class="confirm-kicker">A new hiding turn</p>
    <h2 id="hider-change-title">You’re the new hider.</h2>
    <p id="hider-change-copy">${esc(notice.departedName)} left the room, so the game moved the hiding turn to you.</p>
    <div class="confirm-actions"><button class="primary-btn" type="button" data-confirm-choice="continue">Got it</button></div>
  </section>`;
  document.body.append(backdrop);
  const button = backdrop.querySelector('[data-confirm-choice="continue"]');
  const close = () => {
    backdrop.remove();
    if (previousFocus?.isConnected) previousFocus.focus?.();
  };
  backdrop.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-confirm-choice]') || event.target === backdrop) close();
  });
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  button?.focus();
}

function syncGameDom() {
  const view = app.querySelector('#sceneView');
  if (!view) return;
  const transform = `translate(${boardView.tx} ${boardView.ty}) scale(${boardView.zoom})`;
  view.setAttribute('transform', transform);
  app.querySelector('#interactionLayer')?.setAttribute('transform', transform);
  const level = app.querySelector('#zoom-level');
  if (level) level.textContent = `${boardView.zoom.toFixed(1)}×`;
  positionMimiBubble();
  renderBrushCursor();
}

function updateTargetDom(target = state?.target) {
  const view = app.querySelector('#sceneView');
  if (!view) return;
  let layer = view.querySelector('#targetLayer');
  const show = target && (state.self.isHider || ['searching', 'reveal', 'finished'].includes(state.status));
  if (!show) {
    layer?.remove();
    return;
  }
  const interactive = state.status === 'hiding' && state.self.isHider;
  const transform = `translate(${target.x * VIEWBOX.width} ${target.y * VIEWBOX.height}) scale(${target.size})`;
  const paintSignature = (target.paint || []).map((stroke) => {
    const last = stroke.points?.at(-1);
    return `${stroke.erase ? 'erase:' : ''}${stroke.color}:${stroke.width}:${stroke.points?.length || 0}:${last?.x || 0},${last?.y || 0}`;
  }).join(';');
  if (!layer) {
    const isHighlighted = state.status === 'reveal' || (state.status === 'searching' && state.self.found);
    view.insertAdjacentHTML('beforeend', renderMimi({
      x: target.x * VIEWBOX.width,
      y: target.y * VIEWBOX.height,
      size: target.size,
      interactive,
      paint: target.paint || [],
      outlineOpacity: isHighlighted ? 1 : undefined,
      outlineWidth: isHighlighted ? 2.8 : undefined,
      reveal: isHighlighted,
    }));
    layer = view.querySelector('#targetLayer');
    if (layer) layer.dataset.paintSignature = paintSignature;
  } else {
    layer.setAttribute('transform', transform);
    const paintGroup = layer.querySelector('.mimi-paint');
    if (paintGroup && layer.dataset.paintSignature !== paintSignature) {
      paintGroup.innerHTML = paintStrokesMarkup(target.paint || []);
      layer.dataset.paintSignature = paintSignature;
    }
    const oldHit = layer.querySelector('[data-target-hit]');
    if (oldHit && !interactive) oldHit.remove();
    else if (!oldHit && interactive) layer.insertAdjacentHTML('beforeend', '<rect data-target-hit="true" x="-29" y="-46" width="58" height="76" fill="transparent" pointer-events="all"/>');
  }
  updatePaintControls(target);
  positionMimiBubble();
}

function updatePaintControls(target = localTarget) {
  const hasPaint = Boolean(target?.paint?.length);
  app.querySelector('[data-action="undo-paint"]')?.toggleAttribute('disabled', !hasPaint);
  app.querySelector('[data-action="clear-paint"]')?.toggleAttribute('disabled', !hasPaint);
}

function syncEraserButton() {
  const button = app.querySelector('[data-action="toggle-eraser"]');
  button?.classList.toggle('active', eraserActive);
  button?.setAttribute('aria-pressed', String(eraserActive));
}

async function rasterizeMimiSvg(markup, width, height) {
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Could not read Mimi’s final colors.'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function paletteColorAt(pixels, offset, palette) {
  let closest = palette[0];
  let closestDistance = Infinity;
  for (const entry of palette) {
    const red = pixels[offset] - entry.rgb[0];
    const green = pixels[offset + 1] - entry.rgb[1];
    const blue = pixels[offset + 2] - entry.rgb[2];
    const distance = red * red + green * green + blue * blue;
    if (distance < closestDistance) {
      closest = entry;
      closestDistance = distance;
      if (distance === 0) break;
    }
  }
  return closest.color;
}

async function visiblePaintColorCounts(target = {}) {
  const paint = target.paint || [];
  const paintColors = [...new Set(paint
    .filter((stroke) => !stroke.erase && /^#[0-9a-f]{6}$/i.test(stroke.color || ''))
    .map((stroke) => stroke.color.toLowerCase()))];
  const requestedSize = Number(target.size);
  const mimiSize = Number.isFinite(requestedSize) && requestedSize > 0 ? requestedSize : 1;
  const resolution = Math.max(1, Number(TUNING.paintAnalysisResolution) || 8);
  const canvasWidth = Math.max(1, Math.round(64 * mimiSize * resolution));
  const canvasHeight = Math.max(1, Math.round(84 * mimiSize * resolution));
  const viewBox = `${-32 * mimiSize} ${-48 * mimiSize} ${64 * mimiSize} ${84 * mimiSize}`;
  const svg = (content) => `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="${viewBox}">${content}</svg>`;
  const silhouetteMarkup = `<g transform="scale(${mimiSize})">${mimiSilhouetteMarkup()}</g>`;
  const silhouettePixels = await rasterizeMimiSvg(svg(silhouetteMarkup), canvasWidth, canvasHeight);
  const originalColors = [...new Set([TUNING.targetColor, TUNING.faceColor, TUNING.targetShade]
    .filter((color) => /^#[0-9a-f]{6}$/i.test(color || '')).map((color) => color.toLowerCase()))];
  const basePixels = await rasterizeMimiSvg(svg(renderMimi({ x: 0, y: 0, size: mimiSize, layerId: null, paint: [], outlineOpacity: 0, outlineWidth: 0 })), canvasWidth, canvasHeight);
  const paintPixels = paintColors.length
    ? await rasterizeMimiSvg(svg(renderMimi({ x: 0, y: 0, size: mimiSize, layerId: null, paint, paintOnly: true })), canvasWidth, canvasHeight)
    : new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
  const finalPixels = await rasterizeMimiSvg(svg(renderMimi({ x: 0, y: 0, size: mimiSize, layerId: null, paint, outlineOpacity: 0, outlineWidth: 0 })), canvasWidth, canvasHeight);
  const paletteFor = (colors) => colors.map((color) => ({ color, rgb: [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16)) }));
  const paintPalette = paletteFor(paintColors);
  const originalPalette = paletteFor(originalColors);
  const counts = new Map();
  let silhouetteCount = 0;
  let paintedCount = 0;
  for (let offset = 0; offset < silhouettePixels.length; offset += 4) {
    if (silhouettePixels[offset + 3] < 128) continue;
    silhouetteCount += 1;
    const isPainted = paintPixels[offset + 3] >= 128 && paintPalette.length > 0;
    if (isPainted) paintedCount += 1;
    const palette = isPainted ? paintPalette : originalPalette;
    if (!palette.length) continue;
    const color = paletteColorAt(isPainted ? finalPixels : basePixels, offset, palette);
    let entry = counts.get(color);
    if (!entry) {
      entry = { color, count: 0, sources: new Set() };
      counts.set(color, entry);
    }
    entry.count += 1;
    entry.sources.add(isPainted ? 'paint' : 'original');
  }
  const sizeIndex = SIZE_STEPS.reduce((closestIndex, size, index) =>
    Math.abs(size - mimiSize) < Math.abs(SIZE_STEPS[closestIndex] - mimiSize) ? index : closestIndex, 0);
  const mimiSizeOption = TUNING.mimiSizes.reduce((closest, candidate) =>
    Math.abs(candidate.scale - mimiSize) < Math.abs(closest.scale - mimiSize) ? candidate : closest,
    TUNING.mimiSizes[0]);
  const threshold = Number(mimiSizeOption?.paintThreshold) || 0.015;
  const colors = [...counts.values()].map((entry) => ({
    color: entry.color,
    count: entry.count,
    sources: [...entry.sources],
    percentage: silhouetteCount ? (entry.count / silhouetteCount) * 100 : 0,
  })).sort((a, b) => b.count - a.count);
  return {
    colors,
    threshold,
    sizeLabel: ['S', 'M', 'L'][sizeIndex] || 'M',
    paintedPercentage: silhouetteCount ? (paintedCount / silhouetteCount) * 100 : 0,
  };
}

async function updatePaintColorSummary(target) {
  const node = app.querySelector('#paint-color-summary');
  if (!node) return;
  const job = ++paintSummaryJob;
  const content = node.querySelector('.paint-color-summary-content');
  try {
    const analysis = await visiblePaintColorCounts(target || { paint: [] });
    if (job !== paintSummaryJob || !content?.isConnected) return;
    if (state?.status === 'searching' && state.self.isHider) {
      action('update-color-analysis', {
        colorAnalysis: { colors: analysis.colors.map(({ color, percentage }) => ({ color, percentage })) },
      }).catch(() => { });
    }
    const visibleColors = analysis.colors.map((entry) => {
      const insignificant = entry.percentage < analysis.threshold;
      const source = entry.sources.length > 1 ? 'Paint + original' : entry.sources[0] === 'paint' ? 'Paint' : 'Original';
      return `<div class="paint-color-row ${insignificant ? 'insignificant' : ''}"><i style="--paint-swatch:${entry.color}"></i><span>${entry.color.toUpperCase()}<small>${source}</small></span><strong>${entry.percentage.toFixed(1)}%${insignificant ? '<small>Below threshold</small>' : ''}</strong></div>`;
    }).join('');
    content.innerHTML = `<div class="paint-analysis-overview"><span>Painted coverage <strong>${analysis.paintedPercentage.toFixed(1)}%</strong></span><span>${analysis.sizeLabel} Mimi</span></div>${visibleColors || '<p class="paint-color-empty">Mimi’s original colors are still showing.</p>'}<p class="paint-color-note">Colors will not count towards scoring if they are below the threshold of ${Number(analysis.threshold * 100)}% coverage.</p>`;
  } catch {
    if (job === paintSummaryJob && content?.isConnected) content.textContent = 'Could not read Mimi’s final paint colors.';
  }
}

function updateGame() {
  if (!state) return;
  const phase = phaseContent(state);
  const title = app.querySelector('#phase-title');
  const subtitle = app.querySelector('#phase-subtitle');
  const badge = app.querySelector('#phase-badge');
  if (title) title.textContent = phase.title;
  if (subtitle) subtitle.textContent = phase.subtitle;
  if (badge) {
    badge.textContent = phase.badge;
    badge.className = `phase-badge ${phase.badgeClass}`;
  }
  const waitCover = app.querySelector('#waiting-cover');
  if (waitCover) waitCover.style.display = state.status === 'hiding' && !state.self.isHider ? 'grid' : 'none';
  const scorePanelNode = app.querySelector('#score-panel');
  if (scorePanelNode) scorePanelNode.innerHTML = scorePanel(state);
  const miniCount = app.querySelector('#score-mini-count');
  if (miniCount) miniCount.textContent = `${state.players.length} players`;
  const finderFeedback = app.querySelector('#finder-feedback');
  if (finderFeedback) {
    const remaining = state.self.cooldownUntil - (Date.now() + clockOffset);
    if (feedback && feedback.until > Date.now()) finderFeedback.textContent = feedback.text;
    else if (remaining > 0) finderFeedback.textContent = `Try another spot in ${(remaining / 1000).toFixed(1)}s`;
    else finderFeedback.textContent = 'Drag to pan · tap to guess';
  }
  updateCooldownUI();
  if (!gesture || !['move', 'paint'].includes(gesture.kind)) {
    const target = localTarget || state.target;
    if (target) updateTargetDom(target);
  }
  syncGameDom();
  updateTimer();
}

function updateFinished() {
  const list = app.querySelector('#leaderboard');
  if (list) list.innerHTML = leaderRows(state.players);
}

function leaderRows(players) {
  return [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).map((player, index) => `<div class="leader-row"><span class="leader-rank">${index + 1}</span><span class="leader-medal">${index === 0 ? '✦' : ''}</span><span class="leader-name">${esc(player.name)}${player.isSelf ? ' <span style="color:#99a499;font-weight:500">(you)</span>' : ''}</span><strong class="leader-score">${player.score} <span style="color:#8c998f;font-size:9px;font-weight:400">PTS</span></strong></div>`).join('');
}

function mountFinished() {
  screen = 'finished';
  app.innerHTML = `<div class="app-shell">${appHeader('Good game')}
    <section class="finished-page"><div class="finished-hero"><div class="finished-icon">✦</div><p class="eyebrow" style="justify-content:center">Hideout closed</p><h1 class="finished-title">Score leaderboard.</h1><p class="finished-copy">Mimi is done hiding. Here's how everyone did.</p></div>
      <div class="leaderboard" id="leaderboard">${leaderRows(state.players)}</div>
      <div class="finished-actions"><button class="primary-btn" data-action="return-to-lobby">Return to lobby <span aria-hidden="true">→</span></button></div>
    </section></div>`;
  updateFinished();
}

function updateTimer() {
  if (!state) return;
  const pill = app.querySelector('#timer-pill');
  const value = app.querySelector('#timer-value');
  if (value && state.deadline) {
    const remaining = Math.max(0, Math.ceil((state.deadline - (Date.now() + clockOffset)) / 1000));
    value.textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
    pill?.classList.toggle('warning', remaining <= 10 && state.status !== 'reveal');
    if (state.status === 'hiding' && state.self.isHider && remaining <= 10 && remaining > 0 && !hideNoticeTriggered) {
      hideNoticeTriggered = true;
      const bubble = app.querySelector('#mimi-ten-seconds');
      if (bubble) {
        bubble.hidden = false;
        positionMimiBubble(bubble);
        hideNoticeTimer = setTimeout(() => { bubble.hidden = true; }, 2000);
      }
    }
  }
  if (feedback && feedback.until <= Date.now()) {
    feedback = null;
    const note = app.querySelector('#finder-feedback');
    if (note) note.textContent = 'Drag to pan · tap to guess';
  }
  updateCooldownUI();
}

function updateCooldownUI() {
  const frame = app.querySelector('#scene-frame');
  const overlay = app.querySelector('#cooldown-overlay');
  const remaining = (state?.self?.cooldownUntil || 0) - (Date.now() + clockOffset);
  const waiting = state?.status === 'searching' && !state.self.isHider && !state.self.found && remaining > 0;
  frame?.classList.toggle('cooldown', Boolean(waiting));
  if (overlay) overlay.hidden = !waiting;
  const countdown = app.querySelector('#cooldown-countdown');
  if (countdown && waiting) countdown.textContent = `${(remaining / 1000).toFixed(1)}s`;
}

function updateMimiShhh(event) {
  const bubble = app.querySelector('#mimi-shhh');
  if (!bubble) return;
  const target = state?.target;
  if (!eventOnScene(event) || !target || event.pointerType !== 'mouse') {
    bubble.hidden = true;
    return;
  }
  const local = mimiLocalPoint(scenePoint(event.clientX, event.clientY));
  if (Math.abs(local.x) > 18 || local.y < -35 || local.y > 28) {
    bubble.hidden = true;
    return;
  }
  positionMimiBubble();
  bubble.hidden = false;
}

function positionMimiBubble(oneBubble = null) {
  const bubbles = oneBubble ? [oneBubble] : [...app.querySelectorAll('.mimi-anchor-bubble')];
  const target = state?.self.isHider && state.status === 'hiding' ? localTarget : state?.target || localTarget;
  if (!bubbles.length || !target) return;
  const svg = app.querySelector('#scene-svg');
  const view = app.querySelector('#sceneView');
  const frame = app.querySelector('#scene-frame');
  if (!svg || !view || !frame) return;
  const anchor = svg.createSVGPoint();
  anchor.x = target.x * VIEWBOX.width + 8 * target.size;
  anchor.y = target.y * VIEWBOX.height - 38 * target.size;
  const screen = anchor.matrixTransform(view.getScreenCTM());
  const bounds = frame.getBoundingClientRect();
  for (const bubble of bubbles) {
    if (bubble.id === 'mimi-hide-prompt' && hidePromptDismissed) {
      bubble.hidden = true;
      continue;
    }
    bubble.style.left = `${screen.x - bounds.left - frame.clientLeft + 7}px`;
    bubble.style.top = `${screen.y - bounds.top - frame.clientTop - 3}px`;
  }
}

function renderBrushCursor() {
  const cursor = app.querySelector('#brush-cursor');
  const svg = app.querySelector('#scene-svg');
  const frame = app.querySelector('#scene-frame');
  if (!cursor || !svg || !frame || !brushCursorClient || sceneSamplerActive ||
    state?.status !== 'hiding' || !state.self.isHider || editTool !== 'paint') {
    if (cursor) cursor.hidden = true;
    return;
  }
  const cursorPoint = mimiLocalPoint(scenePoint(brushCursorClient.x, brushCursorClient.y));
  if (!paintPointOnMimi(cursorPoint)) {
    cursor.hidden = true;
    return;
  }
  const frameBounds = frame.getBoundingClientRect();
  const targetLayer = app.querySelector('#targetLayer');
  const targetTransform = targetLayer?.getScreenCTM?.();
  if (!targetTransform || !targetLayer) {
    cursor.hidden = true;
    return;
  }
  const localSvgPoint = svg.createSVGPoint();
  localSvgPoint.x = cursorPoint.x;
  localSvgPoint.y = cursorPoint.y;
  const screenPoint = localSvgPoint.matrixTransform(targetTransform);
  const unitScale = targetTransform
    ? Math.hypot(targetTransform.a, targetTransform.b)
    : 1;
  const diameter = Math.max(7, Math.min(110, brushWidth * unitScale));
  cursor.style.width = `${diameter}px`;
  cursor.style.height = `${diameter}px`;
  cursor.style.left = `${screenPoint.x - frameBounds.left - frame.clientLeft}px`;
  cursor.style.top = `${screenPoint.y - frameBounds.top - frame.clientTop}px`;
  cursor.hidden = false;
}

function updateBrushCursor(event) {
  if (event.pointerType !== 'mouse' || !eventOnScene(event)) {
    brushCursorClient = null;
    renderBrushCursor();
    return;
  }
  brushCursorClient = { x: event.clientX, y: event.clientY };
  renderBrushCursor();
}

function scenePoint(clientX, clientY) {
  const svg = app.querySelector('#scene-svg');
  if (!svg) return { x: 600, y: 380 };
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const base = point.matrixTransform(svg.getScreenCTM().inverse());
  return {
    x: Math.max(0, Math.min(VIEWBOX.width, (base.x - boardView.tx) / boardView.zoom)),
    y: Math.max(0, Math.min(VIEWBOX.height, (base.y - boardView.ty) / boardView.zoom)),
  };
}

function updateViewTransform() {
  const zoom = boardView.zoom;
  boardView.tx = Math.min(0, Math.max(VIEWBOX.width * (1 - zoom), boardView.tx));
  boardView.ty = Math.min(0, Math.max(VIEWBOX.height * (1 - zoom), boardView.ty));
  syncGameDom();
}

function zoomAt(factor, clientX, clientY) {
  const svg = app.querySelector('#scene-svg');
  if (!svg) return;
  const point = svg.createSVGPoint();
  const rect = svg.getBoundingClientRect();
  point.x = clientX ?? rect.left + rect.width / 2;
  point.y = clientY ?? rect.top + rect.height / 2;
  const base = point.matrixTransform(svg.getScreenCTM().inverse());
  const anchorX = (base.x - boardView.tx) / boardView.zoom;
  const anchorY = (base.y - boardView.ty) / boardView.zoom;
  const nextZoom = Math.max(TUNING.minZoom, Math.min(TUNING.maxZoom, boardView.zoom * factor));
  boardView.zoom = nextZoom;
  boardView.tx = base.x - anchorX * nextZoom;
  boardView.ty = base.y - anchorY * nextZoom;
  updateViewTransform();
}

function setEditTool(tool) {
  editTool = tool === 'paint' ? 'paint' : 'move';
  if (editTool === 'move') eraserActive = false;
  syncEraserButton();
  app.querySelectorAll('.mode-btn').forEach((button) => {
    const active = button.dataset.tool === editTool;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const svg = app.querySelector('#scene-svg');
  svg?.classList.toggle('paint-mode', editTool === 'paint');
  const hint = app.querySelector('.tool-hint');
  if (hint) hint.textContent = editTool === 'paint'
    ? eraserActive ? 'Erase paint from Mimi · drag the scene to pan' : 'Draw on Mimi · drag the scene to pan'
    : 'Drag Mimi to move · drag the scene to pan';
  app.querySelector('.paint-tools')?.classList.toggle('muted', editTool !== 'paint');
  const mobileHint = app.querySelector('#mobile-instructions');
  if (mobileHint && state?.self.isHider && state.status === 'hiding') {
    mobileHint.innerHTML = editTool === 'paint'
      ? eraserActive ? '<span>Erase paint from Mimi</span><span>·</span><span>Drag elsewhere to pan</span>' : '<span>Draw on Mimi to paint</span><span>·</span><span>Drag elsewhere to pan</span>'
      : '<span>Drag Mimi to move her</span><span>·</span><span>Drag anywhere else to pan</span>';
  }
  renderBrushCursor();
}

function clampTarget(next) {
  return {
    ...next,
    x: Math.max(TUNING.placementMinX, Math.min(TUNING.placementMaxX, next.x)),
    y: Math.max(TUNING.placementMinY, Math.min(TUNING.placementMaxY, next.y)),
    size: next.size ?? localTarget?.size ?? 1,
  };
}

function persistTargetSoon() {
  clearTimeout(hideMoveTimer);
  hideMoveTimer = setTimeout(() => {
    if (!localTarget || !session) return;
    action('move-target', { x: localTarget.x, y: localTarget.y }).catch((error) => toast(error.message, true));
  }, 65);
}

function moveTarget(point) {
  if (!localTarget || !state?.self.isHider || state.status !== 'hiding') return;
  localTarget = clampTarget({ ...localTarget, x: point.x / VIEWBOX.width, y: point.y / VIEWBOX.height });
  updateTargetDom(localTarget);
  persistTargetSoon();
}

function targetHitFromEvent(event) {
  const target = event.target;
  return Boolean(target?.closest?.('[data-target-hit]'));
}

function eventOnScene(event) {
  return event.target?.closest?.('#scene-svg');
}

async function submitGuess(point, currentGesture = gesture) {
  if (!point || !state || currentGesture?.finishing) return;
  if (currentGesture) currentGesture.finishing = true;
  try {
    const response = await action('guess', { x: point.x / VIEWBOX.width, y: point.y / VIEWBOX.height });
    if (response.hit) {
      feedback = { text: `You found Mimi · +${response.points} points`, until: Date.now() + 1800 };
      if (navigator.vibrate) navigator.vibrate(26);
      if (response.state) applyState(response.state);
      else poll();
    } else {
      feedback = { text: 'Not there. Try another spot.', until: Date.now() + 1500 };
      if (navigator.vibrate) navigator.vibrate([18, 35, 18]);
      applyState({ ...state, self: { ...state.self, cooldownUntil: response.cooldownUntil } });
      setTimeout(poll, 160);
    }
  } catch (error) {
    if (error.status === 429) {
      feedback = { text: 'Take a moment before the next guess.', until: Date.now() + 950 };
      if (currentGesture) applyState({ ...state, self: { ...state.self, cooldownUntil: Date.now() + TUNING.missCooldownMs } });
    } else {
      toast(error.message, true);
      poll();
    }
  } finally {
    if (gesture === currentGesture) gesture = null;
  }
}

function mimiLocalPoint(point) {
  const target = localTarget || state?.target;
  if (!target) return { x: 0, y: 0 };
  return {
    x: (point.x - target.x * VIEWBOX.width) / target.size,
    y: (point.y - target.y * VIEWBOX.height) / target.size,
  };
}

function paintPointOnMimi(point) {
  return point.x >= -30 && point.x <= 30 && point.y >= -47 && point.y <= 32;
}

async function commitPaint(current) {
  if (!current?.stroke || current.cancelled) return;
  const lockButton = app.querySelector('[data-action="lock-in"]');
  if (lockButton) lockButton.disabled = true;
  try {
    const result = await action('paint-stroke', {
      color: current.stroke.color,
      width: current.stroke.width,
      erase: Boolean(current.stroke.erase),
      points: current.stroke.points,
    });
    localTarget = result.target ? { ...result.target, paint: [...(result.target.paint || [])] } : localTarget;
    applyState(result);
  } catch (error) {
    if (localTarget?.paint?.at(-1) === current.stroke) localTarget.paint.pop();
    toast(error.message, true);
  } finally {
    if (gesture === current) gesture = null;
    if (localTarget) updateTargetDom(localTarget);
    if (lockButton?.isConnected) lockButton.disabled = false;
  }
}

function startPinch() {
  if (gesture?.kind === 'paint' && localTarget?.paint?.at(-1) === gesture.stroke) {
    localTarget.paint.pop();
    updateTargetDom(localTarget);
  }
  if (gesture) gesture.cancelled = true;
  gesture = null;
  app.querySelector('#interactionLayer')?.replaceChildren();
  const entries = [...pointers.entries()];
  if (entries.length < 2) return;
  const [aId, a] = entries[0];
  const [bId, b] = entries[1];
  pinch = {
    ids: [aId, bId],
    distance: Math.hypot(a.x - b.x, a.y - b.y),
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  };
}

function onPointerDown(event) {
  if (!eventOnScene(event) || !state || !['hiding', 'searching'].includes(state.status)) return;
  if (gesture?.finishing) return;
  const svg = app.querySelector('#scene-svg');
  svg?.setPointerCapture?.(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (sceneSamplerActive) {
    if (gesture?.kind === 'sample' && gesture.pointerId !== event.pointerId) {
      pointers.delete(event.pointerId);
      event.preventDefault();
      return;
    }
    gesture = { pointerId: event.pointerId, kind: 'sample' };
    updateSceneColorLoupe(event.clientX, event.clientY);
    event.preventDefault();
    return;
  }
  if (pointers.size >= 2) {
    startPinch();
    event.preventDefault();
    return;
  }
  if (state.status === 'searching' && !state.self.isHider && !state.self.found &&
    state.self.cooldownUntil > Date.now() + clockOffset) {
    pointers.delete(event.pointerId);
    svg?.releasePointerCapture?.(event.pointerId);
    event.preventDefault();
    return;
  }
  const point = scenePoint(event.clientX, event.clientY);
  const nextGesture = {
    pointerId: event.pointerId,
    startClient: { x: event.clientX, y: event.clientY },
    lastClient: { x: event.clientX, y: event.clientY },
    startWorld: point,
    moved: false,
    cancelled: false,
    kind: 'idle',
  };
  if (state.status === 'hiding' && state.self.isHider) {
    if (targetHitFromEvent(event) && editTool === 'move') {
      nextGesture.kind = 'move';
      nextGesture.offsetX = localTarget.x * VIEWBOX.width - point.x;
      nextGesture.offsetY = localTarget.y * VIEWBOX.height - point.y;
    } else if (targetHitFromEvent(event) && editTool === 'paint') {
      const firstPoint = mimiLocalPoint(point);
      if (paintPointOnMimi(firstPoint)) {
        nextGesture.kind = 'paint';
        nextGesture.stroke = { color: paintColor, width: brushWidth, erase: eraserActive, points: [firstPoint] };
        localTarget.paint ??= [];
        localTarget.paint.push(nextGesture.stroke);
        updateTargetDom(localTarget);
      } else nextGesture.kind = 'pan';
    } else nextGesture.kind = 'pan';
    if (nextGesture.kind === 'move' || nextGesture.kind === 'paint') {
      hidePromptDismissed = true;
      const prompt = app.querySelector('#mimi-hide-prompt');
      if (prompt) prompt.hidden = true;
    }
    gesture = nextGesture;
  } else if (state.status === 'searching' && !state.self.isHider && !state.self.found) {
    nextGesture.kind = 'seek';
    gesture = nextGesture;
  } else if (state.status === 'searching' && state.self.isHider) {
    nextGesture.kind = 'pan';
    gesture = nextGesture;
  }
  event.preventDefault();
}

function onPointerMove(event) {
  updateBrushCursor(event);
  updateMimiShhh(event);
  if (sceneSamplerActive) {
    if (eventOnScene(event) && (event.pointerType === 'mouse' || gesture?.kind === 'sample')) updateSceneColorLoupe(event.clientX, event.clientY);
    else if (gesture?.kind !== 'sample') {
      const loupe = app.querySelector('#scene-color-loupe');
      if (loupe) loupe.hidden = true;
    }
  }
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pinch && pinch.ids.every((id) => pointers.has(id))) {
    const first = pointers.get(pinch.ids[0]);
    const second = pointers.get(pinch.ids[1]);
    const distance = Math.hypot(first.x - second.x, first.y - second.y);
    const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    if (pinch.distance > 0) zoomAt(distance / pinch.distance, pinch.center.x, pinch.center.y);
    const svg = app.querySelector('#scene-svg');
    if (svg) {
      const scaleX = VIEWBOX.width / svg.getBoundingClientRect().width;
      const scaleY = VIEWBOX.height / svg.getBoundingClientRect().height;
      boardView.tx += (center.x - pinch.center.x) * scaleX;
      boardView.ty += (center.y - pinch.center.y) * scaleY;
      updateViewTransform();
    }
    pinch.distance = distance;
    pinch.center = center;
    event.preventDefault();
    return;
  }
  const current = gesture;
  if (!current || current.pointerId !== event.pointerId) return;
  const dx = event.clientX - current.lastClient.x;
  const dy = event.clientY - current.lastClient.y;
  const total = Math.hypot(event.clientX - current.startClient.x, event.clientY - current.startClient.y);
  if (total > TUNING.panThresholdPx) current.moved = true;
  if (current.kind === 'seek' && total > TUNING.panThresholdPx) {
    current.kind = 'pan';
    current.lastClient = { x: event.clientX, y: event.clientY };
  }
  if (current.kind === 'move' && state.status === 'hiding') {
    const point = scenePoint(event.clientX, event.clientY);
    localTarget = clampTarget({ ...localTarget, x: (point.x + current.offsetX) / VIEWBOX.width, y: (point.y + current.offsetY) / VIEWBOX.height });
    updateTargetDom(localTarget);
    clearTimeout(hideMoveTimer);
    if (!current.lastSentAt || Date.now() - current.lastSentAt > 70) {
      current.lastSentAt = Date.now();
      action('move-target', { x: localTarget.x, y: localTarget.y }).catch(() => { });
    }
  } else if (current.kind === 'paint' && state.status === 'hiding') {
    const point = mimiLocalPoint(scenePoint(event.clientX, event.clientY));
    const last = current.stroke.points.at(-1);
    if (paintPointOnMimi(point) && Math.hypot(point.x - last.x, point.y - last.y) >= 1.7 && current.stroke.points.length < TUNING.paintMaxPoints) {
      current.stroke.points.push(point);
      updateTargetDom(localTarget);
    }
  } else if (current.kind === 'pan') {
    const svg = app.querySelector('#scene-svg');
    if (svg) {
      const bounds = svg.getBoundingClientRect();
      boardView.tx += dx * VIEWBOX.width / bounds.width;
      boardView.ty += dy * VIEWBOX.height / bounds.height;
      updateViewTransform();
      svg.classList.add('is-panning');
    }
  }
  current.lastClient = { x: event.clientX, y: event.clientY };
  event.preventDefault();
}

function onPointerUp(event) {
  pointers.delete(event.pointerId);
  if (pinch) {
    if (pointers.size < 2) pinch = null;
    if (gesture?.pointerId === event.pointerId) gesture = null;
    return;
  }
  const current = gesture;
  if (!current || current.pointerId !== event.pointerId) return;
  if (current.kind === 'sample') {
    finishSceneColorPick(event.clientX, event.clientY);
    gesture = null;
  } else if (current.kind === 'seek') {
    if (!current.moved) submitGuess(current.startWorld, current);
    else gesture = null;
  } else if (current.kind === 'move') {
    persistTargetSoon();
    gesture = null;
  } else if (current.kind === 'paint') {
    commitPaint(current);
  } else {
    app.querySelector('#scene-svg')?.classList.remove('is-panning');
    gesture = null;
  }
}

function onPointerCancel(event) {
  pointers.delete(event.pointerId);
  if (gesture?.pointerId === event.pointerId) {
    if (gesture.kind === 'paint' && localTarget?.paint?.at(-1) === gesture.stroke) {
      localTarget.paint.pop();
      updateTargetDom(localTarget);
    }
    gesture = null;
  }
  if (sceneSamplerActive) {
    const loupe = app.querySelector('#scene-color-loupe');
    if (loupe) loupe.hidden = true;
  }
  if (pointers.size < 2) pinch = null;
}

function bindGlobalEvents() {
  // Picking from the scene is a temporary tool. A different control cancels it,
  // while size and zoom-in/out remain available during sampling.
  app.addEventListener('click', (event) => {
    const gameControl = event.target.closest('[data-action]');
    const gameColorPicker = event.target.closest('[data-paint-picker]');
    if (sceneSamplerActive && (gameColorPicker || gameControl && !['sample-color', 'set-size', 'zoom-in', 'zoom-out'].includes(gameControl.dataset.action))) {
      cancelSceneColorPick();
    }

    const demoControl = event.target.closest('#home-demo button');
    const demoColorPicker = event.target.closest('#home-demo-color');
    if (!app.querySelector('.demo-scene-wrap.demo-sampling') || !demoControl && !demoColorPicker) return;
    const keepsSampling = demoControl && (demoControl.hasAttribute('data-demo-size')
      || ['in', 'out'].includes(demoControl.dataset.demoZoom)
      || demoControl.dataset.demoAction === 'sample');
    if (!keepsSampling) app.querySelector('[data-demo-action="sample"]')?.click();
  }, true);

  app.addEventListener('submit', async (event) => {
    if (event.target.id === 'public-form' || event.target.id === 'create-form') {
      event.preventDefault();
      const nameInput = app.querySelector('#player-name');
      const name = nameInput?.value.trim() || '';
      if (!name) {
        nameInput?.setCustomValidity('Please enter your name first.');
        nameInput?.reportValidity();
        nameInput?.focus();
        return;
      }
      nameInput.setCustomValidity('');
      try {
        const result = await requestGame({ type: event.target.id === 'public-form' ? 'join-public' : 'create-room', name });
        saveSession({ code: result.code, playerId: result.playerId, name: String(name).trim() });
        history.replaceState({}, '', `?room=${encodeURIComponent(result.code)}`);
        const initialSelf = result.state.players.find((player) => player.isSelf);
        const initialState = initialSelf?.ready
          ? await requestGame({ code: result.code, playerId: result.playerId, type: 'ready', value: false })
          : result.state;
        applyState(initialState);
        startPolling();
      } catch (error) { toast(error.message, true); }
    } else if (event.target.id === 'join-form') {
      event.preventDefault();
      const values = new FormData(event.target);
      const code = String(values.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
      const nameInput = app.querySelector('#player-name');
      const name = nameInput?.value.trim() || '';
      if (!name) {
        nameInput?.setCustomValidity('Please enter your name first.');
        nameInput?.reportValidity();
        nameInput?.focus();
        return;
      }
      nameInput.setCustomValidity('');
      if (code.length !== 5) return toast('A room code has five letters or numbers.', true);
      try {
        const result = await requestGame({ type: 'join-room', code, name });
        saveSession({ code: result.code, playerId: result.playerId, name });
        history.replaceState({}, '', `?room=${encodeURIComponent(result.code)}`);
        applyState(result.state);
        startPolling();
      } catch (error) { toast(error.message, true); }
    }
  });
  app.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    event.preventDefault();
    const type = button.dataset.action;
    try {
      if (type === 'create-room') app.querySelector('#create-form')?.requestSubmit();
      else if (type === 'ready') applyState(await action('ready', { value: true }));
      else if (type === 'not-ready') applyState(await action('ready', { value: false }));
      else if (type === 'start') applyState(await action('start'));
      else if (type === 'toggle-visibility') {
        const visibility = state.visibility === 'public' ? 'private' : 'public';
        applyState(await action('set-visibility', { visibility }));
        toast(visibility === 'public' ? 'This room is now public.' : 'This room is now private.');
      }
      else if (type === 'view-results') openResultsModal();
      else if (type === 'close-results') closeResultsModal();
      else if (type === 'kick-player') {
        const target = state.players.find((player) => player.id === button.dataset.playerId);
        if (!target || !await confirmKickPlayer(target)) return;
        applyState(await action('kick-player', { targetPlayerId: target.id }));
        toast(`${target.name} was removed from the room.`);
      }
      else if (type === 'leave-room') await leaveCurrentRoom();
      else if (type === 'lock-in') {
        button.disabled = true;
        const originalLabel = button.innerHTML;
        button.textContent = 'Preparing Mimi…';
        clearTimeout(hideMoveTimer);
        try {
          if (localTarget) await action('move-target', { x: localTarget.x, y: localTarget.y });
          const analysis = await visiblePaintColorCounts(localTarget || state.target);
          applyState(await action('lock-in', {
            colorAnalysis: { colors: analysis.colors.map(({ color, percentage }) => ({ color, percentage })) },
          }));
        } finally {
          if (button.isConnected) {
            button.disabled = false;
            button.innerHTML = originalLabel;
          }
        }
      } else if (type === 'set-tool') setEditTool(button.dataset.tool);
      else if (type === 'sample-color') await beginSceneColorPick();
      else if (type === 'toggle-eraser') {
        setEditTool('paint');
        eraserActive = !eraserActive;
        syncEraserButton();
        setEditTool('paint');
      }
      else if (type === 'toggle-scores') {
        scoresCollapsed = !scoresCollapsed;
        const scorePanelNode = app.querySelector('#score-panel');
        if (scorePanelNode) scorePanelNode.innerHTML = scorePanel(state);
      }
      else if (type === 'brush-size') {
        setEditTool('paint');
        brushWidth = Number(button.dataset.width);
        app.querySelectorAll('.brush-choice').forEach((choice) => {
          const active = Number(choice.dataset.width) === brushWidth;
          choice.classList.toggle('active', active);
          choice.setAttribute('aria-pressed', String(active));
        });
        renderBrushCursor();
      } else if (type === 'undo-paint' || type === 'clear-paint') {
        const result = await action(type);
        localTarget = result.target ? { ...result.target, paint: [...(result.target.paint || [])] } : localTarget;
        applyState(result);
      }
      else if (type === 'set-size') {
        const size = Number(button.dataset.size);
        if (!localTarget) return;
        localTarget = { ...localTarget, size };
        app.querySelectorAll('.size-choice').forEach((choice) => {
          const active = Math.abs(Number(choice.dataset.size) - size) < .001;
          choice.classList.toggle('active', active);
        });
        updateTargetDom(localTarget);
        await action('resize-target', { size });
        updateGame();
      } else if (type === 'zoom-in') zoomAt(TUNING.zoomInStep);
      else if (type === 'zoom-out') zoomAt(TUNING.zoomOutStep);
      else if (type === 'reset-view') {
        boardView = { zoom: 1, tx: 0, ty: 0 };
        syncGameDom();
      } else if (type === 'copy-invite') await copyInvite();
      else if (type === 'return-to-lobby') applyState(await action('return-to-lobby'));
      else if (type === 'brand-home') {
        if (session) await leaveCurrentRoom();
        else mountHome();
      }
    } catch (error) {
      toast(error.message, true);
      poll();
    }
  });
  app.addEventListener('pointerdown', onPointerDown);
  app.addEventListener('pointermove', onPointerMove);
  app.addEventListener('pointerup', onPointerUp);
  app.addEventListener('pointercancel', onPointerCancel);
  app.addEventListener('wheel', (event) => {
    if (!eventOnScene(event)) return;
    zoomAt(Math.exp(-event.deltaY * TUNING.wheelSensitivity), event.clientX, event.clientY);
    event.preventDefault();
  }, { passive: false });
  app.addEventListener('input', (event) => {
    if (!event.target.matches('[data-paint-picker]')) return;
    if (sceneSamplerActive) cancelSceneColorPick();
    setPaintColor(event.target.value);
  });
  app.addEventListener('change', (event) => {
    if (!event.target.matches('[data-paint-picker]')) return;
    if (sceneSamplerActive) cancelSceneColorPick();
    setPaintColor(event.target.value);
  });
  app.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sceneSamplerActive) {
      cancelSceneColorPick();
      toast('Color picking cancelled.');
      event.preventDefault();
    } else if (event.key === 'Escape' && app.querySelector('.demo-scene-wrap.demo-sampling')) {
      app.querySelector('[data-demo-action="sample"]')?.click();
      event.preventDefault();
    }
  });
  app.addEventListener('pointerleave', () => {
    brushCursorClient = null;
    renderBrushCursor();
  });
}

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(inviteUrl());
    toast('Invite link copied. Send it to your friends!');
  } catch {
    toast(`Room code: ${state?.code || session?.code}`);
  }
}

async function togglePlayAgain() {
  const result = await action('play-again');
  saveSession({ ...session, rematchOptIn: result.status === 'lobby' || Boolean(result.self.rematchOptIn) });
  applyState(result);
  startPolling();
  toast(result.status === 'finished' ? (result.self.rematchOptIn ? 'You’re in. Waiting for everyone else to decide.' : 'You changed your mind about playing again.') : 'Everyone decided. Back to the room!');
}

function confirmLeaveRoom() {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    backdrop.innerHTML = `<section class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="leave-dialog-title" aria-describedby="leave-dialog-copy">
      <div class="confirm-mark" aria-hidden="true">↗</div>
      <p class="confirm-kicker">Room ${esc(state?.code || session?.code || '')}</p>
      <h2 id="leave-dialog-title">Leave this room?</h2>
      <p id="leave-dialog-copy">You’ll step out of this game. You can rejoin while there’s still a seat.</p>
      <div class="confirm-actions"><button class="secondary-btn" type="button" data-confirm-choice="stay">Stay here</button><button class="primary-btn" type="button" data-confirm-choice="leave">Leave room</button></div>
    </section>`;
    document.body.append(backdrop);
    const choices = [...backdrop.querySelectorAll('[data-confirm-choice]')];
    const close = (confirmed) => {
      backdrop.remove();
      if (previousFocus?.isConnected) previousFocus.focus?.();
      resolve(confirmed);
    };
    backdrop.addEventListener('click', (event) => {
      const choice = event.target.closest?.('[data-confirm-choice]');
      if (choice) close(choice.dataset.confirmChoice === 'leave');
      else if (event.target === backdrop) close(false);
    });
    backdrop.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(false);
        return;
      }
      if (event.key === 'Tab' && choices.length) {
        const first = choices[0];
        const last = choices[choices.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
    choices[0]?.focus();
  });
}

function confirmKickPlayer(player) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    backdrop.innerHTML = `<section class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="kick-dialog-title" aria-describedby="kick-dialog-copy">
      <div class="confirm-mark" aria-hidden="true">−</div>
      <p class="confirm-kicker">Room ${esc(state?.code || session?.code || '')}</p>
      <h2 id="kick-dialog-title">Remove ${esc(player.name)}?</h2>
      <p id="kick-dialog-copy">${esc(player.name)} will leave the room and can rejoin while there’s still a seat.</p>
      <div class="confirm-actions"><button class="secondary-btn" type="button" data-confirm-choice="stay">Keep player</button><button class="primary-btn" type="button" data-confirm-choice="kick">Remove player</button></div>
    </section>`;
    document.body.append(backdrop);
    const choices = [...backdrop.querySelectorAll('[data-confirm-choice]')];
    const close = (confirmed) => {
      backdrop.remove();
      if (previousFocus?.isConnected) previousFocus.focus?.();
      resolve(confirmed);
    };
    backdrop.addEventListener('click', (event) => {
      const choice = event.target.closest?.('[data-confirm-choice]');
      if (choice) close(choice.dataset.confirmChoice === 'kick');
      else if (event.target === backdrop) close(false);
    });
    backdrop.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(false);
        return;
      }
      if (event.key === 'Tab' && choices.length) {
        const first = choices[0];
        const last = choices[choices.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
    choices[0]?.focus();
  });
}

async function leaveCurrentRoom() {
  if (!session) {
    mountHome();
    return;
  }
  if (!await confirmLeaveRoom()) return;
  try {
    await action('leave');
  } catch (error) {
    if (![403, 404].includes(error.status)) throw error;
  }
  stopPolling();
  saveSession(null);
  history.replaceState({}, '', location.pathname);
  mountHome();
  toast('You left the room.');
}

function localClock() {
  updateTimer();
  requestAnimationFrame(localClock);
}

async function boot() {
  bindGlobalEvents();
  const invite = new URLSearchParams(location.search).get('room') || '';
  if (session?.code && session?.playerId) {
    try {
      const current = await requestGame(null, { room: session.code, playerId: session.playerId });
      applyState(current);
      startPolling();
    } catch {
      saveSession(null);
      history.replaceState({}, '', location.pathname);
      mountHome();
    }
  } else {
    mountHome(invite);
  }
  requestAnimationFrame(localClock);
}

boot();
