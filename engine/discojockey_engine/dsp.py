"""Audio analysis for DJ mixes.

Everything works on one decoded mix (mono, 16 kHz):

* features():      onset envelope, band energies and chroma for the whole mix
* boundaries():    where the music changes enough to be a new track
* blend_window():  how long two tracks overlap around a change, by spectral unmixing
* bpm():           tempo of a stretch of the mix (Fourier tempogram)
* key():           musical key and Camelot code of a stretch (chroma + key profiles)
* energy_curve():  loudness/density over time, for the set-structure graph

Only numpy and scipy, so it runs on a small server in a few seconds per hour of audio.
"""
from __future__ import annotations

import io
import subprocess
import wave
from dataclasses import dataclass

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy import fft as sfft
from scipy import signal as sps
from scipy.ndimage import median_filter, uniform_filter1d
from scipy.optimize import nnls

SR = 16000
N_FFT = 2048
HOP = 512
FPS = SR / HOP  # 31.25 frames per second
N_BANDS = 40
FINE_BINS = 512

CHROMA_FFT = 8192  # 0.5 s window, 1.95 Hz bins: resolves bass notes
CHROMA_HOP = 4096
CHROMA_FPS = SR / CHROMA_HOP

PITCH_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

# Key profiles from KeyFinder (Ibrahim Sha'ath), tuned on electronic music.
MAJOR_PROFILE = np.array([7.23900502618145, 3.50351856973258, 3.58445188076572, 2.84511697609726,
                          5.81898571169716, 4.55865103198494, 2.44778202848755, 6.99473568193478,
                          3.39106443777547, 4.55614473107587, 4.07392506290503, 4.45932147406369])
MINOR_PROFILE = np.array([7.00255045060704, 3.14360665021094, 4.35904368128004, 5.40418981483144,
                          3.67234051398837, 4.08971754008013, 3.90791237563993, 6.19960550204949,
                          3.63424099330025, 2.87241252750713, 5.35467999051718, 3.83242942699493])

# Camelot wheel: (tonic pitch class, is_minor) -> code
CAMELOT = {
    (8, True): '1A', (11, False): '1B', (3, True): '2A', (6, False): '2B',
    (10, True): '3A', (1, False): '3B', (5, True): '4A', (8, False): '4B',
    (0, True): '5A', (3, False): '5B', (7, True): '6A', (10, False): '6B',
    (2, True): '7A', (5, False): '7B', (9, True): '8A', (0, False): '8B',
    (4, True): '9A', (7, False): '9B', (11, True): '10A', (2, False): '10B',
    (6, True): '11A', (9, False): '11B', (1, True): '12A', (4, False): '12B',
}


# --------------------------------------------------------------------------- decode

