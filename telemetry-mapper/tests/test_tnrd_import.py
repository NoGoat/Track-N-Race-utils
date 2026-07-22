import gzip
import json
from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tnrd_import import read_slm_recording, slm_zones_for_map


def _write_v1(path, rows):
    header = {
        'magic': 'TNRD_V1',
        'protocol': 2026,
        'track_id': 7,
        'track_name': 'Silverstone',
        'session_type': 10,
        'session_name': 'Race',
        'start_time': 0,
    }
    with gzip.open(path, 'wt', encoding='utf-8') as stream:
        for row in (header, *rows):
            stream.write(json.dumps(row) + '\n')


def _positions(x, z):
    return {
        'type': 'positions',
        'player_idx': 1,
        'cars': [{'idx': 0, 'x': -1, 'z': -1}, {'idx': 1, 'x': x, 'z': z}],
    }


def test_reads_player_position_at_slm_transitions(tmp_path):
    path = tmp_path / 'session.tnrd'
    _write_v1(path, [
        _positions(10, 20),
        {'type': 'telemetry', 'session_time': 1, 'slm': 0},
        _positions(30, 40),
        {'type': 'telemetry', 'session_time': 2, 'slm': 1},
        _positions(50, 60),
        {'type': 'telemetry', 'session_time': 3, 'slm': 0},
    ])

    recording = read_slm_recording(path)

    assert recording.header['track_id'] == 7
    assert recording.telemetry_samples == 3
    assert recording.position_samples == 3
    assert recording.events == [
        {'type': 'activate', 'x': 30.0, 'z': 40.0},
        {'type': 'deactivate', 'x': 50.0, 'z': 60.0},
    ]


def test_defers_transition_until_first_position(tmp_path):
    path = tmp_path / 'session.tnrd'
    _write_v1(path, [
        {'type': 'telemetry', 'session_time': 1, 'slm': 1},
        _positions(10, 20),
        {'type': 'telemetry', 'session_time': 2, 'slm': 0},
    ])

    recording = read_slm_recording(path)

    assert recording.events == [
        {'type': 'activate', 'x': 10.0, 'z': 20.0},
        {'type': 'deactivate', 'x': 10.0, 'z': 20.0},
    ]


def test_projects_imported_zone_onto_existing_map(tmp_path):
    path = tmp_path / 'session.tnrd'
    _write_v1(path, [
        _positions(10, 0),
        {'type': 'telemetry', 'session_time': 1, 'slm': 1},
        _positions(30, 0),
        {'type': 'telemetry', 'session_time': 2, 'slm': 0},
    ])
    final_map = {
        'transform': {'min_x': 0, 'min_z': 0, 'scale': 1, 'off_x': 0, 'off_z': 0},
        'sectors': [{
            'index': 1,
            'points': [[x, 0] for x in range(200)],
        }],
    }

    zones = slm_zones_for_map(final_map, read_slm_recording(path))

    assert zones == [{
        'start': [10.0, 0.0],
        'end': [30.0, 0.0],
    }]
