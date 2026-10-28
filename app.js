/*************************************************************************
 * discojockey: client for the decoding engine.
 * The page layout is the original Mix Studio / Discover & Mix design; every number
 * on it now comes from the engine's analysis of the real audio.
 *************************************************************************/

/*************************************************************************
 * 1. STORAGE, TOAST & SMALL HELPERS
 *************************************************************************/
function safeGetStorage(key, fallback = '') {
  try {
    const val = window.localStorage.getItem(key);
    return val !== null ? val : fallback;
  } catch (err) {
    return fallback;
  }
}
function safeSetStorage(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch (err) {
    return false;
  }
}
function readJson(key, fallback) {
  try {
    return JSON.parse(safeGetStorage(key, '')) ?? fallback;
  } catch (e) {
    return fallback;
  }
}

function showToast(message) {
  const toast = document.getElementById('toastBanner');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function parseTimeInput(str) {
  if (!str) return 0;
  const clean = String(str).trim();
  if (/^\d+$/.test(clean)) return parseInt(clean, 10);
  const parts = clean.split(':').map(Number);
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  return 0;
}

const num2 = n => String(n).padStart(2, '0');
const fmtBpm = bpm => (bpm ? `${Math.round(bpm * 10) / 10}` : '—');
const fmtCam = cam => cam || '—';
const songKey = (artist, title) => `${(artist || '').toLowerCase().trim()}|${(title || '').toLowerCase().trim()}`;

function displayTitle(tr) {
  if (tr.source === 'unknown' && state.currentSet.partial) return 'Identifying…';
  if (tr.source === 'unknown') return 'ID — not recognised';
  return tr.title;
}
function displayArtist(tr) {
  if (tr.source === 'unknown') return state.currentSet.partial ? 'Listening…' : 'Unknown artist';
  return tr.artist;
}
function sourceLabel(tr) {
  if (tr.source === 'tracklist') return 'From posted tracklist';
  if (tr.source === 'shazam') return 'Shazam match';
  if (tr.source === 'audd') return 'AudD match';
  if (tr.source === 'user') return 'Added by you';
  if (tr.source === 'unknown') return state.currentSet.partial ? 'Identifying' : 'Not recognised';
  return 'Identified';
}

/*************************************************************************
 * 2. CAMELOT TABLE & HARMONIC / TEMPO RECOMMENDATION ENGINE
 *    Formula: 0.35*tempo + 0.35*harmonic + 0.15*style + 0.10*relatedness + 0.05*energy
 *************************************************************************/
const CAMELOT_TO_KEY = {
  '1A': 'Ab Minor', '1B': 'B Major',
  '2A': 'Eb Minor', '2B': 'F# Major',
  '3A': 'Bb Minor', '3B': 'Db Major',
  '4A': 'F Minor',  '4B': 'Ab Major',
  '5A': 'C Minor',  '5B': 'Eb Major',
  '6A': 'G Minor',  '6B': 'Bb Major',
  '7A': 'D Minor',  '7B': 'F Major',
  '8A': 'A Minor',  '8B': 'C Major',
  '9A': 'E Minor',  '9B': 'G Major',
  '10A': 'B Minor', '10B': 'D Major',
  '11A': 'F# Minor','11B': 'A Major',
  '12A': 'Db Minor','12B': 'E Major'
};

const RecommendationEngine = {
  parseCamelot(code) {
    if (!code || typeof code !== 'string') return null;
    const m = code.trim().toUpperCase().match(/^(\d{1,2})([AB])$/);
    if (!m) return null;
    const num = parseInt(m[1], 10);
    if (num < 1 || num > 12) return null;
    return { num, letter: m[2], raw: `${num}${m[2]}` };
  },

  wheelDistance(a, b) {
    const diff = Math.abs(a - b);
    return Math.min(diff, 12 - diff);
  },

  scoreHarmonic(seedCamelot, candCamelot) {
    const s = this.parseCamelot(seedCamelot);
    const c = this.parseCamelot(candCamelot);
    if (!s || !c) return { score: null, label: 'Key unknown', cheeky: 'Key not measured: trust your ears.' };

    const dist = this.wheelDistance(s.num, c.num);
    if (dist === 0 && s.letter === c.letter) {
      return { score: 1.0, label: `Exact Key Lock (${c.raw})`, cheeky: `Locked in ${c.raw}. Zero key clash — blend the intros for 32 bars.` };
    }
    if (dist === 0 && s.letter !== c.letter) {
      return { score: 0.92, label: `Relative Major/Minor (${s.raw} → ${c.raw})`, cheeky: `Relative ${s.raw} → ${c.raw} flip. Same notes, fresh emotional shade.` };
    }
    if (dist === 1 && s.letter === c.letter) {
      return { score: 0.88, label: `±1 Camelot Step (${s.raw} → ${c.raw})`, cheeky: `One step around the Camelot wheel (${s.raw} → ${c.raw}). Butter-smooth harmonic glide.` };
    }
    if (dist === 1 && s.letter !== c.letter) {
      return { score: 0.72, label: `Diagonal Energy Shift (${s.raw} → ${c.raw})`, cheeky: `Diagonal ${s.raw} → ${c.raw} mood shift — crisp for a vocal swap.` };
    }
    if (dist === 2 && s.letter === c.letter) {
      return { score: 0.65, label: `+2 Energy Boost (${s.raw} → ${c.raw})`, cheeky: `Two steps up the wheel (${s.raw} → ${c.raw}) for a hands-up energy jump.` };
    }
    return { score: Math.max(0.2, 0.55 - dist * 0.08), label: `Contrast Cut (${s.raw} → ${c.raw})`, cheeky: `Bold contrast cut — drop on the snare roll or bass switch.` };
  },

  scoreTempo(seedBpm, candBpm) {
    if (!seedBpm || !candBpm) return { score: null, delta: 99, mode: 'direct', cheeky: '', deltaStr: '' };
    const directDiff = Math.abs(seedBpm - candBpm);
    const halfDiff = Math.abs(seedBpm - candBpm * 0.5);
    const doubleDiff = Math.abs(seedBpm - candBpm * 2);

    let bestDiff = directDiff;
    let mode = 'direct';
    if (halfDiff < bestDiff) { bestDiff = halfDiff; mode = 'half-time'; }
    if (doubleDiff < bestDiff) { bestDiff = doubleDiff; mode = 'double-time'; }

    let score = 0.25;
    if (bestDiff <= 1) score = 1.0;
    else if (bestDiff <= 2.5) score = 0.94;
    else if (bestDiff <= 4) score = 0.85;
    else if (bestDiff <= 6) score = 0.72;
    else if (bestDiff <= 10) score = 0.52;

    const signedDelta = Math.round((candBpm - seedBpm) * 10) / 10;
    const deltaStr = signedDelta === 0 ? 'Exact BPM' : (signedDelta > 0 ? `+${signedDelta} BPM` : `${signedDelta} BPM`);
    const cheeky = mode === 'direct'
      ? (bestDiff <= 1.5 ? `${candBpm} BPM (${deltaStr}). Pitch fader barely moves.` : `${candBpm} BPM (${deltaStr}). Easy nudge on the pitch slider.`)
      : `${candBpm} BPM (${mode} pocket bridge).`;

    return { score, delta: bestDiff, mode, cheeky, deltaStr };
  },

  scoreStyle(seedStyle, candStyle) {
    if (!seedStyle || !candStyle) return 0.7;
    const sTokens = seedStyle.toLowerCase().split(/[\s/,&-]+/).filter(Boolean);
    const cTokens = candStyle.toLowerCase().split(/[\s/,&-]+/).filter(Boolean);
    const shared = sTokens.filter(t => cTokens.includes(t));
    if (shared.length >= 2) return 0.96;
    if (shared.length === 1) return 0.84;
    return 0.68;
  },

  rankCandidates(seedTrack, allCandidates, filterMode = 'all') {
    const results = [];
    for (const cand of allCandidates) {
      if (songKey(cand.artist, cand.title) === songKey(seedTrack.artist, seedTrack.title)) continue;

      const tempoRes = this.scoreTempo(seedTrack.bpm, cand.bpm);
      const harmRes = this.scoreHarmonic(seedTrack.camelot, cand.camelot);
      const styleScore = this.scoreStyle(seedTrack.style, cand.style);
      const relatedScore = typeof cand.relatedness === 'number' ? cand.relatedness : 0.7;
      const energyScore = (typeof seedTrack.energy === 'number' && typeof cand.energy === 'number')
        ? Math.max(0.3, 1 - Math.abs(seedTrack.energy - cand.energy))
        : 0.8;

      // Weights move to what we know when BPM or key is missing.
      const weights = {
        tempo: tempoRes.score !== null ? 0.35 : 0,
        harmonic: harmRes.score !== null ? 0.35 : 0,
        style: 0.15,
        related: 0.10,
        energy: 0.05
      };
      const weightSum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
      const composite = (
        (tempoRes.score || 0) * weights.tempo +
        (harmRes.score || 0) * weights.harmonic +
        styleScore * weights.style +
        relatedScore * weights.related +
        energyScore * weights.energy
      ) / weightSum;

      if (filterMode === 'harmonic' && (harmRes.score || 0) < 0.85) continue;
      if (filterMode === 'tempo' && tempoRes.delta > 3.2) continue;
      // Peak time: same or faster tempo, and a key that locks or lifts.
      if (filterMode === 'peak' && (!(cand.bpm && seedTrack.bpm && cand.bpm >= seedTrack.bpm - 0.5) || (harmRes.score || 0) < 0.65)) continue;

      results.push({
        ...cand,
        matchPercent: Math.round(composite * 100),
        harmonicLabel: harmRes.label,
        tempoLabel: tempoRes.deltaStr,
        whyItWorks: `${tempoRes.cheeky || (cand.bpm ? `${cand.bpm} BPM.` : 'Tempo not measured.')} ${harmRes.cheeky}`
      });
    }
    return results.sort((a, b) => b.matchPercent - a.matchPercent);
  }
};

/*************************************************************************
 * 3. APPLICATION STATE
 *************************************************************************/
function emptySet() {
  return { id: '', title: '', dj: '', venue: '', videoId: '', sourceUrl: '', durationSec: 0,
           tracks: [], transitions: [], energy: [], energyCurve: [], phases: [] };
}

const state = {
  activePage: 'studio',
  currentSet: emptySet(),
  currentTimeSec: 0,
  isPlaying: false,
  selectedTrackId: '',
  expandedTrackIds: new Set(),
  discoverSeedTrackId: '',
  discoverOverrideBpm: null,
  discoverOverrideCamelot: '',
  crateFilter: 'all',
  playbackMode: 'none', // 'youtube' | 'local' | 'none'
  ytPlayer: null,
  ytReady: false,
  ytVideoId: '',
  activeTrackIds: '',
  recs: {},
  crate: readJson('dj_crate', []),
  job: null,
  engine: null,
  previewAudio: new Audio(),
  previewBtn: null
};

/*************************************************************************
 * 4. ENGINE CONNECTION
 *************************************************************************/
function engineUrl() {
  return (safeGetStorage('dj_engine_url', '') || window.DISCOJOCKEY_ENGINE || '').trim().replace(/\/+$/, '');
}

async function api(path, opts = {}) {
  const base = engineUrl();
  if (!base) {
    const err = new Error('The decoding engine is not connected yet.');
    err.code = 'NO_ENGINE';
    throw err;
  }
  const headers = opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  let res;
  try {
    res = await fetch(base + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  } catch (e) {
    const err = new Error(`Can't reach the engine at ${base}. Is it running?`);
    err.code = 'OFFLINE';
    throw err;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `Engine error ${res.status}`);
  return body;
}

async function checkEngine() {
  const btn = document.getElementById('engineStatusBtn');
  const pill = document.getElementById('dspStatusPill');
  const modalStatus = document.getElementById('engineModalStatus');
  if (!engineUrl()) {
    state.engine = null;
    if (btn) btn.textContent = '⚙ Connect decoding engine';
    if (pill) pill.textContent = 'Engine not connected';
    if (modalStatus) modalStatus.textContent = 'No engine address set yet.';
    return;
  }
  try {
    const h = await api('/api/health');
    state.engine = h;
    const rec = h.recognizer === 'none' ? 'no recognition' : `${h.recognizer === 'audd' ? 'AudD' : 'Shazam'} recognition`;
    if (btn) btn.textContent = `⚙ Engine online · ${rec}`;
    if (pill && !state.job) pill.textContent = `Engine ready · ${rec}`;
    if (modalStatus) modalStatus.textContent = `Online (v${h.version}) · ${rec}${h.proxy ? ' · YouTube proxy on' : ''}`;
  } catch (e) {
    state.engine = null;
    if (btn) btn.textContent = '⚙ Engine offline';
    if (pill) pill.textContent = 'Engine offline';
    if (modalStatus) modalStatus.textContent = e.message;
  }
}

function toggleEngineModal() {
  const modal = document.getElementById('engineModal');
  if (!modal) return;
  modal.classList.toggle('hidden');
  const input = document.getElementById('engineUrlInput');
  if (input) input.value = engineUrl();
  if (!modal.classList.contains('hidden')) checkEngine();
}

function saveEngineUrl() {
  const val = (document.getElementById('engineUrlInput')?.value || '').trim();
  safeSetStorage('dj_engine_url', val || null);
  checkEngine().then(() => showToast(state.engine ? 'Engine connected!' : 'Saved — but the engine did not answer'));
}

function resetEngineUrl() {
  safeSetStorage('dj_engine_url', null);
  document.getElementById('engineUrlInput').value = engineUrl();
  checkEngine();
}

/*************************************************************************
 * 5. DECODING A SET (YouTube link, uploaded file or pasted tracklist)
 *************************************************************************/
function extractYouTubeId(input) {
  if (!input) return null;
  const str = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str;
  const m = str.match(/(?:[?&]v=|youtu\.be\/|embed\/|shorts\/|live\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function handleAnalyzeSubmission() {
  const raw = (document.getElementById('sourceUrlInput')?.value || '').trim();
  if (!raw) {
    showToast('Paste a YouTube DJ set link first');
    return;
  }
  const vid = extractYouTubeId(raw);
  if (vid) {
    if (location.hash !== `#v=${vid}`) history.replaceState(null, '', `#v=${vid}`);
    startDecode({ videoId: vid });
    return;
  }
  // No link: a pasted timestamped tracklist still gives a usable (names-only) set.
  const parsed = window.DJParser ? window.DJParser.parseTracklist(raw) : { tracks: [] };
  if (parsed.tracks.length >= 2) {
    applyTextTracklist(parsed);
    return;
  }
  showToast('Paste a YouTube link, a timestamped tracklist, or upload an audio file');
}

function setProgress(visible, progress = 0, label = '', isError = false) {
  const box = document.getElementById('decodeProgress');
  const bar = document.getElementById('decodeBar');
  const lab = document.getElementById('decodeStageLabel');
  if (!box) return;
  box.classList.toggle('hidden', !visible);
  if (bar) {
    bar.style.width = `${Math.max(4, Math.min(100, progress * 100))}%`;
    bar.classList.toggle('overlap-blend-zone', !isError);
    bar.classList.toggle('bg-coral', isError);
  }
  if (lab) {
    lab.textContent = label;
    lab.className = isError ? 'truncate text-coral' : 'truncate';
  }
}

async function startDecode({ videoId = '', file = null }) {
  if (state.job) state.job.cancelled = true;
  const job = { id: null, started: Date.now(), cancelled: false, videoId };
  state.job = job;

  if (videoId) {
    const cached = readJson(`dj_set_${videoId}`, null);
    loadYouTube(videoId);
    if (cached && cached.tracks?.length) {
      applySet(cached);
      showToast(`Loaded ${cached.tracks.length} tracks from your history`);
    } else {
      resetSetForLoading(videoId);
    }
  }

  setProgress(true, 0.03, videoId ? 'Sending the link to the engine…' : 'Uploading your mix…');
  clearInterval(state.elapsedTimer);
  state.elapsedTimer = setInterval(() => {
    const el = document.getElementById('decodeElapsed');
    if (el) el.textContent = `${Math.round((Date.now() - job.started) / 1000)}s`;
  }, 250);

  try {
    let start;
    if (file) {
      const form = new FormData();
      form.append('file', file);
      form.append('title', file.name.replace(/\.[^.]+$/, ''));
      start = await api('/api/analyze-file', { method: 'POST', body: form });
    } else {
      start = await api('/api/analyze', { method: 'POST', body: JSON.stringify({ url: videoId }) });
    }
    job.id = start.job;
    await pollJob(job);
  } catch (e) {
    if (job.cancelled) return;
    clearInterval(state.elapsedTimer);
    setProgress(true, 1, e.message, true);
    showToast(e.message);
    if (e.code === 'NO_ENGINE') toggleEngineModal();
    state.job = null;
  }
}

async function pollJob(job) {
  let shownVersion = 0;
  while (!job.cancelled) {
    const s = await api(`/api/jobs/${job.id}`);
    if (job.cancelled) return;
    setProgress(true, s.progress || 0.05, s.message || s.stage);
    const pill = document.getElementById('dspStatusPill');
    if (pill) pill.textContent = `${Math.round((s.progress || 0) * 100)}% · ${s.stage}`;
    if (s.status === 'done') {
      clearInterval(state.elapsedTimer);
      const secs = Math.round((Date.now() - job.started) / 1000);
      applySet(s.result);
      rememberSet(s.result);
      setProgress(false);
      if (pill) pill.textContent = `Decoded ${s.result.tracks.length} tracks in ${secs}s`;
      showToast(`Decoded ${s.result.tracks.length} tracks · ${s.result.stats?.identified ?? 0} identified · ${secs}s`);
      state.job = null;
      return;
    }
    if (s.status === 'error') {
      clearInterval(state.elapsedTimer);
      setProgress(true, 1, s.error || 'Analysis failed', true);
      showToast(s.error || 'Analysis failed');
      state.job = null;
      return;
    }
    if (s.result && s.version !== shownVersion) {
      shownVersion = s.version;
      applySet(s.result);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

function resetSetForLoading(videoId) {
  state.currentSet = { ...emptySet(), videoId, sourceUrl: `https://www.youtube.com/watch?v=${videoId}`, title: 'Decoding…' };
  state.selectedTrackId = '';
  const badge = document.getElementById('activeSetTitleBadge');
  if (badge) badge.textContent = `DECODING // YOUTUBE ${videoId}`;
  const anchor = document.getElementById('activeSetSourceAnchor');
  if (anchor) anchor.href = state.currentSet.sourceUrl;
  renderAll();
}

function normalizeSet(set) {
  const palette = [['#1E3AFF', '#FFFDF7'], ['#FF6B00', '#0D0D0D'], ['#D4FF00', '#0D0D0D'], ['#FF3B30', '#FFFDF7']];
  const tracks = (set.tracks || []).map((t, i) => ({
    featuring: '', credits: '', remixer: '', style: '', links: {}, blends: [], notes: [],
    keyName: '', camelot: '', bpm: null, energy: 0.5, transitionCallout: '',
    color: palette[i % palette.length][0], textColor: palette[i % palette.length][1],
    ...t,
    id: t.id || `t${i + 1}`,
    order: i + 1,
    deck: t.deck || (i % 2 === 0 ? 'A' : 'B')
  }));
  return { ...emptySet(), ...set, tracks };
}

function applySet(incoming) {
  const prevSelected = state.selectedTrackId;
  state.currentSet = normalizeSet(incoming);
  const tracks = state.currentSet.tracks;
  if (!tracks.some(t => t.id === prevSelected)) state.selectedTrackId = tracks[0]?.id || '';
  if (!tracks.some(t => t.id === state.discoverSeedTrackId)) {
    state.discoverSeedTrackId = tracks[0]?.id || '';
    state.discoverOverrideBpm = tracks[0]?.bpm || null;
    state.discoverOverrideCamelot = tracks[0]?.camelot || '';
  }
  if (tracks[0] && !state.expandedTrackIds.size) state.expandedTrackIds.add(tracks[0].id);

  const set = state.currentSet;
  const badge = document.getElementById('activeSetTitleBadge');
  if (badge) badge.textContent = `${set.dj ? set.dj + ' // ' : ''}${set.title || 'Untitled set'}`.toUpperCase();
  const anchor = document.getElementById('activeSetSourceAnchor');
  if (anchor) anchor.href = set.sourceUrl || '#';
  renderAll();
}

function renderAll() {
  renderMixTimeline();
  renderEnergyGraph();
  renderEnergyPhasePills();
  renderEditorialTracklist();
  if (state.activePage === 'discover') renderDiscoverPage();
  renderPracticeCrate();
}

function rememberSet(set) {
  if (!set.videoId) return;
  // Keep the last few full results so revisiting a set is instant.
  const list = readJson('dj_recent', []).filter(r => r.id !== set.videoId);
  list.unshift({ id: set.videoId, title: set.title || set.videoId, n: set.tracks.length });
  const keep = list.slice(0, 6);
  list.slice(6).forEach(r => safeSetStorage(`dj_set_${r.id}`, null));
  safeSetStorage('dj_recent', JSON.stringify(keep));
  if (!safeSetStorage(`dj_set_${set.videoId}`, JSON.stringify(set))) {
    keep.slice(3).forEach(r => safeSetStorage(`dj_set_${r.id}`, null));
    safeSetStorage(`dj_set_${set.videoId}`, JSON.stringify(set));
  }
  renderRecentSets();
}

function renderRecentSets() {
  const row = document.getElementById('recentSetsRow');
  if (!row) return;
  const list = readJson('dj_recent', []);
  const pills = list.map(r => `
    <button onclick="openRecentSet('${esc(r.id)}')" title="${esc(r.title)}"
            class="dj-pill px-3 py-1 rounded-full text-xs font-mono font-bold ${r.id === state.currentSet.videoId ? 'bg-ink text-lime' : 'bg-paper text-ink hover:bg-lime'}">
      ${esc(r.title.length > 26 ? r.title.slice(0, 24) + '…' : r.title)}
    </button>`).join('');
  row.innerHTML = `<span class="text-[11px] font-mono font-extrabold uppercase text-ink/60 mr-1">Recent Sets:</span>` +
    (pills || '<span class="text-[11px] font-mono font-bold text-ink/50">none yet</span>');
}

function openRecentSet(videoId) {
  document.getElementById('sourceUrlInput').value = `https://www.youtube.com/watch?v=${videoId}`;
  history.replaceState(null, '', `#v=${videoId}`);
  const cached = readJson(`dj_set_${videoId}`, null);
  if (cached) {
    loadYouTube(videoId);
    applySet(cached);
    renderRecentSets();
  } else {
    startDecode({ videoId });
  }
}

function applyTextTracklist(parsed) {
  const set = state.currentSet.videoId ? { ...state.currentSet } : { ...emptySet(), title: 'Pasted tracklist' };
  const items = parsed.tracks;
  const duration = state.currentSet.durationSec || (items[items.length - 1].startSec || 0) + 240;
  set.tracks = items.map((it, i) => ({
    id: `p${i + 1}`, title: it.title, artist: it.artist || 'Unknown artist', source: 'tracklist',
    startSec: it.startSec ?? i * 240, endSec: items[i + 1]?.startSec ?? (it.startSec != null ? duration : (i + 1) * 240),
    bpm: null, camelot: '', keyName: '', blends: it.blends || [], identified: true,
    transitionCallout: 'Timing from the pasted tracklist — decode the YouTube link to measure the real blend.'
  }));
  set.durationSec = Math.max(duration, set.tracks[set.tracks.length - 1].endSec);
  set.transitions = [];
  set.energy = [];
  set.energyCurve = [];
  set.phases = [];
  set.partial = false;
  applySet(set);
  showToast(`Loaded ${items.length} tracks from your text (no audio analysis)`);
}

/*************************************************************************
 * 6. PLAYERS: YOUTUBE IFRAME API + UPLOADED AUDIO
 *************************************************************************/
function ensureYouTubeApi(cb) {
  if (window.YT && window.YT.Player) return cb();
  const prev = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => { if (prev) prev(); cb(); };
  if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  }
}

function loadYouTube(videoId) {
  state.playbackMode = 'youtube';
  document.getElementById('emptyStageOverlay')?.classList.add('hidden');
  document.getElementById('customAudioStage')?.classList.add('hidden');
  document.getElementById('localAudioElement')?.pause();
  if (state.ytVideoId === videoId) return;
  state.ytVideoId = videoId;
  if (state.ytPlayer && state.ytReady) {
    state.ytPlayer.cueVideoById(videoId);
    return;
  }
  const ifr = document.getElementById('ytIframeElement');
  if (!ifr) return;
  const origin = location.origin.startsWith('http') ? `&origin=${encodeURIComponent(location.origin)}` : '';
  ifr.src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&rel=0&playsinline=1${origin}`;
  ensureYouTubeApi(() => {
    if (state.ytPlayer) return;
    state.ytPlayer = new YT.Player('ytIframeElement', {
      events: {
        onReady: () => { state.ytReady = true; },
        onStateChange: (e) => {
          const playing = e.data === YT.PlayerState.PLAYING;
          setPlayingUi(playing);
          if (playing) stopPreview();
        }
      }
    });
  });
}

function setPlayingUi(playing) {
  state.isPlaying = playing;
  const playBtn = document.getElementById('masterPlayBtn');
  if (playBtn) playBtn.textContent = playing ? '❚❚' : '▶';
  document.getElementById('headerEq')?.classList.toggle('playing-eq', playing);
}

function toggleMasterPlayback() {
  if (state.playbackMode === 'youtube' && state.ytReady) {
    if (state.isPlaying) state.ytPlayer.pauseVideo();
    else state.ytPlayer.playVideo();
  } else if (state.playbackMode === 'local') {
    const audio = document.getElementById('localAudioElement');
    if (!audio) return;
    if (audio.paused) audio.play();
    else audio.pause();
  } else {
    showToast('Load a set first');
  }
}

function playerTime() {
  if (state.playbackMode === 'youtube' && state.ytReady) {
    try { return state.ytPlayer.getCurrentTime() || 0; } catch (e) { return state.currentTimeSec; }
  }
  if (state.playbackMode === 'local') return document.getElementById('localAudioElement')?.currentTime || 0;
  return state.currentTimeSec;
}

// Follow the real playhead while the set plays.
setInterval(() => {
  if (!state.isPlaying || !state.currentSet.durationSec) return;
  state.currentTimeSec = playerTime();
  updatePlayheadPosition();
  renderEnergyGraph();
  const active = state.currentSet.tracks.filter(t => state.currentTimeSec >= t.startSec && state.currentTimeSec <= t.endSec).map(t => t.id).join(',');
  if (active !== state.activeTrackIds) {
    state.activeTrackIds = active;
    renderMixTimeline();
    renderEditorialTracklist();
  }
}, 500);

async function handleLocalAudioUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = '';
  state.playbackMode = 'local';
  state.ytVideoId = '';
  try { state.ytPlayer?.pauseVideo(); } catch (e) {}
  document.getElementById('emptyStageOverlay')?.classList.add('hidden');
  document.getElementById('customAudioStage')?.classList.remove('hidden');
  const audioEl = document.getElementById('localAudioElement');
  if (audioEl) {
    audioEl.src = URL.createObjectURL(file);
    audioEl.ontimeupdate = () => {
      state.currentTimeSec = audioEl.currentTime;
      updatePlayheadPosition();
    };
    audioEl.onplay = () => { setPlayingUi(true); stopPreview(); };
    audioEl.onpause = () => setPlayingUi(false);
  }
  history.replaceState(null, '', location.pathname);
  state.currentSet = { ...emptySet(), title: file.name.replace(/\.[^.]+$/, ''), dj: 'Uploaded mix' };
  renderAll();
  document.getElementById('activeSetTitleBadge').textContent = `YOUR MIX // ${state.currentSet.title.toUpperCase()}`;
  await startDecode({ file });
  const set = state.currentSet;
  const metrics = document.getElementById('customStageMetrics');
  if (metrics && set.tracks.length) {
    const bpms = set.tracks.map(t => t.bpm).filter(Boolean);
    metrics.textContent = `${set.tracks.length} tracks • ${bpms.length ? Math.min(...bpms) + '–' + Math.max(...bpms) + ' BPM' : ''}`;
  }
  drawWaveformToCanvas();
}

// Energy silhouette of the uploaded mix, drawn from the engine's measurements.
function drawWaveformToCanvas() {
  const canvas = document.getElementById('waveformCanvas');
  const pts = state.currentSet.energy || [];
  if (!canvas || !pts.length) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const bars = 72;
  const barW = Math.floor(W / bars) - 2;
  for (let i = 0; i < bars; i++) {
    const p = pts[Math.min(pts.length - 1, Math.floor((i / bars) * pts.length))];
    const h = Math.max(8, Math.min(H - 8, p.v * (H - 12)));
    ctx.fillStyle = i % 3 === 0 ? '#D4FF00' : (i % 2 === 0 ? '#FF6B00' : '#FFFDF7');
    ctx.fillRect(i * (barW + 2), (H - h) / 2, barW, h);
  }
}

/*************************************************************************
 * 7. LISTENING LINKS
 *************************************************************************/
function renderListeningPillsHtml(links, title, artist, compact = false) {
  const q = encodeURIComponent(`${artist} ${title}`);
  const safeLinks = links || {};
  const platforms = [
    { key: 'spotify',    label: 'Spotify',     bg: 'bg-[#1DB954] text-ink', url: safeLinks.spotify    || `https://open.spotify.com/search/${q}` },
    { key: 'beatport',   label: 'Beatport',    bg: 'bg-lime text-ink',      url: safeLinks.beatport   || `https://www.beatport.com/search?q=${q}` },
    { key: 'soundcloud', label: 'SoundCloud',  bg: 'bg-tangerine text-ink', url: safeLinks.soundcloud || `https://soundcloud.com/search?q=${q}` },
    { key: 'youtube',    label: 'YouTube',     bg: 'bg-coral text-paper',   url: safeLinks.youtube    || `https://www.youtube.com/results?search_query=${q}` },
    { key: 'apple',      label: 'Apple Music', bg: 'bg-paper text-ink',     url: safeLinks.apple      || `https://music.apple.com/us/search?term=${q}` },
    { key: 'ytmusic',    label: 'YT Music',    bg: 'bg-paper text-ink',     url: safeLinks.ytmusic    || `https://music.youtube.com/search?q=${q}` }
  ];
  const shown = compact ? platforms.slice(0, 4) : platforms;
  return shown.map(p => `
    <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()"
       class="dj-pill inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-mono font-extrabold ${p.bg}">
      <span>${p.label}</span>
      <span>↗</span>
    </a>
  `).join('');
}

/*************************************************************************
 * 8. MIX STUDIO: OVERLAPPING TIMELINE, INSPECTOR & ENERGY GRAPH
 *************************************************************************/
function computeOverlaps(tracks) {
  const sorted = [...tracks].sort((a, b) => a.startSec - b.startSec);
  const overlaps = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      const start = Math.max(a.startSec, b.startSec);
      const end = Math.min(a.endSec, b.endSec);
      if (end > start) {
        overlaps.push({ id: `ov_${a.id}_${b.id}`, startSec: start, endSec: end, durationSec: Math.round(end - start), trackA: a, trackB: b });
      }
    }
  }
  return overlaps;
}

function transitionFrom(trackId) {
  return (state.currentSet.transitions || []).find(t => t.from === trackId);
}

function renderMixTimeline() {
  const set = state.currentSet;
  const total = Math.max(1, set.durationSec);
  const tracks = set.tracks;
  const overlaps = computeOverlaps(tracks);

  const ruler = document.getElementById('timelineRuler');
  if (ruler && !set.durationSec) ruler.innerHTML = '';
  else if (ruler) {
    const steps = 6;
    let rulerHtml = '';
    for (let i = 0; i <= steps; i++) {
      const pct = (i / steps) * 100;
      const sec = Math.round((i / steps) * (set.durationSec || 0));
      const align = i === 0 ? 'translate-x-0' : (i === steps ? '-translate-x-full' : '-translate-x-1/2');
      rulerHtml += `
        <div class="absolute top-0 ${align} flex flex-col items-center" style="left: ${pct}%;">
          <span>${formatTime(sec)}</span>
          <span class="w-0.5 h-2 bg-ink mt-0.5"></span>
        </div>
      `;
    }
    ruler.innerHTML = rulerHtml;
  }

  const deckALane = document.getElementById('deckALane');
  const deckBLane = document.getElementById('deckBLane');
  if (deckALane && deckBLane) {
    let htmlA = '';
    let htmlB = '';
    tracks.forEach((tr, idx) => {
      const leftPct = Math.max(0, Math.min(98, (tr.startSec / total) * 100));
      const widthPct = Math.max(1.5, Math.min(100 - leftPct, ((tr.endSec - tr.startSec) / total) * 100));
      const isSelected = state.selectedTrackId === tr.id;
      const isPlayingNow = state.currentTimeSec >= tr.startSec && state.currentTimeSec <= tr.endSec && state.isPlaying;
      const ringClass = isSelected
        ? 'ring-4 ring-ink shadow-[4px_4px_0px_#0D0D0D] z-20 -translate-y-0.5'
        : 'shadow-[2px_2px_0px_#0D0D0D] opacity-95 hover:opacity-100';
      const blockHtml = `
        <div
          onclick="event.stopPropagation(); selectTrackFromTimeline('${tr.id}')"
          style="left: ${leftPct}%; width: ${widthPct}%; background-color: ${tr.color}; color: ${tr.textColor};"
          class="absolute top-1 bottom-1 rounded-xl border-2 border-ink px-2.5 py-1.5 flex items-center justify-between gap-2 overflow-hidden transition-all ${ringClass}"
          title="${esc(displayTitle(tr))} — ${esc(displayArtist(tr))} (${formatTime(tr.startSec)}–${formatTime(tr.endSec)})"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="font-mono text-[10px] font-extrabold px-1.5 py-0.2 rounded bg-ink text-lime">${num2(idx + 1)}</span>
              <span class="font-display font-extrabold text-xs sm:text-sm truncate leading-tight">${esc(displayTitle(tr))}</span>
            </div>
            <div class="font-mono text-[10px] font-bold opacity-85 truncate">
              ${esc(displayArtist(tr))} • ${fmtBpm(tr.bpm)} BPM • ${fmtCam(tr.camelot)}
            </div>
          </div>
          ${isPlayingNow ? `<span class="px-1.5 py-0.5 rounded bg-ink text-lime font-mono text-[9px] font-extrabold uppercase shrink-0">LIVE</span>` : ''}
        </div>
      `;
      if ((tr.deck || (idx % 2 === 0 ? 'A' : 'B')) === 'A') htmlA += blockHtml;
      else htmlB += blockHtml;
    });
    if (!tracks.length) {
      const msg = state.job ? 'Decoding the set…' : 'Paste a YouTube set link above to fill the decks';
      htmlA = `<div class="absolute inset-0 flex items-center justify-center font-mono text-xs font-bold text-ink/50 uppercase">${msg}</div>`;
    }
    deckALane.innerHTML = htmlA;
    deckBLane.innerHTML = htmlB;
  }

  const overlapBand = document.getElementById('overlapBandLane');
  if (overlapBand) {
    overlapBand.innerHTML = overlaps.map(ov => {
      const leftPct = (ov.startSec / total) * 100;
      const widthPct = Math.max(1.2, ((ov.endSec - ov.startSec) / total) * 100);
      return `
        <button
          onclick="event.stopPropagation(); seekSetToSeconds(${ov.startSec}, true)"
          style="left: ${leftPct}%; width: ${widthPct}%;"
          title="Blend window (${ov.durationSec}s): ${esc(displayTitle(ov.trackA))} ⇄ ${esc(displayTitle(ov.trackB))}"
          class="absolute top-0.5 bottom-0.5 overlap-blend-zone rounded-md border border-ink flex items-center justify-center group"
        >
          <span class="hidden sm:inline-block px-1.5 py-0.2 rounded bg-ink text-lime font-mono text-[9px] font-extrabold uppercase tracking-tighter shadow">
            ⚡ ${ov.durationSec}s${widthPct > 4 ? ' BLEND' : ''}
          </span>
        </button>
      `;
    }).join('');
  }

  updatePlayheadPosition();
  renderTimelineInspector();
}

function updatePlayheadPosition() {
  const total = Math.max(1, state.currentSet.durationSec);
  const pct = Math.max(0, Math.min(99.2, (state.currentTimeSec / total) * 100));
  const playhead = document.getElementById('timelinePlayhead');
  const flag = document.getElementById('playheadTimeFlag');
  if (playhead) playhead.style.left = `${pct}%`;
  if (flag) flag.textContent = formatTime(state.currentTimeSec);

  const clock = document.getElementById('masterClockDisplay');
  const dur = document.getElementById('masterDurationDisplay');
  const slider = document.getElementById('masterSeekSlider');
  if (clock) clock.textContent = formatTime(state.currentTimeSec);
  if (dur) dur.textContent = `/ ${formatTime(state.currentSet.durationSec)}`;
  if (slider) {
    slider.max = Math.floor(state.currentSet.durationSec);
    slider.value = Math.floor(state.currentTimeSec);
  }

  const activeTracks = state.currentSet.tracks.filter(t => state.currentTimeSec >= t.startSec && state.currentTimeSec <= t.endSec);
  const headline = document.getElementById('nowPlayingHeadline');
  const blendCallout = document.getElementById('activeBlendCallout');

  if (activeTracks.length >= 2) {
    if (headline) headline.textContent = `${displayTitle(activeTracks[0])} ⇄ ${displayTitle(activeTracks[1])}`;
    if (blendCallout) {
      const tr = transitionFrom(activeTracks[0].id);
      blendCallout.textContent = `🔥 LIVE 2-DECK BLEND (${fmtCam(activeTracks[0].camelot)} → ${fmtCam(activeTracks[1].camelot)})${tr?.bassSwap != null ? ` · bass swap ${formatTime(tr.bassSwap)}` : ''}`;
      blendCallout.className = 'text-coral font-extrabold animate-pulse';
    }
  } else if (activeTracks.length === 1) {
    if (headline) headline.textContent = `${displayTitle(activeTracks[0])} — ${displayArtist(activeTracks[0])}`;
    if (blendCallout) {
      blendCallout.textContent = `Spinning Deck ${activeTracks[0].deck}: ${fmtBpm(activeTracks[0].bpm)} BPM • ${fmtCam(activeTracks[0].camelot)}`;
      blendCallout.className = 'text-lime font-bold';
    }
  } else {
    if (headline) headline.textContent = state.currentSet.title || 'Waiting for a set…';
    if (blendCallout) {
      blendCallout.textContent = state.currentSet.tracks.length ? 'Single deck groove' : (state.job ? 'Decoding…' : 'No set loaded');
      blendCallout.className = 'text-lime font-bold';
    }
  }
}

function renderTimelineInspector() {
  const container = document.getElementById('timelineInspectorCard');
  if (!container) return;
  const tr = state.currentSet.tracks.find(t => t.id === state.selectedTrackId) || state.currentSet.tracks[0];
  if (!tr) {
    container.innerHTML = `
      <div class="font-mono text-xs text-paper/75 leading-relaxed">
        <div class="font-display font-extrabold text-xl text-paper mb-1">How it works</div>
        Paste a YouTube DJ set. The engine downloads the audio, finds where each track starts and how long every blend lasts,
        identifies the songs, and measures BPM and key. Most one-hour sets take under a minute.
      </div>`;
    return;
  }

  const overlaps = computeOverlaps(state.currentSet.tracks).filter(ov => ov.trackA.id === tr.id || ov.trackB.id === tr.id);
  const out = overlaps.find(ov => ov.trackA.id === tr.id) || overlaps[0];
  const overlapBadge = out
    ? `⚡ ${out.durationSec}s blend (${formatTime(out.startSec)}–${formatTime(out.endSec)})`
    : `Clean cue drop at ${formatTime(tr.startSec)}`;

  container.innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-center gap-4 min-w-0 flex-1">
      <div class="w-16 h-16 rounded-2xl border-2 border-paper shrink-0 flex flex-col items-center justify-center font-mono font-extrabold text-xs relative overflow-hidden"
           style="background: ${tr.color}; color: ${tr.textColor};">
        <span class="text-[10px] opacity-80">DECK ${tr.deck}</span>
        <span class="text-base leading-none font-display">${fmtCam(tr.camelot)}</span>
        <span class="text-[10px]">${fmtBpm(tr.bpm)}</span>
      </div>

      <div class="min-w-0 space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="px-2 py-0.5 rounded bg-lime text-ink font-mono text-[11px] font-extrabold uppercase">
            ${formatTime(tr.startSec)} – ${formatTime(tr.endSec)}
          </span>
          <span class="px-2 py-0.5 rounded bg-paper/15 text-paper font-mono text-[11px] font-bold">
            ${fmtBpm(tr.bpm)} BPM • ${esc(tr.keyName || 'Key —')} (${fmtCam(tr.camelot)})
          </span>
          <span class="text-xs font-mono text-lime font-bold">${overlapBadge}</span>
        </div>

        <div class="font-display font-extrabold text-xl sm:text-2xl text-paper truncate">
          ${esc(displayTitle(tr))} <span class="text-paper/65 font-sans font-bold text-base">— ${esc(displayArtist(tr))}${tr.featuring ? ` ft. ${esc(tr.featuring)}` : ''}</span>
        </div>

        <div class="flex flex-wrap items-center gap-2 pt-1 text-[11px] font-mono text-paper/75">
          <span>Nudge Cue:</span>
          <button onclick="nudgeTrackBoundary('${tr.id}', 'start', -5)" class="px-2 py-0.5 rounded bg-paper/15 hover:bg-lime hover:text-ink font-bold">Start -5s</button>
          <button onclick="nudgeTrackBoundary('${tr.id}', 'start', 5)" class="px-2 py-0.5 rounded bg-paper/15 hover:bg-lime hover:text-ink font-bold">Start +5s</button>
          <button onclick="nudgeTrackBoundary('${tr.id}', 'end', -5)" class="px-2 py-0.5 rounded bg-paper/15 hover:bg-lime hover:text-ink font-bold">End -5s</button>
          <button onclick="nudgeTrackBoundary('${tr.id}', 'end', 5)" class="px-2 py-0.5 rounded bg-paper/15 hover:bg-lime hover:text-ink font-bold">End +5s</button>
        </div>
      </div>
    </div>

    <div class="flex flex-col sm:items-end gap-2.5 w-full lg:w-auto border-t lg:border-t-0 border-paper/15 pt-3 lg:pt-0">
      <div class="flex flex-wrap items-center gap-1.5">
        ${tr.source !== 'unknown' ? renderListeningPillsHtml(tr.links, tr.title, tr.artist, true) : ''}
      </div>
      <div class="flex items-center gap-2">
        <button onclick="seekSetToSeconds(${tr.startSec}, true)" class="dj-btn px-3.5 py-1.5 rounded-xl bg-paper text-ink font-mono text-xs font-extrabold uppercase">
          ▶ Cue ${formatTime(tr.startSec)}
        </button>
        <button onclick="jumpToDiscoverForTrack('${tr.id}')" class="dj-btn px-4 py-1.5 rounded-xl bg-lime text-ink font-display text-xs font-extrabold uppercase">
          Find Similar Tracks →
        </button>
      </div>
    </div>
  `;
}

function renderEnergyGraph() {
  const svg = document.getElementById('energySvgCanvas');
  if (!svg) return;
  const set = state.currentSet;
  const dense = set.energy && set.energy.length >= 2 ? set.energy : set.energyCurve || [];
  const nodes = set.energyCurve || [];
  const total = Math.max(1, set.durationSec);
  if (dense.length < 2) {
    svg.innerHTML = '';
    return;
  }

  const W = 1000;
  const H = 155;
  const padTop = 18;
  const padBottom = 14;
  const usableH = H - padTop - padBottom;
  const toPt = pt => ({ x: Math.round((pt.t / total) * W), y: Math.round(padTop + (1 - pt.v) * usableH) });
  const pts = dense.map(toPt);

  let dLine = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const cx = (p0.x + p1.x) / 2;
    dLine += ` C ${cx} ${p0.y}, ${cx} ${p1.y}, ${p1.x} ${p1.y}`;
  }
  const dArea = `${dLine} L ${pts[pts.length - 1].x} ${H} L ${pts[0].x} ${H} Z`;
  const playheadX = Math.round((state.currentTimeSec / total) * W);

  svg.innerHTML = `
    <defs>
      <linearGradient id="energyFillGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#1E3AFF" stop-opacity="0.85" />
        <stop offset="35%" stop-color="#D4FF00" stop-opacity="0.92" />
        <stop offset="72%" stop-color="#FF6B00" stop-opacity="0.95" />
        <stop offset="100%" stop-color="#FF3B30" stop-opacity="0.92" />
      </linearGradient>
    </defs>
    <line x1="0" y1="40" x2="${W}" y2="40" stroke="rgba(255,253,247,0.12)" stroke-dasharray="4 4" />
    <line x1="0" y1="90" x2="${W}" y2="90" stroke="rgba(255,253,247,0.12)" stroke-dasharray="4 4" />
    <path d="${dArea}" fill="url(#energyFillGrad)" />
    <path d="${dLine}" fill="none" stroke="#FFFDF7" stroke-width="3.5" />
    ${nodes.map(n => {
      const p = toPt(n);
      return `<g transform="translate(${p.x}, ${p.y})"><circle r="5.5" fill="#0D0D0D" stroke="#D4FF00" stroke-width="2.5" /></g>`;
    }).join('')}
    <line x1="${playheadX}" y1="0" x2="${playheadX}" y2="${H}" stroke="#FF3B30" stroke-width="3" />
    <circle cx="${playheadX}" cy="12" r="5" fill="#D4FF00" stroke="#0D0D0D" stroke-width="2" />
  `;
}

function renderEnergyPhasePills() {
  const el = document.getElementById('energyPhasePills');
  if (!el) return;
  let phases = [...(state.currentSet.phases || [])];
  if (phases.length > 5) {
    phases = phases.sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 5).sort((a, b) => a.start - b.start);
  }
  if (!phases.length) {
    el.innerHTML = ['WARM-UP', 'BUILD-UP', 'PEAK TIME', 'BREATHER', 'CLOSING']
      .map((n, i) => `<span class="py-1 text-paper/35">${num2(i + 1)} / ${n}</span>`).join('');
    return;
  }
  el.style.gridTemplateColumns = `repeat(${phases.length}, minmax(0, 1fr))`;
  el.innerHTML = phases.map((p, i) => `
    <button onclick="seekSetToSeconds(${p.start}, true)" title="${formatTime(p.start)}–${formatTime(p.end)} · ${p.tracks} track${p.tracks === 1 ? '' : 's'}"
            class="hover:text-lime py-1 rounded hover:bg-paper/10 transition-colors truncate">
      ${num2(i + 1)} / ${esc(p.name.toUpperCase())} <span class="text-paper/50">${formatTime(p.start)}</span>
    </button>`).join('');
}

function handleEnergyGraphHover(event) {
  const svg = document.getElementById('energySvgCanvas');
  const readout = document.getElementById('energyHoverReadout');
  if (!svg || !readout || !state.currentSet.durationSec) return;
  const rect = svg.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const sec = Math.round(ratio * state.currentSet.durationSec);
  const curve = state.currentSet.energyCurve || [];
  if (!curve.length) return;
  let nearest = curve[0];
  for (const pt of curve) {
    if (Math.abs(pt.t - sec) < Math.abs(nearest.t - sec)) nearest = pt;
  }
  const dense = state.currentSet.energy || [];
  const here = dense.length ? dense[Math.min(dense.length - 1, Math.round(sec / 10))] : nearest;
  readout.textContent = `${formatTime(sec)} • ${(nearest.phase || 'SET').toUpperCase()} • energy ${Math.round((here?.v ?? nearest.v) * 100)}% — ${nearest.note}`;
}

function handleEnergyGraphClick(event) {
  const svg = document.getElementById('energySvgCanvas');
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  seekSetToRatio(ratio);
}

/*************************************************************************
 * 9. EDITORIAL TRACKLIST
 *************************************************************************/
function renderEditorialTracklist() {
  const container = document.getElementById('editorialTracklistContainer');
  if (!container) return;

  const query = (document.getElementById('trackSearchInput')?.value || '').trim().toLowerCase();
  const all = state.currentSet.tracks;
  const tracks = all.filter(tr => {
    if (!query) return true;
    return [tr.title, tr.artist, tr.camelot, tr.keyName, tr.style].some(v => (v || '').toLowerCase().includes(query));
  });

  if (!all.length) {
    container.innerHTML = `
      <div class="p-10 text-center space-y-2">
        <p class="font-display font-extrabold text-xl uppercase">${state.job ? 'Decoding… tracks appear here as they are found' : 'No set decoded yet'}</p>
        <p class="text-sm font-bold text-ink/60">Paste any YouTube DJ set link above, or upload your own mix.</p>
      </div>`;
    return;
  }
  if (tracks.length === 0) {
    container.innerHTML = `
      <div class="p-10 text-center space-y-3">
        <p class="font-display font-extrabold text-xl uppercase">No tracks match "${esc(query)}"</p>
        <button onclick="document.getElementById('trackSearchInput').value=''; renderEditorialTracklist();"
                class="dj-btn px-4 py-2 rounded-xl bg-lime text-ink font-mono text-xs font-extrabold uppercase">
          Reset Filter
        </button>
      </div>`;
    return;
  }

  container.innerHTML = tracks.map((tr, i) => {
    const isExpanded = state.expandedTrackIds.has(tr.id);
    const isCurrent = state.isPlaying && state.currentTimeSec >= tr.startSec && state.currentTimeSec <= tr.endSec;
    const durationMin = formatTime(tr.endSec - tr.startSec);
    const tr_out = transitionFrom(tr.id);
    const inCrate = state.crate.some(c => songKey(c.artist, c.title) === songKey(tr.artist, tr.title));
    const blends = (tr.blends || []).map(b => `<span class="font-mono text-[11px] font-extrabold text-cobalt mr-2">w/ ${esc(b.artist ? b.artist + ' – ' : '')}${esc(b.title)}</span>`).join('');

    return `
      <article class="editorial-row p-5 sm:p-6 transition-all ${isCurrent ? 'bg-lime/20' : ''}">
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">

          <div class="flex items-start sm:items-center gap-4 min-w-0 flex-1 cursor-pointer" onclick="seekSetToSeconds(${tr.startSec}, true)">
            <div class="font-display font-extrabold text-3xl sm:text-5xl leading-none tracking-tighter text-ink/90 select-none w-12 sm:w-16 shrink-0">
              ${num2(tr.order || i + 1)}
            </div>

            <div class="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl border-2 border-ink shadow-[3px_3px_0px_#0D0D0D] shrink-0 flex flex-col items-center justify-center font-mono font-extrabold relative group"
                 style="background-color: ${tr.color}; color: ${tr.textColor};">
              <span class="text-[10px] uppercase opacity-80">${fmtCam(tr.camelot)}</span>
              <span class="text-sm font-display font-extrabold">${fmtBpm(tr.bpm)}</span>
              <span class="absolute inset-0 bg-ink/85 text-lime rounded-xl opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-lg">▶</span>
            </div>

            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono text-xs font-extrabold px-2.5 py-0.5 rounded-md bg-ink text-lime">
                  ${formatTime(tr.startSec)} – ${formatTime(tr.endSec)}
                </span>
                <span class="font-mono text-xs font-bold text-ink/65">(${durationMin} in mix)</span>
                ${isCurrent ? `<span class="px-2 py-0.5 rounded-full bg-coral text-paper font-mono text-[10px] font-extrabold uppercase">● SPINNING NOW</span>` : ''}
                ${tr.unreleased ? `<span class="px-2 py-0.5 rounded-full bg-tangerine text-ink font-mono text-[10px] font-extrabold uppercase">Unreleased ID</span>` : ''}
              </div>

              <h3 class="font-display font-extrabold text-xl sm:text-2xl text-ink leading-tight truncate">
                ${esc(displayTitle(tr))}
              </h3>

              <p class="text-sm font-bold text-ink/75 truncate">
                ${esc(displayArtist(tr))}${tr.featuring ? ` <span class="text-ink/55 font-semibold">ft. ${esc(tr.featuring)}</span>` : ''}
                <span class="mx-1.5 text-ink/30">•</span>
                <span class="font-mono text-xs text-cobalt font-extrabold">${esc(tr.style || sourceLabel(tr))}</span>
              </p>
              ${blends ? `<div class="truncate">${blends}</div>` : ''}
            </div>
          </div>

          <div class="flex flex-col sm:flex-row lg:flex-col items-start sm:items-center lg:items-end justify-between gap-3 pt-2 lg:pt-0 border-t lg:border-t-0 border-ink/10">
            <div class="flex flex-wrap items-center gap-2">
              <span class="px-3 py-1 rounded-xl bg-cream border-2 border-ink font-mono text-xs font-extrabold">${fmtBpm(tr.bpm)} BPM</span>
              <span class="px-3 py-1 rounded-xl bg-lime border-2 border-ink font-mono text-xs font-extrabold">${fmtCam(tr.camelot)} • ${esc(tr.keyName || 'Key —')}</span>
              <button onclick="jumpToDiscoverForTrack('${tr.id}')" class="dj-btn px-3.5 py-1 rounded-xl bg-ink text-lime font-display text-xs font-extrabold uppercase">Mix Next →</button>
              ${tr.source !== 'unknown' ? `<button onclick="addTrackToCrate('${tr.id}')" class="dj-btn px-2.5 py-1 rounded-xl ${inCrate ? 'bg-lime' : 'bg-paper'} text-ink font-mono text-xs font-extrabold" title="Save to your practice crate">${inCrate ? '✓ Crate' : '+ Crate'}</button>` : ''}
              <button onclick="toggleTrackDetails('${tr.id}')" class="dj-btn px-2.5 py-1 rounded-xl bg-paper text-ink font-mono text-xs font-extrabold" title="Credits, transition notes & edit">
                ${isExpanded ? '− Less' : '+ Mix Notes'}
              </button>
            </div>
            <div class="flex flex-wrap items-center gap-1.5">
              ${tr.source !== 'unknown' ? renderListeningPillsHtml(tr.links, tr.title, tr.artist, false) : ''}
            </div>
          </div>
        </div>

        ${isExpanded ? `
          <div class="mt-4 pt-4 border-t-2 border-dashed border-ink/25 grid grid-cols-1 md:grid-cols-3 gap-4 bg-cream/70 p-4 rounded-xl">
            <div>
              <div class="text-[10px] font-mono font-extrabold uppercase text-ink/55">Release &amp; Source</div>
              <div class="text-xs font-bold text-ink mt-0.5">${esc(tr.credits || 'No release info')}</div>
              <div class="text-[11px] font-mono text-ink/70 mt-1">${esc(sourceLabel(tr))}${tr.bpmConfidence != null ? ` · BPM confidence ${Math.round(tr.bpmConfidence * 100)}%` : ''}</div>
              ${tr.cueInSong != null && tr.cueInSong > 20 ? `<div class="text-[11px] font-mono text-ink/70 mt-1">Started ${formatTime(tr.cueInSong)} into the track</div>` : ''}
              ${(tr.notes || []).map(n => `<div class="text-[11px] font-mono text-coral mt-1">${esc(n)}</div>`).join('')}
            </div>
            <div>
              <div class="text-[10px] font-mono font-extrabold uppercase text-ink/55">Transition Architecture</div>
              <div class="text-xs font-bold text-ink mt-0.5">${esc(tr.transitionCallout || 'Single track')}</div>
              ${tr_out ? `<ul class="mt-1.5 space-y-1">${(tr_out.tips || []).map(t => `<li class="text-[11px] font-semibold text-ink/80">→ ${esc(t)}</li>`).join('')}</ul>` : ''}
              ${tr_out ? `<button onclick="seekSetToSeconds(${Math.max(0, tr_out.startSec - 8)}, true)" class="mt-2 text-[11px] font-mono font-extrabold underline decoration-2 decoration-lime">▶ Hear this transition (${formatTime(tr_out.startSec)})</button>` : ''}
            </div>
            <div class="flex items-center md:justify-end gap-2">
              <button onclick="openTrackDrawer('${tr.id}')" class="dj-btn px-3.5 py-2 rounded-xl bg-paper text-ink font-mono text-xs font-extrabold uppercase">✎ Edit Track / BPM / Key</button>
              <button onclick="jumpToDiscoverForTrack('${tr.id}')" class="dj-btn px-3.5 py-2 rounded-xl bg-coral text-paper font-mono text-xs font-extrabold uppercase">★ Crate Matches</button>
            </div>
          </div>
        ` : ''}
      </article>
    `;
  }).join('');
}

function toggleTrackDetails(trackId) {
  if (state.expandedTrackIds.has(trackId)) state.expandedTrackIds.delete(trackId);
  else state.expandedTrackIds.add(trackId);
  renderEditorialTracklist();
}

/*************************************************************************
 * 10. DISCOVER & MIX: REAL RECOMMENDATIONS FROM THE ENGINE
 *************************************************************************/
function seedKeyFor(tr) {
  return songKey(tr.artist, tr.title);
}

async function fetchRecs(tr) {
  const key = seedKeyFor(tr);
  if (state.recs[key] && state.recs[key].status !== 'error') return;
  state.recs[key] = { status: 'loading', tracks: [] };
  try {
    const params = new URLSearchParams({ artist: tr.artist, title: tr.title, limit: '16',
      exclude: state.currentSet.tracks.map(t => `${t.artist}|${t.title}`).join(';;') });
    if (tr.bpm) params.set('bpm', tr.bpm);
    if (tr.camelot) params.set('camelot', tr.camelot);
    const out = await api(`/api/next?${params}`);
    state.recs[key] = { status: 'done', tracks: out.tracks || [], note: out.note };
  } catch (e) {
    state.recs[key] = { status: 'error', tracks: [], error: e.message };
  }
  if (state.activePage === 'discover') renderDiscoverPage();
}

function renderDiscoverPage() {
  const tracks = state.currentSet.tracks;
  const seedListEl = document.getElementById('discoverSeedList');
  const bannerEl = document.getElementById('discoverActiveSeedBanner');
  const gridEl = document.getElementById('discoverRecommendationsGrid');
  const countLabel = document.getElementById('crateMatchCountLabel');
  const seedTrack = tracks.find(t => t.id === state.discoverSeedTrackId) || tracks.find(t => t.source !== 'unknown') || tracks[0];

  if (!seedTrack) {
    if (seedListEl) seedListEl.innerHTML = `<p class="text-xs font-bold text-ink/60">Decode a set first — its tracks show up here.</p>`;
    if (bannerEl) bannerEl.innerHTML = `<p class="font-mono text-xs text-paper/80">No seed track yet.</p>`;
    if (gridEl) gridEl.innerHTML = '';
    if (countLabel) countLabel.textContent = 'Pick a seed track';
    return;
  }

  if (seedListEl) {
    seedListEl.innerHTML = tracks.map((tr, idx) => {
      const active = tr.id === seedTrack.id;
      return `
        <button onclick="selectDiscoverSeed('${tr.id}')"
          class="w-full text-left p-3 rounded-xl border-2 border-ink transition-all flex items-center justify-between gap-2 ${active ? 'bg-lime shadow-[3px_3px_0px_#0D0D0D] -translate-y-0.5' : 'bg-cream hover:bg-paper'}">
          <div class="min-w-0">
            <div class="font-mono text-[10px] font-extrabold uppercase text-ink/60">${num2(idx + 1)} • ${formatTime(tr.startSec)}</div>
            <div class="font-display font-extrabold text-sm text-ink truncate">${esc(displayTitle(tr))}</div>
            <div class="text-xs font-bold text-ink/75 truncate">${esc(displayArtist(tr))}</div>
          </div>
          <div class="text-right font-mono shrink-0">
            <span class="px-2 py-0.5 rounded bg-ink text-lime text-xs font-extrabold">${fmtCam(tr.camelot)}</span>
            <div class="text-[11px] font-bold mt-0.5">${fmtBpm(tr.bpm)} BPM</div>
          </div>
        </button>`;
    }).join('');
  }

  const effectiveSeed = {
    ...seedTrack,
    bpm: Number(state.discoverOverrideBpm) || seedTrack.bpm,
    camelot: state.discoverOverrideCamelot || seedTrack.camelot,
    keyName: CAMELOT_TO_KEY[state.discoverOverrideCamelot] || seedTrack.keyName
  };

  if (bannerEl) {
    bannerEl.innerHTML = `
      <div class="space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="px-2.5 py-0.5 rounded bg-lime text-ink font-mono text-xs font-extrabold uppercase">ACTIVE SEED TRACK</span>
          <span class="font-mono text-xs text-paper/80">${fmtBpm(effectiveSeed.bpm)} BPM • ${fmtCam(effectiveSeed.camelot)} (${esc(effectiveSeed.keyName || 'key —')})</span>
        </div>
        <h3 class="font-display font-extrabold text-2xl sm:text-3xl text-paper">
          ${esc(displayTitle(effectiveSeed))} <span class="text-paper/65 font-sans text-lg">— ${esc(displayArtist(effectiveSeed))}</span>
        </h3>
      </div>
      <div class="flex flex-wrap gap-1.5">
        ${seedTrack.source !== 'unknown' ? renderListeningPillsHtml(effectiveSeed.links, effectiveSeed.title, effectiveSeed.artist, true) : ''}
      </div>`;
  }
  if (!gridEl) return;

  if (seedTrack.source === 'unknown') {
    if (countLabel) countLabel.textContent = 'Unidentified seed';
    gridEl.innerHTML = `
      <div class="col-span-full dj-card p-8 text-center space-y-2">
        <p class="font-display font-extrabold text-xl uppercase">This one wasn't recognised</p>
        <p class="text-sm font-bold text-ink/70">Name it with ✎ Edit Track, or pick another seed — recommendations need an artist and title.</p>
      </div>`;
    return;
  }

  const recs = state.recs[seedKeyFor(seedTrack)];
  if (!recs) {
    fetchRecs(seedTrack);
  }
  if (!recs || recs.status === 'loading') {
    if (countLabel) countLabel.textContent = 'Digging…';
    gridEl.innerHTML = `
      <div class="col-span-full dj-card p-8 space-y-3">
        <div class="h-4 rounded-full border-2 border-ink bg-cream overflow-hidden"><div class="h-full w-2/3 overlap-blend-zone"></div></div>
        <p class="font-display font-extrabold text-lg uppercase">Pulling records that fit ${esc(seedTrack.title)}…</p>
        <p class="text-xs font-bold text-ink/70">The engine listens to each candidate's preview to measure its real BPM and key. Takes a few seconds the first time.</p>
      </div>`;
    return;
  }
  if (recs.status === 'error') {
    if (countLabel) countLabel.textContent = 'Offline';
    gridEl.innerHTML = `
      <div class="col-span-full dj-card p-8 text-center space-y-3">
        <p class="font-display font-extrabold text-xl uppercase">Couldn't dig the crate</p>
        <p class="text-xs font-bold text-ink/70">${esc(recs.error)}</p>
        <button onclick="state.recs['${esc(seedKeyFor(seedTrack))}'] = null; renderDiscoverPage();" class="dj-btn px-4 py-2 rounded-xl bg-lime text-ink font-mono text-xs font-extrabold uppercase">Try again</button>
      </div>`;
    return;
  }

  const ranked = RecommendationEngine.rankCandidates(effectiveSeed, recs.tracks, state.crateFilter);
  if (countLabel) countLabel.textContent = `${ranked.length} records ready`;

  if (ranked.length === 0) {
    gridEl.innerHTML = `
      <div class="col-span-full dj-card p-8 text-center space-y-3">
        <p class="font-display font-extrabold text-xl uppercase">${recs.tracks.length ? 'No crate records match this strict filter' : esc(recs.note || 'No related records found')}</p>
        <button onclick="setCrateFilter('all')" class="dj-btn px-4 py-2 rounded-xl bg-lime text-ink font-mono text-xs font-extrabold uppercase">Show All Matches</button>
      </div>`;
    return;
  }

  state.rankedRecs = ranked;
  gridEl.innerHTML = ranked.map((rec, i) => {
    const inCrate = state.crate.some(c => songKey(c.artist, c.title) === songKey(rec.artist, rec.title));
    return `
    <article class="dj-card p-5 flex flex-col justify-between gap-4 bg-paper hover:-translate-y-1 transition-transform">
      <div class="space-y-3">
        <div class="flex items-center justify-between gap-2">
          <span class="px-2.5 py-1 rounded-full bg-lime border-2 border-ink font-mono text-xs font-extrabold truncate">${esc(rec.harmonicLabel)}</span>
          <span class="px-2.5 py-1 rounded-lg bg-ink text-paper font-mono text-xs font-extrabold shrink-0">${fmtBpm(rec.bpm)} BPM • ${fmtCam(rec.camelot)}</span>
        </div>
        <div class="flex items-start gap-3.5">
          <div class="w-14 h-14 rounded-2xl border-2 border-ink shadow-[3px_3px_0px_#0D0D0D] shrink-0 flex flex-col items-center justify-center font-mono font-extrabold relative overflow-hidden"
               style="background-color: #D4FF00; color: #0D0D0D;">
            <span class="text-xs font-display font-extrabold">${fmtCam(rec.camelot)}</span>
            <span class="text-[10px]">${fmtBpm(rec.bpm)}</span>
            ${rec.preview ? `<button onclick="togglePreview(this, ${i})" class="absolute inset-0 bg-ink/85 text-lime opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center text-lg" title="Play 30s preview">▶</button>` : ''}
          </div>
          <div class="min-w-0">
            <h4 class="font-display font-extrabold text-lg sm:text-xl text-ink leading-tight truncate" title="${esc(rec.title)}">${esc(rec.title)}</h4>
            <p class="text-sm font-bold text-ink/75 truncate">${esc(rec.artist)}</p>
            <p class="text-[11px] font-mono font-bold text-cobalt mt-0.5">${esc(rec.style)} · ${rec.matchPercent}% fit</p>
          </div>
        </div>
        <div class="p-3 rounded-xl bg-cream border-2 border-ink text-xs font-bold text-ink leading-relaxed">
          <span class="font-mono uppercase text-[10px] px-1.5 py-0.5 rounded bg-ink text-lime mr-1">WHY IT MIXES</span>
          ${esc(rec.whyItWorks)}
        </div>
      </div>
      <div class="pt-3 border-t-2 border-ink/15 space-y-2">
        <div class="flex items-center justify-between">
          <div class="text-[10px] font-mono font-extrabold uppercase text-ink/55">Listen &amp; Grab Record:</div>
          <button onclick="addRecToCrate(${i})" class="dj-pill px-2.5 py-0.5 rounded-full text-[11px] font-mono font-extrabold ${inCrate ? 'bg-lime' : 'bg-paper'} text-ink">${inCrate ? '✓ In crate' : '+ Crate'}</button>
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          ${renderListeningPillsHtml(rec.links, rec.title, rec.artist, false)}
        </div>
      </div>
    </article>`;
  }).join('');
}

function selectDiscoverSeed(trackId) {
  state.discoverSeedTrackId = trackId;
  const tr = state.currentSet.tracks.find(t => t.id === trackId);
  if (tr) {
    state.discoverOverrideBpm = tr.bpm;
    state.discoverOverrideCamelot = tr.camelot;
    const bpmIn = document.getElementById('overrideBpmInput');
    const camSel = document.getElementById('overrideCamelotSelect');
    if (bpmIn) bpmIn.value = tr.bpm || '';
    if (camSel && tr.camelot) camSel.value = tr.camelot;
  }
  renderDiscoverPage();
}

function handleSeedOverrideChange() {
  const bpmVal = parseFloat(document.getElementById('overrideBpmInput')?.value || '');
  state.discoverOverrideBpm = isNaN(bpmVal) ? null : bpmVal;
  state.discoverOverrideCamelot = document.getElementById('overrideCamelotSelect')?.value || '';
  renderDiscoverPage();
}

function resetSeedOverrides() {
  selectDiscoverSeed(state.discoverSeedTrackId);
  showToast('Reset to the measured BPM & key');
}

function setCrateFilter(mode) {
  state.crateFilter = mode;
  ['all', 'harmonic', 'tempo', 'peak'].forEach(key => {
    const btn = document.getElementById(`crateFilter_${key}`);
    if (!btn) return;
    btn.className = `dj-pill px-3.5 py-1.5 rounded-full text-xs font-mono font-extrabold ${key === mode ? 'bg-lime' : 'bg-paper'} text-ink`;
  });
  renderDiscoverPage();
}

function jumpToDiscoverForTrack(trackId) {
  selectDiscoverSeed(trackId);
  switchPrimaryPage('discover');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function stopPreview() {
  state.previewAudio.pause();
  if (state.previewBtn) state.previewBtn.textContent = '▶';
  state.previewBtn = null;
}

function togglePreview(btn, idx) {
  const rec = state.rankedRecs?.[idx];
  const same = state.previewBtn === btn;
  stopPreview();
  if (same || !rec?.preview) return;
  try { state.ytPlayer?.pauseVideo(); } catch (e) {}
  document.getElementById('localAudioElement')?.pause();
  state.previewAudio.src = rec.preview;
  state.previewAudio.play().catch(() => showToast('Preview unavailable'));
  state.previewBtn = btn;
  btn.textContent = '❚❚';
  btn.classList.add('opacity-100');
}
state.previewAudio.addEventListener('ended', stopPreview);

/*************************************************************************
 * 11. PRACTICE CRATE (saved in this browser) & PLAYLISTS
 *************************************************************************/
function saveCrate() {
  safeSetStorage('dj_crate', JSON.stringify(state.crate));
  const badge = document.getElementById('navCrateBadge');
  if (badge) badge.textContent = String(state.crate.length);
}

function addToCrate(item) {
  const k = songKey(item.artist, item.title);
  if (state.crate.some(c => songKey(c.artist, c.title) === k)) {
    state.crate = state.crate.filter(c => songKey(c.artist, c.title) !== k);
    showToast(`Removed "${item.title}" from your crate`);
  } else {
    state.crate.push({ title: item.title, artist: item.artist, bpm: item.bpm || null, camelot: item.camelot || '',
                       keyName: item.keyName || '', links: item.links || {}, from: state.currentSet.title || '', added: Date.now() });
    showToast(`Saved "${item.title}" to your practice crate`);
  }
  saveCrate();
  renderPracticeCrate();
  renderEditorialTracklist();
  if (state.activePage === 'discover') renderDiscoverPage();
}

function addTrackToCrate(trackId) {
  const tr = state.currentSet.tracks.find(t => t.id === trackId);
  if (tr) addToCrate(tr);
}

function addRecToCrate(idx) {
  const rec = state.rankedRecs?.[idx];
  if (rec) addToCrate(rec);
}

function sortedCrate() {
  const mode = document.getElementById('crateSortSelect')?.value || 'bpm';
  const cam = c => {
    const p = RecommendationEngine.parseCamelot(c.camelot);
    return p ? p.num * 2 + (p.letter === 'B' ? 1 : 0) : 99;
  };
  const list = [...state.crate];
  if (mode === 'bpm') list.sort((a, b) => (a.bpm || 999) - (b.bpm || 999) || cam(a) - cam(b));
  else if (mode === 'key') list.sort((a, b) => cam(a) - cam(b) || (a.bpm || 999) - (b.bpm || 999));
  return list;
}

function renderPracticeCrate() {
  const el = document.getElementById('practiceCrateList');
  saveCrate();
  if (!el) return;
  const list = sortedCrate();
  if (!list.length) {
    el.innerHTML = `<p class="text-xs font-bold text-ink/60">Hit “+ Crate” on any track or recommendation to start a practice crate. It stays in this browser.</p>`;
    return;
  }
  el.innerHTML = list.map(c => `
    <div class="p-2.5 rounded-xl border-2 border-ink bg-cream flex items-center justify-between gap-2">
      <div class="min-w-0">
        <div class="font-display font-extrabold text-sm text-ink truncate">${esc(c.title)}</div>
        <div class="text-xs font-bold text-ink/70 truncate">${esc(c.artist)}</div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <span class="px-2 py-0.5 rounded bg-ink text-lime font-mono text-[11px] font-extrabold">${fmtCam(c.camelot)}</span>
        <span class="font-mono text-[11px] font-bold">${fmtBpm(c.bpm)}</span>
        <button onclick='addToCrate(${JSON.stringify({ artist: c.artist, title: c.title }).replace(/'/g, '&#39;')})' class="w-6 h-6 rounded-lg border-2 border-ink font-mono text-[11px] font-extrabold hover:bg-coral hover:text-paper" title="Remove">✕</button>
      </div>
    </div>`).join('');
}

function clearCrate() {
  if (!state.crate.length || !confirm('Empty your practice crate?')) return;
  state.crate = [];
  renderPracticeCrate();
  renderEditorialTracklist();
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCrate(format) {
  const list = sortedCrate();
  if (!list.length) return showToast('Your crate is empty');
  const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  if (format === 'csv') {
    const rows = [['Artist', 'Title', 'BPM', 'Camelot', 'Key', 'From set']]
      .concat(list.map(c => [c.artist, c.title, c.bpm || '', c.camelot, c.keyName, c.from]));
    download('discojockey-crate.csv', rows.map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv');
  } else if (format === 'txt') {
    // "Artist - Title" per line: what playlist importers (Soundiiz, TuneMyMusic) and record shops accept.
    download('discojockey-crate.txt', list.map(c => `${c.artist} - ${c.title}`).join('\n'), 'text/plain');
  } else {
    const text = list.map((c, i) => `${num2(i + 1)}. ${c.artist} — ${c.title} (${fmtBpm(c.bpm)} BPM • ${fmtCam(c.camelot)})`).join('\n');
    copyText(text, 'Crate copied!');
  }
}

async function makeYouTubePlaylist(which) {
  const items = which === 'crate'
    ? sortedCrate()
    : state.currentSet.tracks.filter(t => t.source !== 'unknown');
  if (!items.length) return showToast(which === 'crate' ? 'Your crate is empty' : 'No identified tracks yet');
  // Open the tab now (inside the click) so pop-up blockers allow it, then point it at the playlist.
  const win = window.open('about:blank', '_blank');
  showToast(`Finding ${Math.min(50, items.length)} tracks on YouTube…`);
  try {
    const out = await api('/api/youtube-playlist', { method: 'POST', body: JSON.stringify({ tracks: items.map(t => ({ artist: t.artist, title: t.title })) }) });
    if (!out.url) throw new Error('None of the tracks were found on YouTube');
    if (win) win.location.href = out.url;
    else window.open(out.url, '_blank');
    const missing = out.ids.filter(x => !x).length;
    showToast(`Playlist ready: ${out.ids.length - missing} tracks${missing ? ` (${missing} not found)` : ''}`);
  } catch (e) {
    if (win) win.close();
    showToast(e.message);
  }
}

/*************************************************************************
 * 12. NAVIGATION, TIMELINE INTERACTION & TRACK EDITING
 *************************************************************************/
function switchPrimaryPage(page) {
  state.activePage = page;
  const studioEl = document.getElementById('pageStudio');
  const discoverEl = document.getElementById('pageDiscover');
  const btnStudio = document.getElementById('navBtnStudio');
  const btnDiscover = document.getElementById('navBtnDiscover');
  const on = 'px-4 sm:px-6 py-2 rounded-full text-xs sm:text-sm font-display font-extrabold tracking-tight transition-all bg-lime text-ink border-2 border-ink shadow-[2px_2px_0px_#0D0D0D]';
  const off = 'px-4 sm:px-6 py-2 rounded-full text-xs sm:text-sm font-display font-extrabold tracking-tight transition-all text-ink/70 hover:text-ink border-2 border-transparent';
  if (page === 'discover') {
    studioEl.classList.add('hidden');
    discoverEl.classList.remove('hidden');
    btnDiscover.className = `${on} flex items-center gap-1.5`;
    btnStudio.className = off;
    renderDiscoverPage();
    renderPracticeCrate();
  } else {
    discoverEl.classList.add('hidden');
    studioEl.classList.remove('hidden');
    btnStudio.className = on;
    btnDiscover.className = `${off} flex items-center gap-1.5`;
    renderMixTimeline();
    renderEnergyGraph();
    renderEditorialTracklist();
  }
}

function selectTrackFromTimeline(trackId) {
  state.selectedTrackId = trackId;
  const tr = state.currentSet.tracks.find(t => t.id === trackId);
  if (tr) seekSetToSeconds(tr.startSec, true);
  renderMixTimeline();
}

function handleTimelineClick(event) {
  const viewport = document.getElementById('timelineViewport');
  if (!viewport) return;
  const rect = viewport.getBoundingClientRect();
  seekSetToRatio(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
}

function seekSetToRatio(ratio) {
  seekSetToSeconds(Math.round(ratio * state.currentSet.durationSec), true);
}

function seekSetToSeconds(sec, syncExternalPlayer = true) {
  if (!state.currentSet.durationSec) return;
  const clamped = Math.max(0, Math.min(state.currentSet.durationSec, Number(sec) || 0));
  state.currentTimeSec = clamped;

  const active = state.currentSet.tracks.filter(t => clamped >= t.startSec && clamped <= t.endSec);
  if (active.length) state.selectedTrackId = active[active.length - 1].id;

  if (syncExternalPlayer) {
    if (state.playbackMode === 'youtube' && state.ytReady) {
      state.ytPlayer.seekTo(clamped, true);
      state.ytPlayer.playVideo();
    } else if (state.playbackMode === 'local') {
      const audio = document.getElementById('localAudioElement');
      if (audio) {
        audio.currentTime = clamped;
        audio.play().catch(() => {});
      }
    }
  }
  updatePlayheadPosition();
  renderMixTimeline();
  renderEnergyGraph();
  renderEditorialTracklist();
}

function jumpToNextOverlap() {
  const overlaps = computeOverlaps(state.currentSet.tracks);
  if (overlaps.length === 0) {
    showToast('No overlapping transitions in this set');
    return;
  }
  const next = overlaps.find(ov => ov.startSec > state.currentTimeSec + 3) || overlaps[0];
  seekSetToSeconds(next.startSec, true);
  showToast(`Jumped to ${next.durationSec}s transition blend at ${formatTime(next.startSec)}`);
}

function persistEdits() {
  if (state.currentSet.videoId && !state.currentSet.partial) {
    safeSetStorage(`dj_set_${state.currentSet.videoId}`, JSON.stringify(state.currentSet));
  }
}

function nudgeTrackBoundary(trackId, boundary, deltaSec) {
  const tr = state.currentSet.tracks.find(t => t.id === trackId);
  if (!tr) return;
  if (boundary === 'start') tr.startSec = Math.max(0, Math.min(tr.endSec - 15, tr.startSec + deltaSec));
  else tr.endSec = Math.max(tr.startSec + 15, Math.min(state.currentSet.durationSec, tr.endSec + deltaSec));
  persistEdits();
  renderMixTimeline();
  renderEditorialTracklist();
  showToast(`Updated ${tr.title} ${boundary} cue to ${formatTime(boundary === 'start' ? tr.startSec : tr.endSec)}`);
}

function openTrackDrawer(trackId) {
  const modal = document.getElementById('trackEditModal');
  const heading = document.getElementById('trackModalHeading');
  if (!modal) return;
  if (!state.currentSet.durationSec && !trackId) {
    showToast('Decode a set first');
    return;
  }
  const existing = state.currentSet.tracks.find(t => t.id === trackId);
  const val = (id, v) => { document.getElementById(id).value = v ?? ''; };
  if (existing) {
    heading.textContent = `Edit Track #${num2(existing.order)}`;
    val('editTrackIdField', existing.id);
    val('editTitleInput', existing.source === 'unknown' ? '' : existing.title);
    val('editArtistInput', existing.source === 'unknown' ? '' : existing.artist);
    val('editStartInput', formatTime(existing.startSec));
    val('editEndInput', formatTime(existing.endSec));
    val('editBpmInput', existing.bpm);
    val('editCamelotInput', existing.camelot);
    val('editKeyNameInput', existing.keyName);
    val('editStyleInput', existing.style);
    val('editCreditsInput', existing.credits);
  } else {
    heading.textContent = 'Add Missing Track ID';
    val('editTrackIdField', '');
    val('editTitleInput', '');
    val('editArtistInput', '');
    val('editStartInput', formatTime(state.currentTimeSec));
    val('editEndInput', formatTime(Math.min(state.currentSet.durationSec, state.currentTimeSec + 210)));
    val('editBpmInput', '');
    val('editCamelotInput', '');
    val('editKeyNameInput', '');
    val('editStyleInput', '');
    val('editCreditsInput', '');
  }
  document.getElementById('editBpmInput').required = false;
  document.getElementById('editCamelotInput').required = false;
  modal.classList.remove('hidden');
}

function closeTrackDrawer() {
  document.getElementById('trackEditModal')?.classList.add('hidden');
}

function saveTrackDrawerForm(event) {
  event.preventDefault();
  const get = id => document.getElementById(id).value.trim();
  const id = get('editTrackIdField');
  const title = get('editTitleInput');
  const artist = get('editArtistInput');
  const startSec = parseTimeInput(get('editStartInput'));
  const endSec = Math.max(startSec + 20, parseTimeInput(get('editEndInput')));
  const bpm = parseFloat(get('editBpmInput')) || null;
  const camelot = get('editCamelotInput').toUpperCase();
  const keyName = get('editKeyNameInput') || CAMELOT_TO_KEY[camelot] || '';
  const style = get('editStyleInput');
  const credits = get('editCreditsInput');
  const q = encodeURIComponent(`${artist} ${title}`);

  if (id) {
    const tr = state.currentSet.tracks.find(t => t.id === id);
    if (tr) {
      const renamed = tr.title !== title || tr.artist !== artist;
      Object.assign(tr, { title, artist, startSec, endSec, bpm, camelot, keyName, style, credits });
      if (renamed) {
        tr.source = 'user';
        tr.links = { youtube: `https://www.youtube.com/results?search_query=${q}` };
      }
    }
  } else {
    const palette = [['#D4FF00', '#0D0D0D'], ['#FF3B30', '#FFFDF7'], ['#FF6B00', '#0D0D0D'], ['#1E3AFF', '#FFFDF7']];
    const n = state.currentSet.tracks.length + 1;
    const newTrack = {
      id: `user_${Date.now()}`, order: n, deck: n % 2 === 1 ? 'A' : 'B', title, artist, featuring: '', credits,
      remixer: '', startSec, endSec, bpm, keyName, camelot, style, energy: 0.5,
      color: palette[n % 4][0], textColor: palette[n % 4][1], source: 'user', identified: true,
      transitionCallout: 'Added by you', links: {}, notes: [], blends: []
    };
    state.currentSet.tracks.push(newTrack);
    state.currentSet.tracks.sort((a, b) => a.startSec - b.startSec).forEach((t, i) => { t.order = i + 1; });
    state.currentSet.durationSec = Math.max(state.currentSet.durationSec, endSec);
    state.selectedTrackId = newTrack.id;
  }
  persistEdits();
  closeTrackDrawer();
  renderAll();
  showToast(`Saved "${title}" to tracklist`);
}

/*************************************************************************
 * 13. EXPORT TRACKLIST
 *************************************************************************/
function exportCleanTracklist() {
  const set = state.currentSet;
  if (!set.tracks.length) return showToast('Decode a set first');
  const lines = [
    `discojockey // ${set.title}`,
    `Source: ${set.sourceUrl || 'uploaded mix'}`,
    `----------------------------------------`,
    ...set.tracks.map((t, idx) =>
      `${num2(idx + 1)}. [${formatTime(t.startSec)} – ${formatTime(t.endSec)}] ${displayArtist(t)} — ${displayTitle(t)} (${fmtBpm(t.bpm)} BPM • ${fmtCam(t.camelot)} ${t.keyName || ''})`.trim()
    )
  ];
  copyText(lines.join('\n'), 'Clean timestamped tracklist copied!');
}

function copyText(text, okMessage) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast(okMessage)).catch(() => fallbackCopyText(text, okMessage));
  } else {
    fallbackCopyText(text, okMessage);
  }
}

function fallbackCopyText(text, okMessage) {
  const ta = document.getElementById('clipboardFallbackArea');
  if (ta) {
    ta.value = text;
    ta.select();
    try { document.execCommand('copy'); } catch (err) {}
  }
  showToast(okMessage);
}

/*************************************************************************
 * 14. START
 *************************************************************************/
window.addEventListener('DOMContentLoaded', () => {
  renderRecentSets();
  renderAll();
  saveCrate();
  checkEngine();
  const m = location.hash.match(/v=([\w-]{11})/);
  if (m) {
    document.getElementById('sourceUrlInput').value = `https://www.youtube.com/watch?v=${m[1]}`;
    openRecentSet(m[1]);
  }
});
