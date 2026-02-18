/* ==========================================================================
   AgentVox SynthEngine — Rhythmic micro-sound telemetry sonification
   Inspired by snd, Jan Jelinek's "Loop Finding Jazz Records"
   Clicks, pops, micro-tones quantized to a grid with polyrhythmic echoes
   ========================================================================== */

// ---------------------------------------------------------------------------
// Echo intervals per tool — different subdivisions create polyrhythm
// interval = steps between echoes, repeats = how many ghosts, decay = volume falloff
// ---------------------------------------------------------------------------
const ECHO = {
  Read:    { interval: 4, repeats: 4, decay: 0.6  },  // quarter note pulse
  Glob:    { interval: 4, repeats: 3, decay: 0.55 },
  Grep:    { interval: 8, repeats: 3, decay: 0.5  },  // half note — slow scan
  Write:   { interval: 3, repeats: 5, decay: 0.6  },  // triplet feel — 3 against 4
  Edit:    { interval: 5, repeats: 4, decay: 0.55 },  // quintuplet — 5 against 4
  Bash:    { interval: 6, repeats: 3, decay: 0.5  },  // dotted quarter cross-rhythm
  Task:    { interval: 7, repeats: 3, decay: 0.45 },  // 7-step long cycle
  default: { interval: 4, repeats: 2, decay: 0.5  },
};

// Sound profiles per tool — freq, type, character
const SOUNDS = {
  Read:       { freq: 3800, type: "click",   dur: 0.003, q: 8  },
  Glob:       { freq: 4200, type: "click",   dur: 0.004, q: 6  },
  Grep:       { freq: 2800, type: "click",   dur: 0.005, q: 10 },
  Write:      { freq: 520,  type: "pop",     dur: 0.015 },
  Edit:       { freq: 440,  type: "pop",     dur: 0.012 },
  Bash:       { freq: 1200, type: "crack",   dur: 0.008, q: 4  },
  Task:       { freq: 340,  type: "sweep",   dur: 0.025, to: 520 },
  default:    { freq: 600,  type: "click",   dur: 0.003, q: 6  },
};

// Event type → special sounds (non-tool events)
const EVENT_SOUNDS = {
  thinking:   { freq: 1600, type: "click",  dur: 0.002, q: 12 },
  error:      { freq: 480,  type: "double", dur: 0.008 },
  completion: { freq: 660,  type: "arp",    dur: 0.020 },
  heartbeat:  { freq: 45,   type: "pop",    dur: 0.030 },
};

const ACTIVITY_BUMP = 0.08;
const ACTIVITY_DECAY_RATE = 0.015;   // per second
const PULSE_FADE_BARS = 12;          // bars of silence before pulse fades

// ---------------------------------------------------------------------------
// Melodic system — D Dorian scale, Markov chain phrase generation
// ---------------------------------------------------------------------------

// D Dorian: D E F G A B C — MIDI notes across two octaves for melody
const DORIAN_MIDI = [62, 64, 65, 67, 69, 71, 72]; // D4 E4 F4 G4 A4 B4 C5
const DORIAN_HIGH = DORIAN_MIDI.map(n => n + 12);  // D5 E5 F5 G5 A5 B5 C6

// Bass notes (D2, G2, A2)
const BASS_ROOT = 38; // D2
const BASS_4TH  = 43; // G2
const BASS_5TH  = 45; // A2

// Tritone for error dissonance (Ab4)
const TRITONE_MIDI = 68;

// MIDI note to frequency
function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Markov transition matrix — row = current degree (0-6), column = next degree (0-6)
// Favors stepwise motion, gravitational pull toward degree 0 (root D)
const MARKOV = [
  [.15, .25, .10, .20, .15, .05, .10], // from 1(D)
  [.20, .15, .25, .10, .15, .10, .05], // from 2(E)
  [.10, .20, .15, .25, .10, .15, .05], // from 3(F)
  [.15, .10, .10, .15, .30, .10, .10], // from 4(G)
  [.20, .10, .05, .20, .15, .20, .10], // from 5(A)
  [.05, .15, .10, .10, .25, .15, .20], // from 6(B)
  [.25, .10, .10, .10, .10, .15, .20], // from 7(C)
];

