"""Synthetic songs and DJ mixes with known ground truth, for testing the analysis."""
from __future__ import annotations

import numpy as np
from scipy import signal as sps

SR = 16000

MINOR_PROG = [0, 0, 8, 10]   # i - i - VI - VII (semitones above tonic)
MAJOR_PROG = [0, 0, 5, 7]    # I - I - IV - V
# Chord quality per scale degree: third of 3 (minor) or 4 (major) semitones.
MINOR_THIRDS = {0: 3, 8: 4, 3: 4, 10: 4}
MAJOR_THIRDS = {0: 4, 5: 4, 7: 4, 9: 3}


def _note(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def make_song(bpm: float, tonic: int, minor: bool, seconds: float, seed: int, style: int = 0) -> np.ndarray:
    """A loop-based dance track: kick, hats, optional clap, bassline and chord pad in a key."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    beat = 60.0 / bpm

    # Kick on every beat.
    kick_len = int(0.25 * SR)
    kt = np.arange(kick_len) / SR
    kick = np.sin(2 * np.pi * (45 * kt + (120 - 45) * (1 - np.exp(-kt * 30)) / 30)) * np.exp(-kt * 14)
    # Hat: short high noise burst on the off-beat.
    hat_len = int(0.05 * SR)
    b, a = sps.butter(4, 5000 / (SR / 2), 'high')
    hat = sps.lfilter(b, a, rng.standard_normal(hat_len)) * np.exp(-np.arange(hat_len) / (0.012 * SR))
    clap_len = int(0.12 * SR)
    b2, a2 = sps.butter(2, [900 / (SR / 2), 3000 / (SR / 2)], 'band')
    clap = sps.lfilter(b2, a2, rng.standard_normal(clap_len)) * np.exp(-np.arange(clap_len) / (0.03 * SR))

    n_beats = int(seconds / beat)
    for i in range(n_beats):
        s = int(i * beat * SR)
        e = min(n, s + kick_len)
        out[s:e] += 0.9 * kick[: e - s]
        hs = int((i + 0.5) * beat * SR)
        he = min(n, hs + hat_len)
        if hs < n:
            out[hs:he] += (0.25 + 0.1 * style) * hat[: he - hs]
        if style % 2 == 1 and i % 2 == 1:
            ce = min(n, s + clap_len)
            out[s:ce] += 0.35 * clap[: ce - s]

    # Chords change every bar (4 beats); bassline plays the chord root in 8th notes.
    prog = MINOR_PROG if minor else MAJOR_PROG
    bar = 4 * beat
    harmonics = 3 + style
    for i in range(int(seconds / bar) + 1):
        s = int(i * bar * SR)
        e = min(n, int((i + 1) * bar * SR))
        if s >= n:
            break
        root = 48 + tonic + prog[i % len(prog)]  # around C3
        chord_third = (MINOR_THIRDS if minor else MAJOR_THIRDS)[prog[i % len(prog)]]
        seg = t[s:e]
        pad = np.zeros(e - s)
        for semis in (0, chord_third, 7, 12):
            f0 = _note(root + 12 + semis)
            for h in range(1, harmonics + 1):
                pad += np.sin(2 * np.pi * f0 * h * seg) / (h * 1.6)
        env = np.minimum(1, (seg - seg[0]) / 0.05) * np.minimum(1, (seg[-1] - seg) / 0.05 + 0.01)
        out[s:e] += 0.05 * pad * env
        # bass: root, 8th notes
        eighth = beat / 2
        for k in range(8):
            bs = s + int(k * eighth * SR)
            be = min(e, bs + int(eighth * 0.8 * SR))
            if bs >= e:
                break
            bt = np.arange(be - bs) / SR
            f0 = _note(root - 12)
            note = np.sin(2 * np.pi * f0 * bt) + 0.4 * np.sin(2 * np.pi * 2 * f0 * bt)
            out[bs:be] += 0.22 * note * np.exp(-bt * 3)
    return out / (np.abs(out).max() + 1e-9) * 0.7


def _split(x: np.ndarray, cutoff: float = 200.0):
    b, a = sps.butter(4, cutoff / (SR / 2), 'low')
    low = sps.filtfilt(b, a, x)
    return low, x - low


def make_mix(specs: list[dict], blends: list[float], bass_swap: bool = False):
    """Play songs back to back with crossfades of `blends[i]` seconds between song i and i+1.

    Returns (int16 pcm, truth) where truth has each song's start/end in the mix and each blend.
    """
    songs = [make_song(**s) for s in specs]
    starts, pos = [], 0.0
    for i, s in enumerate(songs):
        starts.append(pos)
        dur = len(s) / SR
        if i < len(blends):
            pos += dur - blends[i]
    total = int((starts[-1] + len(songs[-1]) / SR) * SR)
    mix = np.zeros(total)
    for i, s in enumerate(songs):
        s = s.copy()
        n = len(s)
        fade_in = blends[i - 1] if i > 0 else 0
        fade_out = blends[i] if i < len(blends) else 0
        gain = np.ones(n)
        if fade_in:
            k = int(fade_in * SR)
            gain[:k] = np.linspace(0, 1, k)
        if fade_out:
            k = int(fade_out * SR)
            gain[n - k:] = np.minimum(gain[n - k:], np.linspace(1, 0, k))
        if bass_swap and (fade_in or fade_out):
            low, high = _split(s)
            lg = np.ones(n)
            if fade_in:
                k = int(fade_in * SR)
                lg[: k // 2] = 0  # incoming bass held back until the middle of the blend
            if fade_out:
                k = int(fade_out * SR)
                lg[n - k + k // 2:] = 0  # outgoing bass cut at the middle
            s = low * lg + high * gain
        else:
            s = s * gain
        a = int(starts[i] * SR)
        mix[a:a + n] += s
    mix = mix / (np.abs(mix).max() + 1e-9) * 0.9
    truth = {
        'starts': starts,
        'ends': [starts[i] + len(songs[i]) / SR for i in range(len(songs))],
        'blends': [(starts[i + 1], starts[i + 1] + blends[i]) for i in range(len(blends))],
    }
    return (mix * 32767).astype(np.int16), truth
