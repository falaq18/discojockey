"""HTTP API for the discojockey site.

POST /api/analyze        {"url": "<youtube link>"}         -> {"job": "<id>"}
POST /api/analyze-file   multipart "file" (+ "title")       -> {"job": "<id>"}
GET  /api/jobs/<id>                                          -> status, progress, partial/final set
GET  /api/next?artist=&title=&bpm=&camelot=                  -> tracks that mix well after it
POST /api/youtube-playlist {"tracks": [{"artist","title"}]}  -> video ids + a no-login playlist link
GET  /api/health
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import dsp, pipeline, recommend
from .recognize import make_recognizer
from .youtube import YouTube, YouTubeError, playlist_url, video_id

log = logging.getLogger('discojockey')
logging.basicConfig(level=os.environ.get('LOG_LEVEL', 'INFO'))

VERSION = '1.0.0'


class Settings:
    def __init__(self):
        env = os.environ.get
        self.recognizer = env('DJ_RECOGNIZER', 'auto')          # auto | shazam | audd | none
        self.audd_token = env('AUDD_API_TOKEN', '')
        self.shazam_concurrency = int(env('SHAZAM_CONCURRENCY', '3'))
        self.yt_api_key = env('YT_API_KEY', '')
        self.proxy = env('YTDLP_PROXY', '')
        self.cookies = env('YTDLP_COOKIES', '')
        self.max_minutes = float(env('MAX_DURATION_MIN', '180'))
        self.budget = float(env('RECOGNITION_BUDGET_S', '35'))
        self.max_jobs = int(env('MAX_JOBS', '2'))
        self.cache_dir = Path(env('CACHE_DIR', './cache'))
        self.max_upload_mb = float(env('MAX_UPLOAD_MB', '300'))
        self.max_queue = int(env('MAX_QUEUE', '8'))
        self.per_ip_hour = int(env('ANALYSES_PER_IP_PER_HOUR', '20'))
        self.comments_wait = float(env('COMMENTS_WAIT_S', '8'))
        self.origins = [o.strip() for o in env('ALLOWED_ORIGINS', '*').split(',') if o.strip()]


settings = Settings()
app = FastAPI(title='discojockey engine', version=VERSION)
app.add_middleware(CORSMiddleware, allow_origins=settings.origins, allow_methods=['*'], allow_headers=['*'])

JOBS: dict[str, dict] = {}
HITS: dict[str, list[float]] = {}     # client ip -> recent request times, for rate limiting
RUNNING: dict[str, str] = {}          # video id -> job id, so two people asking share one job
SLOTS = asyncio.Semaphore(settings.max_jobs)
youtube = YouTube(api_key=settings.yt_api_key, proxy=settings.proxy, cookies=settings.cookies,
                  max_duration=settings.max_minutes * 60)


def _limit(request: Request, bucket: str = 'analyze', per_hour: int | None = None, check_queue: bool = True):
    """Small per-IP budget so one visitor cannot hog a shared engine."""
    ip = (request.headers.get('x-forwarded-for') or (request.client.host if request.client else '?')).split(',')[0].strip()
    key = f'{bucket}:{ip}'
    now = time.time()
    recent = [t for t in HITS.get(key, []) if now - t < 3600]
    if len(recent) >= (per_hour or settings.per_ip_hour):
        raise HTTPException(429, 'Too many requests from your connection this hour. Try again later.')
    HITS[key] = recent + [now]
    if check_queue and sum(1 for j in JOBS.values() if j['status'] in ('queued', 'running')) >= settings.max_queue:
        raise HTTPException(503, 'The engine is busy with other sets right now. Try again in a minute.')


def _cache_path(vid: str) -> Path:
    return settings.cache_dir / f'{vid}.json'


def _new_job(kind: str, ref: str = '') -> dict:
    job = {'id': uuid.uuid4().hex[:12], 'kind': kind, 'ref': ref, 'status': 'queued', 'stage': 'queued',
           'progress': 0.0, 'message': 'Waiting for a free slot…', 'result': None, 'version': 0, 'error': None,
           'created': time.time(), 'updated': time.time()}
    JOBS[job['id']] = job
    _prune()
    return job


def _prune():
    cutoff = time.time() - 3600
    for jid in [j for j, v in JOBS.items() if v['updated'] < cutoff and v['status'] in ('done', 'error')]:
        JOBS.pop(jid, None)


def _reporter(job: dict):
    def report(stage: str, progress: float, message: str, partial: dict | None):
        job.update(stage=stage, progress=round(progress, 2), message=message, updated=time.time(), status='running')
        if partial is not None:
            job['result'] = partial
            job['version'] += 1
    return report


async def _run(job: dict, work):
    recognizer = None
    try:
        async with SLOTS:
            job.update(status='running', updated=time.time())
            recognizer = make_recognizer(settings.recognizer, audd_token=settings.audd_token,
                                         concurrency=settings.shazam_concurrency, proxy=settings.proxy or None)
            result = await work(recognizer)
        job.update(status='done', stage='done', progress=1.0, message='Done', result=result,
                   version=job['version'] + 1, updated=time.time())
    except YouTubeError as e:
        job.update(status='error', error=str(e), message=str(e), updated=time.time())
    except Exception as e:  # keep the server up, tell the page what broke
        log.exception('job %s failed', job['id'])
        job.update(status='error', error=f'Analysis failed: {e}', message=str(e), updated=time.time())
    finally:
        if recognizer:
            await recognizer.close()
        if job['kind'] == 'youtube':
            RUNNING.pop(job['ref'], None)


class AnalyzeBody(BaseModel):
    url: str
    refresh: bool = False


@app.post('/api/analyze')
async def analyze(body: AnalyzeBody, request: Request):
    vid = video_id(body.url)
    if not vid:
        raise HTTPException(400, 'That does not look like a YouTube link.')
    cached = _cache_path(vid)
    if cached.exists() and not body.refresh:
        job = _new_job('youtube', vid)
        job.update(status='done', stage='done', progress=1.0, message='Loaded from cache', version=1,
                   result=json.loads(cached.read_text()))
        return {'job': job['id'], 'cached': True}
    if vid in RUNNING and RUNNING[vid] in JOBS:
        return {'job': RUNNING[vid], 'cached': False}
    _limit(request)
    job = _new_job('youtube', vid)
    RUNNING[vid] = job['id']

    async def work(recognizer):
        report = _reporter(job)
        report('fetching', 0.05, 'Downloading the audio and reading the comments…', None)
        comments = asyncio.create_task(youtube.comments(vid))
        try:
            with tempfile.TemporaryDirectory(prefix='dj-') as tmp:
                audio_path, info = await youtube.download(vid, Path(tmp))
                report('decoding', 0.35, 'Audio downloaded. Decoding…', None)
                pcm = await asyncio.to_thread(dsp.decode, str(audio_path))
            # Comments only help when someone posted a tracklist; never wait long for them.
            try:
                info.candidates += await asyncio.wait_for(asyncio.shield(comments), timeout=settings.comments_wait)
            except asyncio.TimeoutError:
                log.info('comments for %s still loading; going on without them', vid)
        finally:
            if not comments.done():
                comments.cancel()
        meta = {'id': vid, 'videoId': vid, 'title': info.title, 'dj': info.channel, 'venue': 'YouTube',
                'sourceUrl': f'https://www.youtube.com/watch?v={vid}'}
        result = await pipeline.analyse(pcm, meta=meta, candidates=info.candidates, recognizer=recognizer,
                                        report=report, budget=settings.budget)
        settings.cache_dir.mkdir(parents=True, exist_ok=True)
        _cache_path(vid).write_text(json.dumps(result))
        return result

    asyncio.create_task(_run(job, work))
    return {'job': job['id'], 'cached': False}


@app.post('/api/analyze-file')
async def analyze_file(request: Request, file: UploadFile = File(...), title: str = Form('')):
    _limit(request)
    tmpdir = Path(tempfile.mkdtemp(prefix='dj-up-'))
    path = tmpdir / (Path(file.filename or 'mix').name or 'mix')
    limit = settings.max_upload_mb * 1024 * 1024
    size = 0
    with path.open('wb') as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                shutil.rmtree(tmpdir, ignore_errors=True)
                raise HTTPException(413, f'That file is bigger than {settings.max_upload_mb:.0f} MB.')
            out.write(chunk)
    job = _new_job('file', path.name)

    async def work(recognizer):
        try:
            report = _reporter(job)
            report('decoding', 0.2, 'Decoding your file…', None)
            pcm = await asyncio.to_thread(dsp.decode, str(path))
            if len(pcm) > settings.max_minutes * 60 * dsp.SR:
                raise YouTubeError(f'That file is longer than {settings.max_minutes:.0f} minutes.')
            meta = {'id': 'upload-' + job['id'], 'videoId': '', 'title': title or Path(path.name).stem,
                    'dj': 'Uploaded mix', 'venue': 'Your file', 'sourceUrl': ''}
            return await pipeline.analyse(pcm, meta=meta, recognizer=recognizer, report=report, budget=settings.budget)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    asyncio.create_task(_run(job, work))
    return {'job': job['id']}


@app.get('/api/jobs/{job_id}')
async def job_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, 'Unknown job (the server may have restarted). Start the analysis again.')
    return job


@app.get('/api/next')
async def next_tracks(request: Request, artist: str, title: str, bpm: float | None = None, camelot: str = '',
                      limit: int = 12, exclude: str = ''):
    _limit(request, bucket='next', per_hour=120, check_queue=False)
    try:
        return await recommend.next_tracks(artist, title, bpm, camelot, limit=min(limit, 24),
                                           exclude=[e for e in exclude.split(';;') if e])
    except Exception as e:
        log.warning('recommendations failed: %s', e)
        raise HTTPException(502, f'Could not reach the music catalogue: {e}')


class PlaylistBody(BaseModel):
    tracks: list[dict]


@app.post('/api/youtube-playlist')
async def youtube_playlist(body: PlaylistBody, request: Request):
    _limit(request, bucket='playlist', per_hour=30, check_queue=False)
    queries = [f"{t.get('artist', '')} {t.get('title', '')}".strip() for t in body.tracks[:50]]
    ids = await youtube.search_ids(queries)
    return {'ids': ids, 'url': playlist_url(ids)}


@app.get('/api/health')
async def health():
    return {'ok': True, 'version': VERSION,
            'recognizer': 'audd' if (settings.recognizer in ('auto', 'audd') and settings.audd_token) else
                          ('none' if settings.recognizer == 'none' else 'shazam'),
            'youtubeApiKey': bool(settings.yt_api_key), 'proxy': bool(settings.proxy),
            'jobs': sum(1 for j in JOBS.values() if j['status'] in ('queued', 'running'))}