// Pick next scale degree using weighted random from transition row
function markovNext(currentDegree) {
  const row = MARKOV[currentDegree];
  let r = Math.random();
  for (let i = 0; i < row.length; i++) {
    r -= row[i];
    if (r <= 0) return i;
  }
  return 0; // fallback to root
}

// Phrase length by event type
const PHRASE_LENGTH = {
  tool_start: () => 3 + Math.round(Math.random()),       // 3-4
  tool_end:   () => 1 + Math.round(Math.random()),       // 1-2
  thinking:   () => 2,                                     // 2
  error:      () => 3,                                     // 3
  completion: () => 4,                                     // 4
  default:    () => 2 + Math.round(Math.random()),        // 2-3
};

// ---------------------------------------------------------------------------
// Noise buffer (shared, created once)
// ---------------------------------------------------------------------------
let sharedNoiseBuffer = null;

function getNoiseBuffer(ctx) {
  if (sharedNoiseBuffer && sharedNoiseBuffer.sampleRate === ctx.sampleRate) {
    return sharedNoiseBuffer;
  }
  const len = ctx.sampleRate * 2; // 2 seconds of noise
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  sharedNoiseBuffer = buf;
  return buf;
}

// ---------------------------------------------------------------------------
// Micro-sound generators
// ---------------------------------------------------------------------------

function varyPitch(freq) {
  return freq * (0.94 + Math.random() * 0.12); // ±6%
}

function varyGain(gain) {
  return gain * (0.8 + Math.random() * 0.4); // ±20%
}

// Ultra-short filtered noise burst
function playClick(ctx, out, time, freq, gain, dur, q = 6) {
  const noise = getNoiseBuffer(ctx);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  // Random start position in noise buffer
  src.loopStart = Math.random() * 1.5;
  src.loopEnd = src.loopStart + 0.1;

  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = varyPitch(freq);
  bp.Q.value = q;

  const g = ctx.createGain();
  g.gain.setValueAtTime(varyGain(gain), time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  src.connect(bp).connect(g).connect(out);
  src.start(time, src.loopStart, dur + 0.01);
}

// Short sine pop with fast decay
function playPop(ctx, out, time, freq, gain, dur) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = varyPitch(freq);

  const g = ctx.createGain();
  g.gain.setValueAtTime(varyGain(gain), time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  osc.connect(g).connect(out);
  osc.start(time);
  osc.stop(time + dur + 0.01);
}

// Bandpass noise crack — snappier than click, wider band
function playCrack(ctx, out, time, freq, gain, dur, q = 4) {
  const noise = getNoiseBuffer(ctx);
  const src = ctx.createBufferSource();
  src.buffer = noise;

  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = varyPitch(freq);
  bp.Q.value = q;

  // Add slight saturation via waveshaper
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 128) - 1;
    curve[i] = Math.tanh(x * 2);
  }
  shaper.curve = curve;

  const g = ctx.createGain();
  g.gain.setValueAtTime(varyGain(gain), time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  src.connect(bp).connect(shaper).connect(g).connect(out);
  src.start(time, Math.random() * 1.5, dur + 0.01);
}

// Micro frequency sweep
function playSweep(ctx, out, time, freqFrom, freqTo, gain, dur) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  const f = varyPitch(freqFrom);
  osc.frequency.setValueAtTime(f, time);
  osc.frequency.exponentialRampToValueAtTime(varyPitch(freqTo), time + dur * 0.8);

  const g = ctx.createGain();
  g.gain.setValueAtTime(varyGain(gain) * 0.7, time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  osc.connect(g).connect(out);
  osc.start(time);
  osc.stop(time + dur + 0.01);
}

// Double-tap (two rapid clicks for errors)
function playDouble(ctx, out, time, freq, gain, dur) {
  playPop(ctx, out, time, freq, gain * 0.9, dur);
  playPop(ctx, out, time + dur * 1.8, freq * 1.05, gain * 0.7, dur);
}

