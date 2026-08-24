/**
 * VoiceB renderer controller.
 *
 * Owns two TranslationLanes, the audio routing around them, and all UI state.
 */
(function (VB) {
  'use strict';

  const api = window.voiceb;
  const MAX_RESTARTS = 3;

  const state = {
    settings: null,
    info: null,
    keyStatus: { present: false, encrypted: false },
    devices: { inputs: [], outputs: [] },
    routing: {},
    pricePerMinute: 0.034,

    running: false,
    starting: false,
    lanes: { outbound: null, inbound: null },
    meters: { mic: null, remote: null },
    passthrough: null,
    inboundStream: null,
    inboundLastSignalAt: 0,
    laneProblems: {},
    laneTime: {},              // per-lane billed milliseconds, accumulated
    recentOutbound: [],        // [{ text, at }] — last few things we said, for loop detection
    outboundSpeaking: false,
    echoGateTimer: null,
    warnedSilentInbound: false,
    restarts: { outbound: 0, inbound: 0 },

    session: null,
    lineNodes: new Map(),
    muted: false,
    pttHeld: false,
    tickTimer: null,
    toastTimer: null,

    test: { running: false, streams: [], meters: [], timer: null, tickTimer: null,
            monitor: null, peak: { mic: 0, call: 0 }, tested: [] },

    local: { probe: null, gpu: null, busy: '', hint: '', log: [],
             preloaded: false, preloading: null },
  };

  const $ = (id) => document.getElementById(id);

  // ================================================================= boot ==

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    state.settings = await api.settings.get();
    state.info = await api.system.info();
    state.keyStatus = await api.key.status();
    state.pricePerMinute = await api.session.pricePerMinuteUsd();
    VB.glossary.compile(state.settings.glossary);

    buildLanguageSelects();
    bindUi();
    bindMainEvents();
    renderSettings();
    renderEngine();
    renderAbout();
    renderKeyStatus();
    renderGlossary();

    await refreshDevices({ autoGuess: true });
    await renderCables();

    // Probing the local engine spawns Python, so only do it when it is the
    // engine actually in use. Selecting it in Setup probes on demand.
    if (state.settings.engine === 'local') refreshLocalStatus({ gpu: true });

    if (state.settings.engine === 'cloud' && !state.keyStatus.present) {
      openPanel('panel-settings');
      toast('Add your OpenAI API key to get started.');
    }
  }

  const isLocal = () => state.settings.engine === 'local';

  // =============================================================== devices ==

  const DEVICE_FIELDS = [
    { key: 'mic', id: 'micDeviceId', label: 'micLabel', select: 'sel-mic', kind: 'inputs' },
    { key: 'toCall', id: 'toCallDeviceId', label: 'toCallLabel', select: 'sel-tocall', kind: 'outputs' },
    { key: 'fromCall', id: 'fromCallDeviceId', label: 'fromCallLabel', select: 'sel-fromcall', kind: 'inputs', explicit: true },
    { key: 'headphones', id: 'headphonesDeviceId', label: 'headphonesLabel', select: 'sel-headphones', kind: 'outputs' },
  ];

  async function refreshDevices(options) {
    const opts = options || {};
    await VB.audio.ensurePermission();
    state.devices = await VB.audio.listDevices();
    console.info('[devices] ' + JSON.stringify({
      outputs: state.devices.outputs.map((d) => `${d.deviceId.slice(0, 8)} ${d.label}`),
      inputs: state.devices.inputs.map((d) => `${d.deviceId.slice(0, 8)} ${d.label}`),
    }, null, 1));

    const before = state.settings;
    const unset = DEVICE_FIELDS.every((f) => !before[f.id]);
    if (opts.autoGuess && unset) {
      await saveSettings(withLabels(VB.audio.guessRouting(state.devices)));
    }

    const patch = {};
    state.routing = {};
    for (const field of DEVICE_FIELDS) {
      const list = state.devices[field.kind];
      const chosen = resolveDevice(list, state.settings[field.id], state.settings[field.label], field.explicit);
      state.routing[field.key] = chosen;
      fillDeviceSelect($(field.select), list, chosen, field.explicit);

      // Only ever write back a device we can actually see. Persisting a
      // fallback would erase the user's real choice the moment a Bluetooth
      // headset switches profile or a webcam mic is briefly busy.
      if (chosen.available && (chosen.deviceId !== state.settings[field.id]
          || chosen.label !== state.settings[field.label])) {
        patch[field.id] = chosen.deviceId;
        patch[field.label] = chosen.label;
      }
    }
    if (Object.keys(patch).length) await saveSettings(patch);
    renderRouting();
  }

  /** Fills in labels for a set of freshly guessed device ids. */
  function withLabels(guess) {
    const out = { ...guess };
    for (const field of DEVICE_FIELDS) {
      const found = state.devices[field.kind].find((d) => d.deviceId === guess[field.id]);
      out[field.label] = found ? found.label : '';
    }
    return out;
  }

  /**
   * Works out which device a saved selection refers to *now*.
   *
   * Chromium device ids drift, so the label is the durable key: match the id
   * first, then the label, and if neither resolves keep the selection intact
   * and report it as unavailable rather than quietly swapping in another
   * device. Silently substituting is how a session ends up translating the
   * wrong microphone.
   */
  function resolveDevice(list, savedId, savedLabel, explicit) {
    const byId = list.find((d) => d.deviceId === savedId);
    if (byId) return { ...byId, available: true };

    const byLabel = savedLabel && list.find((d) => d.label === savedLabel);
    if (byLabel) return { ...byLabel, available: true };

    if (savedLabel || savedId) {
      return { deviceId: savedId, label: savedLabel || 'unknown device', isCable: false, available: false };
    }

    if (explicit || !list.length) {
      return { deviceId: '', label: '', isCable: false, available: false, unset: true };
    }
    const first = list.find((d) => !d.isDefault) || list[0];
    return { ...first, available: true };
  }

  function fillDeviceSelect(select, devices, chosen, requireExplicit) {
    select.innerHTML = '';
    if (!devices.length) {
      select.appendChild(new Option('No devices found', ''));
      return;
    }
    if (requireExplicit) select.appendChild(new Option('— choose a device —', ''));
    if (!chosen.available && !chosen.unset) {
      select.appendChild(new Option(`⚠ ${chosen.label} — not connected`, chosen.deviceId));
    }
    for (const d of devices) {
      select.appendChild(new Option(`${d.isCable ? '⇄ ' : ''}${d.label}`, d.deviceId));
    }
    select.value = chosen.deviceId;
  }

  /** Records both id and label whenever the user picks a device by hand. */
  function chooseDevice(field, deviceId) {
    const found = state.devices[field.kind].find((d) => d.deviceId === deviceId);
    return saveSettings({
      [field.id]: deviceId,
      [field.label]: found ? found.label : '',
    });
  }

  /**
   * Renders the routing summary and flags the wiring mistakes that actually
   * bite: capturing the same cable we play into (instant feedback loop),
   * translating our own translation, or picking a cable as the headset.
   */
  /** Which models the local engine needs depends on which directions are on. */
  function afterRoutingChange() {
    renderRouting();
    renderLocalStatus();
  }

  function renderRouting() {
    const s = state.settings;
    const r = state.routing || {};
    const pick = (entry) => (entry && entry.label ? entry : null);
    const mic = pick(r.mic);
    const toCall = pick(r.toCall);
    const fromCall = pick(r.fromCall);
    const phones = pick(r.headphones);

    const rows = [];
    if (s.outboundEnabled) {
      rows.push(`<div>${esc(short(mic))} <span class="arrow">→ translate →</span> ${esc(short(toCall))}</div>`);
    }
    if (s.inboundEnabled) {
      rows.push(`<div>${esc(short(fromCall))} <span class="arrow">→ translate →</span> ${esc(short(phones))}</div>`);
    }
    $('route-summary').innerHTML = rows.join('') || '<div>Both directions are switched off.</div>';

    $('hint-tocall').textContent = toCall ? pairedCaptureName(toCall.label) : 'CABLE Output';
    $('hint-fromcall').textContent = fromCall ? pairedRenderName(fromCall.label) : 'CABLE-B Input';

    const problems = [];
    if (s.outboundEnabled && s.inboundEnabled && toCall && fromCall &&
        VB.audio.cableFamily(toCall.label) === VB.audio.cableFamily(fromCall.label)) {
      problems.push('Both directions use the same virtual cable. VoiceB would hear its own '
        + 'translated voice and translate it again. Install a second cable and pick it for '
        + '“Capture call audio from”.');
    }
    if (s.outboundEnabled && toCall && !toCall.isCable) {
      problems.push('“Send translated voice to” is not a virtual cable — the meeting app '
        + 'will not be able to use it as a microphone.');
    }
    if (s.outboundEnabled && mic && mic.isCable) {
      problems.push('“My microphone” looks like a virtual cable rather than a real mic.');
    }
    if (s.outboundEnabled && s.inboundEnabled && mic && phones) {
      const headset = VB.audio.bluetoothFamily(mic.label);
      if (headset && headset === VB.audio.bluetoothFamily(phones.label)) {
        problems.push('Your microphone and your headphones are the same Bluetooth headset. '
          + 'Bluetooth runs either the microphone profile or stereo playback, never both, so '
          + 'one of the two lanes will fail to open. Use a different microphone, or a wired headset.');
      }
    }
    if (s.outboundEnabled && s.inboundEnabled && phones && mic
        && !mic.isCable && VB.audio.looksLikeSpeakers(phones.label)) {
      problems.push('The translation plays out of loudspeakers while your microphone is open. '
        + 'The mic will hear it and send it back through the outbound lane, translated again. '
        + 'Use headphones, or switch off one of the directions.');
    }
    if (s.inboundEnabled && phones && phones.isCable) {
      problems.push('“My headphones” is a virtual cable, so you will not hear anything.');
    }
    if (s.inboundEnabled && fromCall && mic && fromCall.deviceId === mic.deviceId) {
      problems.push('“Capture call audio from” is your own microphone. That lane would pick '
        + 'up your voice instead of theirs. It needs the capture side of the cable the '
        + 'meeting app plays into.');
    } else if (s.inboundEnabled && fromCall && !fromCall.isCable) {
      problems.push('“Capture call audio from” is not a virtual cable. Point the meeting '
        + 'tab’s speaker at a cable and select that cable’s capture side here.');
    }

    // With only one direction running there is no second lane to collide with,
    // so the single cable most people already have is enough.
    if (s.inboundEnabled && !s.outboundEnabled && fromCall && !fromCall.isCable
        && state.devices.inputs.some((d) => d.isCable)) {
      problems.push('Outbound translation is off, so your existing virtual cable is free — '
        + 'send the meeting tab’s audio into it and select its capture side here.');
    }

    for (const field of DEVICE_FIELDS) {
      const entry = r[field.key];
      const needed = field.key === 'mic' || field.key === 'toCall' ? s.outboundEnabled : s.inboundEnabled;
      if (needed && entry && !entry.available && !entry.unset) {
        problems.push(`“${entry.label}” is not connected right now. Reconnect it, or pick `
          + 'another device — VoiceB will not silently substitute one.');
      }
    }

    const warn = $('route-warning');
    warn.hidden = problems.length === 0;
    warn.innerHTML = problems.map((p) => `<div>⚠ ${p}</div>`).join('');
  }

  const short = (device) => (device ? device.label : 'not selected');

  /** "CABLE Input (VB-Audio…)" is the render side; its capture twin is "CABLE Output". */
  function pairedCaptureName(label) {
    return label.replace(/\bInput\b/i, 'Output').split('(')[0].trim();
  }
  function pairedRenderName(label) {
    return label.replace(/\bOutput\b/i, 'Input').split('(')[0].trim();
  }

  async function renderCables() {
    const info = await api.system.cables();
    const box = $('cable-status');
    const names = info.installed.map((c) => c.name);
    if (names.length >= 2) {
      box.className = 'cable-status ok';
      box.textContent = `✓ ${names.length} virtual cables installed: ${names.join(', ')}`;
    } else if (names.length === 1) {
      box.className = 'cable-status';
      box.innerHTML = `Found <b>${esc(names[0])}</b>. Two-way translation needs a second, `
        + 'separate cable — otherwise the inbound lane would capture the outbound lane’s own '
        + 'output. Install <b>VB-CABLE A+B</b> (a different driver, so it coexists with this one).';
    } else {
      box.className = 'cable-status';
      box.textContent = 'No VB-Audio cable detected. Install VB-CABLE to route audio into the meeting app.';
    }
    $('btn-get-cable').onclick = () => api.system.openExternal(info.downloadUrl);
  }

  // ============================================================ device test ==

  const TEST_DURATION_MS = 25000;
  const INBOUND_SILENCE_MS = 25000;
  const SIGNAL_THRESHOLD = 0.04; // above idle noise floor, below quiet speech

  /**
   * Opens the selected capture devices and shows their levels without touching
   * the API. Confirming that call audio actually arrives is otherwise only
   * possible by starting a billed session, which is a poor way to debug wiring.
   */
  async function toggleAudioTest() {
    if (state.test.running) return stopAudioTest();
    if (state.running) return toast('Already translating — the meters in the header are live.', 'error');

    const s = state.settings;
    const targets = [];
    if (s.outboundEnabled && s.micDeviceId) {
      targets.push({ key: 'mic', deviceId: s.micDeviceId, meter: 'meter-test-mic', processing: true });
    }
    if (s.inboundEnabled && s.fromCallDeviceId) {
      targets.push({ key: 'call', deviceId: s.fromCallDeviceId, meter: 'meter-test-call', processing: false });
    }
    if (!targets.length) return toast('Select an input device first.', 'error');

    state.test.peak = { mic: 0, call: 0 };
    state.test.running = true;
    $('btn-test-audio').classList.add('on');
    $('test-note').textContent = 'Listening… speak into the mic, and play some audio into the call device. '
      + 'Whatever reaches the call input is played into your headphones so you can hear it too.';

    for (const target of targets) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: target.deviceId },
            channelCount: 1,
            echoCancellation: target.processing,
            noiseSuppression: target.processing,
            autoGainControl: target.processing,
          },
        });
        state.test.streams.push(stream);
        state.test.meters.push(new VB.audio.Meter(stream, (level) => {
          if (level > state.test.peak[target.key]) state.test.peak[target.key] = level;
          setMeter(target.meter, level);
        }));

        // Monitor the captured call audio in the headphones. Once the meeting
        // tab plays into a cable there is no other way to hear it without
        // starting a billed session, so the test would otherwise leave you
        // staring at a silent bar with no idea which end is wrong.
        if (target.key === 'call' && s.headphonesDeviceId) {
          state.test.monitor = new VB.audio.Passthrough(stream, s.headphonesDeviceId, 1);
        }
      } catch (err) {
        toast(`Could not open ${target.key} device: ${err.message}`, 'error');
      }
    }

    state.test.tested = targets.map((t) => t.key);
    state.test.timer = setTimeout(stopAudioTest, TEST_DURATION_MS);
    tickTestButton(TEST_DURATION_MS);
  }

  function tickTestButton(remaining) {
    if (!state.test.running) return;
    $('btn-test-audio').textContent = `Stop (${Math.ceil(remaining / 1000)}s)`;
    state.test.tickTimer = setTimeout(() => tickTestButton(remaining - 1000), 1000);
  }

  function stopAudioTest() {
    clearTimeout(state.test.timer);
    clearTimeout(state.test.tickTimer);
    if (state.test.monitor) {
      state.test.monitor.stop();
      state.test.monitor = null;
    }
    for (const meter of state.test.meters) meter.stop();
    for (const stream of state.test.streams) {
      for (const track of stream.getTracks()) track.stop();
    }
    state.test.meters = [];
    state.test.streams = [];
    state.test.running = false;

    setMeter('meter-test-mic', 0);
    setMeter('meter-test-call', 0);
    $('btn-test-audio').classList.remove('on');
    $('btn-test-audio').textContent = 'Test devices';
    $('test-note').innerHTML = testVerdict();
  }

  function testVerdict() {
    const parts = [];
    for (const key of state.test.tested || []) {
      const heard = state.test.peak[key] > SIGNAL_THRESHOLD;
      const name = key === 'mic' ? 'Microphone' : 'Call audio';
      parts.push(heard
        ? `<b>${name}: signal detected.</b>`
        : `<b>${name}: silent.</b> ${key === 'mic'
          ? 'Check that the right microphone is selected and not muted in Windows.'
          : 'Point the meeting tab’s speaker at this device’s playback side — and note that '
            + 'some virtual devices do not loop rendered audio back to their capture side at all.'}`);
    }
    return parts.join('<br>') || 'Nothing was tested.';
  }

  // ============================================================= languages ==

  function buildLanguageSelects() {
    for (const id of ['sel-mylang', 'sel-theirlang']) {
      const select = $(id);
      select.innerHTML = '';
      for (const lang of VB.languages.SPOKEN) {
        select.appendChild(new Option(`${lang.flag} ${lang.name} · ${lang.native}`, lang.code));
      }
    }
  }

  // ================================================================== ui ====

  function bindUi() {
    $('btn-setup').onclick = () => togglePanel('panel-setup');
    $('btn-history').onclick = () => { renderHistory(); togglePanel('panel-history'); };
    $('btn-settings').onclick = () => togglePanel('panel-settings');
    for (const btn of document.querySelectorAll('.panel-close')) {
      btn.onclick = () => closePanels();
    }

    $('btn-start').onclick = () => (state.running ? stop() : start());
    $('btn-mute').onclick = () => setMuted(!state.muted);
    $('btn-export').onclick = exportCurrent;

    // Devices
    $('btn-refresh-devices').onclick = () => refreshDevices({});
    $('btn-test-audio').onclick = toggleAudioTest;
    $('sel-mic').onchange = (e) => chooseDevice(DEVICE_FIELDS[0], e.target.value).then(() => refreshDevices({}));
    $('sel-tocall').onchange = (e) => chooseDevice(DEVICE_FIELDS[1], e.target.value).then(() => refreshDevices({}));
    $('sel-fromcall').onchange = (e) => chooseDevice(DEVICE_FIELDS[2], e.target.value).then(() => refreshDevices({}));
    $('sel-headphones').onchange = async (e) => {
      await chooseDevice(DEVICE_FIELDS[3], e.target.value);
      await refreshDevices({});
      await applyHeadphoneDevice(e.target.value);
    };
    $('chk-outbound').onchange = (e) => saveSettings({ outboundEnabled: e.target.checked })
      .then(afterRoutingChange);
    $('chk-inbound').onchange = (e) => saveSettings({ inboundEnabled: e.target.checked })
      .then(afterRoutingChange);

    // Languages
    $('sel-mylang').onchange = (e) => saveSettings({ myLanguage: e.target.value })
      .then(afterSessionSettingChange).then(afterEngineOptionChange);
    $('sel-theirlang').onchange = (e) => saveSettings({ theirLanguage: e.target.value })
      .then(afterSessionSettingChange).then(afterEngineOptionChange);
    $('btn-swap-lang').onclick = async () => {
      const s = state.settings;
      await saveSettings({ myLanguage: s.theirLanguage, theirLanguage: s.myLanguage });
      renderSettings();
      afterSessionSettingChange();
      afterEngineOptionChange();
    };

    $('btn-sound-panel').onclick = () => api.system.openSoundPanel();

    // Engine
    for (const id of ['engine-cloud', 'engine-local']) {
      $(id).onchange = (e) => { if (e.target.checked) chooseEngine(e.target.value); };
    }
    $('btn-local-setup').onclick = () => runLocalJob('Installing the engine',
      () => api.local.setup({ gpu: true }));
    $('btn-local-models').onclick = () => runLocalJob('Downloading models', () => {
      const s = state.settings;
      return api.local.download({
        asr: s.localAsr,
        whisper: s.localWhisper,
        translator: s.localTranslator,
        langs: [s.myLanguage, s.theirLanguage],
        voices: [chosenVoice(s.theirLanguage), chosenVoice(s.myLanguage)].filter(Boolean),
      });
    });
    $('btn-local-recheck').onclick = () => refreshLocalStatus({ gpu: true });
    $('sel-local-asr').onchange = (e) => {
      const [asr, size] = e.target.value.split(':');
      saveSettings({ localAsr: asr, ...(size ? { localWhisper: size } : {}) })
        .then(afterEngineOptionChange);
    };
    $('sel-voice-mine').onchange = (e) => chooseVoice(state.settings.theirLanguage, e.target.value);
    $('sel-voice-theirs').onchange = (e) => chooseVoice(state.settings.myLanguage, e.target.value);
    $('btn-voice-mine').onclick = () => previewVoice('mine');
    $('btn-voice-theirs').onclick = () => previewVoice('theirs');
    $('sel-local-translator').onchange = (e) =>
      saveSettings({ localTranslator: e.target.value }).then(afterEngineOptionChange);
    $('sel-local-device').onchange = (e) =>
      saveSettings({ localDevice: e.target.value }).then(afterEngineOptionChange);
    $('sel-local-endpoint').onchange = (e) =>
      saveSettings({ localEndpointMs: Number(e.target.value) });
    $('rng-local-sensitivity').oninput = (e) =>
      saveSettings({ localSensitivity: Number(e.target.value) / 100 });

    api.on('local:progress', (payload) => {
      if (!payload || !payload.line) return;
      state.local.log.push(payload.line);
      if (state.local.log.length > 200) state.local.log.shift();
      const log = $('local-log');
      log.hidden = false;
      log.textContent = state.local.log.slice(-12).join('\n');
      log.scrollTop = log.scrollHeight;
    });

    // Key
    $('btn-save-key').onclick = async () => {
      const value = $('inp-apikey').value.trim();
      if (!value) return toast('Paste a key first.', 'error');
      state.keyStatus = await api.key.set(value);
      $('inp-apikey').value = '';
      renderKeyStatus();
      verifyKey();
    };
    $('btn-verify-key').onclick = verifyKey;
    $('btn-clear-key').onclick = async () => {
      state.keyStatus = await api.key.clear();
      renderKeyStatus();
      toast('API key removed.');
    };

    // Behaviour
    $('sel-micmode').onchange = (e) => saveSettings({ micMode: e.target.value }).then(applyMicMode);
    $('sel-noise').onchange = (e) => saveSettings({ noiseReduction: e.target.value }).then(afterSessionSettingChange);
    $('chk-echogate').onchange = (e) => {
      applyEchoGate(e.target.checked);
      saveSettings({ echoGate: e.target.checked });
    };
    $('chk-transcription').onchange = (e) =>
      saveSettings({ transcription: e.target.checked }).then(afterSessionSettingChange);

    $('rng-volume').oninput = (e) => {
      const v = Number(e.target.value) / 100;
      $('lbl-volume').textContent = `${e.target.value}%`;
      state.settings.outputVolume = v;
      for (const lane of activeLanes()) lane.setOutputVolume(v);
    };
    $('rng-volume').onchange = (e) => saveSettings({ outputVolume: Number(e.target.value) / 100 });

    $('rng-passthrough').oninput = (e) => {
      $('lbl-passthrough').textContent = `${e.target.value}%`;
      applyPassthroughVolume(Number(e.target.value) / 100);
    };
    $('rng-passthrough').onchange = (e) =>
      saveSettings({ passthroughVolume: Number(e.target.value) / 100 });

    $('inp-hotkey-mute').onchange = (e) => saveSettings({ hotkeyToggleMute: e.target.value.trim() });
    $('inp-hotkey-show').onchange = (e) => saveSettings({ hotkeyShowWindow: e.target.value.trim() });
    $('chk-tray').onchange = (e) => saveSettings({ minimizeToTray: e.target.checked });
    $('chk-autosave').onchange = (e) => saveSettings({ autoSaveHistory: e.target.checked });
    $('btn-open-data').onclick = () => api.system.openDataDir();
    $('btn-add-term').onclick = () => addGlossaryRow({ from: '', to: '' }, true);

    bindPushToTalk();
  }

  function bindPushToTalk() {
    const btn = $('btn-ptt');
    const press = (event) => { event.preventDefault(); setPttHeld(true); };
    const release = () => setPttHeld(false);
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointerleave', release);

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return;
      if (state.settings.micMode !== 'ptt' || !state.running) return;
      e.preventDefault();
      setPttHeld(true);
    });
    document.addEventListener('keyup', (e) => {
      if (e.code !== 'Space' || isTyping(e.target)) return;
      setPttHeld(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePanels();
    });
  }

  const isTyping = (el) => el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);

  function bindMainEvents() {
    api.on('hotkey:toggle-mute', () => state.running && setMuted(!state.muted));
    api.on('tray:toggle-mute', () => state.running && setMuted(!state.muted));
    api.on('tray:stop', () => state.running && stop());
    api.on('app:before-quit', () => { if (state.running) persistSession(); });
  }

  function togglePanel(id) {
    const panel = $(id);
    const wasOpen = !panel.hidden;
    closePanels();
    if (!wasOpen) openPanel(id);
  }

  function openPanel(id) {
    $(id).hidden = false;
    const map = { 'panel-setup': 'btn-setup', 'panel-history': 'btn-history', 'panel-settings': 'btn-settings' };
    if (map[id]) $(map[id]).classList.add('on');
  }

  function closePanels() {
    for (const p of document.querySelectorAll('.panel')) p.hidden = true;
    for (const b of ['btn-setup', 'btn-history', 'btn-settings']) $(b).classList.remove('on');
  }

  // =============================================================== engine ===

  async function chooseEngine(engine) {
    if (state.running) {
      renderEngine();
      return toast('Stop the session before switching engines.', 'error');
    }
    await saveSettings({ engine });
    renderEngine();
    if (engine === 'local') {
      state.local.preloaded = false;
      await refreshLocalStatus({ gpu: true });
    } else if (!state.keyStatus.present) {
      toast('This engine needs an OpenAI API key.', 'error');
    }
  }

  function renderEngine() {
    const s = state.settings;
    $(`engine-${s.engine === 'local' ? 'local' : 'cloud'}`).checked = true;
    $('local-engine').hidden = s.engine !== 'local';
    $('sel-local-asr').value = s.localAsr === 'whisper'
      ? `whisper:${s.localWhisper}` : s.localAsr;
    renderVoiceSelects();
    $('sel-local-translator').value = s.localTranslator;
    $('sel-local-device').value = s.localDevice;
    $('sel-local-endpoint').value = String(s.localEndpointMs);
    $('rng-local-sensitivity').value = Math.round(s.localSensitivity * 100);
    renderLocalStatus();
  }

  async function refreshLocalStatus(options) {
    if (state.local.busy) return;
    setLocalBusy('Checking what is installed');
    try {
      state.local.probe = await api.local.probe();
      console.info('[local] ' + JSON.stringify({
        installed: state.local.probe.installed,
        python: state.local.probe.python,
        whisper: state.local.probe.whisper,
        pairs: state.local.probe.pairs,
        voices: state.local.probe.voices,
        reason: state.local.probe.reason || null,
      }));
      // Only ask about the GPU once the engine itself is installed: the probe
      // loads a model, which takes a few seconds and fails confusingly if the
      // packages are not there yet.
      if ((options || {}).gpu && state.local.probe.installed) {
        setLocalBusy('Checking the GPU');
        state.local.gpu = await api.local.probeGpu();
        if (state.local.gpu.cuda && state.settings.localDevice === 'cpu') {
          await saveSettings({ localDevice: 'cuda' });
        }
      }
    } catch (err) {
      state.local.probe = { ready: false, reason: err.message,
                            whisper: [], voices: [], pairs: [] };
    } finally {
      setLocalBusy('');
      renderEngine();
    }
    preloadLocalModels();
  }

  /**
   * Warms the engine up in the background so Start is not a fifteen-second
   * wait.
   *
   * Loading Whisper, the translator and the voices is the whole of that wait,
   * and none of it depends on anything the user does at Start time. The engine
   * keeps what it loads, so doing it now costs nothing later — and doing it
   * while the Setup panel is open costs the user nothing at all.
   */
  function preloadLocalModels() {
    if (!isLocal() || state.local.preloaded || state.local.preloading) return;
    if (localGaps().length) return;

    const configs = laneNames().map((name) => localLaneConfig(name));
    if (!configs.length) return;

    setLocalHint('Loading models…');
    state.local.preloading = VB.preloadLocal(configs, (stage) => {
      setLocalHint(`Loading ${stage}…`);
    }).then(() => {
      state.local.preloaded = true;
      setLocalHint('');
    }).catch(() => {
      setLocalHint('');
    }).finally(() => {
      state.local.preloading = null;
    });
  }

  /** Anything the engine caches is keyed by these, so preload and start agree. */
  function localLaneConfig(name) {
    const s = state.settings;
    const outbound = name === 'outbound';
    const target = outbound ? s.theirLanguage : s.myLanguage;
    return {
      name,
      source: outbound ? s.myLanguage : s.theirLanguage,
      target,
      voice: chosenVoice(target),
      ...localEngineOptions(),
    };
  }

  /** The Piper voice for a language: the user's pick, else the catalog default. */
  function chosenVoice(lang) {
    const picked = (state.settings.localVoices || {})[lang];
    const catalog = catalogFor(lang);
    if (picked && catalog.some((v) => v.id === picked)) return picked;
    return catalog.length ? catalog[0].id : '';
  }

  function catalogFor(lang) {
    const info = state.local.probe || {};
    return (info.voiceCatalog && info.voiceCatalog[lang]) || [];
  }

  const laneNames = () => ['outbound', 'inbound'].filter(
    (n) => state.settings[n === 'outbound' ? 'outboundEnabled' : 'inboundEnabled']);

  function setLocalHint(text) {
    state.local.hint = text;
    renderLocalStatus();
  }

  /**
   * A different model is a different load. Forget that anything is warm and
   * warm the new one, or the status line will promise an instant Start that
   * the engine cannot deliver.
   */
  function afterEngineOptionChange() {
    state.local.preloaded = false;
    renderLocalStatus();
    preloadLocalModels();
  }

  // ------------------------------------------------------------- voices --

  function renderVoiceSelects() {
    const s = state.settings;
    const info = state.local.probe || {};
    const rows = [
      { select: 'sel-voice-mine', tag: 'voice-mine-lang', lang: s.theirLanguage, who: 'they hear' },
      { select: 'sel-voice-theirs', tag: 'voice-theirs-lang', lang: s.myLanguage, who: 'I hear' },
    ];
    for (const row of rows) {
      const sel = $(row.select);
      const catalog = catalogFor(row.lang);
      const have = new Set(info.voices || []);
      const current = chosenVoice(row.lang);
      sel.innerHTML = '';
      if (!catalog.length) {
        sel.appendChild(new Option(info.voiceCatalog
          ? `no offline voice for ${row.lang}` : 'checking…', ''));
        sel.disabled = true;
      } else {
        for (const v of catalog) {
          const label = `${v.name} — ${v.gender === 'f' ? 'female' : 'male'}`
            + (v.accent ? `, ${v.accent}` : '')
            + (have.has(v.id) ? '' : '  (download)');
          sel.appendChild(new Option(label, v.id, false, v.id === current));
        }
        sel.disabled = false;
      }
      $(row.tag).textContent = `— ${languageName(row.lang)}, what ${row.who}`;
    }
  }

  function languageName(code) {
    const entry = VB.languages.get(code);
    return entry ? entry.name : code;
  }

  async function chooseVoice(lang, voiceId) {
    const localVoices = { ...(state.settings.localVoices || {}), [lang]: voiceId };
    await saveSettings({ localVoices });
    // A running lane can switch voices without a restart; the engine caches
    // them, so the cost is one load the first time.
    afterEngineOptionChange();
  }

  const PREVIEW_TEXT = {
    en: 'Hi, this is how I will sound to the other person. Can you hear me clearly?',
    ru: 'Привет, вот так будет звучать перевод. Меня хорошо слышно?',
    de: 'Hallo, so wird die Übersetzung klingen. Können Sie mich gut hören?',
    es: 'Hola, así sonará la traducción. ¿Me escuchas bien?',
    fr: 'Bonjour, voici à quoi ressemblera la traduction. Vous m’entendez bien ?',
    it: 'Ciao, ecco come suonerà la traduzione. Mi senti bene?',
    pt: 'Olá, é assim que a tradução vai soar. Está me ouvindo bem?',
    uk: 'Привіт, ось так звучатиме переклад. Мене добре чути?',
    pl: 'Cześć, tak będzie brzmiało tłumaczenie. Dobrze mnie słychać?',
    nl: 'Hallo, zo zal de vertaling klinken. Hoor je me goed?',
  };

  /**
   * Plays a sample of the selected voice into the user's headphones.
   *
   * Both previews go to the headphones, including “my voice”, which in a call
   * is routed to the virtual cable: the point is to let *me* hear what the
   * other person will get, not to play it down the line.
   */
  async function previewVoice(which) {
    const s = state.settings;
    const lang = which === 'mine' ? s.theirLanguage : s.myLanguage;
    const voice = chosenVoice(lang);
    const btn = $(which === 'mine' ? 'btn-voice-mine' : 'btn-voice-theirs');
    if (!voice || btn.classList.contains('busy')) return;
    btn.classList.add('busy');
    try {
      const gaps = state.local.probe && !state.local.probe.installed;
      if (gaps) throw new Error('install the engine first');
      const { pcm, rate } = await VB.sayLocal(voice, PREVIEW_TEXT[lang] || PREVIEW_TEXT.en);
      await VB.playPcm(pcm, rate, state.routing.headphones && state.routing.headphones.deviceId);
      // The preview may have just downloaded the voice; the gap list should know.
      if (!(state.local.probe.voices || []).includes(voice)) await refreshLocalStatus({});
    } catch (err) {
      toast(`Voice preview failed: ${err.message}`, 'error');
    } finally {
      btn.classList.remove('busy');
    }
  }

  function setLocalBusy(what) {
    state.local.busy = what;
    for (const id of ['btn-local-setup', 'btn-local-models', 'btn-local-recheck']) {
      $(id).disabled = Boolean(what);
    }
    renderLocalStatus();
  }

  async function runLocalJob(what, job) {
    if (state.local.busy) return;
    state.local.log = [];
    setLocalBusy(what);
    try {
      state.local.probe = await job();
      toast(`${what}: done.`);
    } catch (err) {
      toast(`${what} failed: ${err.message}`, 'error');
    } finally {
      setLocalBusy('');
      $('local-log').hidden = true;
      renderLocalStatus();
    }
  }

  /**
   * What the local engine still needs before a session can start.
   *
   * Reported as a list rather than a single verdict because the two things that
   * can be missing — the Python packages and the model files — are fixed by
   * different buttons, and "not ready" alone tells you neither.
   */
  function localGaps() {
    const info = state.local.probe;
    const s = state.settings;
    if (!info) return ['not checked yet'];
    if (!info.installed) return ['the engine is not installed'];
    if (info.missingPackages && info.missingPackages.length) {
      return [`missing packages: ${info.missingPackages.join(', ')}`];
    }
    if (info.reason) return [info.reason];

    const gaps = [];
    for (const [from] of lanePairs()) {
      const backend = resolveAsr(s.localAsr, from, info);
      if (backend === 'whisper') {
        if (!(info.whisper || []).includes(s.localWhisper)) {
          gaps.push(`the Whisper ${s.localWhisper} model`);
        }
      } else if (!(info.asr || []).includes(backend)) {
        gaps.push(`the ${backend === 'gigaam' ? 'GigaAM' : 'Parakeet'} recognition model`);
      }
    }
    const nllb = s.localTranslator === 'nllb';
    if (nllb && !info.nllb && lanePairs().some(([a, b]) => a !== b)) {
      gaps.push('the NLLB translation model');
    }
    for (const [from, to] of lanePairs()) {
      if (from === to) continue;
      if (nllb) {
        // One model covers everything, so the only thing that can be missing
        // is a language it was never trained on.
        for (const lang of [from, to]) {
          if (info.nllbLanguages && !info.nllbLanguages.includes(lang)) {
            gaps.push(`${lang} (NLLB has no code for it — use OPUS-MT)`);
          }
        }
      } else if (!(info.pairs || []).includes(`${from}-${to}`)) {
        gaps.push(`the ${from}\u2192${to} translation model`);
      }
      const voice = chosenVoice(to);
      if (!voice) gaps.push(`a voice for ${to} (not available offline)`);
      else if (!(info.voices || []).includes(voice)) {
        const entry = catalogFor(to).find((v) => v.id === voice);
        gaps.push(`the voice “${entry ? entry.name : voice}”`);
      }
    }
    return [...new Set(gaps)];
  }

  /**
   * Mirrors pick_asr() in server.py: "auto" becomes the specialist for the
   * language, an explicit choice is honoured even where it cannot work, so
   * the gap list can say so.
   */
  function resolveAsr(requested, language, info) {
    const langs = (info && info.asrLanguages) || {};
    if (requested && requested !== 'auto') return requested;
    if ((langs.gigaam || ['ru']).includes(language)) return 'gigaam';
    if ((langs.parakeet || []).includes(language)) return 'parakeet';
    return 'whisper';
  }

  /** [source, target] for each direction that is switched on. */
  function lanePairs() {
    const s = state.settings;
    const pairs = [];
    if (s.outboundEnabled) pairs.push([s.myLanguage, s.theirLanguage]);
    if (s.inboundEnabled) pairs.push([s.theirLanguage, s.myLanguage]);
    return pairs;
  }

  function renderLocalStatus() {
    const el = $('local-status');
    if (!el) return;
    if (state.local.busy) {
      el.className = 'local-status busy';
      el.textContent = `${state.local.busy}…`;
      return;
    }

    const gaps = localGaps();
    const info = state.local.probe || {};
    if (!gaps.length && state.local.hint) {
      el.className = 'local-status busy';
      el.textContent = state.local.hint;
      return;
    }
    if (!gaps.length) {
      el.className = 'local-status ok';
      const where = state.settings.localDevice === 'cuda' ? 'GPU' : 'CPU';
      const mt = state.settings.localTranslator === 'nllb'
        ? 'NLLB-200'
        : `OPUS-MT (${(info.pairs || []).length} pairs)`;
      const names = { gigaam: 'GigaAM', parakeet: 'Parakeet', whisper: `Whisper ${state.settings.localWhisper}` };
      const asr = [...new Set(lanePairs().map(([from]) =>
        names[resolveAsr(state.settings.localAsr, from, info)]))].join(' + ');
      el.textContent = `Ready — ${asr}, ${mt} on the ${where}, `
        + `${(info.voices || []).length} voices.`
        + (state.local.preloaded ? ' Models are loaded; Start is instant.' : '');
    } else {
      el.className = 'local-status warn';
      el.textContent = `Not ready yet: ${gaps.join('; ')}.`;
    }

    const gpu = state.local.gpu;
    const lines = [];
    if (gpu && gpu.cuda) lines.push('An NVIDIA GPU is available and roughly halves the delay.');
    else if (gpu && gpu.reason) lines.push(`GPU not usable: ${gpu.reason}.`);
    if (info.models) lines.push(`Models are stored in ${info.models}.`);
    lines.push('Nothing leaves this computer and nothing is billed.');
    $('local-note').textContent = lines.join(' ');
  }

  // ============================================================= settings ===

  async function saveSettings(patch) {
    state.settings = await api.settings.set(patch);
    return state.settings;
  }

  function renderSettings() {
    const s = state.settings;
    $('sel-mylang').value = s.myLanguage;
    $('sel-theirlang').value = s.theirLanguage;
    $('chk-outbound').checked = s.outboundEnabled;
    $('chk-inbound').checked = s.inboundEnabled;
    $('sel-micmode').value = s.micMode;
    $('sel-noise').value = s.noiseReduction;
    $('chk-transcription').checked = s.transcription;
    $('chk-echogate').checked = Boolean(s.echoGate);
    $('rng-volume').value = Math.round(s.outputVolume * 100);
    $('lbl-volume').textContent = `${Math.round(s.outputVolume * 100)}%`;
    $('rng-passthrough').value = Math.round(s.passthroughVolume * 100);
    $('lbl-passthrough').textContent = `${Math.round(s.passthroughVolume * 100)}%`;
    $('inp-hotkey-mute').value = s.hotkeyToggleMute;
    $('inp-hotkey-show').value = s.hotkeyShowWindow;
    $('chk-tray').checked = s.minimizeToTray;
    $('chk-autosave').checked = s.autoSaveHistory;
    applyMicMode();
  }

  function renderAbout() {
    const i = state.info;
    $('about').innerHTML = [
      `VoiceB ${esc(i.version)} · Electron ${esc(i.electron)}`,
      `Model: ${esc(i.model)}`,
      `Captions: ${esc(i.transcribeModel)}`,
      `Data: ${esc(i.dataDir)}`,
    ].join('<br>');
  }

  function renderKeyStatus() {
    const el = $('key-status');
    if (!state.keyStatus.present) {
      el.className = 'key-status bad';
      el.textContent = 'No key saved.';
      return;
    }
    el.className = 'key-status ok';
    el.textContent = state.keyStatus.encrypted
      ? 'Key saved and encrypted by Windows.'
      : 'Key saved, but OS encryption is unavailable — it is stored obfuscated only.';
  }

  async function verifyKey() {
    const el = $('key-status');
    el.className = 'key-status';
    el.textContent = 'Checking…';
    const result = await api.key.verify();
    el.className = `key-status ${result.ok ? 'ok' : 'bad'}`;
    el.textContent = result.ok
      ? `Key works and can reach ${state.info.model}.`
      : result.detail || 'Key check failed.';
  }

  /** Language, transcription and noise settings are baked into the session. */
  function afterSessionSettingChange() {
    renderRouting();
    if (state.running) toast('Applies the next time you start translation.');
  }

  function applyMicMode() {
    const ptt = state.settings.micMode === 'ptt';
    $('btn-ptt').hidden = !ptt;
    $('btn-mute').hidden = ptt;
    if (state.running) setMuted(ptt ? !state.pttHeld : false);
  }

  // ============================================================= glossary ===

  function renderGlossary() {
    $('glossary-list').innerHTML = '';
    for (const entry of state.settings.glossary || []) addGlossaryRow(entry, false);
  }

  function addGlossaryRow(entry, focus) {
    const row = document.createElement('div');
    row.className = 'glossary-row';

    const from = document.createElement('input');
    from.placeholder = 'heard as';
    from.value = entry.from || '';

    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';

    const to = document.createElement('input');
    to.placeholder = 'write as';
    to.value = entry.to || '';

    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.title = 'Remove';
    remove.onclick = () => { row.remove(); commitGlossary(); };

    from.onchange = commitGlossary;
    to.onchange = commitGlossary;

    row.append(from, arrow, to, remove);
    $('glossary-list').appendChild(row);
    if (focus) from.focus();
  }

  function commitGlossary() {
    const entries = [];
    for (const row of document.querySelectorAll('.glossary-row')) {
      const [from, to] = row.querySelectorAll('input');
      if (from.value.trim()) entries.push({ from: from.value.trim(), to: to.value });
    }
    VB.glossary.compile(entries);
    saveSettings({ glossary: entries });
  }

  // ============================================================== session ===

  async function start() {
    if (state.starting || state.running) return;

    if (isLocal()) {
      if (!state.local.probe) await refreshLocalStatus({});
      const gaps = localGaps();
      if (gaps.length) {
        openPanel('panel-setup');
        return toast(`The local engine is not ready: ${gaps.join('; ')}.`, 'error');
      }
    } else if (!state.keyStatus.present) {
      openPanel('panel-settings');
      return toast('Add your OpenAI API key first.', 'error');
    }
    const s = state.settings;
    if (!s.outboundEnabled && !s.inboundEnabled) {
      openPanel('panel-setup');
      return toast('Switch on at least one direction.', 'error');
    }
    const missing = DEVICE_FIELDS.filter((f) => {
      const needed = f.key === 'mic' || f.key === 'toCall' ? s.outboundEnabled : s.inboundEnabled;
      const entry = state.routing[f.key];
      return needed && entry && !entry.available && !entry.unset;
    });
    if (missing.length) {
      openPanel('panel-setup');
      return toast(`Not connected: ${missing.map((f) => state.routing[f.key].label).join(', ')}. `
        + 'Reconnect it or choose another device.', 'error');
    }
    if (s.inboundEnabled && !s.fromCallDeviceId) {
      openPanel('panel-setup');
      return toast('Pick the device that carries the call audio, or switch off the inbound direction.', 'error');
    }
    if (s.outboundEnabled && s.inboundEnabled && s.micDeviceId === s.fromCallDeviceId) {
      openPanel('panel-setup');
      return toast('Both directions are reading the same input device — you would be translating yourself.', 'error');
    }

    if (state.test.running) { stopAudioTest(); await delay(400); }

    state.starting = true;
    setStatus('connecting', 'Connecting…');
    $('btn-start').disabled = true;
    closePanels();

    state.session = {
      id: `s${Date.now().toString(36)}`,
      startedAt: Date.now(),
      myLanguage: s.myLanguage,
      theirLanguage: s.theirLanguage,
      lines: [],
    };
    state.lineNodes.clear();
    $('feed').innerHTML = '';
    state.restarts = { outbound: 0, inbound: 0 };
    state.laneTime = {};
    state.warnedSilentInbound = false;
    state.laneProblems = {};
    renderLaneProblems();
    state.recentOutbound = [];
    state.outboundSpeaking = false;

    try {
      const jobs = [];
      if (s.outboundEnabled) jobs.push(startLane('outbound'));
      if (s.inboundEnabled) jobs.push(startLane('inbound'));
      await Promise.all(jobs);

      state.running = true;
      state.starting = false;
      $('btn-start').disabled = false;
      $('btn-start').textContent = 'Stop';
      $('btn-start').classList.add('stop');
      $('btn-mute').disabled = false;
      $('btn-export').disabled = false;
      $('feed-empty').hidden = true;
      api.window.setActive(true);
      setMuted(s.micMode === 'ptt');
      startTicking();
      setStatus('live', liveMessage());
    } catch (err) {
      state.starting = false;
      $('btn-start').disabled = false;
      await stop({ silent: true });
      setStatus('error', 'Failed to start');
      toast(err.message, 'error');
    }
  }

  async function startLane(name) {
    const s = state.settings;
    const r = state.routing;
    const outbound = name === 'outbound';

    // Both lane classes take the same options and raise the same events, so
    // everything below this point is engine-agnostic.
    const common = {
      name,
      label: outbound ? 'outbound' : 'inbound',
      inputDeviceId: (outbound ? r.mic : r.fromCall).deviceId,
      inputLabel: (outbound ? r.mic : r.fromCall).label,
      outputDeviceId: (outbound ? r.toCall : r.headphones).deviceId,
      outputLabel: (outbound ? r.toCall : r.headphones).label,
      targetLanguage: outbound ? s.theirLanguage : s.myLanguage,
      audioProcessing: outbound,          // real mic vs clean digital cable feed
      outputVolume: s.outputVolume,
      startMuted: outbound && s.micMode === 'ptt',
    };

    const lane = isLocal()
      ? new VB.LocalLane({
        ...common,
        // The cloud model detects the source language itself. Whisper is far
        // more accurate when told, and OPUS-MT is one model per direction, so
        // the local engine has to be given both ends of the pair.
        sourceLanguage: outbound ? s.myLanguage : s.theirLanguage,
        engineOptions: { ...localEngineOptions(), voice: chosenVoice(common.targetLanguage) },
      })
      : new VB.TranslationLane({
        ...common,
        transcription: s.transcription,
        // The noise-reduction setting describes *my* microphone. The remote
        // speaker is by definition not at my near-field mic, and their audio
        // has already been through the meeting app's own processing.
        noiseReduction: outbound ? s.noiseReduction : 'far_field',
      });

    lane.on('line', onLine);
    lane.on('lag', onLag);
    lane.on('error', (err) => toast(`${name}: ${err.message}`, 'error'));
    lane.on('playback-error', (err) => {
      state.laneProblems[name] = err.message;
      renderLaneProblems();
      toast(`${name}: ${err.message}`, 'error');
    });
    lane.on('loading', ({ stage }) => {
      if (!state.running) setStatus('connecting', `Loading ${stage}…`);
    });
    lane.on('state', (info) => onLaneState(name, info));
    lane.on('capture', ({ stream }) => attachCapture(name, stream));
    lane.on('speaking', ({ speaking }) => {
      const meter = name === 'outbound' ? 'meter-mic' : 'meter-remote';
      $(meter).parentElement.classList.toggle('hot', speaking);
      if (name === 'outbound') onOutboundSpeaking(speaking);
    });

    state.lanes[name] = lane;
    await lane.start();
  }

  function localEngineOptions() {
    const s = state.settings;
    const cores = navigator.hardwareConcurrency || 4;
    return {
      asr: s.localAsr,
      whisper: s.localWhisper,
      translator: s.localTranslator,
      speculate: s.localSpeculate !== false,
      device: s.localDevice,
      // Half the machine to each direction. They are rarely busy at the same
      // instant — people take turns — so this deliberately oversubscribes a
      // little rather than leaving cores idle whenever only one side is talking.
      threads: s.localThreads || Math.max(2, Math.floor(cores / 2)),
      sensitivity: s.localSensitivity,
      endpoint_ms: s.localEndpointMs,
      max_utterance_ms: s.localMaxUtteranceMs,
      partials: s.localPartials !== false,
    };
  }

  function attachCapture(name, stream) {
    if (name === 'outbound') {
      if (state.meters.mic) state.meters.mic.stop();
      state.meters.mic = new VB.audio.Meter(stream, (level) => setMeter('meter-mic', level));
      return;
    }

    if (state.meters.remote) state.meters.remote.stop();
    state.inboundLastSignalAt = Date.now();
    state.meters.remote = new VB.audio.Meter(stream, (level) => {
      if (level > SIGNAL_THRESHOLD) state.inboundLastSignalAt = Date.now();
      setMeter('meter-remote', level);
    });

    state.inboundStream = stream;
    if (state.passthrough) { state.passthrough.stop(); state.passthrough = null; }
    applyPassthroughVolume(state.settings.passthroughVolume);
  }

  /** Moves live inbound playback to a new device, so it can be fixed mid-call. */
  async function applyHeadphoneDevice(deviceId) {
    if (!state.running) return;
    try {
      if (state.lanes.inbound) await state.lanes.inbound.setOutputDevice(deviceId);
      if (state.passthrough) {
        state.passthrough.stop();
        state.passthrough = new VB.audio.Passthrough(
          state.inboundStream, deviceId, state.settings.passthroughVolume);
      }
    } catch (err) {
      toast(`Could not switch output device: ${err.message}`, 'error');
    }
  }

  /**
   * Mixes the speaker's untranslated voice in quietly under the translation so
   * tone and interruptions stay legible. Creates and tears down the playback on
   * demand: dragging the slider to zero must actually silence it, and dragging
   * back up must bring it back without restarting the session.
   */
  function applyPassthroughVolume(volume) {
    state.settings.passthroughVolume = volume;

    if (volume <= 0) {
      if (state.passthrough) { state.passthrough.stop(); state.passthrough = null; }
      return;
    }
    if (!state.running || !state.inboundStream) return;

    if (state.passthrough) {
      state.passthrough.setVolume(volume);
    } else {
      state.passthrough = new VB.audio.Passthrough(
        state.inboundStream, state.settings.headphonesDeviceId, volume);
    }
  }

  function onLaneState(name, info) {
    markLaneTime(name, info.state === 'live');
    if (!state.running) return;
    if (info.state === 'failed') {
      const attempt = ++state.restarts[name];
      if (attempt > MAX_RESTARTS) {
        setStatus('error', `${name} lane gave up`);
        toast(`${name} lane failed: ${info.detail || 'unknown error'}`, 'error');
        return;
      }
      setStatus('connecting', `Reconnecting ${name}… (${attempt}/${MAX_RESTARTS})`);
      restartLane(name, attempt);
    } else if (info.state === 'live' && everyLaneLive()) {
      setStatus('live', liveMessage());
    }
  }

  async function restartLane(name, attempt) {
    const old = state.lanes[name];
    if (old) await old.stop().catch(() => {});
    await delay(400 * attempt);
    if (!state.running) return;
    try {
      await startLane(name);
      setMuted(state.muted);
    } catch (err) {
      toast(`Could not restart ${name}: ${err.message}`, 'error');
    }
  }

  const everyLaneLive = () => activeLanes().every((lane) => lane.state === 'live');
  const activeLanes = () => Object.values(state.lanes).filter(Boolean);

  async function stop(options) {
    const silent = options && options.silent;
    stopTicking();

    for (const [name, lane] of Object.entries(state.lanes)) {
      if (lane) await lane.stop().catch(() => {});
      state.lanes[name] = null;
    }
    for (const key of ['mic', 'remote']) {
      if (state.meters[key]) { state.meters[key].stop(); state.meters[key] = null; }
    }
    if (state.passthrough) { state.passthrough.stop(); state.passthrough = null; }
    state.inboundStream = null;

    for (const name of ['outbound', 'inbound']) markLaneTime(name, false);

    const wasRunning = state.running;
    state.running = false;
    state.muted = false;

    $('btn-start').textContent = 'Start translation';
    $('btn-start').classList.remove('stop');
    $('btn-start').disabled = false;
    $('btn-mute').disabled = true;
    $('btn-mute').classList.remove('muted');
    $('btn-ptt').classList.remove('on');
    api.window.setActive(false);

    if (wasRunning) await persistSession();
    if (!silent) setStatus('idle', 'Ready');
  }

  async function persistSession() {
    const session = state.session;
    if (!session || !session.lines.length) return;
    session.endedAt = Date.now();
    session.durationMs = session.endedAt - session.startedAt;
    session.estimatedCostUsd = estimateCost();
    if (state.settings.autoSaveHistory) {
      try {
        await api.history.save(session);
      } catch (err) {
        console.error('[history] save failed', err);
      }
    }
  }

  /**
   * Billing is per minute of audio streamed into a session, per lane. Charging
   * the whole session against every *enabled* lane overstates it: a lane that
   * failed, restarted, or was never started costs nothing. Sum what each lane
   * actually spent connected instead.
   */
  function estimateCost() {
    if (isLocal()) return 0;
    let ms = 0;
    for (const name of ['outbound', 'inbound']) ms += laneBilledMs(name);
    return (ms / 60000) * state.pricePerMinute;
  }

  function laneBilledMs(name) {
    const entry = state.laneTime[name];
    if (!entry) return 0;
    return entry.total + (entry.liveSince ? Date.now() - entry.liveSince : 0);
  }

  /** A lane bills from the moment its session connects until it goes away. */
  function markLaneTime(name, live) {
    const entry = state.laneTime[name] || (state.laneTime[name] = { total: 0, liveSince: null });
    if (live) {
      if (!entry.liveSince) entry.liveSince = Date.now();
    } else if (entry.liveSince) {
      entry.total += Date.now() - entry.liveSince;
      entry.liveSince = null;
    }
  }

  // ============================================================= anti-echo ==

  const ECHO_GATE_TAIL_MS = 700;

  /**
   * Loudspeaker loop breaker. If the other party uses a speakerphone, their
   * mic re-captures our translated voice and sends it back; the inbound lane
   * then dutifully translates our own words. While our outbound lane is
   * speaking, stop feeding the inbound lane — plus a short tail for the round
   * trip. The price is real: during that window you cannot hear them talk over
   * you, which is why this is opt-in.
   */
  function onOutboundSpeaking(speaking) {
    state.outboundSpeaking = speaking;
    if (!state.settings.echoGate) return;
    clearTimeout(state.echoGateTimer);
    if (speaking) {
      gateInbound(true);
    } else {
      state.echoGateTimer = setTimeout(() => gateInbound(false), ECHO_GATE_TAIL_MS);
    }
  }

  function gateInbound(closed) {
    const lane = state.lanes.inbound;
    if (!lane) return;
    lane.setMuted(closed);
    $('status-text').classList.toggle('gated', closed);
  }

  function applyEchoGate(enabled) {
    state.settings.echoGate = enabled;
    if (!enabled) {
      clearTimeout(state.echoGateTimer);
      gateInbound(false);
    } else if (state.outboundSpeaking) {
      gateInbound(true);
    }
  }

  // ================================================================ input ===

  function setMuted(muted) {
    state.muted = muted;
    const lane = state.lanes.outbound;
    if (lane) lane.setMuted(muted);
    $('btn-mute').classList.toggle('muted', muted);
    $('btn-mute').textContent = muted ? 'MUTE' : 'MIC';
    $('btn-mute').title = muted ? 'Microphone muted — click to unmute' : 'Mute my microphone';
    if (state.running && state.settings.micMode !== 'ptt') {
      setStatus(muted ? 'idle' : 'live', muted ? 'Muted' : 'Live — speak normally');
    }
  }

  function setPttHeld(held) {
    if (state.settings.micMode !== 'ptt' || !state.running) return;
    if (state.pttHeld === held) return;
    state.pttHeld = held;
    $('btn-ptt').classList.toggle('on', held);
    setMuted(!held);
    setStatus(held ? 'live' : 'idle', held ? 'Talking…' : 'Hold PTT or Space to talk');
  }

  // ================================================================ feed ====

  function onLine(payload) {
    const translated = VB.glossary.apply(payload.translated || '');
    const source = VB.glossary.apply(payload.source || '');
    if (!translated && !source) return;

    let node = state.lineNodes.get(payload.id);
    if (!node) {
      node = createLineNode(payload);
      state.lineNodes.set(payload.id, node);
      const feed = $('feed');
      const pinned = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
      feed.appendChild(node.el);
      if (pinned) feed.scrollTop = feed.scrollHeight;
      $('feed-empty').hidden = true;
    }

    node.translatedEl.textContent = translated || '…';
    node.sourceEl.textContent = source;
    node.sourceEl.hidden = !source;
    node.el.classList.toggle('pending', !payload.done);

    if (payload.done) {
      if (payload.direction === 'outbound' && translated) {
        rememberOutbound(translated);
      } else if (payload.direction === 'inbound' && source && isEchoOfUs(source)) {
        node.el.classList.add('echo');
        node.echoEl = node.echoEl || appendEchoNote(node.el);
      }
    }

    upsertSessionLine({
      id: payload.id,
      direction: payload.direction,
      at: payload.at,
      source,
      translated,
    });
  }

  // Loop detection: an inbound line whose *source* matches something we just
  // said in the other language is our own voice coming back through the call.
  const ECHO_WINDOW_MS = 20000;

  function rememberOutbound(text) {
    const now = Date.now();
    state.recentOutbound = state.recentOutbound
      .filter((e) => now - e.at < ECHO_WINDOW_MS)
      .concat({ text: normalizeForMatch(text), at: now });
  }

  function isEchoOfUs(source) {
    const now = Date.now();
    const probe = normalizeForMatch(source);
    if (probe.length < 6) return false;
    return state.recentOutbound.some((e) =>
      now - e.at < ECHO_WINDOW_MS && (e.text.includes(probe) || probe.includes(e.text)
        || similarity(e.text, probe) > 0.8));
  }

  function normalizeForMatch(text) {
    return String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  }

  /** Cheap token-overlap similarity, enough to catch the same sentence re-transcribed. */
  function similarity(a, b) {
    const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
    if (!ta.size || !tb.size) return 0;
    let hit = 0;
    for (const t of ta) if (tb.has(t)) hit++;
    return hit / Math.max(ta.size, tb.size);
  }

  function appendEchoNote(el) {
    const note = document.createElement('div');
    note.className = 'line-echo';
    note.textContent = '↩ This is your own voice coming back through the call — the other side '
      + 'is on a speakerphone. Ask them to use headphones, or enable Settings → Anti-echo.';
    el.appendChild(note);
    return note;
  }

  function createLineNode(payload) {
    const outbound = payload.direction === 'outbound';
    const s = state.settings;
    const spoken = outbound ? s.myLanguage : s.theirLanguage;
    const heard = outbound ? s.theirLanguage : s.myLanguage;

    const el = document.createElement('div');
    el.className = `line ${payload.direction} pending`;

    const head = document.createElement('div');
    head.className = 'line-head';
    const who = document.createElement('b');
    who.textContent = outbound ? 'YOU' : 'THEM';
    const route = document.createElement('span');
    route.textContent = `${VB.languages.shortLabel(spoken)} → ${VB.languages.shortLabel(heard)}`;
    const time = document.createElement('time');
    time.textContent = new Date(payload.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    head.append(who, route, time);

    const translatedEl = document.createElement('div');
    translatedEl.className = 'line-translated';

    const sourceEl = document.createElement('div');
    sourceEl.className = 'line-source';
    sourceEl.hidden = true;

    el.append(head, translatedEl, sourceEl);
    return { el, translatedEl, sourceEl };
  }

  function upsertSessionLine(line) {
    if (!state.session) return;
    const lines = state.session.lines;
    const index = lines.findIndex((l) => l.id === line.id);
    if (index === -1) lines.push(line);
    else lines[index] = line;
  }

  function onLag(payload) {
    const chip = $('lag-chip');
    chip.hidden = false;
    chip.textContent = `${payload.ms} ms`;
    chip.className = `chip chip-lag ${payload.ms < 900 ? 'good' : 'slow'}`;
  }

  // =============================================================== status ===

  /** Keeps audio-routing trouble on screen; a six-second toast is too easy to miss. */
  function renderLaneProblems() {
    const box = $('lane-problems');
    const entries = Object.entries(state.laneProblems);
    box.hidden = entries.length === 0;
    box.innerHTML = entries
      .map(([name, message]) => `<div>⚠ ${esc(name)}: ${esc(message)}</div>`)
      .join('');
  }

  /** The local engine needs a pause to work with, so say so once per session. */
  function liveMessage() {
    return isLocal() ? 'Live — pause briefly between phrases' : 'Live — speak normally';
  }

  function setStatus(kind, text) {
    $('status-dot').className = `dot ${kind}`;
    $('status-text').textContent = text;
  }

  function setMeter(id, level) {
    $(id).style.setProperty('--level', `${Math.round(level * 100)}%`);
  }

  function startTicking() {
    stopTicking();
    const pill = $('session-pill');
    pill.classList.add('active');
    const tick = () => {
      const elapsed = Date.now() - state.session.startedAt;
      const total = Math.floor(elapsed / 1000);
      const mm = String(Math.floor(total / 60)).padStart(2, '0');
      const ss = String(total % 60).padStart(2, '0');
      pill.textContent = isLocal()
        ? `${mm}:${ss} · offline`
        : `${mm}:${ss} · ~$${estimateCost().toFixed(2)}`;
      checkInboundSilence(elapsed);
    };
    tick();
    state.tickTimer = setInterval(tick, 1000);
  }

  /**
   * The commonest failure in practice is not in this app at all: the meeting
   * app quietly re-picks its output device, so nothing reaches the cable and
   * the inbound lane translates silence. Say so instead of leaving the user to
   * wonder why the other side never appears.
   */
  function checkInboundSilence(elapsed) {
    if (state.warnedSilentInbound || !state.settings.inboundEnabled) return;
    if (elapsed < INBOUND_SILENCE_MS || !state.inboundLastSignalAt) return;
    if (Date.now() - state.inboundLastSignalAt < INBOUND_SILENCE_MS) return;

    state.warnedSilentInbound = true;
    const label = (state.routing.fromCall || {}).label || 'the capture device';
    toast(`No audio has reached “${label}” for a while. Check that the meeting app still `
      + 'plays into that cable — browsers re-pick their output device when devices change.', 'error');
  }

  function stopTicking() {
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.tickTimer = null;
    $('session-pill').classList.remove('active');
    $('session-pill').textContent = 'idle';
    $('lag-chip').hidden = true;
  }

  // ============================================================== history ===

  async function renderHistory() {
    const list = await api.history.list();
    const box = $('history-list');
    box.innerHTML = '';

    if (!list.length) {
      box.innerHTML = '<p class="note">No saved sessions yet.</p>';
      return;
    }

    for (const item of list) {
      const el = document.createElement('div');
      el.className = 'history-item';

      const top = document.createElement('div');
      top.className = 'h-top';
      const when = document.createElement('span');
      when.className = 'h-when';
      when.textContent = new Date(item.startedAt).toLocaleString();
      const meta = document.createElement('span');
      meta.className = 'h-meta';
      meta.textContent = `${formatDuration(item.durationMs)} · ${item.lineCount} lines · $${(item.estimatedCostUsd || 0).toFixed(2)}`;
      top.append(when, meta);

      const langs = document.createElement('div');
      langs.className = 'note';
      langs.textContent = `${VB.languages.shortLabel(item.myLanguage)} ⇄ ${VB.languages.shortLabel(item.theirLanguage)}`;

      const actions = document.createElement('div');
      actions.className = 'h-actions';
      actions.append(
        actionButton('Open', () => openHistorySession(item.id)),
        actionButton('TXT', () => api.history.exportTo(item.id, 'txt').then(reportExport)),
        actionButton('MD', () => api.history.exportTo(item.id, 'md').then(reportExport)),
        actionButton('JSON', () => api.history.exportTo(item.id, 'json').then(reportExport)),
        actionButton('Delete', async () => {
          await api.history.remove(item.id);
          renderHistory();
        }, 'del'),
      );

      el.append(top, langs, actions);
      box.appendChild(el);
    }
  }

  function actionButton(label, onClick, className) {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (className) btn.className = className;
    btn.onclick = onClick;
    return btn;
  }

  async function openHistorySession(id) {
    if (state.running) return toast('Stop translation first.', 'error');
    const session = await api.history.read(id);
    if (!session) return toast('Session not found.', 'error');

    state.session = session;
    state.lineNodes.clear();
    $('feed').innerHTML = '';
    for (const line of session.lines || []) {
      onLine({ ...line, done: true });
    }
    $('feed-empty').hidden = (session.lines || []).length > 0;
    $('btn-export').disabled = false;
    closePanels();
  }

  async function exportCurrent() {
    if (!state.session || !state.session.lines.length) return toast('Nothing to export yet.', 'error');
    const session = { ...state.session };
    session.endedAt = session.endedAt || Date.now();
    session.durationMs = session.endedAt - session.startedAt;
    session.estimatedCostUsd = session.estimatedCostUsd || estimateCost();
    await api.history.save(session);
    reportExport(await api.history.exportTo(session.id, 'txt'));
  }

  function reportExport(result) {
    if (result && result.saved) toast(`Saved to ${result.filePath}`, 'ok');
  }

  function formatDuration(ms) {
    const total = Math.round((ms || 0) / 1000);
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  }

  // ================================================================ utils ===

  function toast(message, kind) {
    console.info(`[toast:${kind || 'info'}] ${message}`);
    const el = $('toast');
    el.textContent = message;
    el.className = `toast ${kind || ''}`.trim();
    el.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6000 : 3500);
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})(window.VB = window.VB || {});
