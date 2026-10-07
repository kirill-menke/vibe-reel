"""A torrent's file as it downloads: written piece by piece, with qBittorrent's
pieceStates view of it (0 pending, 1 downloading, 2 downloaded).

The file is created at its full size (sparse, like qBittorrent's
pre-allocation) and pieces are copied in from `source` bytes as the test
"downloads" them, so a reader that respects pieceStates only ever sees real
bytes, and a reader that doesn't sees zeros — which tests can detect.

`offset` is where this file starts in the torrent's piece space (the sizes of
the files before it in a multi-file torrent), so byte->piece math in
streaming.py/livehls.py is exercised with a non-zero offset too.
"""

from __future__ import annotations

import os
from pathlib import Path


class GrowingFile:
    def __init__(self, path: Path, source: bytes, piece_size: int = 64 * 1024, offset: int = 0,
                 torrent_size: int | None = None):
        assert piece_size > 0
        self.path = Path(path)
        self.source = source
        self.size = len(source)
        self.piece_size = piece_size
        self.offset = offset
        total = torrent_size if torrent_size is not None else offset + self.size
        self.n_pieces = max(1, -(-total // piece_size))
        self.states = [0] * self.n_pieces
        # pieces before this file (other files of the torrent) count as done
        for p in range(0, offset // piece_size):
            self.states[p] = 2
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "wb") as f:
            f.truncate(self.size)

    # ---- piece math ----
    def piece_of(self, file_byte: int) -> int:
        return (self.offset + file_byte) // self.piece_size

    def _file_span(self, piece: int) -> tuple[int, int]:
        """[start, end) of `piece` in file coordinates, clipped to the file."""
        start = piece * self.piece_size - self.offset
        end = start + self.piece_size
        return max(start, 0), min(end, self.size)

    # ---- downloading ----
    def complete_piece(self, piece: int) -> None:
        s, e = self._file_span(piece)
        if e > s:
            with open(self.path, "r+b") as f:
                f.seek(s)
                f.write(self.source[s:e])
        self.states[piece] = 2

    def complete_pieces(self, first: int, last: int) -> None:
        for p in range(first, last + 1):
            self.complete_piece(p)

    def grow_to(self, file_byte: int) -> None:
        """Sequential download: every piece holding bytes [0, file_byte) done."""
        if file_byte <= 0:
            return
        last = self.piece_of(min(file_byte, self.size) - 1)
        self.complete_pieces(self.piece_of(0), last)
        if last + 1 < self.n_pieces and self.states[last + 1] == 0:
            self.states[last + 1] = 1  # the frontier piece is "downloading"

    def first_last(self) -> None:
        """qBittorrent's first/last-piece priority: both ends of the file."""
        self.complete_piece(self.piece_of(0))
        self.complete_piece(self.piece_of(self.size - 1))

    def complete(self) -> None:
        self.complete_pieces(0, self.n_pieces - 1)

    @property
    def progress(self) -> float:
        return sum(1 for s in self.states if s == 2) / len(self.states)

    @property
    def is_complete(self) -> bool:
        return all(s == 2 for s in self.states)

    def piece_states(self) -> list[int]:
        return list(self.states)

    def on_disk(self) -> bytes:
        return self.path.read_bytes()

    def move(self, new_path: Path) -> None:
        """qBittorrent's incomplete/ -> complete/ move (a rename on one fs)."""
        new_path = Path(new_path)
        new_path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(self.path, new_path)
        self.path = new_path