// Micro three-note arpeggio (for completions)
function playArp(ctx, out, time, freq, gain, dur) {
  const notes = [freq, freq * 1.25, freq * 1.5]; // root, major 3rd, 5th
  notes.forEach((f, i) => {
    playPop(ctx, out, time + i * dur * 1.2, f, gain * (1 - i * 0.2), dur * 0.8);
  });
}

// Downbeat pulse — very subtle sub-bass thump, felt more than heard
function playPulse(ctx, out, time, gain) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 48 + Math.random() * 4;

  const g = ctx.createGain();
  g.gain.setValueAtTime(gain * 0.25, time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);

  osc.connect(g).connect(out);
  osc.start(time);
  osc.stop(time + 0.08);
}

// Micro melodic fragment — sine with gentle attack, subtle detune
function playMelodyNote(ctx, out, time, freq, gain, dur) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  // ±2% random detune for organic feel
  osc.frequency.value = freq * (0.98 + Math.random() * 0.04);

  const g = ctx.createGain();
  // 5ms linear attack ramp to avoid click
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(varyGain(gain), time + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  osc.connect(g).connect(out);
  osc.start(time);
  osc.stop(time + dur + 0.01);
}

// Bass anchor — sub sine with longer decay
function playBassNote(ctx, out, time, freq, gain) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;

  const g = ctx.createGain();
  g.gain.setValueAtTime(gain * 0.35, time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.1);

  osc.connect(g).connect(out);
  osc.start(time);
  osc.stop(time + 0.12);
}

// ---------------------------------------------------------------------------
// Dispatcher: plays the right sound for a given tool/event
// ---------------------------------------------------------------------------

function playSound(ctx, out, time, tool, eventType, gain) {
  // Special event types first
  if (eventType && EVENT_SOUNDS[eventType]) {
    const s = EVENT_SOUNDS[eventType];
    switch (s.type) {
      case "click":  playClick(ctx, out, time, s.freq, gain, s.dur, s.q || 6); break;
      case "pop":    playPop(ctx, out, time, s.freq, gain, s.dur); break;
      case "double": playDouble(ctx, out, time, s.freq, gain, s.dur); break;
      case "arp":    playArp(ctx, out, time, s.freq, gain, s.dur); break;
    }
    return;
  }

  // Tool-based sounds
  const s = SOUNDS[tool] || SOUNDS.default;
  switch (s.type) {
    case "click":  playClick(ctx, out, time, s.freq, gain, s.dur, s.q || 6); break;
    case "pop":    playPop(ctx, out, time, s.freq, gain, s.dur); break;
    case "crack":  playCrack(ctx, out, time, s.freq, gain, s.dur, s.q || 4); break;
    case "sweep":  playSweep(ctx, out, time, s.freq, s.to, gain, s.dur); break;
  }
}

// ---------------------------------------------------------------------------
// SynthEngine
// ---------------------------------------------------------------------------

