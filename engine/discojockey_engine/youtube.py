"""YouTube access: video info, tracklist candidates (description, chapters, comments),
audio download and video search. yt-dlp does the heavy lifting; the YouTube Data API is
used for comments when a key is configured, because it is faster and never bot-checked.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

ID_RE = re.compile(r'(?:[?&]v=|youtu\.be/|embed/|shorts/|live/)([\w-]{11})')


def video_id(text: str) -> str | None:
    text = (text or '').strip()
    if re.fullmatch(r'[\w-]{11}', text):
        return text
    m = ID_RE.search(text)
    return m.group(1) if m else None


@dataclass
class VideoInfo:
    video_id: str
    title: str = ''
    channel: str = ''
    duration: float = 0.0
    candidates: list[dict] = field(default_factory=list)  # [{'source', 'text'}] for the tracklist finder


class YouTubeError(RuntimeError):
    """A problem the user should hear about (private video, bot check, too long...)."""


def _friendly(err: Exception) -> str:
    msg = str(err)
    if 'Sign in to confirm' in msg or 'not a bot' in msg:
        return ('YouTube blocked the server ("confirm you are not a bot"). Datacenter IPs get this; '
                'set YTDLP_PROXY to a residential proxy or YTDLP_COOKIES to a cookies file.')
    if 'Private video' in msg or 'Video unavailable' in msg:
        return 'That video is private or unavailable.'
    if 'age' in msg.lower() and 'confirm' in msg.lower():
        return 'That video is age-restricted; YouTube needs a signed-in session to play it.'
    return re.sub(r'\x1b\[[0-9;]*m', '', msg)[-300:]


class YouTube:
    def __init__(self, *, api_key: str = '', proxy: str = '', cookies: str = '', max_duration: float = 3 * 3600):
        self.api_key = api_key
        self.proxy = proxy
        self.cookies = cookies
        self.max_duration = max_duration

    # ------------------------------------------------------------------ yt-dlp

    def _opts(self, **extra) -> dict:
        opts = {
            'quiet': True,
            'no_warnings': True,
            'noprogress': True,
            'noplaylist': True,
            'socket_timeout': 20,
            'retries': 3,
            # YouTube's player needs a JavaScript runtime; node is in the Docker image.
            'js_runtimes': {name: {} for name in os.environ.get('YTDLP_JS_RUNTIMES', 'node,deno').split(',') if name},
        }
        if self.proxy:
            opts['proxy'] = self.proxy
        if self.cookies:
            opts['cookiefile'] = self.cookies
        opts.update(extra)
        return opts

    def _extract(self, url: str, **extra) -> dict:
        import yt_dlp
        with yt_dlp.YoutubeDL(self._opts(**extra)) as ydl:
            return ydl.extract_info(url, download=not extra.get('skip_download', True))

    def _info_from(self, vid: str, data: dict) -> VideoInfo:
        info = VideoInfo(vid, data.get('title') or '', data.get('channel') or data.get('uploader') or '',
                         float(data.get('duration') or 0))
        if data.get('description'):
            info.candidates.append({'source': 'video description', 'text': data['description']})
        chapters = data.get('chapters') or []
        if len(chapters) >= 3:
            text = '\n'.join(f"{int(c['start_time'] // 60)}:{int(c['start_time'] % 60):02d} {c.get('title', '')}" for c in chapters)
            info.candidates.append({'source': 'video chapters', 'text': text})
        return info

    async def comments(self, vid: str) -> list[dict]:
        """Top comments and replies: where viewers post tracklists. Empty list on any failure."""
        if self.api_key:
            try:
                return await self._api_comments(vid)
            except Exception as e:
                log.warning('comment fetch via API failed: %s', e)
        try:
            data = await asyncio.to_thread(
                self._extract, f'https://www.youtube.com/watch?v={vid}', skip_download=True, getcomments=True,
                extractor_args={'youtube': {'max_comments': ['150', '150', '20', '5'], 'comment_sort': ['top']}},
            )
        except Exception as e:
            log.warning('comment fetch via yt-dlp failed: %s', e)
            return []
        return [{'source': 'comment by ' + (c.get('author') or 'a viewer'), 'text': c.get('text') or ''}
                for c in data.get('comments') or []]

    async def _api_comments(self, vid: str, pages: int = 2) -> list[dict]:
        out, token = [], None
        async with httpx.AsyncClient(timeout=15) as http:
            for _ in range(pages):
                params = {'key': self.api_key, 'videoId': vid, 'part': 'snippet,replies', 'order': 'relevance',
                          'maxResults': 100, 'textFormat': 'plainText'}
                if token:
                    params['pageToken'] = token
                res = await http.get('https://www.googleapis.com/youtube/v3/commentThreads', params=params)
                if res.status_code != 200:
                    break
                data = res.json()
                for th in data.get('items', []):
                    top = th['snippet']['topLevelComment']['snippet']
                    out.append({'source': 'comment by ' + top.get('authorDisplayName', 'a viewer'), 'text': top.get('textOriginal', '')})
                    for r in (th.get('replies') or {}).get('comments', []):
                        out.append({'source': 'reply by ' + r['snippet'].get('authorDisplayName', 'a viewer'),
                                    'text': r['snippet'].get('textOriginal', '')})
                token = data.get('nextPageToken')
                if not token:
                    break
        return out

    async def download(self, vid: str, folder: Path) -> tuple[Path, VideoInfo]:
        """Smallest audio-only stream (about 20 MB per hour) plus the video's title, description
        and chapters, all from one request to YouTube."""
        folder.mkdir(parents=True, exist_ok=True)
        url = f'https://www.youtube.com/watch?v={vid}'
        try:
            data = await asyncio.to_thread(
                self._extract, url, skip_download=False,
                format='249/139/250/600/140/251/bestaudio/best',
                outtmpl=str(folder / '%(id)s.%(ext)s'),
                concurrent_fragment_downloads=4,
                http_chunk_size=10 * 1024 * 1024,
                match_filter=self._too_long,
            )
        except Exception as e:
            raise YouTubeError(_friendly(e)) from e
        if data is None or (data.get('duration') and data['duration'] > self.max_duration):
            raise YouTubeError(f'That video is longer than {self.max_duration / 3600:.0f} h, the limit for this engine.')
        info = self._info_from(vid, data)
        for req in data.get('requested_downloads') or []:
            if req.get('filepath') and Path(req['filepath']).exists():
                return Path(req['filepath']), info
        files = sorted(folder.glob(f'{vid}.*'))
        if not files:
            raise YouTubeError('The download finished but no audio file was written.')
        return files[0], info

    def _too_long(self, info, *, incomplete=False):
        d = info.get('duration')
        if d and d > self.max_duration:
            return f'video is longer than {self.max_duration / 3600:.0f} h'
        return None

    async def search_ids(self, queries: list[str], concurrency: int = 6) -> list[str | None]:
        """First YouTube result for each query (for one-click playlists)."""
        sem = asyncio.Semaphore(concurrency)

        async def one(q: str) -> str | None:
            async with sem:
                try:
                    data = await asyncio.to_thread(self._extract, f'ytsearch1:{q}', skip_download=True, extract_flat=True)
                except Exception as e:
                    log.warning('search failed for %r: %s', q, e)
                    return None
                entries = data.get('entries') or []
                return entries[0].get('id') if entries else None

        return await asyncio.gather(*(one(q) for q in queries))


def playlist_url(ids: list[str | None]) -> str | None:
    """YouTube makes an untitled playlist from up to 50 ids, no login needed."""
    ids = [i for i in ids if i][:50]
    return 'https://www.youtube.com/watch_videos?video_ids=' + ','.join(ids) if ids else None
