"""
convert_track.py — Bake a raw telemetry-mapper JSON into a canvas-ready map.

Usage:
    python convert_track.py <raw_json> [--out <dest.json>]

If --out is omitted the output is written to track_<id>.json in the current dir.
"""

import argparse
import json
import math
from pathlib import Path

VIEWBOX     = 1000
PAD         = 50          # padding inside the 1000×1000 space
DEDUP_DIST  = 1.0         # metres — drop consecutive points closer than this
PROX_THRESH = 100         # metres — DRS / crossing cluster radius

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


# ── Data cleaning (ported from view_track.py) ────────────────────────────────

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


def _consolidate_drs_zones(events: list, centerline: list) -> list:
    if not events or not centerline:
        return []

    instances = []
    i = 0
    while i < len(events):
        if events[i]['type'] == 'unlock':
            unlock = events[i]
            j = i + 1
            while j < len(events) and events[j]['type'] != 'lock':
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

    # Map each instance to centerline index range
    N = len(centerline)
    is_drs = [False] * N
    for inst in instances:
        u_idx = _closest_idx(centerline, inst['unlock']['x'], inst['unlock']['z'])
        l_idx = _closest_idx(centerline, inst['lock']['x'],   inst['lock']['z'])
        
        curr = u_idx
        while True:
            is_drs[curr] = True
            if curr == l_idx:
                break
            curr = (curr + 1) % N

    # Fill circular gaps (threshold: 120 meters/indices)
    gap_limit = 120
    
    # Circular gap-filling
    start_idx = -1
    for i in range(N):
        if is_drs[i] and not is_drs[(i - 1) % N]:
            start_idx = i
            break

    if start_idx == -1:
        if any(is_drs):
            return [{'unlock': {'x': centerline[0][0], 'z': centerline[0][2]}, 'lock': {'x': centerline[-1][0], 'z': centerline[-1][2]}}]
        return []

    filled = list(is_drs)
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

    # Extract contiguous True segments
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

    # Merge circular wrap-around zones
    if len(zones) > 1:
        if (zones[-1][1] + 1) % N == zones[0][0]:
            merged_zone = (zones[-1][0], zones[0][1])
            zones = [merged_zone] + zones[1:-1]

    # Convert centerline zones back to standard format
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
    """Return a transform function plus the raw parameters needed for runtime car projection."""
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
    """Index of the centerline point (pre-transform raw coords) nearest to (raw_x, raw_z)."""
    best_i, best_d = 0, float('inf')
    for i, p in enumerate(centerline):
        d = math.hypot(p[0] - raw_x, p[2] - raw_z)
        if d < best_d:
            best_d, best_i = d, i
    return best_i


# ── Main conversion ──────────────────────────────────────────────────────────

def filter_track_data(raw: dict) -> dict:
    points = raw.get('points', [])
    laps_in_points = {p[3] for p in points if len(p) > 3}
    if laps_in_points:
        complete_laps = {lap for lap in laps_in_points if lap > 1 and (lap + 1) in laps_in_points}
        filtered_points = [p for p in points if len(p) > 3 and p[3] in complete_laps]
        filtered_drs = raw.get('drs_events', [])  # Revert: keep all DRS events (including Lap 1 and incomplete laps)
        filtered_traps = [ev for ev in raw.get('speed_traps', []) if ev.get('lap') in complete_laps]
        filtered_crossings = [ev for ev in raw.get('sector_crossings', []) if ev.get('lap') in complete_laps]
    else:
        filtered_points = points
        filtered_drs = raw.get('drs_events', [])
        filtered_traps = raw.get('speed_traps', [])
        filtered_crossings = raw.get('sector_crossings', [])

    return {
        **raw,
        'points': filtered_points,
        'drs_events': filtered_drs,
        'speed_traps': filtered_traps,
        'sector_crossings': filtered_crossings,
    }