export class SynthEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.running = false;
    this.bpm = 128;
    this.swing = 0;            // 0-1
    this.step = 0;             // current step in 16-step bar
    this.nextStepTime = 0;
    this.schedulerInterval = null;
    this.decayInterval = null;
    this.activityLevel = 0;
    this.lastEventTime = 0;
    this.barsSinceEvent = 0;

    // Event queue — telemetry events waiting to be played on next step
    this.eventQueue = [];

    // Ghost echoes — scheduled future repeats: { step, tool, eventType, gain, stepsLeft }
    this.ghosts = [];

    // Visualization state (read by the UI animation loop)
    this.currentStep = 0;           // alias for this.step, updated in _processStep
    this.stepActivity = new Float32Array(16);  // gain level per step, decays over time
    this.toolHits = {};             // { toolName: Set<stepIndex> } — which steps have ghosts
    this.lastTrigger = null;        // { step, tool, type, time } — most recent sound
    this.flashIntensity = 0;        // 0-1, spikes on events, decays rapidly
    this.eventCounts = {};          // { toolName: count } — running totals
    this.totalEvents = 0;
    this.barsElapsed = 0;

    // Melodic state
    this.markovState = 0;         // current Dorian scale degree (0-6), starts on root D
    this.melodicActivity = 0;     // float, bumped on events, decays per bar — bass plays when > 0
    this.phraseQueue = [];        // { freq, gain, dur } notes waiting to play on upcoming steps
  }

  async start() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.5;
    this.masterGain.connect(this.ctx.destination);

    // Pre-create noise buffer
    getNoiseBuffer(this.ctx);

    this.step = 0;
    this.nextStepTime = this.ctx.currentTime + 0.05;
    this.running = true;
    this.lastEventTime = this.ctx.currentTime;
    this.barsSinceEvent = 0;

    // Look-ahead scheduler — runs every 25ms, schedules audio ahead
    this.schedulerInterval = setInterval(() => this._schedule(), 25);

    // Activity decay
    this.decayInterval = setInterval(() => {
      this.activityLevel = Math.max(0, this.activityLevel - ACTIVITY_DECAY_RATE);
      // Decay step activity
      for (let i = 0; i < 16; i++) {
        this.stepActivity[i] = Math.max(0, this.stepActivity[i] - 0.08);
      }
      // Decay flash
      this.flashIntensity = Math.max(0, this.flashIntensity - 0.15);
      // Decay melodic activity (0.5 per bar ≈ 0.03 per second at 128bpm)
      this.melodicActivity = Math.max(0, this.melodicActivity - 0.03);
    }, 1000);
  }

  stop() {
    this.running = false;
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    if (this.decayInterval) {
      clearInterval(this.decayInterval);
      this.decayInterval = null;
    }
    this.ghosts = [];
    this.eventQueue = [];
    this.phraseQueue = [];
    this.melodicActivity = 0;
    if (this.ctx && this.ctx.state === "running") {
      this.ctx.suspend();
    }
  }

  setMasterVolume(v) {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.linearRampToValueAtTime(
        Math.max(0, Math.min(1, v)),
        this.ctx.currentTime + 0.05
      );
    }
  }

  // Keep these as no-ops for backward compat with saved settings
  setAmbientVolume() {}
  setEventVolume() {}

  setTempo(bpm) {
    this.bpm = Math.max(60, Math.min(200, bpm));
  }

  setSwing(amount) {
    this.swing = Math.max(0, Math.min(1, amount));
  }

  isRunning() {
    return this.running;
  }

  getActivityLevel() {
    return this.activityLevel;
  }

  getStep() { return this.currentStep; }
  getStepActivity() { return this.stepActivity; }
  getToolHits() { return this.toolHits; }
  getLastTrigger() { return this.lastTrigger; }
  getFlashIntensity() { return this.flashIntensity; }
  getEventCounts() { return this.eventCounts; }
  getTotalEvents() { return this.totalEvents; }
  getBarsElapsed() { return this.barsElapsed; }

  // --- Telemetry input ---

  onTelemetry(event) {
    if (!this.running) return;

    this.activityLevel = Math.min(1, this.activityLevel + ACTIVITY_BUMP);
    this.lastEventTime = this.ctx ? this.ctx.currentTime : 0;
    this.barsSinceEvent = 0;

    const tool = event.tool || null;
    const eventType = event.type || null;

    // Only sonify certain event types
    if (eventType === "tool_end") {
      // tool_end = very soft ghost of the tool sound, no new echoes
      this.eventQueue.push({ tool, eventType: null, gain: 0.3, noEcho: true });
      return;
    }

    // Queue the sound for next grid step
    this.eventQueue.push({ tool, eventType, gain: 1.0 });

    // Generate melodic phrase
    this.melodicActivity = Math.min(4, this.melodicActivity + 1);
    this._generatePhrase(tool, eventType);
  }

  // --- Scheduler (sample-accurate look-ahead) ---

  _schedule() {
    if (!this.ctx || !this.running) return;

    const lookAhead = 0.1; // schedule 100ms ahead
    while (this.nextStepTime < this.ctx.currentTime + lookAhead) {
      this._processStep(this.step, this.nextStepTime);
      this._advanceStep();
    }
  }

  _advanceStep() {
    const stepDur = 60 / this.bpm / 4; // 16th note duration

    // Swing: delay odd-numbered 16th notes (the "e" and "a" of each beat)
    let dur = stepDur;
    if (this.step % 2 === 1 && this.swing > 0) {
      dur = stepDur * (1 + this.swing * 0.4);
    } else if (this.step % 2 === 0 && this.swing > 0) {
      dur = stepDur * (1 - this.swing * 0.15);
    }

    this.nextStepTime += dur;
    this.step = (this.step + 1) % 16;

    // Track bars since last event
    if (this.step === 0) {
      if (this.ctx && (this.ctx.currentTime - this.lastEventTime) > (60 / this.bpm * 4)) {
        this.barsSinceEvent++;
      }
    }
  }

  _processStep(step, time) {
    this.currentStep = step;

    // 1. Play downbeat pulse (step 0 = beat 1)
    if (step === 0) {
      this.barsElapsed++;
    }
    if (step === 0 && this.barsSinceEvent < PULSE_FADE_BARS) {
      const fadeGain = Math.max(0, 1 - this.barsSinceEvent / PULSE_FADE_BARS);
      playPulse(this.ctx, this.masterGain, time, fadeGain);
    }

    // 2. Play queued telemetry events
    while (this.eventQueue.length > 0) {
      const evt = this.eventQueue.shift();
      playSound(this.ctx, this.masterGain, time, evt.tool, evt.eventType, evt.gain);

      this.stepActivity[step] = Math.min(1, (this.stepActivity[step] || 0) + 0.8);
      this.lastTrigger = { step, tool: evt.tool, type: evt.eventType, time: Date.now() };
      this.flashIntensity = 1.0;
      if (evt.tool) {
        this.eventCounts[evt.tool] = (this.eventCounts[evt.tool] || 0) + 1;
      }
      this.totalEvents++;

      // Schedule echo ghosts (polyrhythmic repeats)
      if (!evt.noEcho) {
        this._scheduleEchoes(step, evt.tool, evt.eventType, evt.gain);
      }
    }

    // 3. Play ghost echoes scheduled for this step
    const globalStep = this._globalStep(step);
    const newGhosts = [];
    for (const ghost of this.ghosts) {
      if (ghost.targetGlobalStep === globalStep) {
        // 5% chance to skip for humanization
        if (Math.random() > 0.05) {
          if (ghost.eventType === "_melody" && ghost.melodyFreq) {
            playMelodyNote(this.ctx, this.masterGain, time, ghost.melodyFreq, ghost.gain, ghost.melodyDur || 0.04);
          } else {
            playSound(this.ctx, this.masterGain, time, ghost.tool, ghost.eventType, ghost.gain);
          }
          this.stepActivity[step] = Math.min(1, (this.stepActivity[step] || 0) + ghost.gain * 0.6);
        }

        // Schedule next repeat if any left
        if (ghost.repeatsLeft > 1) {
          newGhosts.push({
            ...ghost,
            targetGlobalStep: globalStep + ghost.interval,
            gain: ghost.gain * ghost.decay,
            repeatsLeft: ghost.repeatsLeft - 1,
          });
        }
      } else if (ghost.targetGlobalStep > globalStep) {
        newGhosts.push(ghost); // keep waiting
      }
      // else: past its time, drop it
    }
    this.ghosts = newGhosts;

    // Prevent ghost list from growing unbounded
    if (this.ghosts.length > 200) {
      this.ghosts = this.ghosts.slice(-100);
    }

    // 4. Play queued melodic phrase notes (one per step)
    if (this.phraseQueue.length > 0) {
      const note = this.phraseQueue.shift();
      playMelodyNote(this.ctx, this.masterGain, time, note.freq, note.gain, note.dur);

      // Melodic notes get ghost echoes too — polyrhythmic melodic counterpoint
      if (note.tool) {
        const echoConfig = ECHO[note.tool] || ECHO.default;
        const gStep = this._globalStep(step);
        for (let i = 1; i <= Math.min(echoConfig.repeats, 3); i++) {
          this.ghosts.push({
            targetGlobalStep: gStep + echoConfig.interval * i,
            tool: note.tool,
            eventType: "_melody", // marker so ghost handler plays melody note
            melodyFreq: note.freq,
            melodyDur: note.dur,
            gain: note.gain * Math.pow(echoConfig.decay, i),
            interval: echoConfig.interval,
            decay: echoConfig.decay,
            repeatsLeft: 1,
          });
        }
        this._rebuildToolHits();
      }
    }

    // 5. Bass on strong beats when there's melodic activity
    if ((step === 0 || step === 4 || step === 8 || step === 12) && this.melodicActivity > 0) {
      const r = Math.random();
      let bassMidi;
      if (r < 0.60)      bassMidi = BASS_ROOT; // D2
      else if (r < 0.85) bassMidi = BASS_5TH;  // A2
      else                bassMidi = BASS_4TH;  // G2

      const bassGain = Math.min(1, this.melodicActivity / 2); // louder with more activity
      playBassNote(this.ctx, this.masterGain, time, midiToFreq(bassMidi), bassGain);
    }
  }

  _scheduleEchoes(currentStep, tool, eventType, gain) {
    const config = ECHO[tool] || ECHO.default;
    const globalStep = this._globalStep(currentStep);

    for (let i = 1; i <= config.repeats; i++) {
      this.ghosts.push({
        targetGlobalStep: globalStep + config.interval * i,
        tool,
        eventType: null, // ghosts don't trigger special event sounds
        gain: gain * Math.pow(config.decay, i),
        interval: config.interval,
        decay: config.decay,
        repeatsLeft: 1, // each echo is individually scheduled
      });
    }

    // Rebuild tool hit map for visualization
    this._rebuildToolHits();
  }

  _rebuildToolHits() {
    const hits = {};
    for (const ghost of this.ghosts) {
      const localStep = ghost.targetGlobalStep % 16;
      const tool = ghost.tool || "default";
      if (!hits[tool]) hits[tool] = new Set();
      hits[tool].add(localStep);
    }
    this.toolHits = hits;
  }

  _generatePhrase(tool, eventType) {
    const lengthFn = PHRASE_LENGTH[eventType] || PHRASE_LENGTH.default;
    const len = lengthFn();
    const isError = eventType === "error";
    const isCompletion = eventType === "completion";
    const isEnd = eventType === "tool_end";

    // Gain: melody sits behind clicks — tool_end even softer
    const baseGain = isEnd ? 0.15 : 0.4;

    for (let i = 0; i < len; i++) {
      let midi;

      if (isError && i === len - 1) {
        // Last note of error phrase: tritone for dissonance
        midi = TRITONE_MIDI;
      } else if (isCompletion) {
        // Ascending phrase: walk up the scale from current position
        const deg = Math.min(6, this.markovState + i);
        midi = DORIAN_MIDI[deg];
        if (i === len - 1) this.markovState = deg;
      } else {
        // Normal Markov walk
        this.markovState = markovNext(this.markovState);
        midi = DORIAN_MIDI[this.markovState];
      }

      // Randomly place some notes in the upper octave for range
      if (Math.random() < 0.3 && !isError) {
        midi += 12;
      }

      const freq = midiToFreq(midi);
      // Duration varies: 30-80ms
      const dur = 0.03 + Math.random() * 0.05;
      const gain = baseGain * (1 - i * 0.1); // slight fade across phrase

      this.phraseQueue.push({ freq, gain, dur, tool });
    }
  }

  // Global step counter (doesn't wrap at 16, monotonically increases)
  _globalStepCounter = 0;
  _lastLocalStep = -1;

  _globalStep(localStep) {
    if (localStep === 0 && this._lastLocalStep === 15) {
      this._globalStepCounter += 16;
    }
    this._lastLocalStep = localStep;
    return this._globalStepCounter + localStep;
  }
}

export { SynthEngine as default };
