import './tauri-bridge.js';

const $ = id => document.getElementById(id);
// Category colors: three families that stay distinguishable on the graphite base.
const TRACK_COLORS = { animation: '#9b86e0', camera: '#6fd3ae', trigger: '#e0a75c', audio: '#5f9fd6' };
const CLIP_DEFAULTS = {
  camera: { duration: 1, label: 'Camera key' },
  animation: { duration: 2, label: 'New animation' },
  trigger: { duration: 0.25, label: 'Trigger event' },
  audio: { duration: 2, label: 'Audio cue' }
};
const STALE_MS = 4000;
const GUIDE_KEY = 'cineflow.guide.dismissed';
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];

const state = {
  cutscenes: [], activeId: null, selectedClipId: null, selectedTrackId: null,
  zoom: 100, snap: true, snapInterval: 0.25, playhead: 0,
  preview: false, history: [], future: [], dirty: false,
  drag: null, scrubbing: false, toastTimer: null, frameClock: null,
  raw: {}, bridgeRunning: false, connection: { phase: 'idle', plugin: false, phone: false, stale: false, hint: '' },
  lastRig: '', lastAnimationId: '', latestMotion: null, clipboard: null
};
let bridgeInfo = null;
let publishedCutscene = '';
let raf = null;
let chromeRaf = 0;