def decode(path: str, sr: int = SR, ffmpeg: str = 'ffmpeg') -> np.ndarray:
    """Decode any audio/video file to mono int16 at `sr` with ffmpeg."""
    proc = subprocess.run(
        [ffmpeg, '-nostdin', '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', str(sr), '-f', 's16le', '-'],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError('ffmpeg could not decode the audio: ' + proc.stderr.decode(errors='replace')[-400:])
    return np.frombuffer(proc.stdout, dtype=np.int16)


def wav_bytes(pcm: np.ndarray, sr: int = SR) -> bytes:
    """Wrap a mono int16 slice in a WAV container (what recognition services expect)."""
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(np.ascontiguousarray(pcm, dtype=np.int16).tobytes())
    return buf.getvalue()


# --------------------------------------------------------------------------- features

@dataclass
class Features:
    duration: float
    onset: np.ndarray        # (n_frames,) spectral-flux onset envelope at FPS
    low_onset: np.ndarray    # (n_frames,) same, kick/bass region only
    bands: np.ndarray        # (n_seconds, N_BANDS) mean linear power per band, 1 s resolution
    band_freqs: np.ndarray   # (N_BANDS,) centre frequency of each band
    chroma: np.ndarray       # (n_chroma_frames, 12) at CHROMA_FPS
    bass_chroma: np.ndarray  # (n_chroma_frames, 12) bass notes only (55-220 Hz)
    loudness: np.ndarray     # (n_seconds,) RMS in dB
    spec: np.ndarray         # (n_seconds, FINE_BINS) mean power, 15.6 Hz bins up to 8 kHz


def _band_matrix(n_fft: int, sr: int, n_bands: int, fmin: float = 30.0, fmax: float = 7600.0):
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    edges = np.geomspace(fmin, fmax, n_bands + 2)
    m = np.zeros((len(freqs), n_bands), dtype=np.float32)
    for b in range(n_bands):
        lo, mid, hi = edges[b], edges[b + 1], edges[b + 2]
        up = (freqs - lo) / (mid - lo)
        down = (hi - freqs) / (hi - mid)
        m[:, b] = np.clip(np.minimum(up, down), 0, None)
    m /= np.maximum(m.sum(axis=0, keepdims=True), 1e-9)
    return m, edges[1:-1]


def _chroma_matrix(n_fft: int, sr: int, fmin: float = 55.0, fmax: float = 1760.0):
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    m = np.zeros((len(freqs), 12), dtype=np.float32)
    ok = (freqs >= fmin) & (freqs <= fmax)
    midi = 69 + 12 * np.log2(np.where(ok, freqs, 1.0) / 440.0)
    nearest = np.round(midi)
    dist = np.abs(midi - nearest)
    weight = np.clip(1 - 2 * dist, 0, None)  # 1 at the note centre, 0 half a semitone away
    pc = (nearest.astype(int) % 12)
    idx = np.where(ok)[0]
    m[idx, pc[idx]] = weight[idx]
    return m


def features(pcm: np.ndarray) -> Features:
    """Compute everything later steps need, in one pass over the mix."""
    n = len(pcm)
    duration = n / SR
    if n < N_FFT * 4:
        raise ValueError('audio too short to analyse')

    window = np.hanning(N_FFT).astype(np.float32)
    band_m, band_freqs = _band_matrix(N_FFT, SR, N_BANDS)
    freqs = np.fft.rfftfreq(N_FFT, 1 / SR)
    low_bins = freqs < 200

    frames = sliding_window_view(pcm, N_FFT)[::HOP]  # a view: no copy of the mix
    n_frames = frames.shape[0]
    n_sec = int(np.ceil(n_frames / FPS))
    sec_idx = np.minimum((np.arange(n_frames) / FPS).astype(int), n_sec - 1)
    counts = np.bincount(sec_idx, minlength=n_sec).astype(np.float32)

    onset = np.zeros(n_frames, dtype=np.float32)
    low_onset = np.zeros(n_frames, dtype=np.float32)
    bands = np.zeros((n_sec, N_BANDS), dtype=np.float64)
    spec_sec = np.zeros((n_sec, FINE_BINS), dtype=np.float64)
    ms = np.zeros(n_sec, dtype=np.float64)
    prev = None
    chunk = 2048
    for start in range(0, n_frames, chunk):
        block = frames[start:start + chunk].astype(np.float32) / 32768.0
        idx = sec_idx[start:start + len(block)]
        rows, first_of_run = np.unique(idx, return_index=True)  # idx is sorted: sum runs

        def acc(target, values):
            target[rows] += np.add.reduceat(values, first_of_run, axis=0)

        acc(ms, np.mean(block ** 2, axis=1))
        spec = np.abs(sfft.rfft(block * window, axis=1, workers=-1))
        power = spec ** 2
        acc(bands, power @ band_m)
        acc(spec_sec, power[:, :2 * FINE_BINS].reshape(len(block), FINE_BINS, 2).sum(axis=2))
        logspec = np.log1p(100.0 * spec)
        first = prev if prev is not None else logspec[0]
        diff = np.clip(np.diff(np.vstack([first[None, :], logspec]), axis=0), 0, None)
        onset[start:start + len(block)] = diff.sum(axis=1)
        low_onset[start:start + len(block)] = diff[:, low_bins].sum(axis=1)
        prev = logspec[-1]

    bands = (bands / np.maximum(counts, 1)[:, None]).astype(np.float32)
    spec_sec = (spec_sec / np.maximum(counts, 1)[:, None]).astype(np.float32)
    loudness = (10 * np.log10(ms / np.maximum(counts, 1) + 1e-10)).astype(np.float32)

    # Chroma: long FFT frames so neighbouring bass notes land in different bins.
    cwin = np.hanning(CHROMA_FFT).astype(np.float32)
    cm = _chroma_matrix(CHROMA_FFT, SR)
    cm_bass = _chroma_matrix(CHROMA_FFT, SR, 55.0, 220.0)
    top = int(1800 / (SR / CHROMA_FFT)) + 1  # nothing above ~1.8 kHz is used
    cm, cm_bass = cm[:top], cm_bass[:top]
    cframes = sliding_window_view(pcm, CHROMA_FFT)[::CHROMA_HOP]
    chroma = np.zeros((cframes.shape[0], 12), dtype=np.float32)
    bass_chroma = np.zeros((cframes.shape[0], 12), dtype=np.float32)
    for start in range(0, cframes.shape[0], 512):
        block = cframes[start:start + 512].astype(np.float32) / 32768.0
        mag = np.abs(sfft.rfft(block * cwin, axis=1, workers=-1)[:, :top])
        # Keep spectral peaks (tonal content), drop the broadband floor from drums.
        peaks = np.clip(mag - uniform_filter1d(mag, size=31, axis=1), 0, None)
        chroma[start:start + len(block)] = peaks @ cm
        bass_chroma[start:start + len(block)] = peaks @ cm_bass

    return Features(duration, onset, low_onset, bands, band_freqs, chroma, bass_chroma, loudness, spec_sec)


# --------------------------------------------------------------------------- tempo

def bpm(f: Features, start: float, end: float, lo: float = 70.0, hi: float = 180.0) -> tuple[float | None, float]:
    """Tempo of [start, end) in BPM and a 0..1 confidence. Uses at most 120 s from the middle."""
    length = end - start
    if length < 8:
        return None, 0.0
    if length > 120:
        mid = (start + end) / 2
        start, end = mid - 60, mid + 60
    a, b = int(start * FPS), int(end * FPS)
    env = (f.onset[a:b] + 2.0 * f.low_onset[a:b]).astype(np.float64)
    if len(env) < 64 or not env.any():
        return None, 0.0
    env = env - uniform_filter1d(env, size=int(FPS))
    env = np.clip(env, 0, None)
    env -= env.mean()
    nfft = 1 << 18  # frequency resolution of 0.007 BPM
    spectrum = np.abs(np.fft.rfft(env, nfft)) / len(env)
    bin_hz = FPS / nfft

    def mag(bpms):
        return np.interp(np.asarray(bpms) / 60.0 / bin_hz, np.arange(len(spectrum)), spectrum)

    grid = np.arange(lo, hi + 0.001, 0.05)
    score = mag(grid) + 0.5 * mag(grid * 2) + 0.25 * mag(grid / 2)
    # Mild preference for typical club tempos, so 64/128 and 87/174 pick the usual octave.
    prior = np.exp(-0.5 * (np.log2(grid / 124.0) / 0.55) ** 2)
    total = score * (0.6 + 0.4 * prior)
    i = int(np.argmax(total))
    fine = np.arange(grid[i] - 0.1, grid[i] + 0.101, 0.005)
    fs = mag(fine) + 0.5 * mag(fine * 2) + 0.25 * mag(fine / 2)
    best = float(fine[int(np.argmax(fs))])
    peak = total[i]
    others = np.delete(total, np.arange(max(0, i - 60), min(len(total), i + 61)))
    conf = float(np.clip((peak - np.median(total)) / (peak + 1e-12), 0, 1))
    if len(others):
        conf *= float(np.clip(1 - others.max() / (peak + 1e-12), 0, 1)) ** 0.5
    return round(best, 1), round(conf, 2)


# --------------------------------------------------------------------------- key

def key(f: Features, start: float, end: float) -> dict | None:
    """Musical key of [start, end): {'key': 'G Minor', 'camelot': '6A', 'confidence': 0..1}."""
    a, b = int(start * CHROMA_FPS), int(end * CHROMA_FPS)
    c = f.chroma[a:b]
    if len(c) < 8:
        return None
    # Normalise each frame so loud moments do not dominate, then average.
    c = c / (c.sum(axis=1, keepdims=True) + 1e-9)
    profile = c.mean(axis=0)
    if not profile.any():
        return None
    bc = f.bass_chroma[a:b]
    bass = (bc / (bc.sum(axis=1, keepdims=True) + 1e-9)).mean(axis=0)
    scores = []
    for tonic in range(12):
        for minor, prof in ((False, MAJOR_PROFILE), (True, MINOR_PROFILE)):
            score = np.corrcoef(profile, np.roll(prof, tonic))[0, 1]
            # The bass usually sits on the tonic: this is what separates a minor key
            # from its relative major, which share every note.
            if bass.any():
                score += 0.35 * np.corrcoef(bass, np.roll(prof, tonic))[0, 1]
            scores.append((score, tonic, minor))
    scores.sort(reverse=True)
    best, second = scores[0], scores[1]
    tonic, minor = best[1], best[2]
    return {
        'key': f"{PITCH_NAMES[tonic]} {'Minor' if minor else 'Major'}",
        'camelot': CAMELOT[(tonic, minor)],
        'confidence': round(float(np.clip((best[0] - second[0]) * 5, 0, 1)), 2),
    }


# --------------------------------------------------------------------------- energy

def energy_curve(f: Features, step: float = 10.0) -> list[dict]:
    """0..1 energy every `step` seconds, from loudness and rhythmic density."""
    n_sec = len(f.loudness)
    loud = f.loudness.astype(np.float64)
    dens = np.add.reduceat(f.onset, np.arange(0, len(f.onset), int(FPS)))[:n_sec].astype(np.float64)
    bright = (f.bands[:, N_BANDS // 2:].sum(axis=1) / (f.bands.sum(axis=1) + 1e-12))[:n_sec]

    def norm(x):
        lo, hi = np.percentile(x, 5), np.percentile(x, 98)
        return np.clip((x - lo) / (hi - lo + 1e-9), 0, 1)

    raw = 0.5 * norm(loud) + 0.35 * norm(dens) + 0.15 * norm(bright)
    smooth = uniform_filter1d(raw, size=max(3, int(step * 2)))
    times = np.arange(0, n_sec, step)
    return [{'t': float(t), 'v': round(float(smooth[min(int(t), n_sec - 1)]), 3)} for t in times]


def mean_energy(curve: list[dict], start: float, end: float) -> float:
    vals = [p['v'] for p in curve if start <= p['t'] < end]
    return round(float(np.mean(vals)), 3) if vals else 0.0


# --------------------------------------------------------------------------- segmentation

def _segment_features(f: Features) -> np.ndarray:
    """Per-second vectors that change when the track changes: timbre shape + harmony."""
    logb = np.log(f.bands + 1e-10)
    timbre = logb - logb.mean(axis=1, keepdims=True)        # spectral shape, loudness removed
    timbre = (timbre - timbre.mean(axis=0)) / (timbre.std(axis=0) + 1e-6)
    n_sec = len(f.bands)
    per_sec = int(round(CHROMA_FPS))
    c = f.chroma[: n_sec * per_sec]
    if len(c) < n_sec * per_sec:
        c = np.vstack([c, np.zeros((n_sec * per_sec - len(c), 12), dtype=c.dtype)])
    chroma = c.reshape(n_sec, per_sec, 12).mean(axis=1)
    chroma = chroma / (np.linalg.norm(chroma, axis=1, keepdims=True) + 1e-9)
    chroma = (chroma - chroma.mean(axis=0)) / (chroma.std(axis=0) + 1e-6)
    feats = np.hstack([timbre, 0.9 * chroma])
    return uniform_filter1d(feats, size=6, axis=0)


def novelty(f: Features, scales=(12, 24, 40)) -> np.ndarray:
    """Foote novelty: how different the next L seconds are from the previous L seconds."""
    x = _segment_features(f)
    x = x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-9)
    n = len(x)
    total = np.zeros(n)
    for L in scales:
        if n < 2 * L + 2:
            continue
        # Mean similarity inside past/future blocks minus across them, via cumulative sums
        # of the projections (cheap: no n x n matrix).
        cs = np.vstack([np.zeros((1, x.shape[1])), np.cumsum(x, axis=0)])
        nov = np.zeros(n)
        for t in range(L, n - L):
            past = (cs[t] - cs[t - L]) / L
            fut = (cs[t + L] - cs[t]) / L
            within = 0.5 * (past @ past + fut @ fut)
            nov[t] = within - past @ fut
        nov /= (nov.max() + 1e-9)
        total += nov
    return total / max(1, len(scales))


def boundaries(f: Features, min_gap: float = 50.0, sensitivity: float = 1.0) -> list[float]:
    """Seconds where a new track probably takes over. Errs towards too many (recognition merges)."""
    nov = novelty(f)
    if not nov.any():
        return []
    med = median_filter(nov, size=121, mode='nearest')
    thresh = med + 0.12 / sensitivity
    peaks, _ = sps.find_peaks(nov, height=thresh, distance=int(min_gap))
    # Drop peaks in the first/last 20 s (intro noise, applause).
    return [float(p) for p in peaks if 20 <= p <= f.duration - 20]


# --------------------------------------------------------------------------- transitions

def _atoms(X: np.ndarray, k: int = 4, iters: int = 15) -> np.ndarray:
    """k spectral snapshots of a track (k-means on log power), e.g. one per chord or section."""
    if len(X) <= k:
        return X.copy()
    L = np.log(X + 1e-10)
    cent = L[np.linspace(0, len(L) - 1, k).astype(int)]
    for _ in range(iters):
        lab = ((L[:, None, :] - cent[None]) ** 2).sum(-1).argmin(1)
        cent = np.array([L[lab == j].mean(0) if (lab == j).any() else cent[j] for j in range(k)])
    return np.array([X[lab == j].mean(0) for j in range(k) if (lab == j).any()])


def _share(P: np.ndarray, atoms_a: np.ndarray, atoms_b: np.ndarray) -> np.ndarray:
    """How much of each frame is track B (0..1), from non-negative unmixing.

    Each frame is explained as a non-negative mix of A's and B's snapshots; frequency bins
    are weighted equally so the bass does not decide alone. The share is amplitude-like
    (square root of energy), which tracks a DJ's fader position more closely than power.
    """
    w = 1.0 / (atoms_a.mean(0) + atoms_b.mean(0) + 1e-12)
    D = np.vstack([atoms_a, atoms_b]).T * w[:, None]
    na = len(atoms_a)
    out = np.empty(len(P))
    for t in range(len(P)):
        x, _ = nnls(D, P[t] * w)
        ea = (D[:, :na] @ x[:na]).sum()
        eb = (D[:, na:] @ x[na:]).sum()
        out[t] = np.sqrt(eb) / (np.sqrt(ea) + np.sqrt(eb) + 1e-12)
    return out


def _ramp_fit(share: np.ndarray) -> tuple[int, int, float]:
    """Fit share(t) ~ clip((t - s) / (e - s), 0, 1): the fade-in that best explains the curve."""
    n = len(share)
    t = np.arange(n)
    best = (np.inf, 0, n - 1)
    for s in range(0, n - 1):
        e = np.arange(s + 1, n)
        model = np.clip((t[None, :] - s) / (e[:, None] - s), 0, 1)
        err = np.abs(model - share[None, :]).sum(axis=1)
        j = int(np.argmin(err))
        if err[j] < best[0]:
            best = (float(err[j]), s, int(e[j]))
    return best[1], best[2], best[0] / max(1, n)


def blend_window(f: Features, prev_start: float, boundary: float, next_end: float) -> dict:
    """When track B fades in over track A around `boundary` (all in mix seconds).

    Returns {'start', 'end', 'seconds', 'confidence', 'bass_swap'}: the fade-in start and end,
    its length, a 0..1 confidence and, when the low end switched much faster than the rest,
    the second of that bass swap.
    """
    n_sec = len(f.spec)
    b = int(round(boundary))
    fallback = {'start': max(prev_start, boundary - 8), 'end': min(next_end, boundary + 8),
                'seconds': 16.0, 'confidence': 0.0, 'bass_swap': None}
    ref_a = (max(int(prev_start), b - 150), b - 35)
    ref_b = (b + 35, min(int(next_end), b + 150, n_sec))
    if ref_a[1] - ref_a[0] < 10:
        ref_a = (int(prev_start), b - 12)
    if ref_b[1] - ref_b[0] < 10:
        ref_b = (b + 12, min(int(next_end), n_sec))
    if ref_a[1] - ref_a[0] < 5 or ref_b[1] - ref_b[0] < 5:
        return fallback

    S = uniform_filter1d(f.spec.astype(np.float64), size=2, axis=0)
    atoms_a, atoms_b = _atoms(S[ref_a[0]:ref_a[1]]), _atoms(S[ref_b[0]:ref_b[1]])
    lo, hi = max(int(prev_start), b - 100), min(int(next_end), b + 100, n_sec)
    if hi - lo < 20:
        return fallback
    P = S[lo:hi]
    raw = median_filter(_share(P, atoms_a, atoms_b), size=5, mode='nearest')

    # Rescale so A on its own reads 0 and B on its own reads 1.
    left = raw[: max(1, ref_a[1] - lo)]
    right = raw[max(0, ref_b[0] - lo):]
    l0 = float(np.median(left))
    r0 = float(np.median(right)) if len(right) else 1.0
    if r0 - l0 < 0.2:
        return fallback  # the two tracks sound too alike to separate
    share = np.clip((raw - l0) / (r0 - l0), 0, 1)
    s, e, err = _ramp_fit(share)
    start, end = float(lo + s), float(lo + e)

    bass_swap = None
    low = np.fft.rfftfreq(N_FFT, 1 / SR)[: 2 * FINE_BINS : 2] < 200
    if end - start >= 12 and low.sum() >= 4:
        sl = median_filter(_share(P[:, low], atoms_a[:, low], atoms_b[:, low]), size=3, mode='nearest')
        ll = float(np.median(sl[: max(1, ref_a[1] - lo)]))
        lr = float(np.median(sl[max(0, ref_b[0] - lo):])) if ref_b[0] - lo < len(sl) else 1.0
        if lr - ll > 0.2:
            ls, le, _ = _ramp_fit(np.clip((sl - ll) / (lr - ll), 0, 1))
            if le - ls <= max(8, 0.4 * (end - start)) and start <= lo + ls <= end:
                bass_swap = float(lo + (ls + le) / 2)

    conf = float(np.clip(1 - 2.5 * err, 0, 1) * np.clip((r0 - l0) / 0.6, 0, 1))
    return {'start': start, 'end': end, 'seconds': end - start, 'confidence': round(conf, 2), 'bass_swap': bass_swap}


# --------------------------------------------------------------------------- helpers

def camelot_relation(a: str | None, b: str | None) -> str:
    """How two Camelot codes mix, in DJ terms."""
    if not a or not b:
        return 'unknown'
    na, la = int(a[:-1]), a[-1]
    nb, lb = int(b[:-1]), b[-1]
    d = min((na - nb) % 12, (nb - na) % 12)
    if d == 0 and la == lb:
        return 'same key'
    if d == 0:
        return 'relative major/minor'
    if d == 1 and la == lb:
        return 'adjacent (+/-1)'
    if d == 2 and la == lb:
        return 'energy boost (+2)'
    if d == 1:
        return 'diagonal'
    return 'key clash'
