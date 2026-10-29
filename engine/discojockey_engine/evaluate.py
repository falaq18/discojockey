"""Measure the engine on real YouTube sets.

For each link this downloads the set the way the server does and analyses the audio
*without* the posted tracklist (the hard case: a set nobody wrote up). When viewers did post
a timestamped tracklist, that list is the answer key: how many track changes the engine
found, how many songs it named right, and how long each stage took.

    python -m discojockey_engine.evaluate https://youtu.be/AAAAAAAAAAA https://youtu.be/BBBBBBBBBBB
    python -m discojockey_engine.evaluate --file sets.txt --out results.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path

from . import dsp, pipeline, tracklist
from .recognize import make_recognizer
from .youtube import YouTube, YouTubeError, video_id

WINDOW = 30.0  # a posted timestamp this close to a detected blend counts as the same change


def fmt(sec: float | None) -> str:
    return pipeline.fmt(sec) if sec is not None else '--:--'


def compare(reference: list[dict], tracks: list[dict], window: float = WINDOW) -> dict:
    """Score the engine's tracks against a posted tracklist.

    `reference` is the posted list in order ({'start', 'artist', 'title', 'unreleased'});
    `tracks` is the engine's result. A posted change counts as found when it lies within
    `window` seconds of a detected blend (posters mark "when the new track is clearly in",
    which can be anywhere in the blend or just after it).
    """
    blends = []
    for prev, cur in zip(tracks, tracks[1:]):
        a, b = cur['startSec'], prev['endSec']
        blends.append((min(a, b), max(a, b)))

    def dist(t: float, iv: tuple[float, float]) -> float:
        return 0.0 if iv[0] <= t <= iv[1] else min(abs(t - iv[0]), abs(t - iv[1]))

    used: set[int] = set()
    offsets, missed = [], []
    for r in reference[1:]:
        best = min((k for k in range(len(blends)) if k not in used),
                   key=lambda k: dist(r['start'], blends[k]), default=None)
        if best is not None and dist(r['start'], blends[best]) <= window:
            used.add(best)
            offsets.append(r['start'] - (blends[best][0] + blends[best][1]) / 2)
        else:
            missed.append(r)
    extra = [blends[k] for k in range(len(blends)) if k not in used]

    names = {'checked': 0, 'right': 0, 'wrong': 0, 'unnamed': 0}
    rows = []
    for i, r in enumerate(reference):
        if r.get('unreleased') or not r.get('artist'):
            continue
        lo = r['start']
        hi = reference[i + 1]['start'] if i + 1 < len(reference) else max(t['endSec'] for t in tracks)
        overlap = [(min(hi, t['endSec']) - max(lo, t['startSec']), t) for t in tracks]
        span, t = max(overlap, key=lambda o: o[0]) if overlap else (0, None)
        if t is None or span <= 0:
            continue
        names['checked'] += 1
        if not t.get('identified') or t.get('source') == 'unknown':
            names['unnamed'] += 1
            rows.append((r, t, 'not named'))
        elif pipeline._title_overlap(r['title'], t['title']) >= 0.5:
            names['right'] += 1
        else:
            names['wrong'] += 1
            rows.append((r, t, 'different song'))

    return {
        'changes': {'posted': len(reference) - 1, 'found': len(offsets), 'extra': len(extra),
                    'medianOffset': round(statistics.median(offsets), 1) if offsets else None},
        'names': names,
        'missedChanges': [{'start': r['start'], 'posted': f"{r['artist']} - {r['title']}"} for r in missed],
        'extraChanges': [{'start': round(a, 1), 'end': round(b, 1)} for a, b in extra],
        'nameProblems': [{'start': r['start'], 'posted': f"{r['artist']} - {r['title']}",
                          'engine': f"{t['artist']} - {t['title']}", 'kind': kind} for r, t, kind in rows],
    }


def reference_from(candidates: list[dict], duration: float) -> dict | None:
    best = tracklist.pick_best(candidates, duration)
    if not best or not best['timed'] or len(best['entries']) < 4 or tracklist.coverage(best['entries'], duration) < 0.5:
        return None
    entries = [{'start': e.start, 'artist': e.artist, 'title': e.title, 'unreleased': e.unreleased}
               for e in best['entries']]
    return {'sources': best['sources'], 'entries': entries}


async def evaluate_one(url: str, yt: YouTube, recognizer_kind: str, budget: float, comments_wait: float) -> dict:
    vid = video_id(url)
    if not vid:
        return {'url': url, 'error': 'not a YouTube link'}
    times: dict[str, float] = {}
    t0 = time.monotonic()
    comments_task = asyncio.create_task(yt.comments(vid))
    try:
        with tempfile.TemporaryDirectory(prefix='dj-eval-') as tmp:
            path, info = await yt.download(vid, Path(tmp))
            times['download'] = time.monotonic() - t0
            pcm = await asyncio.to_thread(dsp.decode, str(path))
            times['decode'] = time.monotonic() - t0 - times['download']
    except YouTubeError as e:
        comments_task.cancel()
        return {'url': url, 'videoId': vid, 'error': str(e)}

    recognizer = make_recognizer(recognizer_kind, audd_token=os.environ.get('AUDD_API_TOKEN', ''),
                                 concurrency=int(os.environ.get('SHAZAM_CONCURRENCY', '3')),
                                 proxy=os.environ.get('YTDLP_PROXY') or None)
    marks: dict[str, float] = {}

    def report(stage, progress, message, partial):
        marks.setdefault(stage, time.monotonic())

    t_an = time.monotonic()
    try:
        result = await pipeline.analyse(pcm, meta={'videoId': vid, 'title': info.title}, candidates=None,
                                        recognizer=recognizer, report=report, budget=budget)
    finally:
        if recognizer:
            await recognizer.close()
    t_end = time.monotonic()
    times['analysis'] = marks.get('identifying', t_end) - t_an
    times['recognition'] = marks.get('finishing', t_end) - marks.get('identifying', t_end)
    times['blends'] = t_end - marks.get('finishing', t_end)
    times['total'] = t_end - t0

    try:
        comments = await asyncio.wait_for(comments_task, timeout=comments_wait)
    except (asyncio.TimeoutError, Exception):
        comments = []
    ref = reference_from(info.candidates + comments, info.duration)
    tracks = result['tracks']
    out = {
        'url': url, 'videoId': vid, 'title': info.title, 'duration': info.duration,
        'times': {k: round(v, 1) for k, v in times.items()},
        'tracks': len(tracks), 'named': sum(1 for t in tracks if t['identified']),
        'recognitionRequests': result['stats']['recognitionRequests'],
        'reference': ref['sources'] if ref else None,
        'result': result,
    }
    if ref:
        out['score'] = compare(ref['entries'], tracks)
        out['postedTracks'] = len(ref['entries'])
    return out


def print_report(r: dict) -> None:
    print('=' * 78)
    if r.get('error'):
        print(f"{r['url']}\n  ERROR: {r['error']}")
        return
    t = r['times']
    print(f"{r['title']}  ({fmt(r['duration'])})  {r['url']}")
    print(f"  time: total {t['total']}s = download {t['download']}s + decode {t['decode']}s + analysis "
          f"{t['analysis']}s + recognition {t['recognition']}s + blends {t['blends']}s")
    print(f"  engine: {r['tracks']} tracks, {r['named']} named, {r['recognitionRequests']} recognition requests")
    if not r.get('score'):
        print('  no usable posted tracklist to check against')
    else:
        s = r['score']
        c, n = s['changes'], s['names']
        print(f"  answer key: {r['postedTracks']} tracks posted ({', '.join(r['reference'])})")
        print(f"  track changes: found {c['found']}/{c['posted']} within {WINDOW:.0f}s"
              f" (median offset {c['medianOffset']}s), {c['extra']} extra")
        print(f"  names: {n['right']}/{n['checked']} right, {n['wrong']} different song, {n['unnamed']} not named")
        for m in s['missedChanges'][:8]:
            print(f"    missed change  {fmt(m['start'])}  {m['posted']}")
        for p in s['nameProblems'][:10]:
            print(f"    {p['kind']:<15}{fmt(p['start'])}  posted: {p['posted']}  |  engine: {p['engine']}")
    print('  engine tracklist:')
    for tr in r['result']['tracks']:
        print(f"    {fmt(tr['startSec'])}-{fmt(tr['endSec'])}  {tr['bpm'] or '?':>6} BPM  {tr['camelot'] or '?':>3}  "
              f"{tr['artist']} - {tr['title']}")


async def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('urls', nargs='*')
    ap.add_argument('--file', help='text file with one YouTube link per line')
    ap.add_argument('--out', default='eval-results.json')
    ap.add_argument('--recognizer', default=os.environ.get('DJ_RECOGNIZER', 'auto'))
    ap.add_argument('--budget', type=float, default=float(os.environ.get('RECOGNITION_BUDGET_S', '35')))
    ap.add_argument('--pause', type=float, default=20.0, help='seconds between sets (eases rate limits)')
    ap.add_argument('--comments-wait', type=float, default=60.0)
    args = ap.parse_args(argv)
    urls = list(args.urls)
    if args.file:
        urls += [line.strip() for line in Path(args.file).read_text().splitlines() if line.strip() and not line.startswith('#')]
    if not urls:
        ap.error('give at least one YouTube link')
    yt = YouTube(api_key=os.environ.get('YT_API_KEY', ''), proxy=os.environ.get('YTDLP_PROXY', ''),
                 cookies=os.environ.get('YTDLP_COOKIES', ''), max_duration=float(os.environ.get('MAX_DURATION_MIN', '180')) * 60)
    results = []
    for i, url in enumerate(urls):
        if i:
            await asyncio.sleep(args.pause)
        r = await evaluate_one(url, yt, args.recognizer, args.budget, args.comments_wait)
        print_report(r)
        results.append(r)
        Path(args.out).write_text(json.dumps(results, indent=1))
    scored = [r['score'] for r in results if r.get('score')]
    if scored:
        found = sum(s['changes']['found'] for s in scored)
        posted = sum(s['changes']['posted'] for s in scored)
        right = sum(s['names']['right'] for s in scored)
        checked = sum(s['names']['checked'] for s in scored)
        print('=' * 78)
        print(f'OVERALL: track changes found {found}/{posted}, names right {right}/{checked}')
    print(f'full results: {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
