/**
 * Glossary.
 *
 * Important limitation, stated plainly because it shapes what this is worth:
 * gpt-realtime-translate accepts no custom prompt, so nothing here can steer
 * the *spoken* translation. These substitutions are applied to transcript text
 * only — the live captions, the saved history, and exports. Use it to keep
 * product names, people, and internal jargon readable in the record.
 */
(function (VB) {
  'use strict';

  let compiled = [];

  function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Word-ish boundaries via Unicode property escapes — plain \b is ASCII-only
   * and would fail on Cyrillic, which is the main case here.
   */
  function compile(entries) {
    compiled = (entries || [])
      .filter((e) => e && e.from && e.from.trim())
      .map((e) => {
        const flags = e.caseSensitive ? 'gu' : 'giu';
        let pattern;
        try {
          pattern = new RegExp(
            `(?<![\\p{L}\\p{N}])${escapeRegex(e.from.trim())}(?![\\p{L}\\p{N}])`, flags);
        } catch {
          pattern = new RegExp(escapeRegex(e.from.trim()), flags);
        }
        return { pattern, to: e.to == null ? '' : e.to };
      });
    return compiled.length;
  }

  function apply(text) {
    if (!text || !compiled.length) return text;
    let out = text;
    for (const rule of compiled) out = out.replace(rule.pattern, rule.to);
    return out;
  }

  function size() {
    return compiled.length;
  }

  VB.glossary = { compile, apply, size };
})(window.VB = window.VB || {});
