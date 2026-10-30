const params = new URLSearchParams(location.search);
const token = params.get('token');
const $ = id => document.getElementById(id);
const connection = $('connection');
const status = $('status');
const angleReadout = $('angle-readout');
const phoneState = $('phone-state');
const takeStatus = $('take-status');
const enableButton = $('enable');
const calibrateButton = $('calibrate');
const recordButton = $('record');
const sensorNote = $('sensor-note');
const studioWarning = $('studio-warning');
const recordStepNote = $('record-step-note');

let socket;
let connected = false;
let pluginConnected = false;
let sensorEnabled = false;
let recording = false;
let rawAngles = null;
let neutral = null;
let lastSent = 0;
let lastMessageAt = 0;
let recordStartedAt = 0;
let recordTicker = null;

/* Unwrapped yaw so filtering and interpolation never cross the ±180 seam. */
let unwrappedAlpha = null;

function oneEuro(minCutoff = 1.4, beta = 0.02, derivativeCutoff = 1) {
  let value = null;
  let derivative = 0;
  let previousTime = null;
  const alphaFor = (cutoff, dt) => {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  };
  return (next, time) => {
    if (value === null) { value = next; previousTime = time; return value; }
    const dt = Math.max(1 / 240, (time - previousTime) / 1000);
    previousTime = time;
    const rawDerivative = (next - value) / dt;
    const derivativeAlpha = alphaFor(derivativeCutoff, dt);
    derivative = derivativeAlpha * rawDerivative + (1 - derivativeAlpha) * derivative;
    const alpha = alphaFor(minCutoff + beta * Math.abs(derivative), dt);
    value = alpha * next + (1 - alpha) * value;
    return value;
  };
}

const filters = {
  alpha: oneEuro(0.9, 0.015),
  beta: oneEuro(1.6, 0.02),
  gamma: oneEuro(1.6, 0.02)
};

function setConnection(isConnected) {
  connected = isConnected;
  connection.className = `pill ${recording ? 'recording' : isConnected ? 'online' : 'offline'}`;
  connection.innerHTML = `<i></i>${recording ? 'Recording' : isConnected ? 'Connected' : 'Disconnected'}`;
  if (!isConnected) status.textContent = 'Reconnecting to desktop…';
  else if (!sensorEnabled) status.textContent = 'Connected — enable motion sensors';
  else if (!pluginConnected) status.textContent = 'Sensors ready — waiting for Studio';
  else if (!recording) status.textContent = 'Camera ready — move the phone to aim';
  updateSteps();
}

