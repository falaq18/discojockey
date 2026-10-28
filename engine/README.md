# discojockey engine

The server behind [falaq18.github.io/discojockey](https://falaq18.github.io/discojockey/). Give it a YouTube DJ set and it sends back:

- **every track in order**, with when it starts and ends in the mix
- **every transition**: when the next track fades in, how long both play together, and whether the DJ did a bass swap
- **BPM and key** (with Camelot code) of each track, measured from the audio
- **set structure**: an energy curve and the warm-up / build-up / peak / closing phases
- **notes for learning DJs** on each transition (harmonic or clashing keys, tempo moves, how the blend was done)
- **what to play next**: related tracks whose BPM and key are measured from their previews and ranked by how well they mix

## How it works

1. **Download** the smallest audio-only stream from YouTube with yt-dlp (about 20 MB per hour of audio). At the same time it reads the description, chapters and top comments, in case someone posted a tracklist.
2. **Listen to the whole mix** (numpy/scipy, about 7 s per hour of audio on 4 cores):
   - spectral novelty finds where the music changes enough to be a new track
   - a Fourier tempogram measures BPM
   - chroma with KeyFinder profiles, weighted towards the bass line, gives the key
   - loudness and rhythmic density give the energy curve
3. **Identify the songs**: a 12-second clip from the middle of each stretch goes to Shazam, or to AudD if you set a token. Shazam's answer includes where in the song the clip sits, so the engine knows when each song really started and how far into it the DJ dropped it. When two clips in one stretch hear different songs, the stretch is split there, and neighbours that turn out to be the same song are merged.
4. **Measure each blend** by unmixing the spectrum: every second around a change is explained as a mix of the outgoing and incoming track (non-negative least squares on a few spectral snapshots of each), and a fade-in ramp is fitted to the share of the new track. The low end is unmixed separately to spot bass swaps.
5. If a **posted tracklist** covers the set, its names are used and its timestamps are snapped onto the audio changes. The audio still gives the timing, blends, BPM and key.

The page polls the job and shows tracks as soon as they are found. Results are cached per video, so a second visit is instant.

## Speed

A one-hour set takes roughly **30–70 seconds**: download 5–20 s (depends on the connection), decode about 4 s, analysis about 10 s on 2 CPUs, recognition 10–25 s, blends about 3 s. Recognition stops at `RECOGNITION_BUDGET_S` (35 s by default), so a slow recognizer can't hold the result back. Anything it hasn't identified by then stays as "ID".

## Deploy it (pick one)

### A. Hugging Face Spaces: free and always online

1. Make a free account at [huggingface.co](https://huggingface.co), then **New → Space**. Pick **Docker → Blank** and **CPU basic (free)**, and keep the Space **public**.
2. In the Space, open **Files → Add file → Upload files** and upload from this `engine` folder:
   - `Dockerfile`
   - `requirements.txt`
   - the whole `discojockey_engine` folder
3. Under **Settings → Variables and secrets**, add the settings you need (see the table below). On a Space you'll almost certainly need `YTDLP_PROXY` (see *YouTube blocking*).
4. Wait for the Space to show **Running**. Your engine address is `https://<your-username>-<space-name>.hf.space`. Open `/api/health` on it to check.
5. Put that address in `config.js` at the root of the website repo:
   ```js
   window.DISCOJOCKEY_ENGINE = 'https://<your-username>-<space-name>.hf.space';
   ```

Free Spaces go to sleep after 48 hours without visitors. The first request after that wakes the Space, which takes about a minute.

### B. Your own computer: free, and YouTube doesn't block home connections

With Docker:

```bash
docker build -t discojockey-engine engine
```

```bash
docker run -p 7860:7860 discojockey-engine
```

To give the website a public HTTPS address for it, use a free Cloudflare quick tunnel ([install `cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)):

```bash
cloudflared tunnel --url http://localhost:7860
```

Paste the `https://….trycloudflare.com` address it prints into the site's **⚙ Engine** link, or into `config.js`. The address changes each time the tunnel restarts.

Without Docker you need Python 3.11+, ffmpeg and Node.js 22+:

```bash
cd engine && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
```

```bash
uvicorn discojockey_engine.server:app --port 7860
```

## YouTube blocking

YouTube often answers servers in data centres (Hugging Face, AWS and the like) with *"Sign in to confirm you're not a bot"*. Home connections are rarely affected. If the engine reports that error:

- **Residential proxy** (recommended for a public engine): set `YTDLP_PROXY=http://user:password@host:port` to a residential proxy. You pay per GB at most providers, and each hour of audio is about 20–25 MB.
- **Cookies**: export YouTube cookies from a browser (Netscape format), add the file to the image, and set `YTDLP_COOKIES` to its path. Use a spare Google account: yt-dlp warns that accounts used this way can get flagged.
- **Run it at home** (option B).

## Song recognition

| Recognizer | Cost | Notes |
| --- | --- | --- |
| Shazam (default) | free | Uses Shazam's public endpoint through [ShazamIO](https://github.com/shazamio/ShazamIO), which is unofficial. Shazam limits how fast one IP can ask, so keep `SHAZAM_CONCURRENCY` low (3). |
| [AudD](https://audd.io) | paid per request | Set `AUDD_API_TOKEN`. Official API, faster and steadier. A one-hour set uses about 25–40 requests. |

Neither recognizes unreleased tracks, private edits or tracks buried under heavy effects. Those show up as **ID** with their timing, BPM and key still measured, and you can name them on the page.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `DJ_RECOGNIZER` | `auto` | `auto` uses AudD if a token is set, otherwise Shazam. `shazam`, `audd` or `none` force one. |
| `AUDD_API_TOKEN` | | AudD API token. |
| `SHAZAM_CONCURRENCY` | `3` | Shazam requests at once. |
| `RECOGNITION_BUDGET_S` | `35` | Seconds recognition may take per set. |
| `YT_API_KEY` | | Optional YouTube Data API key: reads comments faster than yt-dlp. |
| `YTDLP_PROXY` | | Proxy for YouTube (and Shazam) requests. |
| `YTDLP_COOKIES` | | Path to a cookies.txt for YouTube. |
| `COMMENTS_WAIT_S` | `8` | How long to wait for comments after the audio is ready. |
| `MAX_DURATION_MIN` | `180` | Longest set accepted, in minutes. |
| `MAX_UPLOAD_MB` | `300` | Largest uploaded file. |
| `MAX_JOBS` | `2` | Sets analysed at the same time. |
| `MAX_QUEUE` | `8` | Jobs waiting before new ones are turned away. |
| `ANALYSES_PER_IP_PER_HOUR` | `20` | Per-visitor limit. |
| `CACHE_DIR` | `./cache` | Where finished results are kept. |
| `ALLOWED_ORIGINS` | `*` | Comma-separated sites allowed to call the API. |

## API

| Method and path | Body / query | Returns |
| --- | --- | --- |
| `POST /api/analyze` | `{"url": "<youtube link>"}` | `{"job": id, "cached": bool}` |
| `POST /api/analyze-file` | multipart `file`, optional `title` | `{"job": id}` |
| `GET /api/jobs/{id}` | | `status`, `stage`, `progress`, `message`, `result` (partial while running) |
| `GET /api/next` | `artist`, `title`, `bpm`, `camelot` | tracks ranked by how well they mix after it |
| `POST /api/youtube-playlist` | `{"tracks": [{"artist", "title"}]}` | YouTube video ids and a no-login playlist link |
| `GET /api/health` | | engine status |

## Accuracy

The analysis is tested on synthetic DJ mixes with known answers (`tests/`). On those, BPM and key are right for every track, and blend start and end times are within about 2 seconds. Real mixes are harder:

- **Blend windows** assume the two tracks sound different. Filter sweeps, echo-outs and long ambient blends can stretch or shorten the measured window. The page lets you nudge any start or end.
- **BPM** is precise on steady four-to-the-floor music. Breakbeat, drum & bass and half-time tracks can come out at half or double speed.
- **Key** detection on electronic music is right most of the time, not always. Treat the Camelot code as a strong hint.
- **Track changes** come from the audio, confirmed by recognition. A very gradual mix between two similar tracks can be missed when neither track is recognized.

## Tests

```bash
pip install pytest && cd engine && python -m pytest
```
