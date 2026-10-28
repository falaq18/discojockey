"""What to play next: real tracks that fit a seed track's tempo and key.

Candidates come from Deezer (free, no key): the seed artist's top tracks and the top tracks
of related artists. Deezer's own BPM field is usually empty and it has no key at all, so we
download each 30-second preview and measure BPM and key with the same DSP as the mixes.
"""
from __future__ import annotations

import asyncio
import logging
import subprocess

import httpx
import numpy as np

from . import dsp
from .recognize import search_links, song_key

log = logging.getLogger(__name__)
DEEZER = 'https://api.deezer.com'

_preview_cache: dict[int, dict | None] = {}


def decode_bytes(data: bytes, sr: int = dsp.SR) -> np.ndarray:
    proc = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', str(sr), '-f', 's16le', '-'],
                          input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode(errors='replace')[-200:])
    return np.frombuffer(proc.stdout, dtype=np.int16)


def analyse_preview(data: bytes) -> dict | None:
    pcm = decode_bytes(data)
    if len(pcm) < dsp.SR * 10:
        return None
    f = dsp.features(pcm)
    bpm, conf = dsp.bpm(f, 0, f.duration)
    key = dsp.key(f, 0, f.duration) or {}
    curve = dsp.energy_curve(f, step=2)
    return {'bpm': bpm, 'bpmConfidence': conf, 'camelot': key.get('camelot', ''), 'keyName': key.get('key', ''),
            'loudness': float(np.median(f.loudness))}


# Same scoring rules as the site's crate (tempo 35%, harmony 35%, the rest style/energy).
def _parse_cam(c: str):
    try:
        return int(c[:-1]), c[-1]
    except (ValueError, IndexError, TypeError):
        return None


def harmonic_score(seed: str, cand: str) -> tuple[float | None, str]:
    s, c = _parse_cam(seed), _parse_cam(cand)
    if not s or not c:
        return None, 'Key unknown'
    d = min(abs(s[0] - c[0]), 12 - abs(s[0] - c[0]))
    if d == 0 and s[1] == c[1]:
        return 1.0, f'Exact key lock ({cand})'
    if d == 0:
        return 0.92, f'Relative major/minor ({seed} → {cand})'
    if d == 1 and s[1] == c[1]:
        return 0.88, f'±1 Camelot step ({seed} → {cand})'
    if d == 1:
        return 0.72, f'Diagonal mood shift ({seed} → {cand})'
    if d == 2 and s[1] == c[1]:
        return 0.65, f'+2 energy boost ({seed} → {cand})'
    return max(0.2, 0.55 - d * 0.08), f'Contrast cut ({seed} → {cand})'


def tempo_score(seed: float | None, cand: float | None) -> tuple[float | None, float]:
    if not seed or not cand:
        return None, 99.0
    diff = min(abs(seed - cand), abs(seed - cand * 2), abs(seed - cand / 2))
    for limit, score in ((1, 1.0), (2.5, 0.94), (4, 0.85), (6, 0.72), (10, 0.52)):
        if diff <= limit:
            return score, diff
    return 0.25, diff


def rank(seed: dict, candidates: list[dict]) -> list[dict]:
    out = []
    for c in candidates:
        ts, diff = tempo_score(seed.get('bpm'), c.get('bpm'))
        hs, label = harmonic_score(seed.get('camelot', ''), c.get('camelot', ''))
        weights = {'t': 0.45 if ts is not None else 0, 'h': 0.45 if hs is not None else 0, 'r': 0.10}
        total = ((ts or 0) * weights['t'] + (hs or 0) * weights['h'] + c.get('relatedness', 0.5) * weights['r']) / sum(weights.values())
        delta = round((c['bpm'] - seed['bpm']), 1) if c.get('bpm') and seed.get('bpm') else None
        why = []
        if delta is not None:
            why.append('Same tempo.' if abs(delta) < 0.3 else f"{c['bpm']} BPM ({'+' if delta > 0 else ''}{delta}): "
                       + ('barely touch the pitch fader.' if abs(delta) <= 2 else 'a small pitch nudge.' if abs(delta) <= 5 else 'needs a bigger tempo change.'))
        why.append(label + '.')
        out.append({**c, 'matchPercent': round(total * 100), 'harmonicLabel': label,
                    'tempoDiff': None if diff == 99.0 else round(diff, 1), 'whyItWorks': ' '.join(why)})
    return sorted(out, key=lambda r: r['matchPercent'], reverse=True)