function wsUrl() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws/phone?token=${encodeURIComponent(token ?? '')}`;
}

function connect() {
  if (!token) { status.textContent = 'Invalid QR link — reopen the QR from the desktop app'; return; }
  socket = new WebSocket(wsUrl());
  socket.addEventListener('open', () => {
    lastMessageAt = performance.now();
    socket.send(JSON.stringify({ type: 'hello' }));
    setConnection(true);
  });
  socket.addEventListener('message', event => {
    lastMessageAt = performance.now();
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'state') {
      pluginConnected = !!message.pluginConnected;
      studioWarning.classList.toggle('hidden', pluginConnected);
      if (!recording && message.status) takeStatus.textContent = message.status;
      if (pluginConnected && sensorEnabled && !recording) status.textContent = 'Camera ready — move the phone to aim';
      if (!pluginConnected && !recording) status.textContent = 'Waiting for Studio to connect';
      updateSteps();
    }
    if (message.type === 'error') {
      status.textContent = message.message;
      stopRecording(false);
    }
  });
  socket.addEventListener('close', () => { setConnection(false); setTimeout(connect, 1200); });
  socket.addEventListener('error', () => socket.close());
}

function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }

function normalizedAngles() {
  if (!rawAngles) return null;
  if (!neutral) return rawAngles;
  return {
    alpha: ((rawAngles.alpha - neutral.alpha + 540) % 360) - 180,
    beta: rawAngles.beta - neutral.beta,
    gamma: rawAngles.gamma - neutral.gamma
  };
}

function updateReadout() {
  const angles = normalizedAngles();
  if (!angles) return;
  angleReadout.textContent = `${angles.alpha.toFixed(0)}° / ${angles.beta.toFixed(0)}°`;
  phoneState.textContent = neutral ? 'Calibrated • rotation tracking' : 'Move phone, then set neutral';
  const now = performance.now();
  if (now - lastSent >= 16) {
    send({ type: 'motion', ...angles });
    lastSent = now;
  }
}

function handleOrientation(event) {
  if (![event.alpha, event.beta, event.gamma].every(Number.isFinite)) {
    status.textContent = 'No orientation data — check browser sensor support';
    return;
  }
  const now = event.timeStamp || performance.now();

  // Unwrap yaw continuously so ±180 never produces a 358-degree sweep.
  if (unwrappedAlpha === null) unwrappedAlpha = event.alpha;
  else {
    let delta = ((event.alpha - unwrappedAlpha + 540) % 360) - 180;
    unwrappedAlpha += delta;
  }

  rawAngles = {
    alpha: filters.alpha(unwrappedAlpha, now),
    beta: filters.beta(event.beta, now),
    gamma: filters.gamma(event.gamma, now)
  };
  updateReadout();
}

async function enableSensors() {
  try {
    if (!window.isSecureContext) {
      sensorNote.textContent = 'Sensors require HTTPS on phones';
      throw new Error('Phone motion sensors are blocked on this HTTP link. Open Cineflow over HTTPS with a certificate trusted by your phone, then scan its QR again.');
    }
    if (!('DeviceOrientationEvent' in window)) throw new Error('This browser does not provide phone orientation sensors.');
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== 'granted') throw new Error('Motion sensor permission was not granted. Check this site’s browser permissions and try again.');
    }
    window.addEventListener('deviceorientation', handleOrientation, true);
    sensorEnabled = true;
    enableButton.textContent = 'Enabled';
    enableButton.disabled = true;
    sensorNote.textContent = 'Sensor access available';
    status.textContent = pluginConnected ? 'Move phone, then set its neutral pose' : 'Sensors ready — waiting for Studio';
    updateSteps();
  } catch (error) { status.textContent = error.message ?? 'Could not enable sensors'; }
}

sensorNote.textContent = window.isSecureContext
  ? 'Sensor permission may be required'
  : 'Sensors require HTTPS on phones';

function calibrate() {
  if (!rawAngles) { status.textContent = 'Waiting for sensor reading'; return; }
  neutral = { ...rawAngles };
  status.textContent = 'Neutral pose set';
  updateSteps();
  updateReadout();
}

function updateSteps() {
  $('step-sensors').classList.toggle('done', sensorEnabled);
  $('step-neutral').classList.toggle('done', !!neutral);
  $('step-record').classList.toggle('done', recording);
  calibrateButton.disabled = !sensorEnabled;
  recordButton.disabled = !connected || !pluginConnected || !sensorEnabled;
  recordStepNote.textContent = !pluginConnected ? 'Waiting for Studio' : recording ? 'Capturing rotation samples' : 'Saves to the desktop app';
}

function updateRecordUI() {
  connection.className = `pill ${recording ? 'recording' : connected ? 'online' : 'offline'}`;
  connection.innerHTML = `<i></i>${recording ? 'Recording' : connected ? 'Connected' : 'Disconnected'}`;
  recordButton.classList.toggle('active', recording);
  recordButton.querySelector('span:last-child').textContent = recording ? 'Stop' : 'Start';
  takeStatus.textContent = recording ? 'Recording camera take…' : 'No take recording';
  updateSteps();
}

function stopRecording(notify = true) {
  if (!recording) return;
  if (notify) send({ type: 'stop-record' });
  recording = false;
  clearInterval(recordTicker);
  recordTicker = null;
  updateRecordUI();
}

let noticeTimer = null;
function startNotice(message) {
  status.textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    if (connected && pluginConnected) status.textContent = 'Camera ready — move the phone to aim';
  }, 3200);
}

enableButton.addEventListener('click', enableSensors);
calibrateButton.addEventListener('click', calibrate);

recordButton.addEventListener('click', () => {
  if (!connected) { startNotice('Not connected to the desktop app yet.'); return; }
  if (!pluginConnected) { startNotice('Studio is not connected — recording is unavailable.'); return; }
  if (!sensorEnabled) { startNotice('Enable motion sensors first.'); return; }

  if (!recording) {
    send({ type: 'record' });
    recording = true;
    recordStartedAt = performance.now();
    updateRecordUI();
    recordTicker = setInterval(() => {
      const elapsed = Math.floor((performance.now() - recordStartedAt) / 1000);
      takeStatus.textContent = `Recording ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
    }, 250);
  } else {
    stopRecording(true);
    status.textContent = 'Take sent to the desktop app';
  }
});

/* Watchdog: a silently dead socket looks identical to a quiet one. */
setInterval(() => {
  if (!connected || !socket) return;
  if (performance.now() - lastMessageAt < 25000) return;
  socket.close();
}, 5000);

connect();
updateSteps();
