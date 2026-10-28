from discojockey_engine import tracklist as tl


def names(entries):
    return [f'{e.artist} | {e.title}' for e in entries]


def test_description_formats():
    text = """Tracklist:
01. [00:00] Bicep – Glue [Ninja Tune]
02. [04:12] Four Tet – Baby (Bicep Remix)
03. [08:45] Overmono – So U Kno
w/ Joy Orbison - flight fm
04. [1:02:15] ID – ID"""
    entries, timed, _ = tl.parse(text, 4000)
    assert timed
    assert names(entries) == ['Bicep | Glue', 'Four Tet | Baby (Bicep Remix)', 'Overmono | So U Kno', 'ID | ID']
    assert entries[0].label == 'Ninja Tune'
    assert entries[2].blends == [{'artist': 'Joy Orbison', 'title': 'flight fm'}]
    assert entries[3].unreleased and entries[3].start == 3735


def test_trailing_timestamps_and_ranges():
    entries, _, _ = tl.parse('Peggy Gou - It Goes Like (Nanana) 0:00\nFisher - Losing It 5:10\n9:40 - 14:00 Chris Lake - Turn Off The Lights')
    assert [e.start for e in entries] == [0, 310, 580]
    assert entries[2].artist == 'Chris Lake' and entries[2].title == 'Turn Off The Lights'


def test_comment_html():
    entries, _, _ = tl.parse('<a href="#">0:00</a> Disclosure - Latch<br><a href="#">4:05</a> Kaytranada - 10%<br>8:30 Jamie xx - Gosh &amp; more')
    assert names(entries) == ['Disclosure | Latch', 'Kaytranada | 10%', 'Jamie xx | Gosh & more']


def test_casual_comment_ignored():
    assert tl.parse('1:23:45 this drop is insane\nwho else is here in 2026')[0] == []


def test_pick_best_and_stitch():
    best = tl.pick_best([
        {'source': 'description', 'text': 'New set! 0:00 intro vibes'},
        {'source': 'comment 1', 'text': '12:30 that transition'},
        {'source': 'comment 2', 'text': '0:00 A - One\n4:00 B - Two\n8:00 C - Three'},
        {'source': 'comment 3', 'text': 'pt2\n12:00 D - Four\n16:00 E - Five'},
    ], 1200)
    assert best['sources'] == ['comment 2', 'comment 3']
    assert len(best['entries']) == 5
    assert tl.coverage(best['entries'], 1200) > 0.9
