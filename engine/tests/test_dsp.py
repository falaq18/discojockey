import numpy as np
import pytest

from discojockey_engine import dsp
from synth import make_mix

SPECS = [
    dict(bpm=124, tonic=7, minor=True, seconds=150, seed=1, style=0),   # G minor, 6A
    dict(bpm=126, tonic=5, minor=False, seconds=170, seed=2, style=1),  # F major, 7B
    dict(bpm=128, tonic=9, minor=True, seconds=160, seed=3, style=2),   # A minor, 8A
    dict(bpm=122, tonic=0, minor=True, seconds=140, seed=4, style=3),   # C minor, 5A
    dict(bpm=130, tonic=2, minor=False, seconds=150, seed=5, style=0),  # D major, 10B
    dict(bpm=174, tonic=4, minor=True, seconds=140, seed=6, style=1),   # E minor, 9A (drum & bass)
]


@pytest.fixture(scope='module', params=[([30, 45, 16, 24, 20], False), ([8, 60, 32, 2, 40], True)],
                ids=['crossfades', 'bass-swaps'])
def mix(request):
    blends, bass = request.param
    pcm, truth = make_mix(SPECS, blends, bass_swap=bass)
    return dsp.features(pcm), truth, blends, bass


def solo(truth, blends, i):
    a = truth['starts'][i] + (blends[i - 1] if i > 0 else 0)
    e = truth['ends'][i] - (blends[i] if i < len(blends) else 0)
    return a, e


def test_bpm_per_track(mix):
    f, truth, blends, _ = mix
    for i, spec in enumerate(SPECS):
        value, conf = dsp.bpm(f, *solo(truth, blends, i))
        assert value == pytest.approx(spec['bpm'], abs=0.6), (i, value)
        assert conf > 0.3


def test_key_per_track(mix):
    f, truth, blends, _ = mix
    for i, spec in enumerate(SPECS):
        k = dsp.key(f, *solo(truth, blends, i))
        assert k['camelot'] == dsp.CAMELOT[(spec['tonic'], spec['minor'])], (i, k)


def test_boundaries_found_near_each_blend(mix):
    f, truth, _, _ = mix
    found = dsp.boundaries(f)
    mids = [(a + b) / 2 for a, b in truth['blends']]
    assert len(found) == len(mids)
    for m in mids:
        assert min(abs(m - b) for b in found) <= 12


def test_blend_windows(mix):
    f, truth, _, bass = mix
    errors = []
    for i, (a, b) in enumerate(truth['blends']):
        w = dsp.blend_window(f, truth['starts'][i], (a + b) / 2, truth['ends'][i + 1])
        errors += [abs(w['start'] - a), abs(w['end'] - b)]
        if bass and b - a >= 16:
            assert w['bass_swap'] == pytest.approx((a + b) / 2, abs=max(4, 0.1 * (b - a)))
        if not bass:
            assert w['bass_swap'] is None
    assert np.mean(errors) < 3
    assert max(errors) <= 6


def test_energy_curve_shape(mix):
    f, *_ = mix
    curve = dsp.energy_curve(f)
    assert len(curve) == pytest.approx(f.duration / 10, abs=2)
    assert all(0 <= p['v'] <= 1 for p in curve)


def test_camelot_relations():
    assert dsp.camelot_relation('8A', '8A') == 'same key'
    assert dsp.camelot_relation('8A', '8B') == 'relative major/minor'
    assert dsp.camelot_relation('12A', '1A') == 'adjacent (+/-1)'
    assert dsp.camelot_relation('6A', '8A') == 'energy boost (+2)'
    assert dsp.camelot_relation('6A', '11B') == 'key clash'


def test_wav_bytes_roundtrip():
    pcm = (np.sin(np.arange(16000) / 10) * 1000).astype(np.int16)
    data = dsp.wav_bytes(pcm)
    assert data[:4] == b'RIFF' and len(data) == 44 + 2 * len(pcm)
