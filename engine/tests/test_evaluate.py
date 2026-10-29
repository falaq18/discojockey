from discojockey_engine import evaluate


def track(title, artist, start, end, identified=True):
    return {'title': title, 'artist': artist, 'startSec': start, 'endSec': end,
            'identified': identified, 'source': 'shazam' if identified else 'unknown'}


TRACKS = [
    track('Glue', 'Bicep', 0, 110),
    track('Baby', 'Four Tet', 90, 215),          # blend 90-110
    track('ID', 'Unknown artist', 205, 410, identified=False),   # blend 205-215
    track('Rumble', 'Skrillex', 400, 600),       # blend 400-410
]

REFERENCE = [
    {'start': 0, 'artist': 'Bicep', 'title': 'Glue', 'unreleased': False},
    {'start': 100, 'artist': 'Four Tet', 'title': 'Baby (Bicep Remix)', 'unreleased': False},
    {'start': 230, 'artist': 'Overmono', 'title': 'So U Kno', 'unreleased': False},
    {'start': 300, 'artist': 'ID', 'title': 'ID', 'unreleased': True},
    {'start': 470, 'artist': 'Fred again..', 'title': 'Delilah', 'unreleased': False},
]


def test_changes_are_matched_to_blends():
    s = evaluate.compare(REFERENCE, TRACKS)
    c = s['changes']
    # 100 lies inside the 90-110 blend, 230 is 15 s after the 205-215 blend; 300 and 470 have no blend near.
    assert (c['posted'], c['found'], c['extra']) == (4, 2, 1)
    assert [m['start'] for m in s['missedChanges']] == [300, 470]
    assert s['extraChanges'] == [{'start': 400, 'end': 410}]


def test_names_are_checked_where_tracks_overlap():
    s = evaluate.compare(REFERENCE, TRACKS)
    # Glue right, Baby right (remix suffix ignored), So U Kno landed on an unnamed stretch,
    # the ID is skipped, Delilah overlaps Rumble the most: a different song.
    assert s['names'] == {'checked': 4, 'right': 2, 'wrong': 1, 'unnamed': 1}
    kinds = {p['posted']: p['kind'] for p in s['nameProblems']}
    assert kinds == {'Overmono - So U Kno': 'not named', 'Fred again.. - Delilah': 'different song'}


def test_reference_needs_a_real_timed_tracklist():
    good = [{'source': 'comment by @digger', 'text': '0:00 A - One\n4:00 B - Two\n8:00 C - Three\n12:00 D - Four'}]
    ref = evaluate.reference_from(good, 960)
    assert ref['sources'] == ['comment by @digger'] and len(ref['entries']) == 4
    assert evaluate.reference_from([{'source': 'x', 'text': '0:00 A - One\n1:00 B - Two'}], 3600) is None


def test_whole_run_with_stand_ins(tmp_path, monkeypatch, capsys):
    import asyncio
    import json

    from discojockey_engine import dsp
    from discojockey_engine.youtube import VideoInfo
    from fakes import FakeRecognizer
    from synth import make_mix

    specs = [dict(bpm=124, tonic=7, minor=True, seconds=120, seed=1, style=0),
             dict(bpm=126, tonic=5, minor=False, seconds=130, seed=2, style=1),
             dict(bpm=128, tonic=9, minor=True, seconds=120, seed=3, style=2),
             dict(bpm=122, tonic=0, minor=True, seconds=120, seed=4, style=3)]
    pcm, truth = make_mix(specs, [24, 30, 16])
    wav = tmp_path / 'mix.wav'
    wav.write_bytes(dsp.wav_bytes(pcm))
    stamps = [0] + [s + 8 for s in truth['starts'][1:]]
    posted = '\n'.join(f'{int(t // 60)}:{int(t % 60):02d} {n}' for t, n in
                       zip(stamps, ['Bicep - Glue', 'Four Tet - Baby', 'Overmono - So U Kno', 'Floating Points - LesAlpx']))

    async def download(self, vid, folder):
        return wav, VideoInfo(vid, 'Real-world stand-in', 'DJ', len(pcm) / dsp.SR, [])

    async def comments(self, vid):
        return [{'source': 'comment by @digger', 'text': posted}]

    songs = [('Bicep', 'Glue'), ('Four Tet', 'Baby'), None, ('Floating Points', 'LesAlpx')]
    monkeypatch.setattr(evaluate.YouTube, 'download', download)
    monkeypatch.setattr(evaluate.YouTube, 'comments', comments)
    monkeypatch.setattr(evaluate, 'make_recognizer', lambda *a, **k: FakeRecognizer(pcm, truth, songs))
    out = tmp_path / 'r.json'
    assert asyncio.run(evaluate.main(['https://youtu.be/abcdefghijk', '--out', str(out), '--pause', '0'])) == 0
    printed = capsys.readouterr().out
    assert 'track changes: found 3/3' in printed
    assert 'names: 3/4 right, 0 different song, 1 not named' in printed
    saved = json.loads(out.read_text())
    assert saved[0]['score']['names']['right'] == 3 and saved[0]['times']['total'] > 0
