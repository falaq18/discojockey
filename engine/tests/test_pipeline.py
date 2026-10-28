import asyncio

import pytest

from discojockey_engine import dsp, pipeline
from discojockey_engine.recognize import Match
from fakes import FakeRecognizer
from synth import make_mix

SPECS = [
    dict(bpm=124, tonic=7, minor=True, seconds=150, seed=1, style=0),
    dict(bpm=126, tonic=5, minor=False, seconds=170, seed=2, style=1),
    dict(bpm=128, tonic=9, minor=True, seconds=160, seed=3, style=2),
    dict(bpm=122, tonic=0, minor=True, seconds=140, seed=4, style=3),
    dict(bpm=130, tonic=2, minor=False, seconds=150, seed=5, style=0),
]
BLENDS = [30, 45, 16, 24]
SONGS = [('Bicep', 'Glue'), ('Four Tet', 'Baby'), ('Overmono', 'So U Kno'), None, ('Fred again..', 'Delilah')]


@pytest.fixture(scope='module')
def mix():
    return make_mix(SPECS, BLENDS, bass_swap=True)


def run(coro):
    return asyncio.run(coro)


def test_audio_only_mode(mix):
    pcm, truth = mix
    rec = FakeRecognizer(pcm, truth, SONGS)
    events = []
    result = run(pipeline.analyse(pcm, meta={'title': 'Test set'}, recognizer=rec,
                                  report=lambda *a: events.append(a[0])))
    tracks = result['tracks']
    assert result['mode'] == 'audio'
    assert [t['title'] for t in tracks] == ['Glue', 'Baby', 'So U Kno', 'ID', 'Delilah']
    assert [t['source'] for t in tracks] == ['fake', 'fake', 'fake', 'unknown', 'fake']
    # Each track starts when its fade-in starts (within a few seconds).
    for i in range(1, 5):
        assert tracks[i]['startSec'] == pytest.approx(truth['starts'][i], abs=6)
        assert tracks[i - 1]['endSec'] == pytest.approx(truth['blends'][i - 1][1], abs=6)
    for t, spec in zip(tracks, SPECS):
        assert t['bpm'] == pytest.approx(spec['bpm'], abs=0.6)
        assert t['camelot'] == dsp.CAMELOT[(spec['tonic'], spec['minor'])]
        if t['identified']:
            assert t['cueInSong'] == pytest.approx(0, abs=6)  # every synthetic song starts from its top
    assert len(result['transitions']) == 4
    assert [round(tr['seconds']) for tr in result['transitions']] == pytest.approx(BLENDS, abs=7)
    assert all(tr['bassSwap'] is not None for tr in result['transitions'] if tr['seconds'] >= 16)
    assert result['phases'] and result['energyCurve']
    assert 'identifying' in events and 'finishing' in events
    assert result['stats']['recognitionRequests'] == rec.requests


def test_tracklist_mode_uses_posted_names(mix):
    pcm, truth = mix
    # A viewer's tracklist with timestamps a few seconds off, like real comments.
    stamps = [0] + [s + 6 for s in truth['starts'][1:]]
    names = ['Bicep - Glue', 'Four Tet - Baby', 'Overmono - So U Kno', 'ID - ID', 'Fred again.. - Delilah']
    text = '\n'.join(f'{int(t // 60)}:{int(t % 60):02d} {n}' for t, n in zip(stamps, names))
    rec = FakeRecognizer(pcm, truth, SONGS)
    result = run(pipeline.analyse(pcm, meta={}, candidates=[{'source': 'comment by @digger', 'text': text}],
                                  recognizer=rec))
    assert result['mode'] == 'tracklist+audio'
    assert result['tracklistSources'] == ['comment by @digger']
    titles = [t['title'] for t in result['tracks']]
    assert titles == ['Glue', 'Baby', 'So U Kno', 'ID', 'Delilah']
    assert result['tracks'][3]['unreleased']
    assert rec.requests == 5  # one clip per track to fetch artwork and links


def test_without_recognizer_still_times_the_set(mix):
    pcm, truth = mix
    result = run(pipeline.analyse(pcm, meta={}, recognizer=None))
    assert len(result['tracks']) == 5
    assert all(t['title'] == 'ID' for t in result['tracks'])
    assert all(t['bpm'] for t in result['tracks'])


def test_split_on_disagreement_uses_offset():
    a = Match('One', 'X', offset=60)
    b = Match('Two', 'Y', offset=20)
    seg = pipeline.Segment(0, 400, hits=[(100, a), (300, b)])
    out = pipeline.split_on_disagreement([seg])
    assert [s.best().title for s in out] == ['One', 'Two']
    assert out[0].end == pytest.approx(280)   # 'Two' began 20 s before the clip at 300


def test_merge_same_song():
    a = Match('One', 'X', offset=10)
    segs = [pipeline.Segment(0, 100, hits=[(50, a)]), pipeline.Segment(100, 200, hits=[(150, a)]),
            pipeline.Segment(200, 300, hits=[(250, Match('Two', 'Y'))])]
    out = pipeline.merge_same_song(segs)
    assert [(s.start, s.end) for s in out] == [(0, 200), (200, 300)]


def test_long_stretch_gets_several_probes():
    seg = pipeline.Segment(0, 620)
    pts = pipeline.probe_times(seg, 1)
    assert len(pts) == 4 and all(15 <= p <= 605 for p in pts)
    assert pipeline.probe_times(pipeline.Segment(0, 620), 1, spread=False) == [310.0]


def test_missed_boundary_is_found_by_recognition(mix, monkeypatch):
    """If the audio analysis misses a change, the extra clips on a long stretch still catch it."""
    pcm, truth = mix
    real = dsp.boundaries
    monkeypatch.setattr(dsp, 'boundaries', lambda f, **kw: [b for b in real(f, **kw) if abs(b - 267) > 20])
    rec = FakeRecognizer(pcm, truth, SONGS)
    result = run(pipeline.analyse(pcm, meta={}, recognizer=rec))
    titles = [t['title'] for t in result['tracks']]
    assert titles == ['Glue', 'Baby', 'So U Kno', 'ID', 'Delilah']
    assert result['tracks'][2]['startSec'] == pytest.approx(truth['starts'][2], abs=8)


def test_short_unknown_fragment_is_absorbed(mix):
    pcm, truth = mix
    f = dsp.features(pcm)
    glue, baby = Match('Glue', 'Bicep'), Match('Baby', 'Four Tet')
    segs = [pipeline.Segment(0, 100, hits=[(50, glue)]), pipeline.Segment(100, 130),
            pipeline.Segment(130, 260, hits=[(200, baby)])]
    out = pipeline.absorb_short_unknowns(segs, f)
    assert [(s.start, s.end) for s in out] == [(0, 130), (130, 260)] or [(s.start, s.end) for s in out] == [(0, 100), (100, 260)]


def test_no_slivers_at_the_edges():
    segs = pipeline.segments_from_audio([12.0, 200.0, 590.0], 600.0)
    assert [(s.start, s.end) for s in segs] == [(0.0, 200.0), (200.0, 600.0)]


def test_unknown_lookalikes_merge_even_when_short(mix):
    pcm, truth = mix
    f = dsp.features(pcm)
    end = f.duration
    segs = [pipeline.Segment(truth['starts'][4] + 20, end - 18), pipeline.Segment(end - 18, end)]
    out = pipeline.merge_unknown_lookalikes(segs, f)
    assert len(out) == 1 and out[0].end == end
