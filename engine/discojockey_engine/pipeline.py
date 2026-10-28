"""Turn a mix into a set: which song played when, how long each blend was, BPM, key,
energy, set structure and transition notes.

Order of work (each step reports progress so the page can show results early):
1. features of the whole mix (dsp)
2. where tracks change: from a posted tracklist when there is a good one, else from the audio
3. recognition of a 12 s clip from the middle of each stretch (names, artwork, links)
4. fix the segmentation with what recognition heard (split, merge)
5. blend windows, BPM/key per track, transition notes, set structure
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Awaitable, Callable

import numpy as np

from . import dsp, tracklist
from .recognize import Match, Recognizer, search_links, song_key

log = logging.getLogger(__name__)

Report = Callable[[str, float, str, dict | None], Awaitable[None] | None]

PALETTE = [('#1E3AFF', '#FFFDF7'), ('#FF6B00', '#0D0D0D'), ('#D4FF00', '#0D0D0D'),
           ('#FF3B30', '#FFFDF7'), ('#7C3AED', '#FFFDF7'), ('#00E5A3', '#0D0D0D')]


@dataclass
class Segment:
    start: float                      # centre of the change into this track (0 for the first)
    end: float                        # centre of the change out of it (mix length for the last)
    entry: tracklist.Entry | None = None
    hits: list[tuple[float, Match]] = field(default_factory=list)   # (clip start in mix, match)
    probed: list[float] = field(default_factory=list)

    @property
    def length(self) -> float:
        return self.end - self.start

    def best(self) -> Match | None:
        if not self.hits:
            return None
        counts = Counter(m.key for _, m in self.hits)
        key = counts.most_common(1)[0][0]
        return next(m for _, m in self.hits if m.key == key)


def fmt_bpm(bpm: float | None) -> str:
    return f'{bpm:g}' if bpm else '?'


def fmt(sec: float) -> str:
    sec = max(0, int(round(sec)))
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    return f'{h}:{m:02d}:{s:02d}' if h else f'{m}:{s:02d}'


async def _call(report: Report | None, *args):
    if report is None:
        return
    out = report(*args)
    if asyncio.iscoroutine(out):
        await out


# --------------------------------------------------------------------------- segmentation

def segments_from_tracklist(entries: list[tracklist.Entry], novelty: list[float], duration: float) -> list[Segment]:
    """Use the posted timestamps, nudged onto the audio change they describe (within 25 s)."""
    cuts = []
    for e in entries[1:]:
        t = e.start
        near = [b for b in novelty if abs(b - t) <= 25]
        if near:
            t = min(near, key=lambda b: abs(b - t))
        if (not cuts or t - cuts[-1] >= 20) and 20 <= t <= duration - 20:
            cuts.append(t)
        elif cuts and t - cuts[-1] < 20:
            cuts.append(cuts[-1] + 20)
    edges = [0.0] + cuts + [duration]
    segs = []
    for i, e in enumerate(entries[: len(edges) - 1]):
        segs.append(Segment(edges[i], edges[i + 1], entry=e))
    return segs


def segments_from_audio(novelty: list[float], duration: float, edge: float = 30.0) -> list[Segment]:
    # A "change" in the first or last half minute is an intro, outro or applause, not a track.
    cuts = [b for b in sorted(novelty) if edge <= b <= duration - edge]
    edges = [0.0] + cuts + [duration]
    return [Segment(a, b) for a, b in zip(edges, edges[1:]) if b - a > 1]


def probe_times(seg: Segment, pass_no: int, spread: bool = True) -> list[float]:
    """Where to take 12 s clips: away from the blends, and every ~150 s on long stretches
    (a long stretch may hide a track change the audio analysis missed)."""
    lo, hi = seg.start + 15, seg.end - 15
    if hi - lo < 12:
        lo, hi = seg.start + 1, max(seg.start + 13, seg.end - 1)
    if pass_no == 1:
        n = max(1, round((hi - lo) / 150)) if spread else 1
        pts = [lo + (hi - lo) * (k + 0.5) / n for k in range(n)]
    else:
        pts = [lo + (hi - lo) * 0.3, lo + (hi - lo) * 0.7]
    return [p for p in pts if all(abs(p - q) > 8 for q in seg.probed)]


def split_on_disagreement(segs: list[Segment]) -> list[Segment]:
    """A stretch where recognition heard two different songs hides a change: split it."""
    out = []
    for seg in segs:
        hits = sorted(seg.hits, key=lambda h: h[0])
        groups: list[list[tuple[float, Match]]] = []
        for h in hits:
            if groups and groups[-1][-1][1].key == h[1].key:
                groups[-1].append(h)
            else:
                groups.append([h])
        if len(groups) <= 1:
            out.append(seg)
            continue
        start = seg.start
        for g, nxt in zip(groups, groups[1:] + [None]):
            if nxt is None:
                end = seg.end
            else:
                last_t, first_t = g[-1][0], nxt[0][0]
                inferred = nxt[0][0] - (nxt[0][1].offset or 0)   # when the next song began, from its offset
                end = inferred if last_t + 6 < inferred < first_t else (last_t + 12 + first_t) / 2
            out.append(Segment(start, end, entry=seg.entry if not out or out[-1].entry is not seg.entry else None,
                               hits=list(g), probed=[t for t, _ in g]))
            start = end
    return out


def merge_same_song(segs: list[Segment]) -> list[Segment]:
    out: list[Segment] = []
    for seg in segs:
        prev = out[-1] if out else None
        if prev and prev.best() and seg.best() and prev.best().key == seg.best().key:
            prev.end = seg.end
            prev.hits += seg.hits
            prev.probed += seg.probed
            continue
        out.append(seg)
    return out


def _inner(seg: Segment) -> tuple[float, float]:
    """The part of a stretch away from its edges (where the neighbours blend in)."""
    pad = min(10.0, seg.length / 4)
    return seg.start + pad, seg.end - pad


def merge_unknown_lookalikes(segs: list[Segment], f: dsp.Features) -> list[Segment]:
    """Two unidentified neighbours with the same tempo and key are most likely one track."""
    out: list[Segment] = []
    for seg in segs:
        prev = out[-1] if out else None
        if prev and not prev.best() and not seg.best() and not prev.entry and not seg.entry:
            pa, pb = _inner(prev)
            sa, sb = _inner(seg)
            b1, _ = dsp.bpm(f, pa, pb)
            b2, _ = dsp.bpm(f, sa, sb)
            k1, k2 = dsp.key(f, pa, pb), dsp.key(f, sa, sb)
            if b1 and b2 and abs(b1 - b2) <= 0.6 and k1 and k2 and k1['camelot'] == k2['camelot']:
                prev.end = seg.end
                continue
        out.append(seg)
    return out


def absorb_short_unknowns(segs: list[Segment], f: dsp.Features, max_len: float = 45.0) -> list[Segment]:
    """A short unrecognised stretch between identified tracks is nearly always a breakdown or
    an effect inside one of them: fold it into the neighbour with the closer tempo."""
    out = list(segs)
    i = 0
    while i < len(out):
        seg = out[i]
        if seg.best() or seg.entry or seg.length > max_len or len(out) == 1:
            i += 1
            continue
        prev = out[i - 1] if i > 0 else None
        nxt = out[i + 1] if i + 1 < len(out) else None
        here, _ = dsp.bpm(f, seg.start, seg.end)

        def gap(other):
            if other is None or not (other.best() or other.entry):
                return float('inf')
            b, _ = dsp.bpm(f, *_inner(other))
            return abs((b or 0) - (here or 0)) if b and here else 50.0

        target = prev if gap(prev) <= gap(nxt) else nxt
        if target is None or gap(target) == float('inf'):
            i += 1
            continue
        if target is prev:
            prev.end = seg.end
        else:
            nxt.start = seg.start
        out.pop(i)
    return out


def _title_overlap(a: str, b: str) -> float:
    ta = set(song_key('', a).split('|')[1].split())
    tb = set(song_key('', b).split('|')[1].split())
    return len(ta & tb) / max(1, min(len(ta), len(tb)))


# --------------------------------------------------------------------------- recognition

async def recognise(segs: list[Segment], pcm: np.ndarray, recognizer: Recognizer, deadline: float,
                    pass_no: int, only_unknown: bool = False, spread: bool = True) -> int:
    jobs = []
    for seg in segs:
        if only_unknown and seg.best():
            continue
        for t in probe_times(seg, pass_no, spread):
            seg.probed.append(t)
            jobs.append((seg, t))
    if not jobs:
        return 0

    async def one(seg: Segment, t: float):
        a = int(max(0, t - 6) * dsp.SR)
        clip = dsp.wav_bytes(pcm[a:a + 12 * dsp.SR])
        m = await recognizer.identify(clip)
        if m:
            seg.hits.append((a / dsp.SR, m))

    tasks = [asyncio.create_task(one(s, t)) for s, t in jobs]
    timeout = max(0.5, deadline - time.monotonic())
    done, pending = await asyncio.wait(tasks, timeout=timeout)
    for p in pending:
        p.cancel()
    return len(jobs)


# --------------------------------------------------------------------------- building the set

def blend_style(seconds: float) -> str:
    if seconds < 4:
        return 'cut'
    if seconds < 16:
        return 'quick blend'
    if seconds < 45:
        return 'blend'
    return 'long blend'


def transition_tips(a: dict, b: dict, tr: dict) -> list[str]:
    tips = []
    rel = tr['keyRelation']
    if rel in ('same key', 'adjacent (+/-1)', 'relative major/minor'):
        tips.append(f"Harmonic mix: {a['camelot']} → {b['camelot']} ({rel}) sit together without clashing.")
    elif rel == 'energy boost (+2)':
        tips.append(f"Energy boost: {a['camelot']} → {b['camelot']} is two steps round the Camelot wheel, a lift in mood.")
    elif rel == 'key clash':
        tips.append(f"Keys clash ({a['camelot']} → {b['camelot']}): " +
                    ('the DJ kept the overlap short.' if tr['seconds'] < 16 else
                     f"yet they overlap {round(tr['seconds'])}s, so the melodies were probably EQ'd or filtered out."))
    if a.get('bpm') and b.get('bpm') and abs(a['bpm'] - b['bpm']) > 1.5:
        tips.append(f"Tempo moves {fmt_bpm(a['bpm'])} → {fmt_bpm(b['bpm'])} BPM across the mix.")
    if tr.get('bassSwap') is not None:
        tips.append(f"Bass swap at {fmt(tr['bassSwap'])}: the low end switches in one move, so two basslines never fight.")
    if tr['style'] == 'long blend':
        tips.append(f"Long blend: both tracks run together for {round(tr['seconds'])}s, which needs sparse intros and outros.")
    if tr['style'] == 'cut':
        tips.append('Hard cut: the next track drops straight in, usually on the first beat of a phrase.')
    if b.get('cueInSong') and b['cueInSong'] > 20:
        tips.append(f"{b['title']} was started {fmt(b['cueInSong'])} into the track, skipping its intro.")
    return tips


def set_phases(tracks: list[dict]) -> list[dict]:
    if not tracks:
        return []
    e = np.array([t['energy'] for t in tracks])
    hi, med = np.percentile(e, 75), np.median(e)
    peaks = [i for i, v in enumerate(e) if v >= hi]
    first, last = peaks[0], peaks[-1]
    total = tracks[-1]['endSec'] or 1
    labels = []
    for i, v in enumerate(e):
        pos = tracks[i]['startSec'] / total
        if v >= hi:
            labels.append('Peak time')
        elif i < first:
            labels.append('Warm-up' if pos < 0.3 and v < med else 'Build-up')
        elif i > last:
            labels.append('Closing')
        else:
            labels.append('Breather' if v < med else 'Groove')
        tracks[i]['phase'] = labels[-1]
    runs = []
    for i, lab in enumerate(labels):
        if runs and runs[-1]['name'] == lab:
            runs[-1]['end'] = tracks[i]['endSec']
            runs[-1]['tracks'] += 1
        else:
            runs.append({'name': lab, 'start': tracks[i]['startSec'], 'end': tracks[i]['endSec'], 'tracks': 1})
    return runs


def build_set(f: dsp.Features, segs: list[Segment], curve: list[dict], meta: dict) -> dict:
    duration = f.duration
    n = len(segs)
    blends = []
    for k in range(1, n):
        blends.append(dsp.blend_window(f, segs[k - 1].start, segs[k].start, segs[k].end))

    tracks = []
    for i, seg in enumerate(segs):
        start = 0.0 if i == 0 else blends[i - 1]['start']
        end = duration if i == n - 1 else blends[i]['end']
        solo_a = start if i == 0 else blends[i - 1]['end']
        solo_b = end if i == n - 1 else blends[i]['start']
        if solo_b - solo_a < 12:
            solo_a, solo_b = start, end
        bpm, bpm_conf = dsp.bpm(f, solo_a, solo_b)
        key = dsp.key(f, solo_a, solo_b) or {}
        m = seg.best()
        entry = seg.entry
        notes = []
        if entry and m and _title_overlap(entry.title, m.title) < 0.3:
            notes.append(f'The audio sounds like {m.artist} – {m.title}; the posted tracklist says otherwise.')
        if entry:
            title, artist, source = entry.title, entry.artist, 'tracklist'
            if entry.unreleased and m:
                title, artist, source = m.title, m.artist, m.provider
        elif m:
            title, artist, source = m.title, m.artist, m.provider
        else:
            title, artist, source = 'ID', 'Unknown artist', 'unknown'
        featuring = ''
        for sep in (' feat. ', ' ft. ', ' featuring ', ' Feat. ', ' Ft. '):
            if sep in artist:
                artist, featuring = artist.split(sep, 1)
                break
        links = search_links(artist if artist != 'Unknown artist' else '', title if title != 'ID' else '')
        if m and (not entry or _title_overlap(entry.title, m.title) >= 0.3):
            links.update(m.links)
        cue_in_song = None
        if m and m.offset is not None:
            hit_t = next(t for t, h in seg.hits if h.key == m.key)
            song_start = hit_t - m.offset
            if song_start - 30 <= start <= song_start + 900:
                cue_in_song = max(0.0, start - song_start)
        credits = ' · '.join(x for x in [m.album if m else None, m.label if m else (entry.label if entry else None),
                                          m.released if m else None] if x)
        color, text = PALETTE[i % len(PALETTE)]
        tracks.append({
            'id': f't{i + 1}', 'order': i + 1, 'deck': 'A' if i % 2 == 0 else 'B',
            'title': title, 'artist': artist, 'featuring': featuring,
            'credits': credits, 'remixer': '', 'label': (m.label if m else None) or (entry.label if entry else ''),
            'startSec': round(start, 1), 'endSec': round(end, 1),
            'soloStartSec': round(solo_a, 1), 'soloEndSec': round(solo_b, 1),
            'bpm': bpm, 'bpmConfidence': bpm_conf,
            'keyName': key.get('key', ''), 'camelot': key.get('camelot', ''), 'keyConfidence': key.get('confidence', 0),
            'style': (m.genre if m else None) or '', 'energy': dsp.mean_energy(curve, start, end),
            'color': color, 'textColor': text, 'cover': m.cover if m else None,
            'identified': source != 'unknown', 'source': source,
            'unreleased': bool(entry and entry.unreleased and not m),
            'blends': entry.blends if entry else [],
            'cueInSong': round(cue_in_song, 1) if cue_in_song is not None else None,
            'links': links, 'notes': notes, 'transitionCallout': '',
        })

    transitions = []
    for k, bw in enumerate(blends):
        a, b = tracks[k], tracks[k + 1]
        tr = {
            'from': a['id'], 'to': b['id'], 'startSec': round(bw['start'], 1), 'endSec': round(bw['end'], 1),
            'seconds': round(bw['seconds'], 1), 'style': blend_style(bw['seconds']),
            'bassSwap': bw['bass_swap'], 'confidence': bw['confidence'],
            'bpmFrom': a['bpm'], 'bpmTo': b['bpm'],
            'keyFrom': a['camelot'], 'keyTo': b['camelot'],
            'keyRelation': dsp.camelot_relation(a['camelot'] or None, b['camelot'] or None),
        }
        tr['tips'] = transition_tips(a, b, tr)
        transitions.append(tr)
        bits = [f"{round(tr['seconds'])}s {tr['style']} into {b['title']}"]
        if a['camelot'] and b['camelot']:
            bits.append(f"{a['camelot']} → {b['camelot']} ({tr['keyRelation']})")
        if a['bpm'] and b['bpm']:
            same = abs(a['bpm'] - b['bpm']) < 0.3
            bits.append(f"both at {fmt_bpm(a['bpm'])} BPM" if same else f"{fmt_bpm(a['bpm'])} → {fmt_bpm(b['bpm'])} BPM")
        if tr['bassSwap'] is not None:
            bits.append(f"bass swap at {fmt(tr['bassSwap'])}")
        a['transitionCallout'] = ' · '.join(bits)
    if tracks:
        tracks[-1]['transitionCallout'] = 'Closing track: plays out to the end of the set.'

    phases = set_phases(tracks)
    energy_points = [{
        't': round((t['startSec'] + t['endSec']) / 2, 1), 'v': t['energy'], 'phase': t.get('phase', ''),
        'note': f"{t['artist']} – {t['title']}" + (f" · {fmt_bpm(t['bpm'])} BPM" if t['bpm'] else '') + (f" · {t['camelot']}" if t['camelot'] else ''),
    } for t in tracks]

    return {
        **meta,
        'durationSec': round(duration, 1),
        'tracks': tracks,
        'transitions': transitions,
        'energy': curve,
        'energyCurve': energy_points,
        'phases': phases,
    }


async def analyse(pcm: np.ndarray, *, meta: dict, candidates: list[dict] | None = None,
                  recognizer: Recognizer | None = None, report: Report | None = None,
                  budget: float = 35.0) -> dict:
    """Full analysis of one decoded mix. `meta` is copied into the result (title, videoId...)."""
    t0 = time.monotonic()
    await _call(report, 'analysing', 0.45, 'Listening to the whole mix: tempo, key, energy, track changes…', None)
    f = await asyncio.to_thread(dsp.features, pcm)
    curve = dsp.energy_curve(f)
    novelty = dsp.boundaries(f)
    duration = f.duration

    best = tracklist.pick_best(candidates or [], duration)
    use_tracklist = bool(best and best['timed'] and len(best['entries']) >= 3
                         and tracklist.coverage(best['entries'], duration) >= 0.5)
    if use_tracklist:
        segs = segments_from_tracklist(best['entries'], novelty, duration)
        mode = 'tracklist+audio'
    else:
        segs = segments_from_audio(novelty, duration)
        mode = 'audio'
    meta = {**meta, 'mode': mode, 'tracklistSources': best['sources'] if use_tracklist else [],
            'recognizer': recognizer.name if recognizer else None}

    partial = await asyncio.to_thread(build_set, f, segs, curve, {**meta, 'partial': True})
    await _call(report, 'identifying', 0.6, f'Found {len(segs)} tracks. Identifying them…', partial)

    requests = 0
    if recognizer:
        deadline = t0 + budget
        requests += await recognise(segs, pcm, recognizer, deadline, pass_no=1, spread=not use_tracklist)
        if not use_tracklist:
            segs = merge_same_song(split_on_disagreement(segs))
            if time.monotonic() < deadline - 2:
                await _call(report, 'identifying', 0.8, 'Second listen for the tracks still unknown…', None)
                requests += await recognise(segs, pcm, recognizer, deadline, pass_no=2, only_unknown=True)
                segs = merge_same_song(split_on_disagreement(segs))
    if not use_tracklist:
        segs = await asyncio.to_thread(merge_unknown_lookalikes, segs, f)
        if recognizer:
            segs = await asyncio.to_thread(absorb_short_unknowns, segs, f)

    await _call(report, 'finishing', 0.92, 'Measuring blends and building the set…', None)
    result = await asyncio.to_thread(build_set, f, segs, curve, meta)
    result['stats'] = {
        'analysisSeconds': round(time.monotonic() - t0, 1),
        'recognitionRequests': requests,
        'identified': sum(1 for t in result['tracks'] if t['identified']),
    }
    return result
