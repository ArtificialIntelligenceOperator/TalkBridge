'use strict';

/**
 * Thin client for the OpenAI Realtime *translation* endpoints.
 *
 * Everything here runs in the main process so the long-lived API key never
 * reaches the renderer. The renderer only ever holds a short-lived client
 * secret, and even the SDP exchange is proxied through here to sidestep CORS.
 *
 *   POST /v1/realtime/translations/client_secrets  -> ephemeral secret
 *   POST /v1/realtime/translations/calls           -> SDP answer
 *
 * Unlike the conversational realtime models there is no response.create, no
 * turn taking and no conversation state: audio goes in continuously and
 * translated audio comes back continuously. That is what makes talking over
 * each other work.
 */

const MODEL = 'gpt-realtime-translate';
const TRANSCRIBE_MODEL = 'gpt-realtime-whisper';
const BASE = 'https://api.openai.com/v1/realtime/translations';

// Billed per minute of session wall-clock, per direction.
const USD_PER_MINUTE = 0.034;

/** Output languages gpt-realtime-translate can speak. */
const OUTPUT_LANGUAGES = [
  'en', 'es', 'pt', 'fr', 'de', 'it', 'ru', 'ja', 'zh', 'ko', 'hi', 'id', 'vi',
];

class OpenAiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'OpenAiError';
    this.status = status;
    this.body = body;
  }
}

async function readError(res) {
  const text = await res.text().catch(() => '');
  let detail = text;
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message || text;
  } catch { /* not JSON — use raw text */ }
  return detail || `HTTP ${res.status}`;
}

/**
 * Builds the session descriptor. Audio config is fixed at secret-creation
 * time — the translation session has no session.update for it — so switching
 * target language means tearing the lane down and starting a new one.
 */
function buildSession({ language, transcription, noiseReduction }) {
  if (!OUTPUT_LANGUAGES.includes(language)) {
    throw new Error(`${language} is not a supported output language`);
  }

  const input = {};
  if (transcription) {
    // No language hint here: the translation endpoint rejects
    // session.audio.input.transcription.language outright. Source language is
    // detected automatically, across 70+ languages.
    input.transcription = { model: TRANSCRIBE_MODEL };
  }
  if (noiseReduction && noiseReduction !== 'off') {
    input.noise_reduction = { type: noiseReduction };
  }

  return {
    model: MODEL,
    audio: {
      ...(Object.keys(input).length ? { input } : {}),
      output: { language },
    },
  };
}

/** Creates an ephemeral client secret scoped to one translation session. */
async function createClientSecret(apiKey, options) {
  if (!apiKey) throw new Error('No API key configured');

  const res = await fetch(`${BASE}/client_secrets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session: buildSession(options) }),
  });

  if (!res.ok) {
    throw new OpenAiError(await readError(res), res.status);
  }

  const data = await res.json();
  const value = data?.value || data?.client_secret?.value || data?.client_secret;
  if (!value) {
    throw new OpenAiError('Response contained no client secret', 200, data);
  }
  return { value, expiresAt: data?.expires_at ?? null };
}

/** Exchanges the browser's SDP offer for the server's SDP answer. */
async function exchangeSdp(clientSecret, offerSdp) {
  const res = await fetch(`${BASE}/calls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      'Content-Type': 'application/sdp',
    },
    body: offerSdp,
  });

  if (!res.ok) {
    throw new OpenAiError(await readError(res), res.status);
  }
  return res.text();
}

/** Cheap round trip so Settings can tell "bad key" from "no network". */
async function verifyKey(apiKey) {
  const res = await fetch(`https://api.openai.com/v1/models/${MODEL}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'unauthorized', detail: await readError(res) };
  }
  if (res.status === 404) {
    return {
      ok: false,
      reason: 'no_model_access',
      detail: `This key cannot reach ${MODEL}. Check the project's model permissions.`,
    };
  }
  return { ok: false, reason: 'error', detail: await readError(res) };
}

module.exports = {
  MODEL,
  TRANSCRIBE_MODEL,
  USD_PER_MINUTE,
  OUTPUT_LANGUAGES,
  createClientSecret,
  exchangeSdp,
  verifyKey,
};
