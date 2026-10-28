"""Find and parse timestamped tracklists in YouTube descriptions, chapters and comments.

A Python port of the site's parser.js, so the engine can use a posted tracklist (names
from people who know the music) and the audio analysis together.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass, field

TS_RE = re.compile(r'(?<![\d:])(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)(?![\d:])')
BLEND_RE = re.compile(r'^\s*(?:w/|with\s|\+\s|&\s|x\s|vs\.?\s|over\s)', re.I)
NUMBERED_RE = re.compile(r'^\s*#?\d{1,3}\s*[.)\]:]\s+\S')
EMOJI_RE = re.compile('[\U0001F000-\U0001FAFF☀-➿️‍]')
SEPARATORS = [' - ', ' – ', ' — ', ' -- ', ' ~ ', ' | ']
ID_RE = re.compile(r'^(id|unknown|\?+)$', re.I)


@dataclass
class Entry:
    start: float | None
    artist: str
    title: str
    label: str = ''
    unreleased: bool = False
    has_separator: bool = True
    blends: list[dict] = field(default_factory=list)


def normalize_text(text: str) -> str:
    text = re.sub(r'<br\s*/?>', '\n', text or '', flags=re.I)
    text = re.sub(r'<[^>]+>', '', text)
    return html.unescape(text).replace('\r\n', '\n').replace('\r', '\n')


def clean_label(label: str) -> str:
    s = EMOJI_RE.sub(' ', label)
    s = re.sub(r'[\[({]\s*[\])}]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'^(?:#?\d{1,3}\s*[.)\]:]\s+|#\d{1,3}\s+|\d{1,3}\s+-\s+(?=\S+\s+-\s))', '', s)
    s = re.sub(r'^[\s\-–—|:•·*>~.]+', '', s)
    s = re.sub(r'[\s\-–—|:•·*~]+$', '', s)
    return s.strip()


def split_artist_title(label: str) -> tuple[str, str, bool]:
    norm = re.sub(r'\s+[-–—]{1,2}\s+', lambda m: ' ' + m.group(0).strip() + ' ', label)
    best, sep_len = -1, 0
    for sep in SEPARATORS:
        i = norm.find(sep)
        if i > 0 and (best == -1 or i < best):
            best, sep_len = i, len(sep)
    if best > 0:
        return norm[:best].strip(), norm[best + sep_len:].strip(), True
    m = re.match(r'^(.+?)\s+by\s+(.+)$', norm, re.I)
    if m:
        return m.group(2).strip(), m.group(1).strip(), True
    return '', norm.strip(), False


def split_label(title: str) -> tuple[str, str]:
    m = re.match(r'^(.*?)\s*[\[{]([^\]}]{2,40})[\]}]\s*$', title)
    if m and m.group(1):
        return m.group(1).strip(), m.group(2).strip()
    return title, ''


def make_entry(label: str, start: float | None) -> Entry:
    artist, raw_title, has_sep = split_artist_title(label)
    title, rec_label = split_label(raw_title)
    title = title or raw_title
    unreleased = bool(ID_RE.match(title.strip())) or (bool(ID_RE.match(artist.strip())) and bool(ID_RE.match(title.strip())))
    return Entry(start, artist, title, rec_label, unreleased, has_sep)


def parse(text: str, duration: float | None = None) -> tuple[list[Entry], bool, float]:
    """Parse one block of text. Returns (entries, timed, score)."""
    timed: list[Entry] = []
    untimed: list[Entry] = []
    for raw in normalize_text(text).split('\n'):
        line = raw.strip()
        if not line:
            continue
        m = TS_RE.search(line)
        if m:
            h, mi, se = m.groups()
            start = (int(h) * 3600 if h else 0) + int(mi) * 60 + int(se)
            label = clean_label(re.sub(r'\s[-–—]\s(?=\s*[-–—]?\s)', ' ', TS_RE.sub(' ', line), count=1))
            if len(label) < 2 or (duration and start > duration + 5):
                continue
            timed.append(make_entry(label, float(start)))
            continue
        if BLEND_RE.match(line):
            target = timed[-1] if timed else (untimed[-1] if untimed else None)
            blend = clean_label(BLEND_RE.sub('', line, count=1))
            if target and blend:
                a, t, _ = split_artist_title(blend)
                target.blends.append({'artist': a, 'title': t})
            continue
        if NUMBERED_RE.match(line):
            e = make_entry(clean_label(line), None)
            if e.has_separator:
                untimed.append(e)

    if len(timed) >= 3 or (len(timed) >= 2 and len(timed) >= len(untimed)):
        ordered = sorted(timed, key=lambda e: e.start)
        deduped: list[Entry] = []
        for e in ordered:
            if deduped and deduped[-1].start == e.start and deduped[-1].title.lower() == e.title.lower():
                continue
            deduped.append(e)
        return deduped, True, _score(deduped, timed, duration)
    if len(untimed) >= 3:
        return untimed, False, len(untimed) * 0.5
    return [], False, 0.0


def _score(entries: list[Entry], source_order: list[Entry], duration: float | None) -> float:
    if not entries:
        return 0.0
    with_sep = sum(1 for e in entries if e.has_separator)
    inversions = sum(1 for a, b in zip(source_order, source_order[1:]) if b.start < a.start)
    score = with_sep + (len(entries) - with_sep) * 0.35 - inversions * 0.75
    if entries[0].start <= 120:
        score += 1
    if duration:
        score += min(1.0, entries[-1].start / duration) * 2
    return score


def pick_best(candidates: list[dict], duration: float | None = None) -> dict | None:
    """Best tracklist among [{'source', 'text'}], stitching a list split over several comments."""
    parsed = []
    for i, c in enumerate(candidates):
        entries, timed, score = parse(c.get('text', ''), duration)
        if len(entries) >= 2:
            parsed.append({'source': c.get('source') or f'text #{i + 1}', 'entries': entries, 'timed': timed, 'score': score})
    if not parsed:
        return None
    parsed.sort(key=lambda p: (p['timed'], p['score']), reverse=True)
    best = parsed[0]
    result = {'entries': list(best['entries']), 'timed': best['timed'], 'sources': [best['source']]}
    if best['timed']:
        for p in parsed[1:]:
            if not p['timed']:
                continue
            last = result['entries'][-1].start
            cont = [e for e in p['entries'] if e.start > last + 30]
            if len(cont) >= 2 and len(cont) >= 0.8 * len(p['entries']):
                result['entries'].extend(cont)
                result['sources'].append(p['source'])
    return result


def coverage(entries: list[Entry], duration: float) -> float:
    """Fraction of the mix the timed entries span."""
    times = [e.start for e in entries if e.start is not None]
    if len(times) < 2 or not duration:
        return 0.0
    return min(1.0, (max(times) - min(times) + duration / max(1, len(times))) / duration)
