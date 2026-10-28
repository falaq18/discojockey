/*
 * discojockey app: fetch a YouTube DJ set, find its tracklist, play it with cue
 * points, and suggest more music. Depends on parser.js (window.DJParser).
 */
(function () {
  'use strict';

  // Optional: a YouTube Data API v3 key that every visitor uses. Restrict it to
  // your GitHub Pages domain (HTTP referrer) in Google Cloud before putting it here.
  const SITE_YT_API_KEY = '';

  const P = window.DJParser;
  const $ = (sel) => document.querySelector(sel);
  const fmt = P.formatTime;

  const state = {
    videoId: null,
    meta: { title: '', channel: '', durationSec: 0 },
    tracks: [],
    timed: true,
    sources: [],
    currentIdx: -1,
    player: null,
    playerReady: false,
    pendingSeek: null,
    enrichToken: 0,
    previewAudio: new Audio(),
    previewBtn: null
  };

  /* ---------------------------------------------------------------- storage */

  function store(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      return null;
    }
  }

  function apiKey() {
    return store('dj_yt_key') || SITE_YT_API_KEY || '';
  }

  /* ---------------------------------------------------------------- helpers */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function extractYouTubeId(input) {
    const str = (input || '').trim();
    if (/^[\w-]{11}$/.test(str)) return str;
    const m = str.match(/(?:[?&]v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  function isoDuration(iso) {
    const m = (iso || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return 0;
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  }

  function jsonp(url, timeoutMs = 9000) {
    return new Promise((resolve, reject) => {
      const cb = '__dj_cb_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      const done = (fn, arg) => {
        clearTimeout(timer);
        delete window[cb];
        script.remove();
        fn(arg);
      };
      const timer = setTimeout(() => done(reject, new Error('timeout')), timeoutMs);
      window[cb] = (data) => done(resolve, data);
      script.onerror = () => done(reject, new Error('network'));
      script.src = url + (url.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + cb;
      document.head.appendChild(script);
    });
  }

  // Run async jobs with a small concurrency limit (Deezer allows ~50 req / 5 s).
  async function pool(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          await fn(items[idx], idx);
        } catch (e) {
          /* best effort */
        }
      }
    });
    await Promise.all(workers);
  }

  function searchLinks(t) {
    const q = encodeURIComponent([t.artist, t.title].filter(Boolean).join(' '));
    return [
      ['Spotify', 'https://open.spotify.com/search/' + q],
      ['Apple Music', 'https://music.apple.com/us/search?term=' + q],
      ['YouTube', 'https://www.youtube.com/results?search_query=' + q],
      ['SoundCloud', 'https://soundcloud.com/search?q=' + q],
      ['Beatport', 'https://www.beatport.com/search?q=' + q]
    ];
  }

  /* ---------------------------------------------------------------- YouTube data */

  async function ytGet(path, params) {
    const qs = new URLSearchParams(Object.assign({ key: apiKey() }, params));
    const res = await fetch('https://www.googleapis.com/youtube/v3/' + path + '?' + qs);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data.error?.errors?.[0]?.reason || data.error?.status || res.status;
      const err = new Error(data.error?.message || 'YouTube API error');
      err.reason = reason;
      throw err;
    }
    return data;
  }

  async function fetchVideo(videoId) {
    const data = await ytGet('videos', { id: videoId, part: 'snippet,contentDetails' });
    const item = data.items?.[0];
    if (!item) throw Object.assign(new Error('Video not found'), { reason: 'notFound' });
    return {
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      description: item.snippet.description || '',
      durationSec: isoDuration(item.contentDetails?.duration)
    };
  }

  // Top-level comments (most relevant first) plus the replies YouTube includes.
  async function fetchComments(videoId, pages = 3) {
    const out = [];
    let pageToken;
    for (let p = 0; p < pages; p++) {
      let data;
      try {
        data = await ytGet('commentThreads', {
          videoId,
          part: 'snippet,replies',
          order: 'relevance',
          maxResults: 100,
          textFormat: 'plainText',
          ...(pageToken ? { pageToken } : {})
        });
      } catch (e) {
        if (e.reason === 'commentsDisabled') break;
        if (p === 0) throw e;
        break;
      }
      for (const th of data.items || []) {
        const top = th.snippet.topLevelComment.snippet;
        out.push({ source: 'comment by ' + (top.authorDisplayName || 'a viewer'), text: top.textOriginal || top.textDisplay });
        for (const r of th.replies?.comments || []) {
          out.push({ source: 'reply by ' + (r.snippet.authorDisplayName || 'a viewer'), text: r.snippet.textOriginal || r.snippet.textDisplay });
        }
      }
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  async function fetchTitleWithoutKey(videoId) {
    try {
      const res = await fetch('https://noembed.com/embed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + videoId));
      const data = await res.json();
      return { title: data.title || '', channel: data.author_name || '' };
    } catch (e) {
      return { title: '', channel: '' };
    }
  }

  /* ---------------------------------------------------------------- analyse */

  function setStep(text, kind = 'loading') {
    const el = $('#status');
    el.hidden = !text;
    el.className = 'status ' + kind;
    el.innerHTML = kind === 'loading' ? '<span class="spinner"></span>' + esc(text) : esc(text);
  }

  async function analyse(input) {
    const raw = (input || '').trim();
    if (!raw) return toast('Paste a YouTube link first');
    const videoId = extractYouTubeId(raw);

    // Pasted tracklist text without a link: parse it on its own.
    if (!videoId) {
      const parsed = P.parseTracklist(raw);
      if (parsed.tracks.length < 2) return toast('That doesn’t look like a YouTube link or a tracklist');
      loadSet({ videoId: state.videoId, meta: state.meta, tracks: parsed.tracks, timed: parsed.timed, sources: ['pasted text'] });
      return;
    }

    history.replaceState(null, '', '#v=' + videoId);
    $('#urlInput').value = 'https://www.youtube.com/watch?v=' + videoId;

    const saved = store('dj_set_' + videoId);
    if (saved && saved.tracks?.length) {
      loadSet(Object.assign({ videoId }, saved));
      return;
    }

    let meta = { title: '', channel: '', durationSec: 0 };
    let candidates = [];

    if (apiKey()) {
      try {
        setStep('Reading the video description…');
        const v = await fetchVideo(videoId);
        meta = { title: v.title, channel: v.channel, durationSec: v.durationSec };
        candidates.push({ source: 'video description', text: v.description });
        setStep('Searching the top comments for a tracklist…');
        candidates = candidates.concat(await fetchComments(videoId));
      } catch (e) {
        if (e.reason === 'notFound') {
          setStep('That video doesn’t exist or is private.', 'error');
          return;
        }
        const keyProblem = ['keyInvalid', 'API_KEY_INVALID', 'forbidden', 'accessNotConfigured', 'ipRefererBlocked', 'quotaExceeded', 'dailyLimitExceeded', 400, 403].includes(e.reason);
        toast(keyProblem ? 'YouTube API key problem: ' + e.message : 'Couldn’t reach YouTube: ' + e.message);
      }
    }
    if (!meta.title) Object.assign(meta, await fetchTitleWithoutKey(videoId));

    setStep('');
    const best = P.pickBestTracklist(candidates, meta.durationSec);
    if (best) {
      loadSet({ videoId, meta, tracks: best.tracks, timed: best.timed, sources: best.sources });
    } else {
      loadSet({ videoId, meta, tracks: [], timed: true, sources: [], searched: candidates.length });
    }
  }

  function loadSet(set) {
    state.videoId = set.videoId;
    state.meta = set.meta || { title: '', channel: '', durationSec: 0 };
    state.timed = set.timed !== false;
    state.sources = set.sources || [];
    state.tracks = P.buildSet(set.tracks || [], state.meta.durationSec);
    state.currentIdx = -1;
    state.searched = set.searched;

    $('#hero').classList.add('compact');
    $('#set').hidden = false;
    renderMeta();
    renderTracklist();
    renderTimeline();
    renderNowPlaying();
    $('#recs').hidden = true;
    loadPlayer(set.videoId);

    if (state.videoId && state.tracks.length) {
      store('dj_set_' + state.videoId, {
        meta: state.meta,
        tracks: set.tracks,
        timed: state.timed,
        sources: state.sources
      });
      rememberRecent();
    }
    enrich();
  }

  function rememberRecent() {
    const list = (store('dj_recent') || []).filter((r) => r.id !== state.videoId);
    list.unshift({ id: state.videoId, title: state.meta.title || state.videoId, n: state.tracks.length });
    store('dj_recent', list.slice(0, 6));
    renderRecent();
  }

  /* ---------------------------------------------------------------- player */

  function loadPlayer(videoId) {
    if (!videoId) return;
    if (state.player && state.playerReady) {
      state.player.cueVideoById(videoId);
      return;
    }
    if (state.player) return;
    const create = () => {
      state.player = new YT.Player('player', {
        videoId,
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady: () => {
            state.playerReady = true;
            if (!state.meta.durationSec) {
              const d = state.player.getDuration();
              if (d) {
                state.meta.durationSec = d;
                state.tracks = P.buildSet(state.tracks, d);
                renderTimeline();
              }
            }
            if (state.pendingSeek != null) seek(state.pendingSeek);
          },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.PLAYING) stopPreview();
          }
        }
      });
    };
    if (window.YT && window.YT.Player) create();
    else {
      window.onYouTubeIframeAPIReady = create;
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(s);
      }
    }
  }

  function seek(sec) {
    if (!state.playerReady) {
      state.pendingSeek = sec;
      return;
    }
    state.pendingSeek = null;
    state.player.seekTo(Math.max(0, sec), true);
    state.player.playVideo();
    tick();
    if (window.matchMedia('(max-width: 900px)').matches) $('#stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function currentTime() {
    try {
      return state.playerReady ? state.player.getCurrentTime() : 0;
    } catch (e) {
      return 0;
    }
  }

  function trackAt(sec) {
    let idx = -1;
    for (let i = 0; i < state.tracks.length; i++) {
      if (state.tracks[i].startSec != null && state.tracks[i].startSec <= sec + 0.5) idx = i;
    }
    return idx;
  }

  function tick() {
    if (!state.tracks.length || !state.timed) return;
    const t = currentTime();
    const idx = trackAt(t);
    if (idx !== state.currentIdx) {
      document.querySelectorAll('.track.playing').forEach((el) => el.classList.remove('playing'));
      document.querySelectorAll('.seg.playing').forEach((el) => el.classList.remove('playing'));
      document.querySelector('.track[data-idx="' + idx + '"]')?.classList.add('playing');
      document.querySelector('.seg[data-idx="' + idx + '"]')?.classList.add('playing');
      state.currentIdx = idx;
      renderNowPlaying();
    }
    const dur = state.meta.durationSec;
    if (dur) $('#playhead').style.left = Math.min(100, (t / dur) * 100) + '%';
    const cur = state.tracks[idx];
    if (cur && cur.lengthSec) {
      const pct = Math.min(100, ((t - cur.startSec) / cur.lengthSec) * 100);
      const bar = $('#npProgress');
      if (bar) bar.style.width = pct + '%';
      const el = $('#npClock');
      if (el) el.textContent = fmt(t - cur.startSec) + ' / ' + fmt(cur.lengthSec);
    }
  }

  /* ---------------------------------------------------------------- render */

  function renderMeta() {
    $('#setTitle').textContent = state.meta.title || 'YouTube set';
    const bits = [];
    if (state.meta.channel) bits.push(state.meta.channel);
    if (state.meta.durationSec) bits.push(fmt(state.meta.durationSec));
    if (state.tracks.length) bits.push(state.tracks.length + ' tracks');
    $('#setSub').textContent = bits.join(' · ');
    $('#ytLink').href = 'https://www.youtube.com/watch?v=' + state.videoId;
  }

  function art(t, cls = 'art') {
    if (t.deezer?.cover) return '<img class="' + cls + '" src="' + esc(t.deezer.cover) + '" alt="" loading="lazy">';
    return '<div class="' + cls + ' art-empty" aria-hidden="true">' + esc((t.artist || t.title || '?').charAt(0).toUpperCase()) + '</div>';
  }

  function trackName(t) {
    return (t.artist ? esc(t.artist) + ' – ' : '') + esc(t.title);
  }

  function renderTracklist() {
    const list = $('#tracklist');
    const count = $('#trackCount');
    const src = $('#trackSource');

    if (!state.tracks.length) {
      count.textContent = 'No tracklist found yet';
      src.textContent = '';
      const q = encodeURIComponent(state.meta.title || '');
      const why = !apiKey()
        ? 'To read the description and comments automatically, add a free YouTube API key in <button class="link" data-action="settings">settings</button>. Or paste a tracklist below.'
        : state.searched > 1
          ? 'We checked the description and ' + (state.searched - 1) + ' top comments and none contained a timestamped tracklist.'
          : state.searched
          ? 'The description has no timestamped tracklist and the comments are off or empty.'
          : 'We couldn’t read this video’s description or comments.';
      list.innerHTML =
        '<div class="empty">' +
        '<p>' + why + '</p>' +
        '<textarea id="inlinePaste" rows="8" placeholder="0:00 Artist – Track\n3:45 Artist – Track\n…"></textarea>' +
        '<div class="row"><button class="btn primary" data-action="parse-inline">Use this tracklist</button>' +
        (q ? '<a class="btn ghost" target="_blank" rel="noopener" href="https://www.1001tracklists.com/search/result.php?searchstring=' + q + '">Search 1001Tracklists ↗</a>' : '') +
        '</div></div>';
      return;
    }

    count.textContent = state.tracks.length + ' tracks';
    src.textContent = 'from the ' + state.sources.join(' + ');

    const html = [];
    state.tracks.forEach((t, i) => {
      const links = searchLinks(t);
      if (t.deezer?.link) links.unshift(['Deezer', t.deezer.link]);
      const blends = t.blends.length
        ? '<div class="blends">' + t.blends.map((b) => '<span>w/ ' + trackName(b) + '</span>').join('') + '</div>'
        : '';
      const meta = [];
      if (t.recordLabel) meta.push(esc(t.recordLabel));
      if (t.deezer?.bpm) meta.push(Math.round(t.deezer.bpm) + ' BPM');
      if (t.lengthSec) meta.push(fmt(t.lengthSec) + ' in the mix');
      html.push(
        '<li class="track' + (t.unreleased ? ' unreleased' : '') + '" data-idx="' + i + '">' +
          '<button class="cue" data-action="seek" data-sec="' + (t.startSec ?? '') + '" ' + (t.startSec == null ? 'disabled' : '') + ' aria-label="Play from ' + fmt(t.startSec) + '">' +
            '<span class="num">' + String(i + 1).padStart(2, '0') + '</span>' +
            '<span class="time">' + (t.startSec != null ? fmt(t.startSec) : '—') + '</span>' +
          '</button>' +
          art(t) +
          '<div class="info">' +
            '<div class="title">' + esc(t.title) + (t.unreleased ? ' <span class="tag">Unreleased</span>' : '') + '</div>' +
            '<div class="artist">' + esc(t.artist || 'Unknown artist') + '</div>' +
            blends +
            (meta.length ? '<div class="meta">' + meta.join(' · ') + '</div>' : '') +
          '</div>' +
          '<details class="links"><summary aria-label="Listen elsewhere">Listen</summary><div class="menu">' +
            links.map(([n, u]) => '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + n + '</a>').join('') +
          '</div></details>' +
        '</li>'
      );
      const next = state.tracks[i + 1];
      if (next && next.startSec != null && state.timed) {
        html.push(
          '<li class="transition">' +
            '<span class="line"></span>' +
            '<button data-action="seek" data-sec="' + Math.max(0, next.startSec - 20) + '">' +
              '⇄ Mix into <b>' + esc(next.title) + '</b> at ' + fmt(next.startSec) + ' · <u>hear the transition</u>' +
            '</button>' +
          '</li>'
        );
      }
    });
    list.innerHTML = html.join('');
    if (state.currentIdx >= 0) document.querySelector('.track[data-idx="' + state.currentIdx + '"]')?.classList.add('playing');
  }

  function renderTimeline() {
    const el = $('#timeline');
    const dur = state.meta.durationSec;
    if (!state.timed || !dur || !state.tracks.length) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const hues = [72, 200, 18, 280, 145, 330];
    el.querySelector('.segs').innerHTML = state.tracks
      .map((t, i) => {
        const w = ((t.lengthSec || 0) / dur) * 100;
        return '<button class="seg" data-action="seek" data-sec="' + t.startSec + '" data-idx="' + i + '" style="width:' + w + '%;--h:' + hues[i % hues.length] + '" title="' + esc(fmt(t.startSec) + '  ' + (t.artist ? t.artist + ' – ' : '') + t.title) + '"></button>';
      })
      .join('');
  }

  function renderNowPlaying() {
    const el = $('#nowPlaying');
    const t = state.tracks[state.currentIdx];
    if (!t) {
      el.innerHTML = state.tracks.length
        ? '<div class="np-idle">Press play or tap any track to jump straight to it.</div>'
        : '';
      return;
    }
    const next = state.tracks[state.currentIdx + 1];
    el.innerHTML =
      '<div class="np">' + art(t, 'np-art') +
        '<div class="np-info"><div class="eyebrow">Now playing · ' + String(state.currentIdx + 1).padStart(2, '0') + '/' + state.tracks.length + '</div>' +
        '<div class="np-title">' + esc(t.title) + '</div><div class="np-artist">' + esc(t.artist) + '</div>' +
        '<div class="np-bar"><span id="npProgress"></span></div><div class="np-clock" id="npClock"></div></div>' +
      '</div>' +
      (next ? '<button class="np-next" data-action="seek" data-sec="' + next.startSec + '"><span>Up next</span> ' + trackName(next) + ' →</button>' : '');
  }

  function renderRecent() {
    const list = store('dj_recent') || [];
    const el = $('#recent');
    el.hidden = !list.length;
    el.innerHTML = list.length
      ? '<span class="label">Recent</span>' + list.map((r) => '<button class="chip" data-action="open" data-id="' + esc(r.id) + '">' + esc(r.title.length > 42 ? r.title.slice(0, 40) + '…' : r.title) + '</button>').join('')
      : '';
  }

  /* ---------------------------------------------------------------- Deezer enrichment */

  const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)|\[.*?\]|feat\.?.*$|ft\..*$/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  function sameArtist(a, b) {
    const x = norm(a).split(' ').filter((w) => w.length > 1);
    const y = new Set(norm(b).split(' '));
    return x.length > 0 && x.some((w) => y.has(w));
  }

  async function matchDeezer(t) {
    if (t.unreleased || !t.artist) return null;
    const firstArtist = t.artist.split(/\s*(?:,|&| x | and | vs\.? |feat\.?|ft\.)\s*/i)[0];
    const queries = [
      'artist:"' + firstArtist + '" track:"' + norm(t.title) + '"',
      firstArtist + ' ' + norm(t.title)
    ];
    for (const q of queries) {
      const res = await jsonp('https://api.deezer.com/search?limit=5&q=' + encodeURIComponent(q));
      const hit = (res.data || []).find((d) => sameArtist(firstArtist, d.artist?.name) || sameArtist(d.artist?.name, t.artist));
      if (hit) {
        return {
          id: hit.id,
          link: hit.link,
          cover: hit.album?.cover_medium || hit.album?.cover,
          preview: hit.preview,
          artistId: hit.artist?.id,
          artistName: hit.artist?.name
        };
      }
    }
    return null;
  }

  async function enrich() {
    const token = ++state.enrichToken;
    const tracks = state.tracks;
    if (!tracks.length) return;
    let pending = 0;
    await pool(tracks, 4, async (t) => {
      const d = await matchDeezer(t);
      if (token !== state.enrichToken || !d) return;
      t.deezer = d;
      if (++pending % 4 === 0) renderTracklist();
    });
    if (token !== state.enrichToken) return;
    renderTracklist();
    renderNowPlaying();
    await buildRecommendations(token);
  }

  async function buildRecommendations(token) {
    const inSetArtists = new Map();
    for (const t of state.tracks) {
      if (t.deezer?.artistId) inSetArtists.set(t.deezer.artistId, t.deezer.artistName);
    }
    if (!inSetArtists.size) return;

    const inSetTitles = new Set(state.tracks.map((t) => norm(t.title)));
    const related = new Map(); // id -> { name, because: Set, picture }
    await pool([...inSetArtists.keys()].slice(0, 10), 4, async (id) => {
      const res = await jsonp('https://api.deezer.com/artist/' + id + '/related?limit=8');
      for (const a of res.data || []) {
        if (inSetArtists.has(a.id)) continue;
        const r = related.get(a.id) || { id: a.id, name: a.name, because: new Set() };
        r.because.add(inSetArtists.get(id));
        related.set(a.id, r);
      }
    });
    if (token !== state.enrichToken) return;

    const ranked = [...related.values()].sort((a, b) => b.because.size - a.because.size).slice(0, 12);
    const recs = [];
    await pool(ranked, 4, async (a) => {
      const res = await jsonp('https://api.deezer.com/artist/' + a.id + '/top?limit=3');
      const pick = (res.data || []).find((d) => !inSetTitles.has(norm(d.title)));
      if (pick) recs.push({ artist: a, track: pick });
    });
    if (token !== state.enrichToken || !recs.length) return;

    recs.sort((x, y) => y.artist.because.size - x.artist.because.size);
    renderRecommendations(recs);
  }

  function renderRecommendations(recs) {
    const el = $('#recGrid');
    el.innerHTML = recs
      .map((r, i) => {
        const t = { artist: r.track.artist?.name || r.artist.name, title: r.track.title };
        const because = [...r.artist.because].slice(0, 2).join(' & ');
        return (
          '<article class="rec">' +
            '<div class="rec-art"><img src="' + esc(r.track.album?.cover_medium || '') + '" alt="" loading="lazy">' +
              (r.track.preview ? '<button class="play" data-action="preview" data-src="' + esc(r.track.preview) + '" aria-label="Play 30 second preview">▶</button>' : '') +
            '</div>' +
            '<div class="rec-title">' + esc(t.title) + '</div>' +
            '<div class="rec-artist">' + esc(t.artist) + '</div>' +
            '<div class="rec-why">Because you heard ' + esc(because) + '</div>' +
            '<div class="rec-links"><a href="' + esc(r.track.link) + '" target="_blank" rel="noopener">Deezer</a>' +
              searchLinks(t).slice(0, 3).map(([n, u]) => '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + n + '</a>').join('') +
            '</div>' +
          '</article>'
        );
      })
      .join('');
    $('#recs').hidden = false;
  }

  function stopPreview() {
    state.previewAudio.pause();
    if (state.previewBtn) state.previewBtn.textContent = '▶';
    state.previewBtn = null;
  }

  function togglePreview(btn) {
    const same = state.previewBtn === btn;
    stopPreview();
    if (same) return;
    try {
      state.player?.pauseVideo();
    } catch (e) {}
    state.previewAudio.src = btn.dataset.src;
    state.previewAudio.play().catch(() => toast('Preview unavailable'));
    state.previewBtn = btn;
    btn.textContent = '❚❚';
  }
  state.previewAudio.addEventListener('ended', stopPreview);

  /* ---------------------------------------------------------------- dialogs & actions */

  function openEditor() {
    $('#editText').value = state.tracks.length ? P.toText(state.tracks) : '';
    $('#editDialog').showModal();
  }

  function applyEditor(text) {
    const parsed = P.parseTracklist(text, state.meta.durationSec);
    if (parsed.tracks.length < 2) {
      toast('Need at least two lines like “3:45 Artist – Track”');
      return false;
    }
    loadSet({ videoId: state.videoId, meta: state.meta, tracks: parsed.tracks, timed: parsed.timed, sources: ['your edits'] });
    toast('Tracklist updated');
    return true;
  }

  async function copyTracklist() {
    const header = (state.meta.title || 'Tracklist') + '\nhttps://www.youtube.com/watch?v=' + state.videoId + '\n\n';
    const text = header + P.toText(state.tracks);
    try {
      await navigator.clipboard.writeText(text);
      toast('Tracklist copied');
    } catch (e) {
      $('#editText').value = text;
      $('#editDialog').showModal();
    }
  }

  async function share() {
    const url = location.origin + location.pathname + '#v=' + state.videoId;
    try {
      if (navigator.share) await navigator.share({ title: state.meta.title, url });
      else {
        await navigator.clipboard.writeText(url);
        toast('Link copied');
      }
    } catch (e) {}
  }

  function wire() {
    $('#analyseForm').addEventListener('submit', (e) => {
      e.preventDefault();
      analyse($('#urlInput').value);
    });

    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) {
        document.querySelectorAll('details.links[open]').forEach((d) => d.removeAttribute('open'));
        return;
      }
      const a = el.dataset.action;
      if (a === 'seek' && el.dataset.sec !== '') seek(parseFloat(el.dataset.sec));
      else if (a === 'open') analyse(el.dataset.id);
      else if (a === 'edit') openEditor();
      else if (a === 'copy') copyTracklist();
      else if (a === 'share') share();
      else if (a === 'settings') openSettings();
      else if (a === 'preview') togglePreview(el);
      else if (a === 'refetch') {
        store('dj_set_' + state.videoId, null);
        analyse(state.videoId);
      } else if (a === 'parse-inline') applyEditor($('#inlinePaste').value);
    });

    $('#editForm').addEventListener('submit', (e) => {
      if (e.submitter?.value === 'cancel') return;
      if (!applyEditor($('#editText').value)) e.preventDefault();
    });

    $('#settingsForm').addEventListener('submit', (e) => {
      if (e.submitter?.value === 'cancel') return;
      const key = $('#keyInput').value.trim();
      store('dj_yt_key', key || null);
      renderKeyStatus();
      toast(key ? 'API key saved in this browser' : 'API key removed');
    });

    window.addEventListener('hashchange', fromHash);
    setInterval(tick, 500);
  }

  function openSettings() {
    $('#keyInput').value = store('dj_yt_key') || '';
    $('#settingsDialog').showModal();
  }

  function renderKeyStatus() {
    const has = !!apiKey();
    const el = $('#keyStatus');
    el.textContent = has ? 'Auto-detect on' : 'Add API key';
    el.classList.toggle('on', has);
  }

  function fromHash() {
    const m = location.hash.match(/v=([\w-]{11})/);
    if (m && m[1] !== state.videoId) analyse(m[1]);
  }

  wire();
  renderRecent();
  renderKeyStatus();
  fromHash();
})();
