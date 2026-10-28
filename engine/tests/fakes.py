"""A recognizer that knows the synthetic mix, standing in for Shazam/AudD in tests."""
from __future__ import annotations

import io
import wave

import numpy as np

from discojockey_engine.recognize import Match, Recognizer, search_links

SR = 16000


class FakeRecognizer(Recognizer):
    name = 'fake'

    def __init__(self, pcm: np.ndarray, truth: dict, songs: list[tuple[str, str] | None]):
        self.pcm = pcm
        self.starts = truth['starts']
        self.ends = truth['ends']
        self.songs = songs          # (artist, title) per song, None = not in the database
        self.requests = 0

    def _locate(self, clip: np.ndarray) -> float:
        head = clip[:64]
        cands = np.flatnonzero(self.pcm[: len(self.pcm) - 64] == head[0])
        for c in cands:
            if np.array_equal(self.pcm[c:c + 64], head):
                return c / SR
        raise AssertionError('clip not found in mix')

    async def identify(self, wav: bytes) -> Match | None:
        self.requests += 1
        with wave.open(io.BytesIO(wav)) as w:
            clip = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        t = self._locate(clip)
        mid = t + 6
        # The loudest song at the clip's middle: the one whose fade-in passed half way.
        playing = [i for i in range(len(self.starts)) if self.starts[i] <= mid < self.ends[i]]
        i = playing[-1] if len(playing) == 1 else self._dominant(playing, mid)
        if self.songs[i] is None:
            return None
        artist, title = self.songs[i]
        return Match(title=title, artist=artist, offset=t - self.starts[i], provider='fake',
                     genre='Electronic', label='Test Records', links=search_links(artist, title))

    def _dominant(self, playing, mid):
        a, b = playing[0], playing[-1]
        blend_mid = (self.starts[b] + self.ends[a]) / 2
        return b if mid >= blend_mid else a
