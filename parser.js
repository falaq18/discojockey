/*
 * discojockey tracklist parser.
 *
 * Turns free text (a YouTube description, a comment, or a pasted list) into an
 * ordered list of tracks. Pure functions only, so it runs in the browser and
 * under `node --test`.
 */
(function (root) {
  'use strict';

  // h:mm:ss, mm:ss or m:ss, not glued to other digits.
  const TS_RE = /(?<![\d:])(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)(?![\d:])/;
  const TS_RE_G = new RegExp(TS_RE.source, 'g');

  const SEPARATORS = [' - ', ' – ', ' — ', ' -- ', ' ~ ', ' | '];

  function decodeEntities(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ');
  }

  function normalizeText(text) {
    return decodeEntities(
      String(text || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
    ).replace(/\r\n?/g, '\n');
  }

  function toSeconds(h, m, s) {
    return (h ? parseInt(h, 10) * 3600 : 0) + parseInt(m, 10) * 60 + parseInt(s, 10);
  }

  function formatTime(sec) {
    if (sec == null || isNaN(sec)) return '--:--';
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  // Strip list numbering, bullets, emoji and stray separators from the edges.
  function cleanLabel(label) {
    let s = label
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
      .replace(/[\[\(\{]\s*[\]\)\}]/g, ' ') // brackets left empty by a removed timestamp
      .replace(/\s+/g, ' ')
      .trim();
    s = s.replace(/^(?:#?\d{1,3}\s*[.)\]:]\s+|#\d{1,3}\s+|\d{1,3}\s+-\s+(?=\S+\s+-\s))/, '');
    s = s.replace(/^[\s\-–—|:•·*>~.]+/, '').replace(/[\s\-–—|:•·*~]+$/, '');
    return s.trim();
  }

  function splitArtistTitle(label) {
    const normalized = label.replace(/\s+[-–—]{1,2}\s+/g, (m) => ' ' + m.trim() + ' ');
    let best = -1;
    let sepLen = 0;
    for (const sep of SEPARATORS) {
      const i = normalized.indexOf(sep);
      if (i > 0 && (best === -1 || i < best)) {
        best = i;
        sepLen = sep.length;
      }
    }
    if (best > 0) {
      return {
        artist: normalized.slice(0, best).trim(),
        title: normalized.slice(best + sepLen).trim(),
        hasSeparator: true
      };
    }
    const by = normalized.match(/^(.+?)\s+by\s+(.+)$/i);
    if (by) return { artist: by[2].trim(), title: by[1].trim(), hasSeparator: true };
    return { artist: '', title: normalized.trim(), hasSeparator: false };
  }

  // "[Label]" or "{LABEL}" at the end of a line is a record label, not the title.
  function splitLabel(title) {
    const m = title.match(/^(.*?)\s*[\[{]([^\]}]{2,40})[\]}]\s*$/);
    if (m && m[1]) return { title: m[1].trim(), label: m[2].trim() };
    return { title, label: '' };
  }

  function isUnreleasedId(artist, title) {
    const id = /^(id|unknown|\?+)$/i;
    return id.test(title.trim()) || (id.test(artist.trim()) && id.test(title.trim()));
  }

  function makeTrack(label, startSec) {
    const { artist, title: rawTitle, hasSeparator } = splitArtistTitle(label);
    const { title, label: recordLabel } = splitLabel(rawTitle);
    return {
      startSec,
      artist,
      title: title || rawTitle,
      recordLabel,
      hasSeparator,
      unreleased: isUnreleasedId(artist, title || rawTitle),
      blends: [],
      raw: label
    };
  }

  const BLEND_RE = /^\s*(?:w\/|with\s|\+\s|&\s|x\s|vs\.?\s|over\s)/i;
  const NUMBERED_RE = /^\s*#?\d{1,3}\s*[.)\]:]\s+\S/;

  /**
   * Parse one block of text. Returns { tracks, timed, score }.
   * `durationSec` (optional) is used to drop timestamps past the end of the video.
   */
  function parseTracklist(text, durationSec) {
    const lines = normalizeText(text).split('\n');
    const timed = [];
    const untimed = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const m = line.match(TS_RE);
      if (m) {
        const startSec = toSeconds(m[1], m[2], m[3]);
        // Drop every timestamp in the line (ranges like "0:00 - 3:20" included).
        const label = cleanLabel(line.replace(TS_RE_G, ' ').replace(/\s[-–—]\s(?=\s*[-–—]?\s)/, ' '));
        if (!label || label.length < 2) continue;
        if (durationSec && startSec > durationSec + 5) continue;
        timed.push(makeTrack(label, startSec));
        continue;
      }

      if (BLEND_RE.test(line)) {
        const target = timed.length ? timed[timed.length - 1] : untimed[untimed.length - 1];
        const blend = cleanLabel(line.replace(BLEND_RE, ''));
        if (target && blend) target.blends.push(splitArtistTitle(blend));
        continue;
      }

      if (NUMBERED_RE.test(line)) {
        const label = cleanLabel(line);
        const t = makeTrack(label, null);
        if (t.hasSeparator) untimed.push(t);
      }
    }

    if (timed.length >= 3 || (timed.length >= 2 && timed.length >= untimed.length)) {
      // Keep source order unless it is clearly out of order; then sort.
      const sorted = timed.slice().sort((a, b) => a.startSec - b.startSec);
      const deduped = [];
      for (const t of sorted) {
        const prev = deduped[deduped.length - 1];
        if (prev && prev.startSec === t.startSec && prev.title.toLowerCase() === t.title.toLowerCase()) continue;
        deduped.push(t);
      }
      return { tracks: deduped, timed: true, score: scoreTracks(deduped, timed, durationSec) };
    }

    if (untimed.length >= 3) {
      return { tracks: untimed, timed: false, score: untimed.length * 0.5 };
    }

    return { tracks: [], timed: false, score: 0 };
  }

  // Higher is a more convincing tracklist.
  function scoreTracks(tracks, sourceOrder, durationSec) {
    if (!tracks.length) return 0;
    const withSep = tracks.filter((t) => t.hasSeparator).length;
    let inversions = 0;
    for (let i = 1; i < sourceOrder.length; i++) {
      if (sourceOrder[i].startSec < sourceOrder[i - 1].startSec) inversions++;
    }
    let score = withSep * 1.0 + (tracks.length - withSep) * 0.35;
    score -= inversions * 0.75;
    if (tracks[0].startSec <= 120) score += 1;
    if (durationSec) {
      const coverage = tracks[tracks.length - 1].startSec / durationSec;
      score += Math.min(1, coverage) * 2;
    }
    return score;
  }

  /**
   * Pick the best tracklist out of several candidate texts (description first,
   * then comments). A tracklist split over several comments is stitched together
   * when a later candidate carries on after the best one ends.
   */
  function pickBestTracklist(candidates, durationSec) {
    const parsed = candidates
      .map((c, i) => Object.assign({ source: c.source || 'text #' + (i + 1) }, parseTracklist(c.text, durationSec)))
      .filter((p) => p.tracks.length >= 2);

    if (!parsed.length) return null;

    parsed.sort((a, b) => (b.timed - a.timed) || (b.score - a.score));
    const best = parsed[0];
    const result = { tracks: best.tracks.slice(), timed: best.timed, sources: [best.source] };

    if (best.timed) {
      for (const p of parsed.slice(1)) {
        if (!p.timed) continue;
        const lastStart = result.tracks[result.tracks.length - 1].startSec;
        const continuation = p.tracks.filter((t) => t.startSec > lastStart + 30);
        if (continuation.length >= 2 && continuation.length >= p.tracks.length * 0.8) {
          result.tracks.push(...continuation);
          result.sources.push(p.source);
        }
      }
    }
    return result;
  }

  /** Add end times and transition points. The last track runs to `durationSec`. */
  function buildSet(tracks, durationSec) {
    return tracks.map((t, i) => {
      const next = tracks[i + 1];
      const endSec = next && next.startSec != null ? next.startSec : durationSec || null;
      return Object.assign({}, t, {
        index: i,
        endSec,
        lengthSec: t.startSec != null && endSec != null ? Math.max(0, endSec - t.startSec) : null
      });
    });
  }

  /** Plain-text export, one track per line. */
  function toText(tracks) {
    return tracks
      .map((t, i) => {
        const time = t.startSec != null ? formatTime(t.startSec) + ' ' : String(i + 1).padStart(2, '0') + '. ';
        const name = t.artist ? t.artist + ' - ' + t.title : t.title;
        const blends = t.blends.map((b) => '\n   w/ ' + (b.artist ? b.artist + ' - ' + b.title : b.title)).join('');
        return time + name + blends;
      })
      .join('\n');
  }

  const api = { parseTracklist, pickBestTracklist, buildSet, toText, formatTime, normalizeText, splitArtistTitle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DJParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
