"""Song recognition for 12-second clips of a mix.

Two providers behind one interface:

* ShazamRecognizer: free, through the unofficial ShazamIO client. No key needed; Shazam
  limits how fast one IP can ask, so requests are spread over a few concurrent slots.
* AudDRecognizer: paid API (https://audd.io), faster and officially supported. Used when
  AUDD_API_TOKEN is set.

Both return a Match with the song and *where in the song* the clip was (offset), which is
what lets the pipeline work out when each song started in the mix.
"""
from __future__ import annotations

import asyncio
import logging
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from urllib.parse import quote, quote_plus

log = logging.getLogger(__name__)


@dataclass
class Match:
    title: str
    artist: str
    offset: float | None = None     # seconds into the song where the clip starts
    skew: float | None = None       # time skew: ~ how much the DJ sped up (+) or slowed down (-)
    provider: str = ''
    cover: str | None = None
    genre: str | None = None
    album: str | None = None
    label: str | None = None
    released: str | None = None
    isrc: str | None = None
    links: dict = field(default_factory=dict)

    @property
    def key(self) -> str:
        return song_key(self.artist, self.title)

    def to_dict(self) -> dict:
        return asdict(self)


def song_key(artist: str, title: str) -> str:
    """Loose identity for a song: lowercase, no accents, no brackets, no 'feat.'."""
    def norm(s: str) -> str:
        s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()
        s = re.sub(r'\(.*?\)|\[.*?\]', ' ', s)
        s = re.sub(r'\b(feat|ft|featuring)\b.*$', ' ', s)
        return re.sub(r'[^a-z0-9]+', ' ', s).strip()
    first_artist = re.split(r'\s*(?:,|&| x | and | vs\.? )\s*', norm(artist))[0] if artist else ''
    return f'{first_artist}|{norm(title)}'


def search_links(artist: str, title: str) -> dict:
    q = f'{artist} {title}'.strip()
    return {
        'spotify': 'https://open.spotify.com/search/' + quote(q),
        'apple': 'https://music.apple.com/us/search?term=' + quote_plus(q),
        'youtube': 'https://www.youtube.com/results?search_query=' + quote_plus(q),
        'ytmusic': 'https://music.youtube.com/search?q=' + quote_plus(q),
        'soundcloud': 'https://soundcloud.com/search?q=' + quote_plus(q),
        'beatport': 'https://www.beatport.com/search?q=' + quote_plus(q),
        'deezer': 'https://www.deezer.com/search/' + quote(q),
    }


class Recognizer:
    name = 'none'
    requests = 0

    async def identify(self, wav: bytes) -> Match | None:  # pragma: no cover - interface
        raise NotImplementedError

    async def close(self) -> None:
        pass


# --------------------------------------------------------------------------- Shazam

def parse_shazam(answer: dict) -> Match | None:
    matches = answer.get('matches') or []
    track = answer.get('track') or {}
    if not matches or not track.get('title'):
        return None
    m = matches[0]
    meta = {}
    for section in track.get('sections') or []:
        if section.get('type') == 'SONG':
            meta = {item.get('title'): item.get('text') for item in section.get('metadata') or []}
    links = search_links(track.get('subtitle', ''), track.get('title', ''))
    apple = (((track.get('hub') or {}).get('options') or [{}])[0].get('actions') or [{}])[0].get('uri')
    if apple and apple.startswith('http'):
        links['apple'] = apple.split('?')[0]
    for provider in (track.get('hub') or {}).get('providers') or []:
        uri = ((provider.get('actions') or [{}])[0]).get('uri', '')
        if provider.get('type') == 'SPOTIFY' and uri.startswith('spotify:search:'):
            links['spotify'] = 'https://open.spotify.com/search/' + quote(uri.split('spotify:search:', 1)[1])
    if track.get('key'):
        links['shazam'] = f"https://www.shazam.com/track/{track['key']}"
    images = track.get('images') or {}
    return Match(
        title=track.get('title', ''),
        artist=track.get('subtitle', ''),
        offset=float(m['offset']) if m.get('offset') is not None else None,
        skew=float(m['timeskew']) if m.get('timeskew') is not None else None,
        provider='shazam',
        cover=images.get('coverarthq') or images.get('coverart'),
        genre=(track.get('genres') or {}).get('primary'),
        album=meta.get('Album'),
        label=meta.get('Label'),
        released=meta.get('Released'),
        isrc=track.get('isrc'),
        links=links,
    )


