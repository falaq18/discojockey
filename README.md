# discojockey

**Paste a DJ set. Get every track.**

Drop any YouTube DJ set link into [falaq18.github.io/discojockey](https://falaq18.github.io/discojockey/) and it:

- **Finds the tracklist.** Reads the video description and the top ~300 comments and replies, scores every candidate, and picks the one that looks most like a real tracklist. A list split over several comments ("part 2") gets stitched together.
- **Puts the tracks in order with cue points.** Every track gets a timestamp that seeks the player. Every transition gets a "hear the transition" button that starts 20 seconds before the mix. `w/` lines show up as blends over the track above.
- **Follows along as you listen.** A timeline, the current track and what's up next all update with the YouTube player.
- **Suggests more music.** Tracks are matched on Deezer for artwork, BPM and 30-second previews. Related artists are ranked by how many artists in the set they connect to.
- **Lets you fix it.** If a set has no tracklist, or a wrong one, paste or edit it by hand. Your edits are saved in your browser.

## How it finds tracks (and its limits)

The site is static (GitHub Pages), so it can't listen to the audio. Tracklists come from what people wrote under the video, so a set with no tracklist in its description or comments needs one pasted in (the page links to a 1001Tracklists search for it).

The parser handles the common formats: `0:00 Artist - Title`, `01. [00:00] Artist – Title [Label]`, `Artist - Title 1:02:30`, ranges like `9:40 - 14:00`, HTML in comments, `ID - ID`, and untimed numbered lists.

## YouTube API key

Reading descriptions and comments uses the YouTube Data API v3, which needs a free key:

1. In Google Cloud, enable **YouTube Data API v3**.
2. Create an **API key** under Credentials.
3. Either paste it in the site's settings (stored only in that browser), or set `SITE_YT_API_KEY` at the top of `app.js` so every visitor gets automatic detection. If you set it in `app.js`, restrict the key to HTTP referrer `https://falaq18.github.io/*` and to the YouTube Data API only, since anyone can read the page source.

Without a key the player and pasted tracklists still work.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page markup |
| `styles.css` | Styles (dark, works on phones) |
| `parser.js` | Tracklist parser, no dependencies |
| `app.js` | YouTube fetch, player, Deezer matching and recommendations |
| `tests/parser.test.js` | Parser tests: `node --test tests/*.test.js` |

## Deploy

Settings → Pages → Deploy from a branch → `main` / `(root)`.