function uid(prefix = 'item') { return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`; }

function newCutscene(name = 'Untitled Cutscene') {
  return { schemaVersion: 1, id: uid('cutscene'), name, fps: 30, duration: 12, tracks: [
    { id: uid('track'), name: 'Camera 01', type: 'camera', locked: false, visible: true, clips: [] },
    { id: uid('track'), name: 'Character Animations', type: 'animation', locked: false, visible: true, clips: [] },
    { id: uid('track'), name: 'Triggers', type: 'trigger', locked: false, visible: true, clips: [] }
  ], takes: [] };
}
function active() { return state.cutscenes.find(item => item.id === state.activeId) ?? null; }
function allClips(cutscene = active()) { return cutscene?.tracks.flatMap(track => track.clips.map(clip => ({ ...clip, trackId: track.id, trackType: track.type }))) ?? []; }
function selectedClip() { return allClips().find(clip => clip.id === state.selectedClipId) ?? null; }

function toast(message, error = false) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('error', error);
  node.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.add('hidden'), 2800);
}

function snapshot() { return JSON.stringify(state.cutscenes); }
function commitHistory() {
  state.history.push(snapshot());
  if (state.history.length > 60) state.history.shift();
  state.future = [];
  markDirty();
}
function markDirty() {
  state.dirty = true;
  $('dirty-dot').classList.add('show');
  $('dirty-label').classList.remove('hidden');
}
function markClean() {
  state.dirty = false;
  $('dirty-dot').classList.remove('show');
  $('dirty-label').classList.add('hidden');
}
function restoreHistory(stack, other) {
  if (!stack.length) return;
  other.push(snapshot());
  state.cutscenes = JSON.parse(stack.pop());
  if (!active() && state.cutscenes.length) state.activeId = state.cutscenes[0].id;
  state.selectedClipId = null;
  markDirty();
  renderAll();
}
function undo() { restoreHistory(state.history, state.future); }
function redo() { restoreHistory(state.future, state.history); }

function formatTime(seconds, fps = 30) {
  seconds = Math.max(0, seconds || 0);
  const whole = Math.floor(seconds);
  const frames = Math.floor((seconds - whole) * fps + 1e-5);
  const hh = String(Math.floor(whole / 3600)).padStart(2, '0');
  const mm = String(Math.floor(whole / 60) % 60).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}:${String(frames).padStart(2, '0')}`;
}
function durationOf(c) { return Math.max(c?.duration ?? 0, ...(c?.tracks.flatMap(t => t.clips.map(x => x.start + x.duration)) ?? [0])); }
function pxPerSec() { return 60 * state.zoom / 100; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------------------------------------------------------------- connection */

function deriveConnection() {
  const raw = state.raw ?? {};
  const age = Number.isFinite(raw.pluginConnectedMsAgo) ? raw.pluginConnectedMsAgo : null;
  const stale = !!raw.pluginConnected && age !== null && age >= STALE_MS;
  const plugin = !!raw.pluginConnected && !stale;
  const phone = !!raw.phoneConnected;

  if (!state.bridgeRunning) {
    return { phase: 'idle', plugin: false, phone: false, stale: false, tone: 'off',
      pill: 'Studio disconnected',
      hint: 'Start the phone bridge, then connect the Studio plugin.' };
  }
  if (stale) {
    return { phase: 'stale', plugin: false, phone, stale: true, tone: 'warn',
      pill: 'Studio not responding',
      hint: 'Studio stopped polling — click Connect again in the plugin panel.' };
  }
  if (!plugin) {
    return { phase: 'bridge-only', plugin: false, phone, stale: false, tone: 'off',
      pill: 'Studio disconnected',
      hint: 'In Studio open the Cineflow panel and click Connect to desktop app.' };
  }
  if (phone) {
    return { phase: 'phone-live', plugin: true, phone: true, stale: false, tone: 'on',
      pill: 'Studio + phone live',
      hint: 'Ready — add clips, then press Preview.' };
  }
  return { phase: 'studio-ready', plugin: true, phone: false, stale: false, tone: 'on',
    pill: 'Studio connected',
    hint: 'Studio is live. Connect your phone if you want handheld camera aim.' };
}

function renderConnection() {
  const conn = deriveConnection();
  state.connection = conn;

  const pill = $('studio-status');
  pill.textContent = conn.pill;
  const dot = $('studio-dot');
  dot.classList.toggle('live', conn.tone === 'on' && conn.plugin);
  dot.classList.toggle('warn', conn.tone === 'warn');

  const tag = $('phone-indicator');
  tag.classList.toggle('on', conn.phone);
  tag.classList.toggle('off', !conn.phone);
  tag.querySelector('span').textContent = conn.phone ? 'Connected' : 'Offline';

  const bridgeStatus = state.raw?.status;
  $('phone-status').textContent = bridgeStatus && bridgeStatus !== 'Offline' ? bridgeStatus : conn.hint;
  $('phone-dot').classList.toggle('live', conn.phone);
  $('viewport-hint').textContent = conn.hint;

  renderTransportNote();
}

function previewBlocker() {
  if (!active()) return 'Create a cutscene first';
  const conn = state.connection;
  if (!state.bridgeRunning) return 'Start the phone bridge to preview';
  if (conn.stale) return 'Studio not responding — reconnect in the panel';
  if (!conn.plugin) return 'Connect the Studio plugin to preview';
  if (!allClips().length) return 'Add a clip to preview';
  return '';
}

function renderTransportNote() {
  const note = $('transport-note');
  const blocker = state.preview ? '' : previewBlocker();
  note.textContent = blocker;
  note.classList.toggle('hidden', !blocker);
  $('preview-button').disabled = false;
  $('preview-button').classList.toggle('blocked', !!blocker);
}

/* ------------------------------------------------------------------- render */

function renderChrome() {
  const cutscene = active();
  const title = cutscene?.name ?? 'No cutscene';
  $('active-title').textContent = title;
  $('sequence-name').textContent = title;
  $('duration-meta').textContent = cutscene ? `${durationOf(cutscene).toFixed(1)} sec` : '—';
  const count = cutscene ? allClips(cutscene).length : 0;
  $('clip-count').textContent = `${count} clip${count === 1 ? '' : 's'}`;
  $('total-time').textContent = formatTime(cutscene ? durationOf(cutscene) : 0, cutscene?.fps);
  $('current-time').textContent = formatTime(state.playhead, cutscene?.fps);
  $('viewport-timecode').textContent = formatTime(state.playhead, cutscene?.fps);
  $('zoom-label').textContent = `${state.zoom}%`;
  $('play-state').textContent = state.preview ? 'PLAYBACK' : 'EDITING';

  const clip = selectedClip();
  $('sequence-label').textContent = state.preview ? 'PREVIEW PLAYBACK'
    : clip ? 'CLIP SELECTED'
    : state.selectedTrackId ? 'TRACK SELECTED'
    : 'NO ACTIVE TAKE';

  $('preview-button').classList.toggle('playing', state.preview);
  $('preview-button').innerHTML = `<span class="play-symbol">${state.preview ? '■' : '▶'}</span> ${state.preview ? 'Stop Preview' : 'Preview'}`;
  $('transport-play').textContent = state.preview ? '■' : '▶';

  const selection = clip
    ? `Selected: ${clip.name} · ${clip.duration.toFixed(1)}s`
    : state.selectedTrackId
      ? `Track: ${cutscene?.tracks.find(track => track.id === state.selectedTrackId)?.name ?? 'track'}`
      : 'No clip selected';
  $('selection-summary').textContent = selection;

  renderConnection();
  renderTakes(cutscene);
  publishCutscene();
}

function renderTimeline(cutscene = active()) {
  const ticks = $('ruler-ticks');
  const rows = $('track-rows');
  const scroll = $('timeline-scroll');
  const pps = pxPerSec();

  if (!cutscene) {
    $('ruler').style.width = '100%';
    ticks.innerHTML = '';
    rows.innerHTML = '<div class="lane-empty">Create a cutscene to start arranging clips.</div>';
    return;
  }

  const duration = Math.max(12, durationOf(cutscene) + 3);
  const step = TICK_STEPS.find(candidate => candidate * pps >= 64) ?? 60;
  const rulerWidth = duration * pps;

  $('ruler').style.width = `${rulerWidth}px`;
  $('ruler').style.flex = 'none';
  $('ruler').style.setProperty('--major', `${pps * step}px`);
  scroll.style.setProperty('--minor', `${Math.max(12, pps / 2)}px`);

  ticks.innerHTML = '';
  for (let sec = 0; sec <= duration + 1e-6; sec += step) {
    const label = document.createElement('span');
    label.className = 'tick-label';
    label.style.left = `${sec * pps}px`;
    const minutes = Math.floor(sec / 60);
    label.textContent = `${String(minutes).padStart(2, '0')}:${String(Math.round((sec - minutes * 60) * 100) / 100).padStart(2, '0')}`;
    ticks.append(label);
  }

  $('playhead').style.left = `${state.playhead * pps}px`;
  rows.innerHTML = '';

  cutscene.tracks.forEach(track => {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.classList.toggle('selected', track.id === state.selectedTrackId);

    const label = document.createElement('div');
    label.className = 'track-label';
    const color = document.createElement('i');
    color.className = 'track-color';
    color.style.background = TRACK_COLORS[track.type] || '#7b8492';
    const title = document.createElement('span');
    title.className = 'track-name';
    title.textContent = track.name;
    const type = document.createElement('span');
    type.className = 'track-type';
    type.textContent = track.type;
    // Name over type keeps the label column readable without eating the lane.
    const titleBlock = document.createElement('span');
    titleBlock.className = 'track-title';
    titleBlock.append(title, type);
    const tools = document.createElement('div');
    tools.className = 'track-tools';
    const lock = document.createElement('button');
    lock.textContent = track.locked ? '▣' : '⌑';
    lock.title = track.locked ? 'Unlock track' : 'Lock track';
    lock.classList.toggle('locked', track.locked);
    lock.addEventListener('click', event => { event.stopPropagation(); commitHistory(); track.locked = !track.locked; renderAll(); });
    const vis = document.createElement('button');
    vis.textContent = track.visible ? '◉' : '⊘';
    vis.title = 'Toggle track visibility';
    vis.addEventListener('click', event => { event.stopPropagation(); commitHistory(); track.visible = !track.visible; renderAll(); });
    const add = document.createElement('button');
    add.textContent = '+';
    add.title = 'Add clip';
    add.addEventListener('click', event => { event.stopPropagation(); selectTrack(track, false); openClipDialog(track.type, null, track); });
    tools.append(lock, vis, add);
    label.append(color, titleBlock, tools);
    label.addEventListener('pointerdown', () => selectTrack(track));
    row.append(label);

    const lane = document.createElement('div');
    lane.className = 'clip-lane';
    lane.style.width = `${rulerWidth}px`;
    lane.style.flex = 'none';
    lane.addEventListener('pointerdown', event => {
      if (event.target !== lane) return;
      clearSelection(false);
      selectTrack(track);
      beginScrub(event);
    });
    lane.addEventListener('contextmenu', event => {
      if (event.target !== lane) return;
      state.selectedTrackId = track.id;
      state.selectedClipId = null;
      renderAll();
      showContextMenu(event, trackMenuItems(track));
    });

    for (const clip of track.clips) {
      const node = document.createElement('div');
      node.className = 'clip';
      node.style.setProperty('--clip-color', TRACK_COLORS[track.type] || '#6b7480');
      node.style.left = `${clip.start * pps}px`;
      node.style.width = `${Math.max(35, clip.duration * pps)}px`;
      node.title = `${clip.name} • ${clip.duration.toFixed(2)} sec`;
      node.dataset.clipId = clip.id;
      node.classList.toggle('selected', clip.id === state.selectedClipId);

      const left = document.createElement('span');
      left.className = 'clip-handle left';
      left.addEventListener('pointerdown', event => beginClipDrag(event, clip, track, 'left'));
      const right = document.createElement('span');
      right.className = 'clip-handle right';
      right.addEventListener('pointerdown', event => beginClipDrag(event, clip, track, 'right'));
      const text = document.createElement('span');
      text.className = 'clip-label';
      text.textContent = clip.name;
      const meta = document.createElement('span');
      meta.className = 'clip-meta';
      meta.textContent = `${clip.duration.toFixed(1)}s`;
      node.append(left, text, meta, right);
      node.addEventListener('pointerdown', event => {
        if (event.target.classList.contains('clip-handle')) return;
        beginClipDrag(event, clip, track, 'move');
      });
    node.addEventListener('dblclick', event => {
      event.stopPropagation();
      state.selectedClipId = clip.id;
      openClipDialog(track.type, clip, track);
    });
    node.addEventListener('contextmenu', event => {
      state.selectedClipId = clip.id;
      state.selectedTrackId = track.id;
      renderAll();
      showContextMenu(event, clipMenuItems(clip, track));
    });
      lane.append(node);
    }

    if (!track.clips.length) {
      const hint = document.createElement('div');
      hint.className = 'lane-hint';
      hint.textContent = '＋ to add a clip';
      lane.append(hint);
    }

    row.append(lane);
    rows.append(row);
  });

  if (!allClips(cutscene).length) {
    const empty = document.createElement('div');
    empty.className = 'lane-empty';
    empty.textContent = 'No clips yet — press ＋ on a track, or use Quick add on the right.';
    rows.append(empty);
  }
}

function renderAll() { renderChrome(); renderTimeline(); }

function renderSequences() {
  const list = $('sequence-list');
  list.innerHTML = '';
  state.cutscenes.forEach(cutscene => {
    const button = document.createElement('button');
    button.className = 'sequence-choice';
    button.innerHTML = `<span>${escapeHtml(cutscene.name)}</span><small>${cutscene.tracks.reduce((n, t) => n + t.clips.length, 0)} clips · ${durationOf(cutscene).toFixed(1)}s</small>`;
    button.addEventListener('click', () => {
      state.activeId = cutscene.id;
      state.playhead = 0;
      clearSelection(false);
      $('sequence-dialog').close();
      renderAll();
    });
    list.append(button);
  });
  if (!state.cutscenes.length) list.textContent = 'No cutscenes yet.';
}

function renderTakes(cutscene) {
  const takes = [...(cutscene?.takes ?? [])];
  $('take-count').textContent = takes.length;
  const list = $('takes-list');
  list.innerHTML = '';
  if (!takes.length) {
    list.innerHTML = '<div class="empty-takes">Record on your phone once Studio is connected</div>';
    return;
  }
  takes.forEach((take, index) => {
    const row = document.createElement('div');
    row.className = 'take-item';
    row.innerHTML = `<span><strong>${escapeHtml(take.name ?? `Take ${index + 1}`)}</strong><small>${Number(take.samples?.length ?? 0)} motion samples · ${new Date(take.createdAt ?? Date.now()).toLocaleTimeString()}</small></span><button>Use</button>`;
    row.querySelector('button').addEventListener('click', () => applyTake(take));
    list.append(row);
  });
}

function publishCutscene() {
  const cutscene = active();
  if (!cutscene || !window.cineflow) return;
  const payload = { id: cutscene.id, name: cutscene.name, duration: durationOf(cutscene), tracks: cutscene.tracks };
  const serialized = JSON.stringify(payload);
  if (serialized === publishedCutscene) return;
  publishedCutscene = serialized;
  window.cineflow.setActiveCutscene(payload).catch(() => { publishedCutscene = ''; });
}

function onBridgeState(message) {
  state.raw = message ?? {};
  if (previewFrame.data && performance.now() - previewFrame.at > 2500) {
    previewFrame.data = null;
    drawPreview();
  }
  if (chromeRaf) return;
  chromeRaf = requestAnimationFrame(() => {
    chromeRaf = 0;
    if (state.drag) return;
    renderChrome();
  });
}

/* ----------------------------------------------------------------- timeline */

function snapValue(value, bypass = false) {
  const snapped = !bypass && state.snap;
  return snapped ? Math.max(0, Math.round(value / state.snapInterval) * state.snapInterval) : Math.max(0, value);
}

function beginClipDrag(event, clip, track, mode) {
  if (track.locked) { toast('Unlock the track to move clips.', true); return; }
  event.preventDefault();
  event.stopPropagation();
  commitHistory();
  state.selectedClipId = clip.id;
  state.selectedTrackId = track.id;
  state.drag = { clip, track, mode, startX: event.clientX, originalStart: clip.start, originalDuration: clip.duration };
  window.addEventListener('pointermove', moveClip);
  window.addEventListener('pointerup', endClip, { once: true });
  renderAll();
}

function showGhost(event, text) {
  const ghost = $('drag-ghost');
  ghost.textContent = text;
  ghost.classList.remove('hidden');
  ghost.style.left = `${event.clientX + 14}px`;
  ghost.style.top = `${event.clientY - 30}px`;
}

function moveClip(event) {
  const drag = state.drag;
  if (!drag) return;
  const delta = (event.clientX - drag.startX) / pxPerSec();
  const bypass = event.altKey;
  const snapLabel = bypass ? 'free' : `${state.snapInterval}s`;

  if (drag.mode === 'move') drag.clip.start = snapValue(drag.originalStart + delta, bypass);
  if (drag.mode === 'right') drag.clip.duration = Math.max(0.1, snapValue(drag.originalDuration + delta, bypass));
  if (drag.mode === 'left') {
    const end = drag.originalStart + drag.originalDuration;
    const start = Math.min(end - 0.1, snapValue(drag.originalStart + delta, bypass));
    drag.clip.start = start;
    drag.clip.duration = Math.max(0.1, end - start);
  }

  showGhost(event, `${drag.clip.start.toFixed(2)}s → ${(drag.clip.start + drag.clip.duration).toFixed(2)}s · ${drag.clip.duration.toFixed(2)}s · ${snapLabel}`);
  renderTimeline(active());
  $('current-time').textContent = formatTime(state.playhead, active()?.fps);
}

function endClip() {
  window.removeEventListener('pointermove', moveClip);
  state.drag = null;
  $('drag-ghost').classList.add('hidden');
  markDirty();
  renderAll();
}

function setPlayhead(value) {
  const cutscene = active();
  state.playhead = Math.max(0, Math.min(value, cutscene ? durationOf(cutscene) : 0));
  $('playhead').style.left = `${state.playhead * pxPerSec()}px`;
  $('current-time').textContent = formatTime(state.playhead, cutscene?.fps);
  $('viewport-timecode').textContent = formatTime(state.playhead, cutscene?.fps);
}

/* Scrub: press anywhere on the ruler or the empty timeline body and drag the
   playhead, the way an editor transport works. Position is frame-quantized. */
function scrubTo(clientX) {
  const cutscene = active();
  const fps = cutscene?.fps || 30;
  const rect = $('ruler').getBoundingClientRect();
  const seconds = (clientX - rect.left) / pxPerSec();
  setPlayhead(Math.max(0, Math.round(seconds * fps)) / fps);
}

function moveScrub(event) {
  if (!state.scrubbing) return;
  scrubTo(event.clientX);
}

function endScrub() {
  if (!state.scrubbing) return;
  state.scrubbing = false;
  $('timeline-scroll').classList.remove('scrubbing');
  window.removeEventListener('pointermove', moveScrub);
}

function beginScrub(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  if (state.preview) {
    state.preview = false;
    state.frameClock = null;
    cancelAnimationFrame(raf);
    window.cineflow?.command('stop-preview');
    renderAll();
  }
  state.scrubbing = true;
  $('timeline-scroll').classList.add('scrubbing');
  scrubTo(event.clientX);
  window.addEventListener('pointermove', moveScrub);
  window.addEventListener('pointerup', endScrub, { once: true });
}

function tick(timestamp) {
  if (!state.preview) return;
  const cutscene = active();
  if (state.frameClock === null) state.frameClock = timestamp;
  const delta = Math.min(0.25, Math.max(0, (timestamp - state.frameClock) / 1000));
  state.frameClock = timestamp;
  setPlayhead(state.playhead + delta);
  if (state.playhead >= durationOf(cutscene)) {
    setPlayhead(0);
    state.preview = false;
    state.frameClock = null;
    window.cineflow?.command('stop-preview');
    renderAll();
    return;
  }
  raf = requestAnimationFrame(tick);
}

function togglePreview() {
  if (!active()) { toast('Create a cutscene first.', true); return; }
  if (!state.preview) {
    const blocker = previewBlocker();
    if (blocker) { toast(blocker, true); return; }
    state.preview = true;
    state.frameClock = null;
    window.cineflow?.command('preview', { start: state.playhead });
    raf = requestAnimationFrame(tick);
  } else {
    state.preview = false;
    state.frameClock = null;
    cancelAnimationFrame(raf);
    window.cineflow?.command('stop-preview');
  }
  renderAll();
}

function clearSelection(render = true) {
  state.selectedClipId = null;
  state.selectedTrackId = null;
  if (render) renderAll();
}

function selectTrack(track, render = true) {
  state.selectedTrackId = track?.id ?? null;
  if (render) renderAll();
}

/* -------------------------------------------------------------------- clips */

function openClipDialog(type, clip = null, track = null) {
  const dialog = $('clip-dialog');
  const defaults = CLIP_DEFAULTS[type] ?? { duration: 2, label: 'Clip' };
  const isTrigger = type === 'trigger';
  const isCamera = type === 'camera';

  $('clip-dialog-title').textContent = clip ? 'Edit clip' : `Add ${type} clip`;
  $('trigger-field').classList.toggle('hidden', !isTrigger);
  $('rig-field').classList.toggle('hidden', isTrigger || isCamera);
  $('animation-field').classList.toggle('hidden', isTrigger || isCamera);
  $('camera-fields').classList.toggle('hidden', !isCamera);

  $('clip-label').value = clip?.name ?? defaults.label;
  $('clip-start').value = clip?.start ?? Number(state.playhead.toFixed(2));
  $('clip-duration').value = clip?.duration ?? defaults.duration;
  $('clip-rig').value = clip?.rig ?? state.lastRig;
  $('clip-asset').value = clip?.assetId ?? state.lastAnimationId;
  $('clip-trigger').value = clip?.triggerPart ?? '';
  $('clip-alpha').value = clip?.rotation?.alpha ?? 0;
  $('clip-beta').value = clip?.rotation?.beta ?? 0;
  $('clip-gamma').value = clip?.rotation?.gamma ?? 0;
  $('clip-easing').value = clip?.easing ?? 'Linear';
  $('delete-clip').classList.toggle('hidden', !clip);

  $('apply-clip').onclick = event => {
    event.preventDefault();
    const cutscene = active();
    if (!cutscene) return;

    let targetTrack = track;
    if (!targetTrack) {
      targetTrack = cutscene.tracks.find(item => item.type === type);
      if (!targetTrack) {
        targetTrack = { id: uid('track'), name: titleFor(type), type, locked: false, visible: true, clips: [] };
        cutscene.tracks.push(targetTrack);
      }
    }
    if (targetTrack.locked) { toast('Unlock the timeline track first.', true); return; }

    commitHistory();
    const item = clip ?? { id: uid('clip') };
    item.name = $('clip-label').value.trim() || defaults.label;
    item.start = snapValue(Number($('clip-start').value) || 0);
    item.duration = Math.max(0.1, Number($('clip-duration').value) || defaults.duration);
    item.easing = $('clip-easing').value;

    if (type === 'animation') {
      item.rig = $('clip-rig').value.trim();
      item.assetId = $('clip-asset').value.trim();
      if (item.rig) state.lastRig = item.rig;
      if (item.assetId) state.lastAnimationId = item.assetId;
    }
    if (type === 'trigger') item.triggerPart = $('clip-trigger').value.trim();
    if (type === 'camera') {
      item.rotation = {
        alpha: Number($('clip-alpha').value) || 0,
        beta: Number($('clip-beta').value) || 0,
        gamma: Number($('clip-gamma').value) || 0
      };
    }
    if (!clip) targetTrack.clips.push(item);

    state.selectedClipId = item.id;
    state.selectedTrackId = targetTrack.id;
    cutscene.duration = Math.max(cutscene.duration, item.start + item.duration);
    dialog.close();
    renderAll();
  };

  $('delete-clip').onclick = () => {
    const cutscene = active();
    if (!cutscene || !clip) return;
    commitHistory();
    for (const track of cutscene.tracks) track.clips = track.clips.filter(item => item.id !== clip.id);
    state.selectedClipId = null;
    dialog.close();
    renderAll();
  };

  dialog.showModal();
}

function titleFor(type) {
  return type === 'camera' ? 'Camera' : type === 'trigger' ? 'Triggers' : type === 'audio' ? 'Audio' : 'Animations';
}

function duplicateSelected() {
  const cutscene = active();
  if (!cutscene) return;
  for (const track of cutscene.tracks) {
    const original = track.clips.find(item => item.id === state.selectedClipId);
    if (!original) continue;
    commitHistory();
    const copy = structuredClone(original);
    copy.id = uid('clip');
    copy.name = `${copy.name} copy`;
    copy.start = snapValue(copy.start + copy.duration);
    track.clips.push(copy);
    state.selectedClipId = copy.id;
    cutscene.duration = Math.max(cutscene.duration, copy.start + copy.duration);
    renderAll();
    return;
  }
  toast('Select a clip to duplicate.', true);
}

function deleteSelected() {
  const cutscene = active();
  if (!cutscene || !state.selectedClipId) return;
  commitHistory();
  for (const track of cutscene.tracks) track.clips = track.clips.filter(item => item.id !== state.selectedClipId);
  state.selectedClipId = null;
  renderAll();
}

/* ------------------------------------------------------------ clip actions */

function stripClipMeta(clip) {
  const { trackId, trackType, ...rest } = clip;
  return rest;
}

function copySelectedClip(silent = false) {
  const clip = selectedClip();
  if (!clip) { if (!silent) toast('Select a clip to copy.', true); return false; }
  state.clipboard = { clip: structuredClone(stripClipMeta(clip)), trackType: clip.trackType };
  if (!silent) toast(`Copied “${clip.name}”.`);
  return true;
}

function cutSelectedClip() {
  if (!copySelectedClip(true)) { toast('Select a clip to cut.', true); return; }
  deleteSelected();
  toast('Clip cut.');
}

function pasteClip(track = null) {
  const data = state.clipboard;
  const cutscene = active();
  if (!data) { toast('Nothing to paste yet — copy a clip first.', true); return; }
  if (!cutscene) return;
  const target = track ?? cutscene.tracks.find(item => item.type === data.trackType) ?? cutscene.tracks[0];
  if (!target) { toast('Add a track before pasting.', true); return; }
  if (target.locked) { toast('Unlock the track to paste.', true); return; }
  commitHistory();
  const clip = structuredClone(data.clip);
  clip.id = uid('clip');
  clip.start = snapValue(state.playhead);
  clip.duration = Math.max(0.1, Number(clip.duration) || 1);
  target.clips.push(clip);
  state.selectedClipId = clip.id;
  state.selectedTrackId = target.id;
  cutscene.duration = Math.max(cutscene.duration, clip.start + clip.duration);
  renderAll();
  toast(`Pasted into ${target.name}.`);
}

function splitClip(clip, track) {
  const cutscene = active();
  if (!cutscene || !track) return;
  if (track.locked) { toast('Unlock the track to split clips.', true); return; }
  const start = Number(clip.start) || 0;
  const end = start + (Number(clip.duration) || 0);
  const at = state.playhead;
  if (at <= start + 1e-3 || at >= end - 1e-3) { toast('Put the playhead inside the clip to split it.', true); return; }
  commitHistory();
  const offset = at - start;
  const right = structuredClone(clip);
  right.id = uid('clip');
  right.name = `${clip.name} B`;
  right.start = at;
  right.duration = end - at;
  if (Array.isArray(clip.keyframes)) {
    // Camera-take keyframes are relative to the clip start, so the right half rebases them.
    right.keyframes = clip.keyframes
      .filter(frame => Number(frame.time) >= offset)
      .map(frame => ({ ...frame, time: Number(frame.time) - offset }));
    clip.keyframes = clip.keyframes.filter(frame => Number(frame.time) < offset);
  }
  clip.duration = offset;
  track.clips.push(right);
  state.selectedClipId = right.id;
  cutscene.duration = Math.max(cutscene.duration, right.start + right.duration);
  renderAll();
  toast('Clip split at the playhead.');
}

function splitSelected() {
  const cutscene = active();
  if (!cutscene) return;
  for (const track of cutscene.tracks) {
    const clip = track.clips.find(item => item.id === state.selectedClipId);
    if (clip) { splitClip(clip, track); return; }
  }
  toast('Select a clip to split.', true);
}

function deleteTrack(track) {
  const cutscene = active();
  if (!cutscene) return;
  if (cutscene.tracks.length <= 1) { toast('A cutscene needs at least one track.', true); return; }
  if (track.clips.length && !confirm(`Delete “${track.name}” and its ${track.clips.length} clip(s)?`)) return;
  commitHistory();
  cutscene.tracks = cutscene.tracks.filter(item => item.id !== track.id);
  if (state.selectedTrackId === track.id) state.selectedTrackId = null;
  if (!selectedClip()) state.selectedClipId = null;
  renderAll();
  toast('Track deleted.');
}

/* ------------------------------------------------------------ context menu */

function hideContextMenu() {
  const menu = $('context-menu');
  menu.classList.add('hidden');
  menu.innerHTML = '';
  document.removeEventListener('pointerdown', dismissContextMenu, true);
  window.removeEventListener('blur', hideContextMenu);
  window.removeEventListener('resize', hideContextMenu);
}

function dismissContextMenu(event) {
  if (event.target.closest?.('#context-menu')) return;
  hideContextMenu();
}

function showContextMenu(event, items) {
  event.preventDefault();
  event.stopPropagation();
  hideContextMenu();
  const menu = $('context-menu');
  for (const item of items) {
    if (item === '-') {
      const line = document.createElement('div');
      line.className = 'menu-separator';
      menu.append(line);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.className = `menu-item${item.danger ? ' danger' : ''}`;
    button.disabled = !!item.disabled;
    const label = document.createElement('span');
    label.textContent = item.label;
    button.append(label);
    if (item.hint) {
      const hint = document.createElement('kbd');
      hint.textContent = item.hint;
      button.append(hint);
    }
    button.addEventListener('click', () => { hideContextMenu(); item.action?.(); });
    menu.append(button);
  }
  menu.classList.remove('hidden');
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
  document.addEventListener('pointerdown', dismissContextMenu, true);
  window.addEventListener('blur', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);
}

function clipMenuItems(clip, track) {
  const inside = state.playhead > clip.start + 1e-3 && state.playhead < clip.start + clip.duration - 1e-3;
  return [
    { label: 'Edit clip…', hint: 'Double-click', action: () => openClipDialog(track.type, clip, track) },
    '-',
    { label: 'Cut', hint: 'Ctrl+X', action: () => cutSelectedClip() },
    { label: 'Copy', hint: 'Ctrl+C', action: () => copySelectedClip() },
    { label: 'Duplicate', hint: 'Ctrl+D', action: () => duplicateSelected() },
    { label: 'Paste at playhead', hint: 'Ctrl+V', disabled: !state.clipboard, action: () => pasteClip(track) },
    '-',
    { label: 'Split at playhead', hint: 'S', disabled: !inside, action: () => splitClip(clip, track) },
    '-',
    { label: 'Delete clip', hint: 'Del', danger: true, action: () => { state.selectedClipId = clip.id; deleteSelected(); } }
  ];
}

function trackMenuItems(track) {
  return [
    { label: 'Add clip here', action: () => openClipDialog(track.type, null, track) },
    { label: 'Paste clip here', hint: 'Ctrl+V', disabled: !state.clipboard, action: () => pasteClip(track) },
    '-',
    { label: track.locked ? 'Unlock track' : 'Lock track', action: () => { commitHistory(); track.locked = !track.locked; renderAll(); } },
    { label: track.visible ? 'Hide track' : 'Show track', action: () => { commitHistory(); track.visible = !track.visible; renderAll(); } },
    '-',
    { label: 'Delete track', danger: true, action: () => deleteTrack(track) }
  ];
}

function rulerMenuItems() {
  return [
    { label: 'Add animation track', action: () => addTrack('animation') },
    { label: 'Add camera track', action: () => addTrack('camera') },
    '-',
    { label: 'Fit timeline to cutscene', hint: 'F', action: fitTimeline }
  ];
}

function addTrack(type = 'animation') {
  const cutscene = active();
  if (!cutscene) { toast('Create a cutscene first.', true); return; }
  commitHistory();
  cutscene.tracks.push({ id: uid('track'), name: titleFor(type), type, locked: false, visible: true, clips: [] });
  renderAll();
}

function applyTake(take) {
  const cutscene = active();
  if (!cutscene) return;
  const samples = take.samples ?? [];
  if (!samples.length) { toast('This take contains no motion samples.', true); return; }

  let track = cutscene.tracks.find(item => item.type === 'camera');
  if (!track) {
    track = { id: uid('track'), name: 'Phone Camera Take', type: 'camera', locked: false, visible: true, clips: [] };
    cutscene.tracks.push(track);
  }

  commitHistory();
  cutscene.takes ??= [];
  if (!cutscene.takes.some(item => item.id === take.id)) cutscene.takes.push(take);

  const sampled = [];
  // Keep the recorded density (up to a sane cap) so the acted motion survives.
  const stride = Math.max(1, Math.ceil(samples.length / 900));
  for (let index = 0; index < samples.length; index += stride) {
    const sample = samples[index];
    sampled.push({
      time: Number(sample.time ?? index / 30),
      rotation: { alpha: Number(sample.alpha) || 0, beta: Number(sample.beta) || 0, gamma: Number(sample.gamma) || 0 }
    });
  }
  const last = samples[samples.length - 1];
  const lastKey = sampled[sampled.length - 1];
  if (Number(last.time ?? 0) > lastKey.time) {
    sampled.push({
      time: Number(last.time),
      rotation: { alpha: Number(last.alpha) || 0, beta: Number(last.beta) || 0, gamma: Number(last.gamma) || 0 }
    });
  }

  const start = Number(sampled[0].time) || 0;
  const keyframes = sampled.map(frame => ({ ...frame, time: frame.time - start }));
  const clip = {
    id: uid('clip'),
    name: take.name ?? 'Phone Camera Take',
    start,
    duration: Math.max(1 / 30, keyframes[keyframes.length - 1].time),
    easing: 'Linear',
    keyframes,
    kind: 'camera-take',
    // The world anchor the take was recorded from. Playback pivots here instead of
    // wherever the Studio camera happens to sit, which is what moved the shot before.
    base: Array.isArray(take.base) && take.base.length >= 12 ? take.base : null
  };
  track.clips.push(clip);
  state.selectedClipId = clip.id;
  state.selectedTrackId = track.id;
  cutscene.duration = Math.max(cutscene.duration, Number(last.time) || 1);
  renderAll();
  toast(`Take added to the camera track · ${clip.duration.toFixed(1)}s`);
}

/* ------------------------------------------------------------------ bridge */

async function connectBridge() {
  if (!window.cineflow) { toast('Desktop bridge is unavailable.', true); return; }
  try {
    bridgeInfo = await window.cineflow.startBridge();
    state.bridgeRunning = true;
    publishedCutscene = '';

    const cutscene = active();
    if (cutscene) {
      await window.cineflow.setActiveCutscene({
        id: cutscene.id, name: cutscene.name, duration: durationOf(cutscene), tracks: cutscene.tracks
      });
    }

    $('qr-image').src = bridgeInfo.qr;
    $('phone-url').textContent = bridgeInfo.url;
    $('qr-placeholder').classList.add('hidden');
    $('qr-container').classList.remove('hidden');
    $('phone-secure-setup').classList.remove('hidden');
    $('setup-qr-image').src = bridgeInfo.setupQr;
    $('phone-setup-url').textContent = bridgeInfo.phoneSetupUrl;
    $('ca-fingerprint').textContent = bridgeInfo.caFingerprint;
    $('bridge-button').textContent = 'Bridge running';
    $('bridge-button').disabled = true;

    renderChrome();
    toast('Bridge started — now connect the Studio plugin, then scan the QR.');
  } catch (error) {
    toast(`Could not start phone bridge: ${error.message}`, true);
  }
}

/* --------------------------------------------------------- studio preview */

const previewFrame = { data: null, at: 0, pending: 0 };

function handlePreviewFrame(payload) {
  const frame = payload?.preview ?? payload;
  if (!frame || frame.active === false) {
    previewFrame.data = null;
    if (!previewFrame.pending) previewFrame.pending = requestAnimationFrame(drawPreview);
    return;
  }
  const camera = frame.camera ?? frame.cf;
  if (!Array.isArray(camera) || camera.length < 12) return;
  previewFrame.data = { ...frame, camera, mode: frame.recording ? 'record' : 'preview', playhead: frame.time };
  previewFrame.at = performance.now();
  if (!previewFrame.pending) previewFrame.pending = requestAnimationFrame(drawPreview);
}

function previewBasis(camera) {
  // Roblox CFrame components: x y z R00 R01 R02 R10 R11 R12 R20 R21 R22
  return {
    position: [camera[0], camera[1], camera[2]],
    right: [camera[3], camera[6], camera[9]],
    up: [camera[4], camera[7], camera[10]],
    forward: [-camera[5], -camera[8], -camera[11]]
  };
}

function drawPreview() {
  previewFrame.pending = 0;
  const canvas = $('preview-canvas');
  const viewport = canvas?.parentElement;
  if (!canvas || !viewport) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const live = !!previewFrame.data && performance.now() - previewFrame.at < 2500;
  viewport.classList.toggle('is-live', live);
  $('preview-live').classList.toggle('hidden', !live);
  if (!live) return;

  const frame = previewFrame.data;
  const cam = previewBasis(frame.camera);
  const fov = (Number(frame.fov) || 70) * Math.PI / 180;
  const focal = (rect.height / 2) / Math.tan(fov / 2);
  const cx = rect.width / 2;
  const cy = rect.height / 2;  const NEAR = 0.3;

  // View-space transform, kept separate from projection so geometry that crosses
  // the near plane can be clipped instead of thrown away.
  const toView = point => {
    const dx = point[0] - cam.position[0];
    const dy = point[1] - cam.position[1];
    const dz = point[2] - cam.position[2];
    return {
      x: dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2],
      y: dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2],
      z: dx * cam.forward[0] + dy * cam.forward[1] + dz * cam.forward[2]
    };
  };
  const toScreen = view => ({ x: cx + (view.x / view.z) * focal, y: cy - (view.y / view.z) * focal });
  const mix = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

  // Clips a world-space segment to the near plane and appends it to the path.
  const clipSegment = (from, to) => {
    let a = toView(from);
    let b = toView(to);
    if (a.z < NEAR && b.z < NEAR) return false;
    if (a.z < NEAR) a = mix(a, b, (NEAR - a.z) / (b.z - a.z));
    else if (b.z < NEAR) b = mix(b, a, (NEAR - b.z) / (a.z - b.z));
    const start = toScreen(a);
    const end = toScreen(b);
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    return true;
  };
  const strokeSegment = (from, to) => {
    ctx.beginPath();
    if (clipSegment(from, to)) ctx.stroke();
  };

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(126,224,176,0.14)';
  for (let i = -20; i <= 20; i += 5) {
    for (const line of [[[i, 0, -20], [i, 0, 20]], [[-20, 0, i], [20, 0, i]]]) {
      strokeSegment(line[0], line[1]);
    }
  }

  const source = Array.isArray(frame.parts) ? frame.parts : Array.isArray(frame.items) ? frame.items : [];
  const items = source
    .map(item => {
      const matrix = Array.isArray(item.cf) ? item.cf.map(Number) : null;
      const center = Array.isArray(item.center) ? item.center.map(Number) : matrix ? matrix.slice(0, 3) : null;
      if (!center) return null;
      const view = toView(center);
      return { item, matrix, center, view, p: view.z > NEAR ? toScreen(view) : null };
    })
    .filter(Boolean)
    .sort((a, b) => b.view.z - a.view.z);

  // Each part is drawn as its real oriented box, so the proxy reads as a room
  // instead of a scatter of dots and the framing actually matches Studio.
  const edgePairs = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

  for (const { item, matrix, center, view, p } of items) {
    const anchor = item.kind === 'anchor';
    const color = anchor ? '#7ee0b0' : '#9aa4b0';
    const size = Array.isArray(item.size) ? item.size.map(value => Math.abs(Number(value)) || 0) : [2, 2, 2];
    const corners = [];
    let drawn = false;

    if (matrix) {
      const axis = offset => [matrix[offset], matrix[offset + 3], matrix[offset + 6]];
      const rightAxis = axis(3);
      const upAxis = axis(4);
      const backAxis = axis(5);
      for (let index = 0; index < 8; index += 1) {
        const sx = index & 4 ? 1 : -1;
        const sy = index & 2 ? 1 : -1;
        const sz = index & 1 ? 1 : -1;
        corners.push([0, 1, 2].map(axisIndex => center[axisIndex]
          + rightAxis[axisIndex] * (size[0] / 2) * sx
          + upAxis[axisIndex] * (size[1] / 2) * sy
          + backAxis[axisIndex] * (size[2] / 2) * sz));
      }
    }

    if (corners.length === 8) {
      ctx.strokeStyle = `${color}${anchor ? 'ee' : '77'}`;
      ctx.lineWidth = anchor ? 1.6 : 1;
      ctx.beginPath();
      let edges = 0;
      for (const [from, to] of edgePairs) if (clipSegment(corners[from], corners[to])) edges += 1;
      if (edges) { ctx.stroke(); drawn = true; }
    }

    if (!drawn && p) {
      const radius = Math.max(2, Math.min(rect.width / 2, (Math.max(...size) / 2 / view.z) * focal));
      ctx.strokeStyle = color;
      ctx.lineWidth = anchor ? 2 : 1;
      ctx.strokeRect(p.x - radius, p.y - radius, radius * 2, radius * 2);
    }

    if (anchor) {
      // A take is normally shot standing on its own anchor, so the marker can sit
      // exactly at the eye and project to nothing. Ring the reticle instead.
      const markerX = p ? p.x : cx;
      const markerY = p ? p.y : cy;
      if (!p) {
        ctx.strokeStyle = 'rgba(126,224,176,0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, 21, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(231,228,223,0.86)';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText('camera anchor', markerX + 9, markerY + 3);
    }
  }

  const mode = frame.mode === 'record' ? 'RECORDING' : frame.mode === 'preview' ? 'PLAYBACK' : 'PHONE AIM';
  const seconds = frame.playhead != null ? ` · ${Number(frame.playhead).toFixed(2)}s` : '';
  ctx.fillStyle = 'rgba(231,228,223,0.58)';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText(`${mode} · ${items.length} object${items.length === 1 ? '' : 's'}${seconds}`, 14, rect.height - 30);
}

function handleMotion(motion) {
  if (!motion) return;
  if (![motion.alpha, motion.beta, motion.gamma].every(Number.isFinite)) return;
  state.latestMotion = motion;
}

async function refreshTakes() {
  const files = await window.cineflow?.listTakes?.() ?? [];
  const cutscene = active();
  if (!cutscene) return;
  for (const file of files) {
    const take = file.content;
    if (take && !cutscene.takes?.some(item => item.id === take.id)) cutscene.takes = [...(cutscene.takes ?? []), take];
  }
  renderTakes(cutscene);
}

/* ------------------------------------------------------------------ project */

function saveProject() {
  const cutscene = active();
  if (!cutscene) { toast('Create a cutscene first.', true); return; }
  if (!window.cineflow?.saveCutscene) { toast('Saving is unavailable in this build.', true); return; }
  window.cineflow.saveCutscene(cutscene)
    .then(result => {
      if (result.canceled) return;
      markClean();
      $('save-location').textContent = result.filePath ?? 'Cutscene saved';
      toast('Cutscene saved.');
    })
    .catch(error => toast(`Save failed: ${error.message}`, true));
}

function openProject() {
  if (!window.cineflow?.openCutscene) { toast('Opening is unavailable in this build.', true); return; }
  window.cineflow.openCutscene()
    .then(result => {
      if (result.canceled) return;
      const cutscene = result.content;
      if (!cutscene || cutscene.schemaVersion !== 1 || !Array.isArray(cutscene.tracks)) throw new Error('Unsupported cutscene file.');
      cutscene.takes ??= [];
      state.cutscenes.push(cutscene);
      state.activeId = cutscene.id;
      state.playhead = 0;
      state.history = [];
      state.future = [];
      clearSelection(false);
      markClean();
      $('save-location').textContent = result.filePath ?? 'Cutscene opened';
      renderAll();
      toast('Cutscene opened.');
    })
    .catch(error => toast(`Could not open cutscene: ${error.message}`, true));
}

function newSequence() {
  const cutscene = newCutscene(`Cutscene ${state.cutscenes.length + 1}`);
  state.cutscenes.push(cutscene);
  state.activeId = cutscene.id;
  state.playhead = 0;
  clearSelection(false);
  markClean();
  renderAll();
  toast('New cutscene created.');
}

function renameSequence() {
  const cutscene = active();
  if (!cutscene) return;
  const name = prompt('Cutscene name', cutscene.name);
  if (name?.trim()) {
    commitHistory();
    cutscene.name = name.trim();
    renderAll();
  }
}

function changeZoom(delta, clientX) {
  const scroll = $('timeline-scroll');
  const before = pxPerSec();
  const next = Math.max(40, Math.min(240, state.zoom + delta));
  if (next === state.zoom) return;

  const rect = scroll.getBoundingClientRect();
  const offset = typeof clientX === 'number' ? clientX - rect.left : rect.width / 2;
  const anchorTime = (scroll.scrollLeft + offset) / before;

  state.zoom = next;
  renderTimeline(active());
  $('zoom-label').textContent = `${state.zoom}%`;

  scroll.scrollLeft = Math.max(0, anchorTime * pxPerSec() - offset);
}

function fitTimeline() {
  const cutscene = active();
  if (!cutscene) return;
  const scroll = $('timeline-scroll');
  const available = Math.max(240, scroll.clientWidth - 160);
  const total = Math.max(1, durationOf(cutscene) + 1);
  state.zoom = Math.max(40, Math.min(240, (available / total) / 0.6));
  scroll.scrollLeft = 0;
  renderTimeline(cutscene);
  $('zoom-label').textContent = `${Math.round(state.zoom)}%`;
}

/* --------------------------------------------------------------------- init */

function openGuide() { $('guide-dialog').showModal(); }

function initGuide() {
  $('open-guide').addEventListener('click', openGuide);
  $('guide-dialog').addEventListener('close', () => {
    if ($('guide-dismiss').checked) {
      try { localStorage.setItem(GUIDE_KEY, '1'); } catch { /* storage unavailable */ }
    }
  });
  let dismissed = false;
  try { dismissed = localStorage.getItem(GUIDE_KEY) === '1'; } catch { dismissed = false; }
  if (!dismissed) setTimeout(openGuide, 500);
}

function init() {
  const first = newCutscene();
  state.cutscenes = [first];
  state.activeId = first.id;
  renderAll();
  initGuide();

  window.cineflow?.onState(onBridgeState);
  window.cineflow?.onMotion(handleMotion);
  window.cineflow?.onPluginPreview?.(handlePreviewFrame);
  window.cineflow?.onPreview(handlePreviewFrame);

  $('bridge-button').addEventListener('click', connectBridge);
  $('preview-button').addEventListener('click', togglePreview);
  $('transport-play').addEventListener('click', togglePreview);
  $('calibrate-desktop').addEventListener('click', () => {
    if (!state.connection.plugin) { toast('Connect the Studio plugin before calibrating.', true); return; }
    window.cineflow?.command('calibrate');
    toast('Asked Studio to reset the camera neutral pose.');
  });
  $('save-project').addEventListener('click', saveProject);
  $('open-project').addEventListener('click', openProject);
  $('export-plugin').addEventListener('click', () => {
    if (!window.cineflow?.exportPlugin) { toast('Plugin export is unavailable in this build.', true); return; }
    window.cineflow.exportPlugin()
      .then(result => { if (!result.canceled) toast(`Studio plugin exported${result.filePath ? ` to ${result.filePath}` : ''}.`); })
      .catch(error => toast(error.message, true));
  });

  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('zoom-in').addEventListener('click', () => changeZoom(10));
  $('zoom-out').addEventListener('click', () => changeZoom(-10));
  $('fit-timeline').addEventListener('click', fitTimeline);
  $('snap-checkbox').addEventListener('change', event => { state.snap = event.target.checked; $('snap-toggle').classList.toggle('active', state.snap); });
  $('snap-toggle').addEventListener('click', event => {
    state.snap = !state.snap;
    $('snap-checkbox').checked = state.snap;
    event.currentTarget.classList.toggle('active', state.snap);
  });
  $('snap-unit').addEventListener('change', event => { state.snapInterval = Number(event.target.value); });
  $('add-track').addEventListener('click', () => addTrack('animation'));
  document.querySelectorAll('[data-track]').forEach(button => button.addEventListener('click', () => addTrack(button.dataset.track)));
  $('new-sequence').addEventListener('click', newSequence);
  $('sequence-menu').addEventListener('click', () => { renderSequences(); $('sequence-dialog').showModal(); });
  $('rename-sequence').addEventListener('click', renameSequence);
  $('refresh-takes').addEventListener('click', () => refreshTakes().then(() => toast('Takes refreshed.')));
  $('to-start').addEventListener('click', () => setPlayhead(0));
  $('to-end').addEventListener('click', () => setPlayhead(durationOf(active())));
  $('step-back').addEventListener('click', () => setPlayhead(state.playhead - 1 / (active()?.fps || 30)));
  $('step-forward').addEventListener('click', () => setPlayhead(state.playhead + 1 / (active()?.fps || 30)));
  $('track-menu').addEventListener('click', () => {
    if (confirm('Add an animation track?')) addTrack('animation');
  });

  $('ruler').addEventListener('pointerdown', beginScrub);
  $('ruler').addEventListener('contextmenu', event => {
    scrubTo(event.clientX);
    showContextMenu(event, rulerMenuItems());
  });

  // The WebView's own menu (Back / Refresh / Inspect) has no place in an editor;
  // text fields keep theirs so paste-in works.
  document.addEventListener('contextmenu', event => {
    if (event.target.closest?.('#context-menu')) { event.preventDefault(); return; }
    if (event.target.matches?.('input, textarea')) return;
    event.preventDefault();
  });

  $('timeline-scroll').addEventListener('wheel', event => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    changeZoom(event.deltaY > 0 ? -5 : 5, event.clientX);
  }, { passive: false });

  document.addEventListener('keydown', event => {
    if (event.target instanceof Element && event.target.matches('input,textarea,select')) return;
    const cutscene = active();
    const fps = cutscene?.fps || 30;
    const mod = event.ctrlKey || event.metaKey;

    if (event.code === 'Space') { event.preventDefault(); togglePreview(); }
    else if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    else if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelected(); }
    else if (mod && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelectedClip(); }
    else if (mod && event.key.toLowerCase() === 'x') { event.preventDefault(); cutSelectedClip(); }
    else if (mod && event.key.toLowerCase() === 'v') { event.preventDefault(); pasteClip(); }
    else if (!mod && event.key.toLowerCase() === 's') { event.preventDefault(); splitSelected(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); setPlayhead(state.playhead - 1 / fps); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); setPlayhead(state.playhead + 1 / fps); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelected(); }
    else if (event.key === 'Escape') { hideContextMenu(); clearSelection(); }
    else if (event.key.toLowerCase() === 'f') { event.preventDefault(); fitTimeline(); }
  });

  window.cineflow?.getState().then(onBridgeState).catch(() => {});
}

init();
