# discojockey

**Find the tracks. Map the transitions. Catch the vibe.**

Paste any YouTube DJ set into [falaq18.github.io/discojockey](https://falaq18.github.io/discojockey/) and it listens to the set and shows:

- **01 / Mix Studio**
  - **Overlapping Mix Timeline**: every track on Deck A or Deck B, with the real blend windows where two tracks play together. Click to scrub, or jump to the next transition.
  - **Now playing**, synced with the YouTube player, including live two-deck blends and bass swaps.
  - **Set Energy & Crowd Arc**: the energy curve measured from the audio, with the set's phases (warm-up, build-up, peak time, breather, closing).
  - **The Tracklist**: time in the mix, BPM, key and Camelot code, listening links, and *Mix Notes* that explain each transition (key compatibility, tempo moves, bass swaps, blend length, where in the track the DJ started it).
- **02 / Discover & Mix**
  - **What to spin next**: real tracks related to the one you pick, with BPM and key measured from their previews, ranked by how well they mix. You can preview them, filter them and adjust the target BPM or key.
  - **Practice Crate**: save tracks from any set, sort them by BPM or key, export them as CSV or TXT, or open them as a YouTube playlist.
- **Upload your own mix** to decode it the same way.
- **One-click YouTube playlist** of a whole set. No login needed.

## How it fits together

```
GitHub Pages (index.html, app.js)  ──►  discojockey engine (engine/)
  the original design, now fed            downloads the audio, finds the track changes,
  by real analysis                        identifies the songs (Shazam / AudD), measures
                                          blends, BPM, key and energy, suggests next tracks
```

The website is static and the listening happens on the engine. A GitHub Pages site can't download YouTube audio, so the engine has to run somewhere. **Setting it up takes about 10 minutes and can be free.** See [`engine/README.md`](engine/README.md).

## Setup

1. Deploy the engine ([Hugging Face Spaces](engine/README.md#a-hugging-face-spaces-free-and-always-online) or [your own computer](engine/README.md#b-your-own-computer-free-and-youtube-doesnt-block-home-connections)).
2. Put its address in [`config.js`](config.js):
   ```js
   window.DISCOJOCKEY_ENGINE = 'https://<your-username>-<space-name>.hf.space';
   ```
3. GitHub Pages: **Settings → Pages → Deploy from a branch → `main` / `(root)`**.

Without an engine the site still accepts a pasted timestamped tracklist, but it can't measure anything.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page (Tailwind, original design) |
| `app.js` | Talks to the engine and draws the timeline, energy arc, tracklist, Discover and crate |
| `parser.js` | Reads pasted timestamped tracklists in the browser |
| `config.js` | The engine's address |
| `engine/` | The analysis server: Python, Docker. Has its own README and tests |
| `tests/parser.test.js` | `node --test tests/*.test.js` |
