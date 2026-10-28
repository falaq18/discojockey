const test = require('node:test');
const assert = require('node:assert');
const P = require('../parser.js');

const names = (r) => r.tracks.map((t) => `${t.artist} | ${t.title}`);

test('plain description tracklist with h:mm:ss', () => {
  const text = `Boiler Room London. Thanks for coming!

Tracklist:
0:00 Fred again.. - Kammy (like i do)
3:30 Fred again.. & Danielle - Danielle (smile on my face)
7:30 Swedish House Mafia - Turn On The Lights again..
1:02:15 Skrillex, Fred again.. & Flowdan - Rumble

Follow us on instagram`;
  const r = P.parseTracklist(text, 4000);
  assert.strictEqual(r.timed, true);
  assert.deepStrictEqual(names(r), [
    'Fred again.. | Kammy (like i do)',
    'Fred again.. & Danielle | Danielle (smile on my face)',
    'Swedish House Mafia | Turn On The Lights again..',
    'Skrillex, Fred again.. & Flowdan | Rumble'
  ]);
  assert.deepStrictEqual(r.tracks.map((t) => t.startSec), [0, 210, 450, 3735]);
});

test('numbered lines with bracketed timestamps, labels and en dashes', () => {
  const text = `01. [00:00] Bicep – Glue [Ninja Tune]
02. [04:12] Four Tet – Baby (Bicep Remix) [Text]
03. [08:45] Overmono – So U Kno [XL]
04. [13:01] ID – ID`;
  const r = P.parseTracklist(text);
  assert.deepStrictEqual(names(r), [
    'Bicep | Glue',
    'Four Tet | Baby (Bicep Remix)',
    'Overmono | So U Kno',
    'ID | ID'
  ]);
  assert.strictEqual(r.tracks[0].recordLabel, 'Ninja Tune');
  assert.strictEqual(r.tracks[3].unreleased, true);
});

test('timestamp at the end of the line and ranges', () => {
  const text = `Peggy Gou - It Goes Like (Nanana) 0:00
Fisher - Losing It 5:10
9:40 - 14:00 Chris Lake - Turn Off The Lights`;
  const r = P.parseTracklist(text);
  assert.strictEqual(r.tracks.length, 3);
  assert.strictEqual(r.tracks[1].artist, 'Fisher');
  assert.strictEqual(r.tracks[1].startSec, 310);
  assert.strictEqual(r.tracks[2].startSec, 580);
  assert.strictEqual(r.tracks[2].artist, 'Chris Lake');
  assert.strictEqual(r.tracks[2].title, 'Turn Off The Lights');
});

test('w/ lines become blends of the previous track', () => {
  const text = `0:00 Daft Punk - One More Time
w/ Romanthony - Hold On (acapella)
4:00 Justice - D.A.N.C.E.
8:00 Stardust - Music Sounds Better With You`;
  const r = P.parseTracklist(text);
  assert.strictEqual(r.tracks.length, 3);
  assert.deepStrictEqual(r.tracks[0].blends, [{ artist: 'Romanthony', title: 'Hold On (acapella)', hasSeparator: true }]);
});

test('YouTube comment HTML (links, entities, <br>) is handled', () => {
  const html = 'Tracklist 🔥<br><a href="https://www.youtube.com/watch?v=x&amp;t=0">0:00</a> Disclosure - Latch<br><a href="https://www.youtube.com/watch?v=x&amp;t=245">4:05</a> Kaytranada - 10%<br><a href="#">8:30</a> Jamie xx - Gosh &amp; more';
  const r = P.parseTracklist(html);
  assert.deepStrictEqual(names(r), ['Disclosure | Latch', 'Kaytranada | 10%', 'Jamie xx | Gosh & more']);
});

test('untimed numbered tracklist still gives order', () => {
  const r = P.parseTracklist(`1. Bicep - Glue\n2. Bicep - Atlas\n3. Floating Points - LesAlpx`);
  assert.strictEqual(r.timed, false);
  assert.strictEqual(r.tracks.length, 3);
});

test('casual comments are not mistaken for a tracklist', () => {
  const r = P.parseTracklist('1:23:45 this drop is insane\nwho else is here in 2026');
  assert.strictEqual(r.tracks.length, 0);
});

test('timestamps past the video end are dropped', () => {
  const r = P.parseTracklist('0:00 A - One\n2:00 B - Two\n3:00 C - Three\n59:00 D - Four', 600);
  assert.strictEqual(r.tracks.length, 3);
});

test('pickBestTracklist prefers the real tracklist and stitches part 2', () => {
  const candidates = [
    { source: 'description', text: 'New set! 0:00 intro vibes' },
    { source: 'comment 1', text: '12:30 that transition 🔥🔥' },
    { source: 'comment 2', text: 'Part 1\n0:00 Artist A - Song A\n4:00 Artist B - Song B\n8:00 Artist C - Song C' },
    { source: 'comment 3', text: 'Part 2\n12:00 Artist D - Song D\n16:00 Artist E - Song E' }
  ];
  const best = P.pickBestTracklist(candidates, 1200);
  assert.deepStrictEqual(best.sources, ['comment 2', 'comment 3']);
  assert.strictEqual(best.tracks.length, 5);
});

test('buildSet sets end times and lengths', () => {
  const r = P.parseTracklist('0:00 A - One\n2:00 B - Two\n5:00 C - Three');
  const set = P.buildSet(r.tracks, 600);
  assert.deepStrictEqual(set.map((t) => [t.startSec, t.endSec, t.lengthSec]), [[0, 120, 120], [120, 300, 180], [300, 600, 300]]);
});

test('toText round-trips through the parser', () => {
  const r = P.parseTracklist('0:00 A - One\nw/ X - Acap\n2:00 B - Two\n1:05:00 C - Three');
  const again = P.parseTracklist(P.toText(r.tracks));
  assert.deepStrictEqual(names(again), names(r));
  assert.strictEqual(again.tracks[0].blends.length, 1);
});
