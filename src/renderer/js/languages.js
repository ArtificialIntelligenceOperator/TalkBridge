/**
 * Language tables.
 *
 * gpt-realtime-translate detects any of 70+ input languages automatically but
 * can only *speak* 13. Both sides of a VoiceB conversation must therefore be
 * chosen from the spoken set — each language is the output of one lane and the
 * transcription hint of the other.
 */
(function (VB) {
  'use strict';

  const SPOKEN = [
    { code: 'en', name: 'English', native: 'English', flag: '🇬🇧' },
    { code: 'ru', name: 'Russian', native: 'Русский', flag: '🇷🇺' },
    { code: 'es', name: 'Spanish', native: 'Español', flag: '🇪🇸' },
    { code: 'pt', name: 'Portuguese', native: 'Português', flag: '🇵🇹' },
    { code: 'fr', name: 'French', native: 'Français', flag: '🇫🇷' },
    { code: 'de', name: 'German', native: 'Deutsch', flag: '🇩🇪' },
    { code: 'it', name: 'Italian', native: 'Italiano', flag: '🇮🇹' },
    { code: 'ja', name: 'Japanese', native: '日本語', flag: '🇯🇵' },
    { code: 'zh', name: 'Chinese', native: '中文', flag: '🇨🇳' },
    { code: 'ko', name: 'Korean', native: '한국어', flag: '🇰🇷' },
    { code: 'hi', name: 'Hindi', native: 'हिन्दी', flag: '🇮🇳' },
    { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia', flag: '🇮🇩' },
    { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt', flag: '🇻🇳' },
  ];

  const byCode = new Map(SPOKEN.map((l) => [l.code, l]));

  function get(code) {
    return byCode.get(code) || { code, name: code.toUpperCase(), native: code, flag: '' };
  }

  function label(code) {
    const l = get(code);
    return `${l.flag} ${l.name}`.trim();
  }

  function shortLabel(code) {
    return get(code).name;
  }

  VB.languages = { SPOKEN, get, label, shortLabel };
})(window.VB = window.VB || {});
