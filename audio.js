// ==== AUDIO: procedural city ambience (Web Audio, no asset files) ====
// The graph is created lazily on the first user gesture (autoplay policy) and
// everything no-ops when Web Audio is unavailable (test harness, old browsers).
// main.js calls AudioAPI.step(dt, moving, flying, weather) once per frame;
// that is a single null-check in the common (pre-gesture) case.

let audioOn = true;             // settings-backed: master enable
let audioVol = 0.5;             // settings-backed: 0..1 master gain

let actx = null, aStarted = false;
let aMaster = null, aRain = null, aWind = null, aNoise = null;
let lastRain = -1, lastWind = -1, footT = 0, armed = false;

function makeNoiseBuffer(ctx) {
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  return buf;
}

function startAudio() {
  if (!audioOn) return;
  if (actx) {
    if (actx.state === 'suspended' && actx.resume) actx.resume().catch(() => {});
    return;
  }
  const AC = (typeof AudioContext !== 'undefined') ? AudioContext
    : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
  if (!AC) return;                        // no Web Audio: stay dormant (retry on next gesture)
  try { actx = new AC(); } catch (e) { actx = null; return; }

  aMaster = actx.createGain();
  aMaster.gain.value = audioVol;
  aMaster.connect(actx.destination);
  aNoise = makeNoiseBuffer(actx);

  const loopNoise = (filterType, freq, gainVal) => {
    const src = actx.createBufferSource();
    src.buffer = aNoise; src.loop = true;
    const flt = actx.createBiquadFilter();
    flt.type = filterType; flt.frequency.value = freq;
    const g = actx.createGain(); g.gain.value = gainVal;
    src.connect(flt); flt.connect(g); g.connect(aMaster);
    src.start(0);
    return g;
  };
  loopNoise('lowpass', 320, 0.055);   // city bed: muffled traffic hiss
  loopNoise('lowpass', 70, 0.05);     // sub rumble
  aRain = loopNoise('highpass', 1100, 0);  // rain: ramped by weather
  aWind = loopNoise('lowpass', 420, 0);    // wind: ramped while flying
  lastRain = 0; lastWind = 0;
  aStarted = true;
  if (actx.state === 'suspended' && actx.resume) actx.resume().catch(() => {});
}

function playStep(now) {
  const src = actx.createBufferSource();
  src.buffer = aNoise;
  src.loop = false;
  const bp = actx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 520 + Math.random() * 420;
  bp.Q.value = 1.4;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.3, now + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
  src.connect(bp); bp.connect(g); g.connect(aMaster);
  src.start(now);
  src.stop(now + 0.11);
}

function audioStep(dt, moving, flying, weather) {
  if (!aStarted) return;
  const now = actx.currentTime;
  const rT = weather === 1 ? 0.10 : 0;
  if (rT !== lastRain) { lastRain = rT; aRain.gain.setTargetAtTime(rT, now, 0.3); }
  const wT = flying ? 0.05 : 0;
  if (wT !== lastWind) { lastWind = wT; aWind.gain.setTargetAtTime(wT, now, 0.3); }
  if (moving && !flying) {
    footT -= dt;
    if (footT <= 0) { footT = 0.40 + Math.random() * 0.14; playStep(now); }
  } else if (footT > 0.15) {
    footT = 0.15;                                  // don't bank a long stride pause
  }
}

function armAudio() {
  if (armed || !audioOn) return;
  armed = true;
  const kick = () => startAudio();
  ['pointerdown', 'keydown', 'touchstart'].forEach(t => {
    try { addEventListener(t, kick, { once: true }); } catch (e) { addEventListener(t, kick); }
  });
}
armAudio();

const AudioAPI = { start: startAudio, step: audioStep };

Settings.define('sound', { label: 'Ambient sound', type: 'checkbox', default: true },
  v => {
    audioOn = v;
    if (v) { if (actx) startAudio(); else { armed = false; armAudio(); } }
    else if (actx && actx.suspend) actx.suspend().catch(() => {});
  });
Settings.define('volume', { label: 'Volume', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5, fmt: v => Math.round(v * 100) + '%' },
  v => { audioVol = v; if (aMaster) aMaster.gain.value = v; });