def convert(raw: dict) -> dict:
    raw = filter_track_data(raw)
    track_id      = raw['track_id']
    track_length  = raw.get('track_length_m', 0)
    track_name, circuit_name = TRACK_NAMES.get(track_id, (f'Track {track_id}', ''))

    # 1. Clean all points (drop Lap 1 and incomplete laps)
    all_points = raw['points']
    all_clean = _clean_points(all_points, track_length)
    if not all_clean:
        raise ValueError('No usable points after cleaning.')

    # 2. Pick the reference lap (most points)
    lap_groups: dict[int, list] = {}
    for p in all_clean:
        lap = p[3] if len(p) > 3 else 0
        lap_groups.setdefault(lap, []).append(p)
    ref_lap_pts = max(lap_groups.values(), key=len)

    # 3. Deduplicate along the reference lap centerline
    centerline: list = [ref_lap_pts[0]]
    for p in ref_lap_pts[1:]:
        if math.hypot(p[0] - centerline[-1][0], p[2] - centerline[-1][2]) >= DEDUP_DIST:
            centerline.append(p)

    # 4. Build coordinate transform
    xform, transform_params = _make_transform(centerline)

    # 5. Find start/finish — where lap number ticks over in the full cleaned set, with fallback
    sf_raw_idx = None
    for i in range(1, len(all_clean)):
        if len(all_clean[i]) > 3 and len(all_clean[i - 1]) > 3:
            if all_clean[i][3] != all_clean[i - 1][3]:
                sf_raw_x, sf_raw_z = all_clean[i][0], all_clean[i][2]
                sf_raw_idx = _closest_idx(centerline, sf_raw_x, sf_raw_z)
                break

    if sf_raw_idx is None:
        # Fallback 1: Look for 2 -> 0 sector crossing in telemetry
        sf_crossings = [c for c in raw.get('sector_crossings', []) if c.get('from_s') == 2 and c.get('to_s') == 0]
        if sf_crossings:
            sf_raw_idx = _closest_idx(centerline, sf_crossings[0]['x'], sf_crossings[0]['z'])
        # Fallback 2: Default to index 0 of the centerline
        elif len(centerline) > 0:
            sf_raw_idx = 0

    # 6. Sector crossings
    raw_crossings = _consolidate_sector_crossings(raw.get('sector_crossings', []))
    s12_idx = s23_idx = None
    for c in raw_crossings:
        idx = _closest_idx(centerline, c['x'], c['z'])
        if c['from_s'] == 0 and c['to_s'] == 1:
            s12_idx = idx
        elif c['from_s'] == 1 and c['to_s'] == 2:
            s23_idx = idx

    # 7. Split into sectors
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

    # 8. DRS zones
    raw_drs  = _consolidate_drs_zones(raw.get('drs_events', []), centerline)
    drs_zones = []
    for zone in raw_drs:
        # The zone polyline is re-derived by the app as the centerline slice
        # between start and end, so only the two endpoints are persisted.
        drs_zones.append({
            'start':        xform(zone['unlock']['x'], zone['unlock']['z']),
            'end':          xform(zone['lock']['x'],   zone['lock']['z']),
        })

    # 9. Speed traps
    raw_traps = _consolidate_by_proximity(raw.get('speed_traps', []))
    speed_traps = [xform(t['x'], t['z']) for t in raw_traps]

    # 10. Start/finish point
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


def main() -> None:
    parser = argparse.ArgumentParser(description='Convert raw track JSON to canvas-ready format.')
    parser.add_argument('input',  help='Raw track JSON file')
    parser.add_argument('--out',  help='Output path (default: track_<id>.json)')
    args = parser.parse_args()

    raw = json.loads(Path(args.input).read_text(encoding='utf-8'))
    result = convert(raw)

    out_path = Path(args.out) if args.out else Path(f"track_{result['track_id']}.json")
    out_path.write_text(json.dumps(result, indent=2), encoding='utf-8')

    n_pts   = sum(len(s['points']) for s in result['sectors'])
    n_drs   = len(result['drs_zones'])
    n_traps = len(result['speed_traps'])
    n_sec   = len(result['sectors'])
    print(f"Written: {out_path}")
    print(f"  Track {result['track_id']} — {result['track_name']}")
    print(f"  {n_pts} centerline points  |  {n_sec} sectors  |  {n_drs} DRS zone(s)  |  {n_traps} speed trap(s)")


if __name__ == '__main__':
    main()
