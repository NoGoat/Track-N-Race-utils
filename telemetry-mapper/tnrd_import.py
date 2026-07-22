"""Read Straight Line Mode zones from Track N Race ``.tnrd`` recordings.

TNRD is a compressed JSONL stream.  The first line is a container header and
the remaining lines are the rows written by ``protocol_parser_library``.  SLM
state lives on telemetry rows while the player's world position lives on
positions rows, so the two streams are joined in recording order here.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import gzip
import io
import json
from pathlib import Path
import shutil
import subprocess

from record_slm_zones import _zones_for_map


GZIP_MAGIC = b'\x1f\x8b'
ZSTD_MAGIC = b'\x28\xb5\x2f\xfd'


class TnrdImportError(Exception):
    """A user-facing TNRD decoding or validation error."""


@dataclass
class SlmRecording:
    header: dict
    events: list[dict]
    telemetry_samples: int
    position_samples: int


def _zstd_module_stream(path: Path):
    """Return a binary Zstandard reader from an installed Python module."""
    try:
        import zstandard  # type: ignore[import-not-found]
    except ImportError:
        zstandard = None
    if zstandard is not None:
        source = path.open('rb')
        return zstandard.ZstdDecompressor().stream_reader(source), source

    try:
        import pyzstd  # type: ignore[import-not-found]
    except ImportError:
        pyzstd = None
    if pyzstd is not None:
        return pyzstd.open(path, 'rb'), None

    # Python 3.14 gained a standard-library Zstandard module.
    try:
        from compression import zstd  # type: ignore[import-not-found]
    except ImportError:
        zstd = None
    if zstd is not None:
        return zstd.open(path, 'rb'), None

    return None, None


@contextmanager
def _open_tnrd_text(path: Path):
    try:
        with path.open('rb') as source:
            signature = source.read(4)
    except OSError as exc:
        raise TnrdImportError(f'Cannot open the recording: {exc}') from exc

    if signature.startswith(GZIP_MAGIC):
        try:
            with gzip.open(path, 'rt', encoding='utf-8') as stream:
                yield stream, 'gzip'
        except (OSError, EOFError) as exc:
            raise TnrdImportError(f'Cannot decompress the gzip TNRD file: {exc}') from exc
        return

    if signature != ZSTD_MAGIC:
        raise TnrdImportError('Unknown TNRD compression signature.')

    binary, source = _zstd_module_stream(path)
    if binary is not None:
        try:
            with binary:
                with io.TextIOWrapper(binary, encoding='utf-8') as stream:
                    yield stream, 'zstd'
        except (OSError, EOFError) as exc:
            raise TnrdImportError(f'Cannot decompress the Zstandard TNRD file: {exc}') from exc
        finally:
            if source is not None and not source.closed:
                source.close()
        return

    zstd_exe = shutil.which('zstd')
    if zstd_exe:
        proc = subprocess.Popen(
            [zstd_exe, '--decompress', '--stdout', '--quiet', str(path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert proc.stdout is not None
        stream = io.TextIOWrapper(proc.stdout, encoding='utf-8')
        try:
            yield stream, 'zstd'
        finally:
            stream.close()
            stderr = proc.stderr.read().decode('utf-8', errors='replace') if proc.stderr else ''
            return_code = proc.wait()
            if return_code:
                raise TnrdImportError(
                    f'Cannot decompress the Zstandard TNRD file: '
                    f'{stderr.strip() or "zstd failed"}')
        return

    raise TnrdImportError(
        'Zstandard support is required for this TNRD file. Install it with '
        '"python -m pip install zstandard" (or install the zstd command-line tool).')


def _read_json(line: str, line_number: int) -> dict:
    try:
        value = json.loads(line)
    except json.JSONDecodeError as exc:
        raise TnrdImportError(
            f'Invalid JSON in the TNRD file at decompressed line {line_number}: {exc.msg}.') from exc
    if not isinstance(value, dict):
        raise TnrdImportError(
            f'Invalid TNRD row at decompressed line {line_number}: expected an object.')
    return value


def _validate_header(header: dict, codec: str):
    expected_magic = 'TNRD_V2' if codec == 'zstd' else 'TNRD_V1'
    if header.get('magic') != expected_magic:
        raise TnrdImportError(
            f'TNRD header/container mismatch: expected {expected_magic}, '
            f'found {header.get("magic", "no magic value")!r}.')
    compression = header.get('compression')
    if codec == 'zstd' and compression != 'zstd':
        raise TnrdImportError('The TNRD V2 header does not declare Zstandard compression.')
    if codec == 'gzip' and compression not in (None, 'gzip'):
        raise TnrdImportError('The TNRD V1 header does not match gzip compression.')


def _player_position(row: dict) -> tuple[float, float] | None:
    player_idx = row.get('player_idx')
    cars = row.get('cars')
    if not isinstance(player_idx, int) or not isinstance(cars, list):
        return None
    for array_idx, car in enumerate(cars):
        if not isinstance(car, dict):
            continue
        if car.get('idx', array_idx) != player_idx:
            continue
        x, z = car.get('x'), car.get('z')
        if isinstance(x, (int, float)) and isinstance(z, (int, float)):
            return float(x), float(z)
    return None


def read_slm_recording(path: str | Path) -> SlmRecording:
    """Decode a TNRD and return player-positioned SLM transition events."""
    path = Path(path)
    latest_position = None
    pending_transition = None
    last_slm = 0
    events = []
    telemetry_samples = 0
    position_samples = 0

    with _open_tnrd_text(path) as (stream, codec):
        header_line = stream.readline()
        if not header_line:
            raise TnrdImportError('The TNRD file is empty.')
        header = _read_json(header_line, 1)
        _validate_header(header, codec)

        for line_number, line in enumerate(stream, start=2):
            if not line.strip():
                continue
            row = _read_json(line, line_number)
            row_type = row.get('type')

            if row_type == 'positions':
                position = _player_position(row)
                if position is None:
                    continue
                latest_position = position
                position_samples += 1
                if pending_transition is not None:
                    events.append({
                        'type': pending_transition,
                        'x': position[0],
                        'z': position[1],
                    })
                    pending_transition = None
                continue

            if row_type != 'telemetry' or 'slm' not in row:
                continue
            telemetry_samples += 1
            try:
                slm = 1 if int(row['slm']) else 0
            except (TypeError, ValueError) as exc:
                raise TnrdImportError(
                    f'Invalid Straight Line Mode value at decompressed line {line_number}.') from exc
            if slm == last_slm:
                continue

            transition = 'activate' if slm else 'deactivate'
            if latest_position is None:
                pending_transition = transition
            else:
                events.append({
                    'type': transition,
                    'x': latest_position[0],
                    'z': latest_position[1],
                })
            last_slm = slm

    return SlmRecording(
        header=header,
        events=events,
        telemetry_samples=telemetry_samples,
        position_samples=position_samples,
    )


def slm_zones_for_map(final_map: dict, recording: SlmRecording) -> list[dict]:
    """Snap a recording's SLM transitions to an existing finalized map."""
    if not final_map.get('transform'):
        raise TnrdImportError(
            'The open map has no world-to-map transform, so TNRD points cannot be imported.')
    try:
        projected = _zones_for_map(final_map, recording.events)
        # Final map files persist endpoints only; both Track N Race frontends
        # reconstruct each zone's centreline slice at load time.
        return [{'start': zone['start'], 'end': zone['end']} for zone in projected]
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        raise TnrdImportError(f'Could not project the TNRD points onto this map: {exc}') from exc
