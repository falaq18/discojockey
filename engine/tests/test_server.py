import json
import subprocess
import time
from pathlib import Path

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from discojockey_engine import dsp, recommend, server
from discojockey_engine.youtube import VideoInfo
from fakes import FakeRecognizer
from synth import make_mix, make_song

SPECS = [
    dict(bpm=124, tonic=7, minor=True, seconds=120, seed=1, style=0),
    dict(bpm=126, tonic=5, minor=False, seconds=130, seed=2, style=1),
    dict(bpm=128, tonic=9, minor=True, seconds=120, seed=3, style=2),
]
SONGS = [('Bicep', 'Glue'), ('Four Tet', 'Baby'), ('Overmono', 'So U Kno')]


@pytest.fixture()
def client(tmp_path, monkeypatch):
    pcm, truth = make_mix(SPECS, [24, 30])
    wav = tmp_path / 'mix.wav'
    wav.write_bytes(dsp.wav_bytes(pcm))

    async def fake_download(vid, folder):
        return wav, VideoInfo(vid, 'Test Set @ Somewhere', 'Test DJ', len(pcm) / dsp.SR,
                              [{'source': 'video description', 'text': 'Thanks for listening!'}])

    async def fake_comments(vid):
        return [{'source': 'comment by @fan', 'text': 'what a set'}]

    async def fake_search(queries, concurrency=6):
        return [f'id{i:09d}' for i in range(len(queries))]

    monkeypatch.setattr(server.youtube, 'download', fake_download)
    monkeypatch.setattr(server.youtube, 'comments', fake_comments)
    monkeypatch.setattr(server.youtube, 'search_ids', fake_search)
    monkeypatch.setattr(server, 'make_recognizer', lambda *a, **k: FakeRecognizer(pcm, truth, SONGS))
    monkeypatch.setattr(server.settings, 'cache_dir', tmp_path / 'cache')
    with TestClient(server.app) as c:
        yield c


def wait(client, job_id, timeout=120):
    seen = []
    end = time.time() + timeout
    while time.time() < end:
        job = client.get(f'/api/jobs/{job_id}').json()
        seen.append(job['stage'])
        if job['status'] in ('done', 'error'):
            return job, seen
        time.sleep(0.2)
    raise AssertionError('job did not finish')


def test_analyze_youtube_link(client):
    res = client.post('/api/analyze', json={'url': 'https://youtu.be/abcdefghijk?si=x'})
    assert res.status_code == 200
    job, stages = wait(client, res.json()['job'])
    assert job['status'] == 'done', job['error']
    result = job['result']
    assert result['videoId'] == 'abcdefghijk'
    assert result['title'] == 'Test Set @ Somewhere'
    assert [t['title'] for t in result['tracks']] == ['Glue', 'Baby', 'So U Kno']
    assert len(result['transitions']) == 2
    # A second request is served from the cache straight away.
    again = client.post('/api/analyze', json={'url': 'abcdefghijk'}).json()
    assert again['cached'] is True
    assert client.get(f"/api/jobs/{again['job']}").json()['result']['tracks'] == result['tracks']


def test_rejects_non_youtube_text(client):
    assert client.post('/api/analyze', json={'url': 'hello'}).status_code == 400


def test_upload_file(client, tmp_path):
    pcm, _ = make_mix(SPECS, [24, 30])
    data = dsp.wav_bytes(pcm)
    res = client.post('/api/analyze-file', files={'file': ('my mix.wav', data, 'audio/wav')}, data={'title': 'Bedroom mix'})
    job, _ = wait(client, res.json()['job'])
    assert job['status'] == 'done', job['error']
    assert job['result']['title'] == 'Bedroom mix'
    assert len(job['result']['tracks']) == 3


