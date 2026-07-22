"""
live_mapper.py — Combined live telemetry recorder + track viewer for F1 25
(2026 Season Pack).

Starts listening for F1 25 UDP telemetry as soon as it's launched. While a
session is being recorded (SSTA -> SEND), every point, DRS unlock/lock, and
SLM (Active Aero Mode) activate/deactivate event is plotted on the canvas in
real time, so the map can be checked visually while still driving instead of
after the fact.

Weather is chosen with the Dry/Wet radio buttons in the toolbar (not a
terminal prompt) and decides whether the SLM zones detected this session are
written as slm_dry or slm_wet.

On session end (or the "Finalize Now" button):
  - If telemetry-mapper/final_json/track_<id>.json already exists, only the
    slm_dry/slm_wet key is added/replaced — every other key is left alone.
  - If it doesn't exist yet, a full map (sectors, drs_zones, speed_traps,
    start_finish, slm_dry/slm_wet) is built and written for the first time.

This script is fully self-contained (no imports from convert_track.py,
record_slm_zones.py, or view_track.py).

Run: python live_mapper.py
"""

import socket
import struct
import json
import math
import threading
import queue
import tkinter as tk
from tkinter import messagebox
from pathlib import Path

# ───────────────────────────── constants ────────────────────────────────────

UDP_PORT       = 20777
MIN_DIST       = 2.0   # metres between recorded points
FINAL_JSON_DIR = Path(__file__).parent / 'final_json'

VIEWBOX     = 1000        # the final JSON's own canvas space
PAD         = 50          # padding inside that 1000×1000 space
DEDUP_DIST  = 1.0         # metres — drop consecutive points closer than this
PROX_THRESH = 100         # metres — DRS / SLM / crossing cluster radius

CANVAS_W  = 900           # live Tkinter canvas size (separate from VIEWBOX)
CANVAS_H  = 800
PADDING   = 60
MAP_ROT_PAD = 24          # padding around the *rotated* bounds, matching TrackMap.tsx's MAP_PAD

LAP_COLORS = ['#5794F2', '#73BF69', '#FADE2A', '#F2495C', '#FF9830',
              '#B877D9', '#19B8C2', '#E05F73', '#8AB8FF', '#96D98D']

DRS_ACTIVATE_COLOR   = '#73BF69'
DRS_DEACTIVATE_COLOR = '#F2495C'
SLM_ACTIVATE_COLOR   = '#FFB86C'
SLM_DEACTIVATE_COLOR = '#BD93F9'

# ── Per-format packet geometry ───────────────────────────────────────────────
# The F1 25 base game streams 22-car arrays; the 2026 Season Pack streams
# 24-car arrays with re-sized per-car structs (Motion 60->54, Car Telemetry
# 60->59). The per-car stride MUST match the streaming format, otherwise the
# player car's slot is read at the wrong offset — which silently zeroed every
# recorded world position on 2026 sessions, collapsing all SLM/DRS zones onto
# a single map point. Keyed by total UDP packet length (fixed per format), with
# a packet-format fallback for any size not tabulated.
MOTION_STRIDE_BY_LEN = {1349: 60, 1325: 54}  # PacketMotionData        (v3 / 2026)
CARTEL_STRIDE_BY_LEN = {1352: 60, 1448: 59}  # PacketCarTelemetryData  (v3 / 2026)


def _car_stride(data: bytes, by_len: dict[int, int], old: int, new: int) -> int:
    """Per-car struct stride for a packet, detected from its length, falling
    back to the packet-format field (uint16 at header offset 0) for any size
    we don't have tabulated (>= 2026 => new 24-car layout)."""
    stride = by_len.get(len(data))
    if stride is not None:
        return stride
    packet_format = struct.unpack_from('<H', data, 0)[0]
    return new if packet_format >= 2026 else old

TRACK_NAMES: dict[int, tuple[str, str]] = {
    0:  ('Australian Grand Prix',      'Albert Park Circuit'),
    2:  ('Chinese Grand Prix',         'Shanghai International Circuit'),
    3:  ('Bahrain Grand Prix',         'Bahrain International Circuit'),
    4:  ('Spanish Grand Prix',         'Circuit de Barcelona-Catalunya'),
    5:  ('Monaco Grand Prix',          'Circuit de Monaco'),
    6:  ('Canadian Grand Prix',        'Circuit Gilles Villeneuve'),
    7:  ('British Grand Prix',         'Silverstone Circuit'),
    9:  ('Hungarian Grand Prix',       'Hungaroring'),
    10: ('Belgian Grand Prix',         'Circuit de Spa-Francorchamps'),
    11: ('Italian Grand Prix',         'Autodromo Nazionale Monza'),
    12: ('Singapore Grand Prix',       'Marina Bay Street Circuit'),
    13: ('Japanese Grand Prix',        'Suzuka International Racing Course'),
    14: ('Abu Dhabi Grand Prix',       'Yas Marina Circuit'),
    15: ('United States Grand Prix',   'Circuit of the Americas'),
    16: ('São Paulo Grand Prix',       'Autódromo José Carlos Pace'),
    17: ('Austrian Grand Prix',        'Red Bull Ring'),
    19: ('Mexico City Grand Prix',     'Autódromo Hermanos Rodríguez'),
    20: ('Azerbaijan Grand Prix',      'Baku City Circuit'),
    26: ('Dutch Grand Prix',           'Circuit Zandvoort'),
    27: ('Emilia Romagna Grand Prix',  'Autodromo Enzo e Dino Ferrari'),
    29: ('Saudi Arabian Grand Prix',   'Jeddah Corniche Circuit'),
    30: ('Miami Grand Prix',           'Miami International Autodrome'),
    31: ('Las Vegas Grand Prix',       'Las Vegas Street Circuit'),
    32: ('Qatar Grand Prix',           'Losail International Circuit'),
    39: ('British Grand Prix',         'Silverstone Circuit (Reverse)'),
    40: ('Austrian Grand Prix',        'Red Bull Ring (Reverse)'),
    41: ('Dutch Grand Prix',           'Circuit Zandvoort (Reverse)'),
}


# ── Data cleaning ─────────────────────────────────────────────────────────────