class ShazamRecognizer(Recognizer):
    name = 'shazam'

    def __init__(self, concurrency: int = 3, proxy: str | None = None):
        from aiohttp_retry import ExponentialRetry
        from shazamio import HTTPClient, Shazam

        # Few retries: a slow answer is worse than "unknown" when we promise results in a minute.
        client = HTTPClient(retry_options=ExponentialRetry(attempts=3, start_timeout=1.0, max_timeout=6.0,
                                                           statuses={429, 500, 502, 503, 504}))
        self._shazam = Shazam(http_client=client)
        self._client = client
        self._sem = asyncio.Semaphore(concurrency)
        self._proxy = proxy
        self.requests = 0

    async def identify(self, wav: bytes) -> Match | None:
        async with self._sem:
            self.requests += 1
            try:
                answer = await asyncio.wait_for(self._shazam.recognize(wav, proxy=self._proxy), timeout=20)
            except Exception as e:  # network, 429 after retries, bad signature
                log.warning('shazam failed: %s', e)
                return None
        return parse_shazam(answer)

    async def close(self) -> None:
        await self._client.close()


# --------------------------------------------------------------------------- AudD

def _timecode(tc: str | None) -> float | None:
    if not tc:
        return None
    parts = [float(p) for p in tc.split(':')]
    total = 0.0
    for p in parts:
        total = total * 60 + p
    return total


def parse_audd(answer: dict) -> Match | None:
    r = answer.get('result') if answer.get('status') == 'success' else None
    if not r or not r.get('title'):
        return None
    links = search_links(r.get('artist', ''), r.get('title', ''))
    if (r.get('apple_music') or {}).get('url'):
        links['apple'] = r['apple_music']['url']
    if ((r.get('spotify') or {}).get('external_urls') or {}).get('spotify'):
        links['spotify'] = r['spotify']['external_urls']['spotify']
    if (r.get('deezer') or {}).get('link'):
        links['deezer'] = r['deezer']['link']
    if r.get('song_link'):
        links['songlink'] = r['song_link']
    cover = None
    art = (r.get('apple_music') or {}).get('artwork') or {}
    if art.get('url'):
        cover = art['url'].replace('{w}', '400').replace('{h}', '400')
    elif ((r.get('deezer') or {}).get('album') or {}).get('cover_big'):
        cover = r['deezer']['album']['cover_big']
    genre = ((r.get('apple_music') or {}).get('genreNames') or [None])[0]
    return Match(
        title=r.get('title', ''), artist=r.get('artist', ''), offset=_timecode(r.get('timecode')),
        provider='audd', cover=cover, genre=genre, album=r.get('album'), label=r.get('label'),
        released=r.get('release_date'), isrc=(r.get('apple_music') or {}).get('isrc'), links=links,
    )


class AudDRecognizer(Recognizer):
    name = 'audd'

    def __init__(self, token: str, concurrency: int = 8):
        import httpx
        self._token = token
        self._http = httpx.AsyncClient(timeout=20)
        self._sem = asyncio.Semaphore(concurrency)
        self.requests = 0

    async def identify(self, wav: bytes) -> Match | None:
        async with self._sem:
            self.requests += 1
            try:
                res = await self._http.post(
                    'https://api.audd.io/',
                    data={'api_token': self._token, 'return': 'apple_music,spotify,deezer'},
                    files={'file': ('clip.wav', wav, 'audio/wav')},
                )
                return parse_audd(res.json())
            except Exception as e:
                log.warning('audd failed: %s', e)
                return None

    async def close(self) -> None:
        await self._http.aclose()


def make_recognizer(kind: str, *, audd_token: str = '', concurrency: int = 3, proxy: str | None = None) -> Recognizer | None:
    if kind == 'audd' or (kind == 'auto' and audd_token):
        if not audd_token:
            raise ValueError('AUDD_API_TOKEN is required for the AudD recognizer')
        return AudDRecognizer(audd_token)
    if kind in ('shazam', 'auto'):
        return ShazamRecognizer(concurrency=concurrency, proxy=proxy)
    return None