async def _get(http: httpx.AsyncClient, path: str, **params) -> dict:
    res = await http.get(DEEZER + path, params=params)
    res.raise_for_status()
    data = res.json()
    if isinstance(data, dict) and data.get('error'):
        raise RuntimeError(str(data['error']))
    return data


async def next_tracks(artist: str, title: str, bpm: float | None, camelot: str, limit: int = 12,
                      exclude: list[str] | None = None) -> dict:
    exclude_keys = {song_key(*e.split('|', 1)) if '|' in e else e for e in (exclude or [])}
    exclude_keys.add(song_key(artist, title))
    async with httpx.AsyncClient(timeout=10) as http:
        found = await _get(http, '/search', q=f'artist:"{artist}" track:"{title}"', limit=1)
        if not found.get('data'):
            found = await _get(http, '/search', q=f'{artist} {title}', limit=1)
        if not found.get('data'):
            found = await _get(http, '/search/artist', q=artist, limit=1)
            artist_id = found['data'][0]['id'] if found.get('data') else None
        else:
            artist_id = found['data'][0]['artist']['id']
        if not artist_id:
            return {'seed': {'artist': artist, 'title': title}, 'tracks': [], 'note': 'Deezer does not know this artist.'}

        related = (await _get(http, f'/artist/{artist_id}/related', limit=10)).get('data', [])
        pools = [(artist_id, artist, 5, 0.6)] + [(a['id'], a['name'], 3, 1.0 - i * 0.04) for i, a in enumerate(related)]
        sem = asyncio.Semaphore(6)

        async def tops(aid, name, n, rel):
            async with sem:
                try:
                    data = await _get(http, f'/artist/{aid}/top', limit=n)
                except Exception:
                    return []
            return [(t, name, rel) for t in data.get('data', [])]

        cands = []
        seen = set(exclude_keys)
        for group in await asyncio.gather(*(tops(*p) for p in pools)):
            for t, name, rel in group:
                k = song_key(t['artist']['name'], t['title'])
                if k in seen or not t.get('preview'):
                    continue
                seen.add(k)
                cands.append((t, name, rel))

        async def measure(t, name, rel):
            tid = t['id']
            if tid not in _preview_cache:
                async with sem:
                    try:
                        audio = (await http.get(t['preview'])).content
                        _preview_cache[tid] = await asyncio.to_thread(analyse_preview, audio)
                    except Exception as e:
                        log.warning('preview analysis failed for %s: %s', tid, e)
                        _preview_cache[tid] = None
            info = _preview_cache[tid] or {}
            a, ti = t['artist']['name'], t['title']
            links = search_links(a, ti)
            links['deezer'] = t.get('link') or links['deezer']
            return {
                'id': f'dz{tid}', 'title': ti, 'artist': a, 'bpm': info.get('bpm'), 'camelot': info.get('camelot', ''),
                'keyName': info.get('keyName', ''), 'style': f'Related to {artist}' if name != artist else f'More from {artist}',
                'energy': None, 'cover': (t.get('album') or {}).get('cover_medium'), 'preview': t['preview'],
                'relatedness': rel, 'links': links,
            }

        measured = await asyncio.gather(*(measure(*c) for c in cands[:36]))
    seed = {'artist': artist, 'title': title, 'bpm': bpm, 'camelot': camelot}
    return {'seed': seed, 'tracks': rank(seed, measured)[:limit]}