def _iqr_bounds(values: list[float], k: float = 3.5) -> tuple[float, float]:
    s = sorted(values)
    n = len(s)
    q1, q3 = s[n // 4], s[(3 * n) // 4]
    iqr = q3 - q1
    return q1 - k * iqr, q3 + k * iqr


def _clean_points(points: list, track_length_m: float) -> list:
    if len(points) < 4:
        return points

    xs = [p[0] for p in points]
    zs = [p[2] for p in points]
    x_lo, x_hi = _iqr_bounds(xs)
    z_lo, z_hi = _iqr_bounds(zs)
    iqr_clean = [p for p in points if x_lo <= p[0] <= x_hi and z_lo <= p[2] <= z_hi]

    max_jump = (track_length_m or 10000) * 0.5
    jump_clean: list = []
    for p in iqr_clean:
        if jump_clean and math.hypot(p[0] - jump_clean[-1][0], p[2] - jump_clean[-1][2]) > max_jump:
            continue
        jump_clean.append(p)

    if not jump_clean:
        return jump_clean

    segments: list[list] = [[jump_clean[0]]]
    for p in jump_clean[1:]:
        if math.hypot(p[0] - segments[-1][-1][0], p[2] - segments[-1][-1][2]) > 50:
            segments.append([])
        segments[-1].append(p)

    min_pts = max(20, len(jump_clean) // 100)
    return [p for seg in segments if len(seg) >= min_pts for p in seg]


def _consolidate_zones(events: list, centerline: list, on_type: str = 'unlock', off_type: str = 'lock') -> list:
    if not events or not centerline:
        return []

    instances = []
    i = 0
    while i < len(events):
        if events[i]['type'] == on_type:
            unlock = events[i]
            j = i + 1
            while j < len(events) and events[j]['type'] != off_type:
                j += 1
            if j < len(events):
                instances.append({'unlock': unlock, 'lock': events[j]})
                i = j + 1
            else:
                i += 1
        else:
            i += 1

    if not instances:
        return []

    N = len(centerline)
    is_zone = [False] * N
    for inst in instances:
        u_idx = _closest_idx(centerline, inst['unlock']['x'], inst['unlock']['z'])
        l_idx = _closest_idx(centerline, inst['lock']['x'],   inst['lock']['z'])

        curr = u_idx
        while True:
            is_zone[curr] = True
            if curr == l_idx:
                break
            curr = (curr + 1) % N

    gap_limit = 120

    start_idx = -1
    for i in range(N):
        if is_zone[i] and not is_zone[(i - 1) % N]:
            start_idx = i
            break

    if start_idx == -1:
        if any(is_zone):
            return [{'unlock': {'x': centerline[0][0], 'z': centerline[0][2]}, 'lock': {'x': centerline[-1][0], 'z': centerline[-1][2]}}]
        return []

    filled = list(is_zone)
    i = start_idx
    visited_count = 0
    while visited_count < N:
        if not filled[i]:
            gap_start = i
            gap_len = 0
            while not filled[i] and visited_count < N:
                gap_len += 1
                i = (i + 1) % N
                visited_count += 1
            if gap_len < gap_limit:
                is_straight = True
                ref_idx = (gap_start - 1) % N
                ref_dx = centerline[gap_start][0] - centerline[ref_idx][0]
                ref_dz = centerline[gap_start][2] - centerline[ref_idx][2]
                ref_len = math.hypot(ref_dx, ref_dz)
                if ref_len > 0:
                    ref_ux = ref_dx / ref_len
                    ref_uz = ref_dz / ref_len

                    curr = gap_start
                    for _ in range(gap_len):
                        next_curr = (curr + 1) % N
                        dx = centerline[next_curr][0] - centerline[curr][0]
                        dz = centerline[next_curr][2] - centerline[curr][2]
                        leng = math.hypot(dx, dz)
                        if leng > 0:
                            ux = dx / leng
                            uz = dz / leng
                            dot = ref_ux * ux + ref_uz * uz
                            if dot < 0.92:  # turns by more than ~23 degrees
                                is_straight = False
                                break
                        curr = next_curr

                if is_straight:
                    curr = gap_start
                    for _ in range(gap_len):
                        filled[curr] = True
                        curr = (curr + 1) % N
        else:
            i = (i + 1) % N
            visited_count += 1

    zones = []
    i = start_idx
    visited_count = 0
    while visited_count < N:
        if filled[i]:
            zone_start = i
            zone_len = 0
            while filled[i] and visited_count < N:
                zone_len += 1
                i = (i + 1) % N
                visited_count += 1
            zone_end = (zone_start + zone_len - 1) % N
            zones.append((zone_start, zone_end))
        else:
            i = (i + 1) % N
            visited_count += 1

    if len(zones) > 1:
        if (zones[-1][1] + 1) % N == zones[0][0]:
            merged_zone = (zones[-1][0], zones[0][1])
            zones = [merged_zone] + zones[1:-1]

    result = []
    for u_idx, l_idx in zones:
        result.append({
            'unlock': {'x': centerline[u_idx][0], 'z': centerline[u_idx][2]},
            'lock': {'x': centerline[l_idx][0], 'z': centerline[l_idx][2]},
        })
    return result


def _consolidate_by_proximity(events: list, key_x: str = 'x', key_z: str = 'z') -> list:
    clusters: list[list] = []
    for ev in events:
        ex, ez = ev[key_x], ev[key_z]
        placed = False
        for cl in clusters:
            if math.hypot(ex - cl[0][key_x], ez - cl[0][key_z]) < PROX_THRESH:
                cl.append(ev)
                placed = True
                break
        if not placed:
            clusters.append([ev])
    return [cl[0] for cl in clusters]


def _consolidate_sector_crossings(events: list) -> list:
    result = []
    for key in ((0, 1), (1, 2)):
        subset = [e for e in events if e['from_s'] == key[0] and e['to_s'] == key[1]]
        if subset:
            result.append(_consolidate_by_proximity(subset)[0])
    return result


# ── Geometry helpers ─────────────────────────────────────────────────────────

def _make_transform(points: list):
    """Transform + params for the exported JSON's 1000×1000 view_box space."""
    xs = [p[0] for p in points]
    zs = [p[2] for p in points]
    min_x, max_x = min(xs), max(xs)
    min_z, max_z = min(zs), max(zs)
    span_x = max_x - min_x or 1
    span_z = max_z - min_z or 1
    usable  = VIEWBOX - 2 * PAD
    scale   = min(usable / span_x, usable / span_z)
    off_x   = (VIEWBOX - scale * span_x) / 2
    off_z   = (VIEWBOX - scale * span_z) / 2

    params = {
        'min_x': round(min_x, 4),
        'min_z': round(min_z, 4),
        'scale': round(scale, 6),
        'off_x': round(off_x, 4),
        'off_z': round(off_z, 4),
    }

    def _t(x: float, z: float) -> list[float]:
        return [
            round((x - min_x) * scale + off_x, 2),
            round((z - min_z) * scale + off_z, 2),
        ]
    return _t, params


def _closest_idx(centerline: list[list[float]], raw_x: float, raw_z: float) -> int:
    best_i, best_d = 0, float('inf')
    for i, p in enumerate(centerline):
        d = math.hypot(p[0] - raw_x, p[2] - raw_z)
        if d < best_d:
            best_d, best_i = d, i
    return best_i


def rotate_point(x, z, cx, cz, angle_rad):
    """View-only rotation used purely for the live/final canvas display."""
    dx = x - cx
    dz = z - cz
    rx = dx * math.cos(angle_rad) - dz * math.sin(angle_rad)
    rz = dx * math.sin(angle_rad) + dz * math.cos(angle_rad)
    return rx + cx, rz + cz


def _view_transform(points: list, width: int, height: int, pad: int):
    """Transform for the live Tkinter canvas (separate from _make_transform,
    which produces the persisted JSON's own 1000×1000 space)."""
    xs = [p[0] for p in points]
    zs = [p[2] for p in points]
    min_x, max_x = min(xs), max(xs)
    min_z, max_z = min(zs), max(zs)
    span_x = max_x - min_x or 1
    span_z = max_z - min_z or 1
    scale  = min((width - 2 * pad) / span_x, (height - 2 * pad) / span_z)
    off_x  = (width  - scale * span_x) / 2
    off_z  = (height - scale * span_z) / 2

    def _t(x, z):
        return ((x - min_x) * scale + off_x, (z - min_z) * scale + off_z)
    return _t


def _view_normalize(points: list, width: int, height: int, pad: int):
    t = _view_transform(points, width, height, pad)
    return [t(p[0], p[2]) for p in points], t


def _find_sf_line(points: list, data: dict | None = None):
    for i in range(1, len(points)):
        if len(points[i]) > 3 and len(points[i - 1]) > 3:
            if points[i][3] != points[i - 1][3]:
                return i
    if data and 'sector_crossings' in data:
        sf_crossings = [c for c in data['sector_crossings'] if c.get('from_s') == 2 and c.get('to_s') == 0]
        if sf_crossings:
            sf_c = sf_crossings[0]
            best_i, best_d = 0, float('inf')
            for idx, pt in enumerate(points):
                d = math.hypot(pt[0] - sf_c['x'], pt[2] - sf_c['z'])
                if d < best_d:
                    best_d, best_i = d, idx
            return best_i
    if points:
        return 0
    return None


# ── Main conversion (mirrors convert_track.py / record_slm_zones.py) ────────

def filter_track_data(raw: dict) -> dict:
    points = raw.get('points', [])
    laps_in_points = {p[3] for p in points if len(p) > 3}
    if laps_in_points:
        complete_laps = {lap for lap in laps_in_points if lap > 1 and (lap + 1) in laps_in_points}
        filtered_points = [p for p in points if len(p) > 3 and p[3] in complete_laps]
        filtered_drs = raw.get('drs_events', [])  # keep all DRS events (including Lap 1 and incomplete laps)
        filtered_traps = [ev for ev in raw.get('speed_traps', []) if ev.get('lap') in complete_laps]
        filtered_crossings = [ev for ev in raw.get('sector_crossings', []) if ev.get('lap') in complete_laps]
        filtered_slm = raw.get('slm_events', [])  # keep all SLM events too
    else:
        filtered_points = points
        filtered_drs = raw.get('drs_events', [])
        filtered_traps = raw.get('speed_traps', [])
        filtered_crossings = raw.get('sector_crossings', [])
        filtered_slm = raw.get('slm_events', [])

    return {
        **raw,
        'points': filtered_points,
        'drs_events': filtered_drs,
        'speed_traps': filtered_traps,
        'sector_crossings': filtered_crossings,
        'slm_events': filtered_slm,
    }


def convert(raw: dict) -> dict:
    raw = filter_track_data(raw)
    track_id      = raw['track_id']
    track_length  = raw.get('track_length_m', 0)
    track_name, circuit_name = TRACK_NAMES.get(track_id, (f'Track {track_id}', ''))

    all_points = raw['points']
    all_clean = _clean_points(all_points, track_length)
    if not all_clean:
        raise ValueError('No usable points after cleaning.')

    lap_groups: dict[int, list] = {}
    for p in all_clean:
        lap = p[3] if len(p) > 3 else 0
        lap_groups.setdefault(lap, []).append(p)
    ref_lap_pts = max(lap_groups.values(), key=len)

    centerline: list = [ref_lap_pts[0]]
    for p in ref_lap_pts[1:]:
        if math.hypot(p[0] - centerline[-1][0], p[2] - centerline[-1][2]) >= DEDUP_DIST:
            centerline.append(p)

    xform, transform_params = _make_transform(centerline)

    sf_raw_idx = None
    for i in range(1, len(all_clean)):
        if len(all_clean[i]) > 3 and len(all_clean[i - 1]) > 3:
            if all_clean[i][3] != all_clean[i - 1][3]:
                sf_raw_x, sf_raw_z = all_clean[i][0], all_clean[i][2]
                sf_raw_idx = _closest_idx(centerline, sf_raw_x, sf_raw_z)
                break

    if sf_raw_idx is None:
        sf_crossings = [c for c in raw.get('sector_crossings', []) if c.get('from_s') == 2 and c.get('to_s') == 0]
        if sf_crossings:
            sf_raw_idx = _closest_idx(centerline, sf_crossings[0]['x'], sf_crossings[0]['z'])
        elif len(centerline) > 0:
            sf_raw_idx = 0

    raw_crossings = _consolidate_sector_crossings(raw.get('sector_crossings', []))
    s12_idx = s23_idx = None
    for c in raw_crossings:
        idx = _closest_idx(centerline, c['x'], c['z'])
        if c['from_s'] == 0 and c['to_s'] == 1:
            s12_idx = idx
        elif c['from_s'] == 1 and c['to_s'] == 2:
            s23_idx = idx

    def _sector_points(lo: int | None, hi: int | None, append_zero: bool = False) -> list[list[float]]:
        lo = lo or 0
        hi = hi or len(centerline)
        pts = [xform(p[0], p[2]) for p in centerline[lo:hi]]
        if append_zero and len(centerline) > 0:
            pts.append(xform(centerline[0][0], centerline[0][2]))
        return pts

    if s12_idx is not None and s23_idx is not None:
        sectors = [
            {'index': 1, 'points': _sector_points(0,       s12_idx)},
            {'index': 2, 'points': _sector_points(s12_idx, s23_idx)},
            {'index': 3, 'points': _sector_points(s23_idx, None, append_zero=True)},
        ]
    elif s12_idx is not None:
        sectors = [
            {'index': 1, 'points': _sector_points(0,       s12_idx)},
            {'index': 2, 'points': _sector_points(s12_idx, None, append_zero=True)},
        ]
    else:
        sectors = [{'index': 1, 'points': _sector_points(0, None, append_zero=True)}]

    raw_drs  = _consolidate_zones(raw.get('drs_events', []), centerline, 'unlock', 'lock')
    drs_zones = []
    for zone in raw_drs:
        # The zone polyline is re-derived by the app as the centerline slice
        # between start and end, so only the two endpoints are persisted.
        drs_zones.append({
            'start':        xform(zone['unlock']['x'], zone['unlock']['z']),
            'end':          xform(zone['lock']['x'],   zone['lock']['z']),
        })

    raw_traps = _consolidate_by_proximity(raw.get('speed_traps', []))
    speed_traps = [xform(t['x'], t['z']) for t in raw_traps]

    start_finish = None
    if sf_raw_idx is not None:
        p = centerline[sf_raw_idx]
        start_finish = xform(p[0], p[2])

    return {
        'track_id':       track_id,
        'track_name':     track_name,
        'circuit_name':   circuit_name,
        'track_length_m': track_length,
        'view_box':       {'width': VIEWBOX, 'height': VIEWBOX},
        'rotation_deg':   0,
        'transform':      transform_params,
        'sectors':        sectors,
        'drs_zones':      drs_zones,
        'speed_traps':    speed_traps,
        'start_finish':   start_finish,
    }


def _forward_transform(x: float, z: float, transform: dict) -> list[float]:
    """Map a raw telemetry (x, z) into a final map's persisted 1000x1000
    space, using that map's own stored transform. Since it's the same
    physical track, raw coordinates line up whether they came from this
    session or a previously-recorded one."""
    return [
        round((x - transform['min_x']) * transform['scale'] + transform['off_x'], 2),
        round((z - transform['min_z']) * transform['scale'] + transform['off_z'], 2),
    ]


class _MapView:
    """Rotation + rescale needed to draw a final map's persisted (view_box-
    space) geometry on screen — mirrors prepareMap()/buildLayout() in
    TrackMap.tsx exactly, so the Python renderer matches what the app itself
    would draw for this same file."""
    __slots__ = ('rot_cos', 'rot_sin', 'rot_cx', 'rot_cy', 'scale', 'ox', 'oy')

    def __init__(self, rot_cos, rot_sin, rot_cx, rot_cy, scale, ox, oy):
        self.rot_cos, self.rot_sin = rot_cos, rot_sin
        self.rot_cx, self.rot_cy = rot_cx, rot_cy
        self.scale, self.ox, self.oy = scale, ox, oy

    def rotate(self, pt):
        dx = pt[0] - self.rot_cx
        dy = pt[1] - self.rot_cy
        return (
            self.rot_cos * dx - self.rot_sin * dy + self.rot_cx,
            self.rot_sin * dx + self.rot_cos * dy + self.rot_cy,
        )

    def to_canvas(self, pt):
        rx, ry = self.rotate(pt)
        return rx * self.scale + self.ox, ry * self.scale + self.oy


def _prepare_map_view(final_map: dict, canvas_w: int, canvas_h: int) -> _MapView:
    """Reads rotation_deg + view_box from the file and rotates the map's
    persisted geometry around the view_box center (matching TrackMap.tsx's
    prepareMap()), then fits the *rotated* sector bounds into the given
    canvas with MAP_ROT_PAD padding (matching its buildLayout())."""
    rot_rad = math.radians(final_map.get('rotation_deg', 0) or 0)
    cos_r, sin_r = math.cos(rot_rad), math.sin(rot_rad)
    view_box = final_map.get('view_box') or {'width': VIEWBOX, 'height': VIEWBOX}
    cx, cy = view_box['width'] / 2, view_box['height'] / 2

    def rot(pt):
        dx, dy = pt[0] - cx, pt[1] - cy
        return cos_r * dx - sin_r * dy + cx, sin_r * dx + cos_r * dy + cy

    min_x = min_y = float('inf')
    max_x = max_y = float('-inf')
    for sector in final_map.get('sectors', []):
        for p in sector['points']:
            rx, ry = rot(p)
            min_x, max_x = min(min_x, rx), max(max_x, rx)
            min_y, max_y = min(min_y, ry), max(max_y, ry)

    if min_x > max_x:  # no sector points — fall back to the full view_box
        min_x, min_y, max_x, max_y = 0, 0, view_box['width'], view_box['height']

    w = (max_x - min_x) or 1
    h = (max_y - min_y) or 1
    scale = min((canvas_w - 2 * MAP_ROT_PAD) / w, (canvas_h - 2 * MAP_ROT_PAD) / h)
    ox = (canvas_w - w * scale) / 2 - min_x * scale
    oy = (canvas_h - h * scale) / 2 - min_y * scale

    return _MapView(cos_r, sin_r, cx, cy, scale, ox, oy)


def _zones_for_map(final_map: dict, events: list, on_type: str = 'activate', off_type: str = 'deactivate') -> list:
    """Consolidate activate/deactivate events into zone dicts shaped exactly
    like drs_zones ({'start', 'end'}), rebuilding a raw-space centerline from the
    given map's own sectors + transform so this works whether final_map was just
    built fresh or loaded from an existing file. The zone polyline is re-derived
    by the app as the centerline slice between start and end, so only the two
    endpoints are persisted."""
    if not events:
        return []

    transform = final_map['transform']
    min_x, min_z = transform['min_x'], transform['min_z']
    scale = transform['scale']
    off_x, off_z = transform['off_x'], transform['off_z']

    canvas_pts = [p for sector in final_map['sectors'] for p in sector['points']]
    centerline = [
        [(cx - off_x) / scale + min_x, 0.0, (cz - off_z) / scale + min_z]
        for cx, cz in canvas_pts
    ]

    raw_zones = _consolidate_zones(events, centerline, on_type, off_type)

    def _xform(x, z):
        return [round((x - min_x) * scale + off_x, 2), round((z - min_z) * scale + off_z, 2)]

    zones = []
    for zone in raw_zones:
        zones.append({
            'start':        _xform(zone['unlock']['x'], zone['unlock']['z']),
            'end':          _xform(zone['lock']['x'],   zone['lock']['z']),
        })
    return zones


# ───────────────────────────── Recorder ──────────────────────────────────────

def _new_state() -> dict:
    return {
        'recording': False,
        'track_id': -1,
        'session_uid': None,
        'track_length_m': 0,
        'points': [],
        'last_xz': None,
        'current_lap': 0,
        'last_pos': None,
        'drs': 0,
        'drs_events': [],
        'active_aero': 0,
        'slm_events': [],
        'speed_traps': [],
        'sector_crossings': [],
        'last_sector': -1,
    }


class Recorder:
    """Owns the UDP socket + telemetry capture state. The network loop runs on
    a background thread and only ever mutates `state` there; the GUI thread
    only reads `state` to redraw (safe under the GIL for this read-mostly,
    visualization-only usage) and calls `finalize()` synchronously on the main
    thread after a session ends."""

    def __init__(self, log_queue: queue.Queue):
        self.log_queue = log_queue
        self.sock = None
        self.thread = None
        self._stop = threading.Event()
        self.state = _new_state()
        self.existing_map = None  # loaded final_json/track_<id>.json, if this track is already mapped

    def start(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(('', UDP_PORT))
        self.sock.settimeout(1.0)
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def stop(self):
        self._stop.set()
        if self.sock:
            self.sock.close()

    def _log(self, msg: str):
        self.log_queue.put(msg)

    def _loop(self):
        while not self._stop.is_set():
            try:
                data, _ = self.sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            self._handle_packet(data)

    def _handle_packet(self, data: bytes):
        s = self.state
        if len(data) < 29:
            return

        packet_id      = data[6]
        session_uid    = struct.unpack_from('<Q', data, 7)[0]
        player_car_idx = data[27]

        if packet_id == 1 and len(data) > 36:
            s['track_length_m'] = struct.unpack_from('<H', data, 33)[0]
            s['track_id']       = struct.unpack_from('<b', data, 36)[0]
            s['session_uid']    = f'{session_uid:016x}'

        elif packet_id == 3 and len(data) >= 33:
            code = data[29:33].decode('ascii', errors='ignore')
            if code == 'SSTA':
                s['recording']        = True
                s['points']           = []
                s['last_xz']          = None
                s['current_lap']      = 0
                s['drs']              = 0
                s['drs_events']       = []
                s['active_aero']      = 0
                s['slm_events']       = []
                s['speed_traps']      = []
                s['sector_crossings'] = []
                s['last_sector']      = -1

                final_path = FINAL_JSON_DIR / f"track_{s['track_id']}.json"
                if final_path.exists():
                    try:
                        self.existing_map = json.loads(final_path.read_text(encoding='utf-8'))
                        self._log(f'[SSTA] Recording started — track_id={s["track_id"]} (existing map loaded as backdrop)')
                    except (OSError, json.JSONDecodeError):
                        self.existing_map = None
                        self._log(f'[SSTA] Recording started — track_id={s["track_id"]}')
                else:
                    self.existing_map = None
                    self._log(f'[SSTA] Recording started — track_id={s["track_id"]}')
            elif code == 'SEND' and s['recording']:
                s['recording'] = False
                self._log('[SEND] Session ended.')
                self.log_queue.put(('__session_ended__',))
            elif code == 'SPTP' and s['recording'] and s['last_pos']:
                if len(data) >= 39 and data[33] == player_car_idx:
                    speed = round(struct.unpack_from('<f', data, 34)[0], 1)
                    x, y, z = s['last_pos']
                    s['speed_traps'].append({
                        'x': x, 'y': y, 'z': z,
                        'lap': s['current_lap'], 'speed_kph': speed,
                    })
                    self._log(f'[SPTP] lap={s["current_lap"]} speed={speed:.0f} km/h')

        elif packet_id == 2:  # Lap Data
            lap_base = 29 + player_car_idx * 57
            if len(data) >= lap_base + 34:
                s['current_lap'] = data[lap_base + 33]
            if len(data) >= lap_base + 37:
                sector = data[lap_base + 36]
                if (s['recording'] and s['last_pos']
                        and sector != s['last_sector']
                        and s['last_sector'] != -1):
                    x, y, z = s['last_pos']
                    s['sector_crossings'].append({
                        'from_s': s['last_sector'], 'to_s': sector,
                        'x': x, 'y': y, 'z': z, 'lap': s['current_lap'],
                    })
                s['last_sector'] = sector

        elif packet_id == 0:  # Motion
            base = 29 + player_car_idx * _car_stride(data, MOTION_STRIDE_BY_LEN, 60, 54)
            if len(data) < base + 12:
                return
            x = round(struct.unpack_from('<f', data, base)[0],     2)
            y = round(struct.unpack_from('<f', data, base + 4)[0], 2)
            z = round(struct.unpack_from('<f', data, base + 8)[0], 2)
            s['last_pos'] = [x, y, z]
            if s['recording']:
                pt = [x, y, z, s['current_lap']]
                if s['last_xz'] is None or math.hypot(pt[0] - s['last_xz'][0], pt[2] - s['last_xz'][2]) >= MIN_DIST:
                    s['points'].append(pt)
                    s['last_xz'] = pt

        elif packet_id == 6 and s['recording'] and s['last_pos']:  # Car Telemetry
            base = 29 + player_car_idx * _car_stride(data, CARTEL_STRIDE_BY_LEN, 60, 59)
            if len(data) < base + 19:
                return
            drs = data[base + 18]
            if drs != s['drs']:
                s['drs'] = drs
                kind = 'unlock' if drs == 1 else 'lock'
                x, y, z = s['last_pos']
                s['drs_events'].append({
                    'type': kind, 'lap': s['current_lap'],
                    'x': x, 'y': y, 'z': z,
                })
                self._log(f'[DRS {kind}] lap={s["current_lap"]}')

        elif packet_id == 16 and s['recording'] and s['last_pos']:  # Car Telemetry 2 (2026 Active Aero Mode)
            base = 29 + player_car_idx * 10
            if len(data) < base + 1:
                return
            active_aero = data[base]  # 0 = Corner mode, 1 = Straight mode
            if active_aero != s['active_aero']:
                s['active_aero'] = active_aero
                kind = 'activate' if active_aero == 1 else 'deactivate'
                x, y, z = s['last_pos']
                s['slm_events'].append({
                    'type': kind, 'lap': s['current_lap'],
                    'x': x, 'y': y, 'z': z,
                })
                self._log(f'[SLM {kind}] lap={s["current_lap"]}')

    def snapshot_raw(self) -> tuple[dict, str]:
        s = self.state
        uid_short = s['session_uid'][:16] if s['session_uid'] else 'unknown'
        raw = {
            'track_id':         s['track_id'],
            'session_uid':      s['session_uid'],
            'track_length_m':   s['track_length_m'],
            'points':           list(s['points']),
            'drs_events':       list(s['drs_events']),
            'speed_traps':      list(s['speed_traps']),
            'sector_crossings': list(s['sector_crossings']),
            'slm_events':       list(s['slm_events']),
        }
        return raw, uid_short

    def finalize(self, weather_key: str) -> dict:
        """Must be called on the main thread. Saves the raw recording, then
        either merges slm_dry/slm_wet into the existing final map or builds a
        brand-new one. Returns a result summary for the GUI to display."""
        raw, uid_short = self.snapshot_raw()
        if not raw['points']:
            raise ValueError('No points recorded — nothing to save.')

        raw_fname = Path(__file__).parent / f"track_{raw['track_id']}_{uid_short}.json"
        raw_fname.write_text(json.dumps(raw, indent=2))

        FINAL_JSON_DIR.mkdir(parents=True, exist_ok=True)
        final_path = FINAL_JSON_DIR / f"track_{raw['track_id']}.json"

        if final_path.exists():
            final_map = json.loads(final_path.read_text(encoding='utf-8'))
            final_map[weather_key] = _zones_for_map(final_map, raw['slm_events'])
            is_new = False
        else:
            final_map = convert(raw)
            final_map[weather_key] = _zones_for_map(final_map, raw['slm_events'])
            is_new = True

        final_path.write_text(json.dumps(final_map, indent=2), encoding='utf-8')

        return {
            'raw_path':    raw_fname,
            'final_path':  final_path,
            'is_new':      is_new,
            'weather_key': weather_key,
            'final_map':   final_map,
            'n_zones':     len(final_map[weather_key]),
        }


# ───────────────────────────────── GUI ───────────────────────────────────────

class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.log_queue: queue.Queue = queue.Queue()
        self.recorder = Recorder(self.log_queue)
        self._final_view = None  # set after a successful finalize(), for read-only inspection
        self._tick_after_id = None
        self._session_ended_unsaved = False  # SEND fired, user hasn't confirmed save yet

        root.title('Live Track Mapper — 2026 SLM / DRS')
        root.resizable(False, False)
        root.configure(bg='#111216')

        toolbar = tk.Frame(root, bg='#1c1e26', pady=6)
        toolbar.pack(fill='x')

        self.finalize_btn = tk.Button(
            toolbar, text='Finalize Now', command=self.finalize_now,
            bg='#2a2d3a', fg='#888', relief='flat',
            padx=12, pady=4, cursor='hand2', state='disabled',
        )
        self.finalize_btn.pack(side='left', padx=8)

        weather_frame = tk.Frame(toolbar, bg='#1c1e26')
        weather_frame.pack(side='left', padx=(16, 4))
        tk.Label(weather_frame, text='Weather:', bg='#1c1e26', fg='#aaa',
                 font=('Consolas', 10)).pack(side='left', padx=(0, 6))
        self.weather_var = tk.StringVar(value='slm_dry')
        tk.Radiobutton(
            weather_frame, text='Dry', variable=self.weather_var, value='slm_dry',
            bg='#1c1e26', fg='#e0e0e0', selectcolor='#2a2d3a',
            activebackground='#1c1e26', activeforeground='#e0e0e0',
            font=('Consolas', 10),
        ).pack(side='left')
        tk.Radiobutton(
            weather_frame, text='Wet', variable=self.weather_var, value='slm_wet',
            bg='#1c1e26', fg='#e0e0e0', selectcolor='#2a2d3a',
            activebackground='#1c1e26', activeforeground='#e0e0e0',
            font=('Consolas', 10),
        ).pack(side='left', padx=(8, 0))

        self.rot_label = tk.Label(
            toolbar, text='Rotation (°):', bg='#1c1e26', fg='#aaa', font=('Consolas', 10),
        )
        self.rot_label.pack(side='left', padx=(16, 4))
        self.rot_entry = tk.Entry(
            toolbar, bg='#2a2d3a', fg='#e0e0e0', insertbackground='#e0e0e0',
            relief='flat', width=6, font=('Consolas', 10), justify='center',
        )
        self.rot_entry.insert(0, '0')
        self.rot_entry.pack(side='left', padx=4)

        self.status = tk.Label(
            toolbar, text='Starting…', bg='#1c1e26', fg='#666', font=('Consolas', 10),
        )
        self.status.pack(side='right', padx=16)

        self.canvas = tk.Canvas(
            root, width=CANVAS_W, height=CANVAS_H, bg='#111216', highlightthickness=0,
        )
        self.canvas.pack()
        self.canvas.create_text(
            CANVAS_W // 2, CANVAS_H // 2,
            text=f'Listening on UDP :{UDP_PORT} — start a session in F1 25 (2026 Season Pack)',
            fill='#444', font=('Consolas', 13),
        )

        root.protocol('WM_DELETE_WINDOW', self._on_close)

        try:
            self.recorder.start()
            self.status.config(text=f'Listening on :{UDP_PORT}')
        except OSError as e:
            messagebox.showerror('Could not start', f'Failed to bind UDP :{UDP_PORT}\n\n{e}')
            self.status.config(text='Not listening', fg='#F2495C')

        self._tick_after_id = self.root.after(200, self._tick)

    # ── background-thread event pump (runs on the main thread) ──────────────

    def _tick(self):
        session_ended = False
        while True:
            try:
                msg = self.log_queue.get_nowait()
            except queue.Empty:
                break
            if isinstance(msg, tuple) and msg and msg[0] == '__session_ended__':
                session_ended = True
            else:
                self.status.config(text=str(msg))

        if self.recorder.state['recording']:
            self._session_ended_unsaved = False  # a new SSTA has started

        if session_ended:
            self._confirm_and_finalize()

        self._refresh_status()
        if self.recorder.state['recording']:
            self.render_live()

        self._tick_after_id = self.root.after(200, self._tick)

    def _refresh_status(self):
        s = self.recorder.state
        if s['recording']:
            track_name, _ = TRACK_NAMES.get(s['track_id'], (f'Track {s["track_id"]}', ''))
            self.finalize_btn.config(state='normal', fg='#e0e0e0')
            self.status.config(
                text=(f'Recording — {track_name}  |  lap {s["current_lap"]}  |  '
                      f'{len(s["points"])} pts  |  {len(s["drs_events"])} DRS ev  |  '
                      f'{len(s["slm_events"])} SLM ev'),
                fg='#73BF69',
            )
        elif self._session_ended_unsaved:
            self.finalize_btn.config(state='normal', fg='#e0e0e0')
            self.status.config(text='Session ended — not saved (pick weather, then Finalize Now)', fg='#FADE2A')
        else:
            self.finalize_btn.config(state='disabled', fg='#888')

    def _confirm_and_finalize(self):
        """Called when SEND arrives. Asks before writing anything to disk —
        recording never auto-saves."""
        s = self.recorder.state
        track_name, _ = TRACK_NAMES.get(s['track_id'], (f'Track {s["track_id"]}', ''))
        weather_label = 'Dry' if self.weather_var.get() == 'slm_dry' else 'Wet'
        save = messagebox.askyesno(
            'Session ended',
            f"{track_name}\n\n"
            f"{len(s['points'])} pts  |  {len(s['drs_events'])} DRS event(s)  |  "
            f"{len(s['slm_events'])} SLM event(s)\n\n"
            f"Save this session as {weather_label}?",
        )
        if not save:
            self._session_ended_unsaved = True
            self.status.config(text='Session ended — not saved', fg='#FADE2A')
            return
        self._finalize_and_report()

    def finalize_now(self):
        if not (self.recorder.state['recording'] or self._session_ended_unsaved):
            return
        self.recorder.state['recording'] = False
        self._finalize_and_report()

    def _finalize_and_report(self):
        try:
            result = self.recorder.finalize(self.weather_var.get())
        except ValueError as e:
            messagebox.showwarning('Nothing to save', str(e))
            return
        self._session_ended_unsaved = False
        self._show_result(result)

    def _show_result(self, result: dict):
        kind = 'merged into existing map' if not result['is_new'] else 'brand-new map created'
        messagebox.showinfo(
            'Finalized',
            f"{kind}\n\n"
            f"Raw recording: {result['raw_path'].name}\n"
            f"Final map:     {result['final_path']}\n"
            f"{result['weather_key']}: {result['n_zones']} zone(s)",
        )
        self._final_view = result['final_map']
        self.render_final(self._final_view)
        self.status.config(text=f"Written {result['final_path'].name}", fg='#73BF69')

    # ── rendering ─────────────────────────────────────────────────────────

    def _rotation(self) -> float:
        try:
            return float(self.rot_entry.get())
        except ValueError:
            return 0.0

    def render_live(self):
        """Draws the in-progress recording. If this track already has a saved
        map, that map is used as a static backdrop (in its own coordinate
        frame) with this session's live trail/DRS/SLM events overlaid on top
        in real time; for a brand-new track, the view is instead built live
        from just this session's points, as before."""
        existing_map = self.recorder.existing_map
        if existing_map is not None:
            self._render_live_over_existing(existing_map)
        else:
            self._render_live_fresh()

    def _render_live_over_existing(self, existing_map: dict):
        """Backdrop = the already-saved map (dimmed), rendered with the same
        rotation_deg + rescale-to-fit pipeline the app itself uses. Overlay =
        this session's live trail and SLM/DRS event markers: first placed
        into the map's own raw->view_box space via its stored transform, then
        run through that same rotation/rescale so everything lines up with
        the backdrop exactly as it will in the app."""
        s = self.recorder.state
        self.canvas.delete('all')
        view = _prepare_map_view(existing_map, CANVAS_W, CANVAS_H)
        _s = view.to_canvas

        for sector in existing_map.get('sectors', []):
            flat = []
            for p in sector['points']:
                flat.extend(_s(p))
            if len(flat) >= 4:
                self.canvas.create_line(flat, fill='#3a3d4a', width=2, smooth=True, capstyle='round')

        for zone in existing_map.get('drs_zones', []):
            ux, uy = _s(zone['start'])
            lx, ly = _s(zone['end'])
            self.canvas.create_polygon(ux, uy - 6, ux - 5, uy + 3, ux + 5, uy + 3,
                                        fill='#3a3d4a', outline='#555a6b', width=1)
            self.canvas.create_polygon(lx, ly + 6, lx - 5, ly - 3, lx + 5, ly - 3,
                                        fill='#3a3d4a', outline='#555a6b', width=1)

        sf = existing_map.get('start_finish')
        if sf:
            sx, sy = _s(sf)
            self.canvas.create_oval(sx - 5, sy - 5, sx + 5, sy + 5,
                                     fill='#3a3d4a', outline='#555a6b', width=1)

        transform = existing_map['transform']

        live_points = list(s['points'])
        if live_points:
            flat = []
            for p in live_points:
                cx, cz = _forward_transform(p[0], p[2], transform)
                flat.extend(_s([cx, cz]))
            if len(flat) >= 4:
                self.canvas.create_line(flat, fill='#e0e0e0', width=2, smooth=True, capstyle='round')

        for ev in s['drs_events']:
            cx, cz = _forward_transform(ev['x'], ev['z'], transform)
            px, py = _s([cx, cz])
            color = DRS_ACTIVATE_COLOR if ev['type'] == 'unlock' else DRS_DEACTIVATE_COLOR
            self.canvas.create_oval(px - 5, py - 5, px + 5, py + 5,
                                     fill=color, outline='#ffffff', width=1)

        for ev in s['slm_events']:
            cx, cz = _forward_transform(ev['x'], ev['z'], transform)
            px, py = _s([cx, cz])
            color = SLM_ACTIVATE_COLOR if ev['type'] == 'activate' else SLM_DEACTIVATE_COLOR
            self.canvas.create_oval(px - 6, py - 6, px + 6, py + 6,
                                     fill=color, outline='#ffffff', width=1)

    def _render_live_fresh(self):
        """Draws the in-progress recording straight from the recorder's raw
        state, so the map can be checked while still driving. Used when this
        track has no saved map yet, so there's no existing geometry to place
        events against."""
        s = self.recorder.state
        raw_points = list(s['points'])
        if not raw_points:
            return

        points = _clean_points(raw_points, s['track_length_m'])
        if not points:
            return

        angle_rad = math.radians(self._rotation())
        xs = [p[0] for p in points]
        zs = [p[2] for p in points]
        cx = sum(xs) / len(points)
        cz = sum(zs) / len(points)

        rotated = []
        for p in points:
            rx, rz = rotate_point(p[0], p[2], cx, cz, angle_rad)
            rotated.append([rx, p[1], rz] + p[3:])

        coords, xform = _view_normalize(rotated, CANVAS_W, CANVAS_H, PADDING)

        self.canvas.delete('all')

        segments: dict = {}
        for i, p in enumerate(rotated):
            lap = p[3] if len(p) > 3 else 0
            segments.setdefault(lap, []).append(i)

        for lap, indices in sorted(segments.items()):
            color = LAP_COLORS[lap % len(LAP_COLORS)]
            flat = []
            for i in indices:
                flat.extend(coords[i])
            if len(flat) >= 4:
                self.canvas.create_line(flat, fill=color, width=2, smooth=True, capstyle='round')

        sf = _find_sf_line(points, s)
        if sf is not None:
            cx_sf, cy_sf = coords[sf]
            self.canvas.create_oval(cx_sf - 6, cy_sf - 6, cx_sf + 6, cy_sf + 6,
                                     fill='#e10600', outline='#ffffff', width=1.5)

        drs_zones = _consolidate_zones(s['drs_events'], points, 'unlock', 'lock')
        for zone in drs_zones:
            rx_u, rz_u = rotate_point(zone['unlock']['x'], zone['unlock']['z'], cx, cz, angle_rad)
            rx_l, rz_l = rotate_point(zone['lock']['x'],   zone['lock']['z'],   cx, cz, angle_rad)
            ux, uy = xform(rx_u, rz_u)
            lx, ly = xform(rx_l, rz_l)
            self.canvas.create_polygon(ux, uy - 8, ux - 6, uy + 4, ux + 6, uy + 4,
                                        fill=DRS_ACTIVATE_COLOR, outline='#ffffff', width=1)
            self.canvas.create_polygon(lx, ly + 8, lx - 6, ly - 4, lx + 6, ly - 4,
                                        fill=DRS_DEACTIVATE_COLOR, outline='#ffffff', width=1)

        slm_zones = _consolidate_zones(s['slm_events'], points, 'activate', 'deactivate')
        for zone in slm_zones:
            rx_u, rz_u = rotate_point(zone['unlock']['x'], zone['unlock']['z'], cx, cz, angle_rad)
            rx_l, rz_l = rotate_point(zone['lock']['x'],   zone['lock']['z'],   cx, cz, angle_rad)
            ux, uy = xform(rx_u, rz_u)
            lx, ly = xform(rx_l, rz_l)
            self.canvas.create_oval(ux - 6, uy - 6, ux + 6, uy + 6,
                                     fill=SLM_ACTIVATE_COLOR, outline='#ffffff', width=1)
            self.canvas.create_oval(lx - 6, ly - 6, lx + 6, ly + 6,
                                     fill=SLM_DEACTIVATE_COLOR, outline='#ffffff', width=1)

        traps = _consolidate_by_proximity(s['speed_traps'])
        for t in traps:
            rx_t, rz_t = rotate_point(t['x'], t['z'], cx, cz, angle_rad)
            tx, ty = xform(rx_t, rz_t)
            self.canvas.create_polygon(tx, ty - 8, tx + 6, ty, tx, ty + 8, tx - 6, ty,
                                        fill='#FADE2A', outline='#ffffff', width=1)

    def render_final(self, final_map: dict):
        """Draws the just-written final map straight from its persisted
        (view_box-space) sectors/zones — applying rotation_deg and refitting
        to the canvas exactly like the app's own TrackMap.tsx renderer does —
        for a direct look at exactly what was saved to disk."""
        self.canvas.delete('all')
        view = _prepare_map_view(final_map, CANVAS_W, CANVAS_H)
        _s = view.to_canvas

        for i, sector in enumerate(final_map.get('sectors', [])):
            color = LAP_COLORS[i % len(LAP_COLORS)]
            flat = []
            for p in sector['points']:
                flat.extend(_s(p))
            if len(flat) >= 4:
                self.canvas.create_line(flat, fill=color, width=2, smooth=True, capstyle='round')

        for zone in final_map.get('drs_zones', []):
            ux, uy = _s(zone['start'])
            lx, ly = _s(zone['end'])
            self.canvas.create_polygon(ux, uy - 8, ux - 6, uy + 4, ux + 6, uy + 4,
                                        fill=DRS_ACTIVATE_COLOR, outline='#ffffff', width=1)
            self.canvas.create_polygon(lx, ly + 8, lx - 6, ly - 4, lx + 6, ly - 4,
                                        fill=DRS_DEACTIVATE_COLOR, outline='#ffffff', width=1)

        for key, color in (('slm_dry', SLM_ACTIVATE_COLOR), ('slm_wet', SLM_DEACTIVATE_COLOR)):
            for zone in final_map.get(key, []):
                ux, uy = _s(zone['start'])
                lx, ly = _s(zone['end'])
                self.canvas.create_oval(ux - 6, uy - 6, ux + 6, uy + 6,
                                         fill=color, outline='#ffffff', width=1)
                self.canvas.create_oval(lx - 6, ly - 6, lx + 6, ly + 6,
                                        fill=color, outline='#ffffff', width=1)

        sf = final_map.get('start_finish')
        if sf:
            sx, sy = _s(sf)
            self.canvas.create_oval(sx - 6, sy - 6, sx + 6, sy + 6,
                                     fill='#e10600', outline='#ffffff', width=1.5)

    def shutdown(self):
        """Cancels the pending _tick poll and stops the recorder. Safe to
        call before destroying the Tk root (avoids a stray callback firing
        against an already-destroyed interpreter)."""
        if self._tick_after_id is not None:
            self.root.after_cancel(self._tick_after_id)
            self._tick_after_id = None
        self.recorder.stop()

    def _on_close(self):
        if self.recorder.state['recording'] or self._session_ended_unsaved:
            if messagebox.askyesno('Unsaved session', 'Finalize the current session before closing?'):
                self._finalize_and_report()
        self.shutdown()
        self.root.destroy()


if __name__ == '__main__':
    root = tk.Tk()
    App(root)
    root.mainloop()