def test_youtube_playlist(client):
    res = client.post('/api/youtube-playlist', json={'tracks': [{'artist': 'Bicep', 'title': 'Glue'}, {'artist': 'X', 'title': 'Y'}]})
    body = res.json()
    assert body['ids'] == ['id000000000', 'id000000001']
    assert body['url'] == 'https://www.youtube.com/watch_videos?video_ids=id000000000,id000000001'


def test_health(client):
    assert client.get('/api/health').json()['ok'] is True


def test_rate_limit(client, monkeypatch):
    monkeypatch.setattr(server.settings, 'per_ip_hour', 2)
    server.HITS.clear()
    codes = [client.post('/api/analyze', json={'url': f'https://youtu.be/{i:011d}'}).status_code for i in range(3)]
    assert codes[:2] == [200, 200] and codes[2] == 429
    server.HITS.clear()


def test_upload_too_big(client, monkeypatch):
    monkeypatch.setattr(server.settings, 'max_upload_mb', 0.001)
    res = client.post('/api/analyze-file', files={'file': ('big.wav', b'0' * 5000, 'audio/wav')})
    assert res.status_code == 413


# ----------------------------------------------------------------------------- recommendations

def mp3_of(seconds, bpm, tonic, minor, seed):
    song = make_song(bpm, tonic, minor, seconds, seed)
    proc = subprocess.run(['ffmpeg', '-v', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0',
                           '-f', 'mp3', 'pipe:1'], input=(song * 32767).astype(np.int16).tobytes(),
                          stdout=subprocess.PIPE, check=True)
    return proc.stdout


def test_next_tracks_measures_previews(monkeypatch):
    previews = {
        'p1': mp3_of(30, 124, 7, True, 11),   # 6A at 124: perfect after a 6A/124 seed
        'p2': mp3_of(30, 140, 1, False, 12),  # 3B at 140: poor fit
        'p3': mp3_of(30, 125, 2, True, 13),   # 7A at 125: adjacent key, near tempo
    }

    def handler(request: httpx.Request):
        p = request.url.path
        if request.url.host == 'cdn.test':
            return httpx.Response(200, content=previews[p.strip('/')])
        if p == '/search':
            return httpx.Response(200, json={'data': [{'id': 1, 'title': 'Glue', 'artist': {'id': 10, 'name': 'Bicep'}}]})
        if p == '/artist/10/related':
            return httpx.Response(200, json={'data': [{'id': 20, 'name': 'Overmono'}, {'id': 30, 'name': 'Ross From Friends'}]})
        tops = {
            '/artist/10/top': [{'id': 101, 'title': 'Glue', 'artist': {'name': 'Bicep'}, 'preview': 'https://cdn.test/p1'},
                               {'id': 102, 'title': 'Atlas', 'artist': {'name': 'Bicep'}, 'preview': 'https://cdn.test/p1'}],
            '/artist/20/top': [{'id': 201, 'title': 'So U Kno', 'artist': {'name': 'Overmono'}, 'preview': 'https://cdn.test/p3'}],
            '/artist/30/top': [{'id': 301, 'title': 'Talk To Me You\'ll Understand', 'artist': {'name': 'Ross From Friends'}, 'preview': 'https://cdn.test/p2'}],
        }
        return httpx.Response(200, json={'data': tops.get(p, [])})

    real = httpx.AsyncClient
    monkeypatch.setattr(recommend.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    recommend._preview_cache.clear()

    import asyncio
    out = asyncio.run(recommend.next_tracks('Bicep', 'Glue', 124.0, '6A', limit=5))
    titles = [t['title'] for t in out['tracks']]
    assert 'Glue' not in titles                       # never suggest the seed itself
    assert titles[0] == 'Atlas'                        # same key, same tempo
    assert titles[-1] == "Talk To Me You'll Understand"  # wrong key and tempo ranks last
    atlas = out['tracks'][0]
    assert atlas['bpm'] == pytest.approx(124, abs=0.6) and atlas['camelot'] == '6A'
    assert atlas['matchPercent'] > out['tracks'][-1]['matchPercent']
