# discojockey 🔥

**Find the tracks. Map the transitions. Catch the vibe.**

`discojockey` is an interactive DJ set track identifier, overlapping transition visualizer, crowd energy silhouette analyzer, and Camelot harmonic recommendation studio.

## Live Features on GitHub Pages
- **01 / Mix Studio**:
  - **Overlapping Mix Timeline**: Multi-deck horizontal timeline (Deck A + Deck B) with animated striped blend zones showing exact transition overlaps.
  - **Set Energy & Crowd Arc**: Synchronized SVG energy silhouette mapping warm-up, groove lock, hands-up builds, peak-time bass, and cathartic finales.
  - **Editorial Tracklist**: Magazine-style tracklist with oversized numerals, BPM, musical key & Camelot notation, songwriter/producer credits, cue nudging, and direct listening links (**Spotify**, **Beatport**, **SoundCloud**, **YouTube**, **Apple Music**, **YT Music**).
  - **Client-Side Web Audio DSP**: Upload any local audio mix (`MP3`, `WAV`, `M4A`, `FLAC`, `OGG`) for in-browser onset-autocorrelation BPM detection, key estimation, and RMS energy curve rendering.
- **02 / Discover & Mix**:
  - **Harmonic Record Crate**: Weighted tempo + Camelot wheel recommendation engine (`0.35*tempo + 0.35*harmonic + 0.15*style + 0.10*audio + 0.05*energy`) with live BPM and Camelot override controls.

## Quick Deploy to GitHub Pages
1. Upload `index.html`, `README.md`, and `.nojekyll` to the root of your GitHub repository (e.g., `falaq18/discojockey`).
2. Go to **Settings → Pages** in your repository.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**, select **`main`** and **`/ (root)`**, and click **Save**.
4. Your site will go live at `https://falaq18.github.io/discojockey/`.
