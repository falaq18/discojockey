# PROGRESS.md

Read at the start of every session. Newest entries at the top.

## Where we are
- **Stage:** the analysis engine and the restored original design are built, and tested only on synthetic mixes. No real YouTube set has been run yet. Not live.
- **Branch:** `claude/admiring-hypatia-9j59sl`. `main` (and the live site) still has the earlier comments-only rebuild.
- **Waiting for:** somewhere to run real sets: Falaq's Mac (home internet isn't blocked by YouTube), or a cloud session with network access opened (see *Blockers*).
- **Then:** measure real sets → tune → deploy the engine → put its address in `config.js` → merge into `main`.

---

## Handoff (written 2026-10-30)

### What Falaq asked for
- Paste any YouTube DJ set and get: which song played when, where tracks overlap, each track's BPM and key (Camelot), in under a minute.
- Keep the original site's look exactly: 01 / Mix Studio and 02 / Discover & Mix.
- Playlists: YouTube, no login.
- DJ tools: transition breakdowns, a practice crate, "what to play next", and set structure/energy.

### How it works
- **`engine/`** is a FastAPI service (Docker or plain Python):
  - yt-dlp downloads the smallest audio stream, plus the description, chapters and comments.
  - numpy/scipy find the track changes (spectral novelty), BPM (tempogram), key (chroma with KeyFinder profiles and bass weighting) and the energy curve.
  - Shazam (ShazamIO, free and unofficial) or AudD (paid, `AUDD_API_TOKEN`) names a 12 s clip from each stretch. The match's offset gives when the song really started.
  - Blend windows come from unmixing the spectrum around each change (NNLS on spectral snapshots of both tracks, then a fade-in ramp fit). The low band alone gives bass swaps.
  - A posted tracklist supplies the names when it covers the set.
  - Recommendations come from Deezer's related artists, with BPM and key measured from their 30 s previews.
- **The site:**
  - `index.html` is the original design.
  - `app.js` is the engine client.
  - `parser.js` reads pasted tracklists.
  - `config.js` holds the engine's address.

### How to resume
- **Get the code:**
  ```bash
  git clone -b claude/admiring-hypatia-9j59sl https://github.com/falaq18/discojockey
  ```
  If it's already cloned, run `git pull` instead.
- **Health check:**
  - `cd engine && python -m pytest` should say "39 passed".
  - `node --test tests/*.test.js` (from the repo root) should pass 11 tests.
- **Run the engine:** either Docker (`docker build -t discojockey-engine engine`, then `docker run -p 7860:7860 discojockey-engine`), or Python 3.11+ with ffmpeg and Node 22+ on the PATH (`pip install -r engine/requirements.txt`, then `uvicorn discojockey_engine.server:app --port 7860` from `engine/`).
- **Run the site:** `python3 -m http.server 8000` in the repo root, open http://localhost:8000, then ⚙ Engine → `http://localhost:7860`.
- **Measure real sets:** `cd engine && python -m discojockey_engine.evaluate <youtube links> --out results.json`. It analyses each set as if no tracklist had been posted, then scores it against the tracklist viewers posted. It reports changes found within 30 s, names right, and the time per stage.

### Next steps, in order
1. **Run `evaluate.py` on 5–8 real sets** that have full timestamped tracklists. Mix the genres:
   - house with long blends
   - techno
   - drum & bass or breaks
   - a Boiler Room set
   - a Cercle set
   - the Fred again.. Boiler Room London (`c0-hvjV2A5Y`) from the original site

   Note the changes found, names right and the timings for each.
2. **Tune** from those results (see *Most likely to need tuning*). Add any real failure as a test where possible.
3. **Deploy the engine** (`engine/README.md`): a Hugging Face Space with a residential proxy, or Falaq's Mac with a Cloudflare tunnel. Set `ALLOWED_ORIGINS=https://falaq18.github.io`.
4. **Go live:** put the engine's address in `config.js`, then merge the branch into `main`. GitHub Pages redeploys on its own.

### Not yet tried for real
- yt-dlp downloading from any network.
- Shazam on real mix clips: match rate, rate limits, and tracks played pitched up or down.
- Deezer's related artists and the preview analysis.
- The YouTube player sync and the `watch_videos` playlist link in a real browser.
- The Hugging Face deployment.

### Most likely to need tuning (guesses until measured)
- **Track changes:** `dsp.boundaries` uses threshold `0.12` and a 50 s minimum gap. Long blends between similar tracks can be missed, and breakdowns can be split.
- **Pitched tracks:** DJs often play tracks 2–6 % fast or slow. Shazam's match rate on those is unknown, and ShazamIO's `max_skew` is unused.
- **BPM octave:** breaks and drum & bass can come out at half or double speed.
- **Blend windows:** filter sweeps and echo-outs can stretch or shorten them.
- **Speed:** `RECOGNITION_BUDGET_S=35` has to fit the under-a-minute promise once the real download time is known.

### Blockers and how to clear them
- **Cloud sessions** block youtube.com, shazam.com and deezer.com. To allow them: session title caret → Edit cloud environment → Network access → **Full**, or **Custom** with `*.youtube.com`, `*.googlevideo.com`, `*.shazam.com`, `*.deezer.com` and `*.dzcdn.net`. YouTube may still refuse cloud IPs ("Sign in to confirm you're not a bot"). For the deployed engine, the fix is `YTDLP_PROXY` (a residential proxy) or `YTDLP_COOKIES`.
- **Remote Control** can't be used yet. Its list shows only the Jarvis folder, and the Mac's name has a character the approval prompt can't show (probably the apostrophe in "…'s MacBook"). The fix: rename the Mac using only letters, numbers and dashes, and share the `discojockey` folder.

### Useful facts
- **Speed on synthetic audio (4 cores):**
  - A one-hour mix: features about 5 s, every blend about 2 s, BPM and key for 20 tracks 0.15 s.
  - The Docker image analysed an 18.5-minute mix in 3.5 s, without recognition.
- **The Docker image** needs Node in it: yt-dlp solves YouTube's player JavaScript with it, and node 22+ is required.
- **Results are cached** per video on the engine and in the visitor's browser. Edits on the page are saved in the browser too.
- **Jarvis Stage 2's DJ expert** needs tempo and key for VirtualDJ's songs. `engine/discojockey_engine/dsp.py` (`features`, `bpm`, `key`) does exactly that and could be reused.
