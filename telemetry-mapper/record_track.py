import socket
import struct
import json
import math
import signal
import sys
from pathlib import Path

UDP_PORT = 20777
MIN_DIST = 2.0  # metres between recorded points

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(('', UDP_PORT))
sock.settimeout(1.0)

state = {
    'recording': False,
    'track_id': -1,
    'session_uid': None,
    'track_length_m': 0,
    'points': [],
    'last_xz': None,
    'current_lap': 0,
    'last_pos': None,
    'drs': 0,
    'drs_events': [],       # [{type, x, y, z, lap}, ...]
    'speed_traps': [],      # [{x, y, z, lap, speed_kph}, ...]
    'sector_crossings': [], # [{from_s, to_s, x, y, z, lap}, ...]
    'last_sector': -1,
}


def xz_dist(a, b):
    return math.hypot(a[0] - b[0], a[2] - b[2])


def save():
    if not state['points']:
        print('No points to save.')
        return
    uid_short = state['session_uid'][:16] if state['session_uid'] else 'unknown'
    fname = f"track_{state['track_id']}_{uid_short}.json"
    Path(fname).write_text(json.dumps({
        'track_id': state['track_id'],
        'session_uid': state['session_uid'],
        'track_length_m': state['track_length_m'],
        'points': state['points'],
        'drs_events': state['drs_events'],
        'speed_traps': state['speed_traps'],
        'sector_crossings': state['sector_crossings'],
    }, indent=2))
    print(f"Saved {len(state['points'])} points -> {fname}")


def handle_packet(data: bytes):
    if len(data) < 29:
        return

    packet_id      = data[6]
    session_uid    = struct.unpack_from('<Q', data, 7)[0]
    player_car_idx = data[27]

    if packet_id == 1 and len(data) > 36:
        state['track_length_m'] = struct.unpack_from('<H', data, 33)[0]
        state['track_id']       = struct.unpack_from('<b', data, 36)[0]
        state['session_uid']    = f'{session_uid:016x}'

    elif packet_id == 3 and len(data) >= 33:
        code = data[29:33].decode('ascii', errors='ignore')
        if code == 'SSTA':
            state['recording']        = True
            state['points']           = []
            state['last_xz']          = None
            state['current_lap']      = 0
            state['drs']              = 0
            state['drs_events']       = []
            state['speed_traps']      = []
            state['sector_crossings'] = []
            state['last_sector']      = -1
            print(f'[SSTA] Recording started  —  track_id={state["track_id"]}  length={state["track_length_m"]}m')
        elif code == 'SEND' and state['recording']:
            state['recording'] = False
            print('[SEND] Session ended.')
            save()
        elif code == 'SPTP' and state['recording'] and state['last_pos']:
            if len(data) >= 39 and data[33] == player_car_idx:
                speed = round(struct.unpack_from('<f', data, 34)[0], 1)
                x, y, z = state['last_pos']
                state['speed_traps'].append({
                    'x': x, 'y': y, 'z': z,
                    'lap': state['current_lap'], 'speed_kph': speed,
                })
                print(f'[SPTP] lap={state["current_lap"]}  speed={speed:.0f} km/h  pos=({x:.0f}, {z:.0f})')

    elif packet_id == 2:  # Lap Data
        lap_base = 29 + player_car_idx * 57
        if len(data) >= lap_base + 34:
            state['current_lap'] = data[lap_base + 33]
        if len(data) >= lap_base + 37:
            sector = data[lap_base + 36]
            if (state['recording'] and state['last_pos']
                    and sector != state['last_sector']
                    and state['last_sector'] != -1):
                x, y, z = state['last_pos']
                state['sector_crossings'].append({
                    'from_s': state['last_sector'], 'to_s': sector,
                    'x': x, 'y': y, 'z': z, 'lap': state['current_lap'],
                })
                print(f'[SECTOR S{state["last_sector"]+1}->S{sector+1}] lap={state["current_lap"]}  pos=({x:.0f}, {z:.0f})')
            state['last_sector'] = sector

    elif packet_id == 0:  # Motion
        base = 29 + player_car_idx * 60
        if len(data) < base + 12:
            return
        x = round(struct.unpack_from('<f', data, base)[0],     2)
        y = round(struct.unpack_from('<f', data, base + 4)[0], 2)
        z = round(struct.unpack_from('<f', data, base + 8)[0], 2)
        state['last_pos'] = [x, y, z]
        if state['recording']:
            pt = [x, y, z, state['current_lap']]
            if state['last_xz'] is None or xz_dist(pt, state['last_xz']) >= MIN_DIST:
                state['points'].append(pt)
                state['last_xz'] = pt

    elif packet_id == 6 and state['recording'] and state['last_pos']:  # Car Telemetry
        base = 29 + player_car_idx * 60
        if len(data) < base + 19:
            return
        drs = data[base + 18]
        if drs != state['drs']:
            state['drs'] = drs
            kind = 'unlock' if drs == 1 else 'lock'
            x, y, z = state['last_pos']
            state['drs_events'].append({
                'type': kind, 'lap': state['current_lap'],
                'x': x, 'y': y, 'z': z,
            })
            print(f'[DRS {kind}] lap={state["current_lap"]}  pos=({x:.0f}, {z:.0f})')


def on_sigint(*_):
    print('\nInterrupted.')
    if state['recording'] and state['points']:
        save()
    sys.exit(0)


signal.signal(signal.SIGINT, on_sigint)

print(f'Listening on UDP :{UDP_PORT}')
print('Start a session in F1 25. Recording begins on SSTA and saves on SEND.')
print('Press Ctrl+C to force-save and exit.\n')

while True:
    try:
        data, _ = sock.recvfrom(4096)
        handle_packet(data)
    except socket.timeout:
        pass
