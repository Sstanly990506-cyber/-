import itertools
import math
from urllib.parse import quote


def infer_segment(a, b):
    dx = (float(a.get('lat', 0)) - float(b.get('lat', 0))) * 111000
    dy = (float(a.get('lng', 0)) - float(b.get('lng', 0))) * 101000
    meters = int(math.sqrt(dx * dx + dy * dy))
    duration_sec = max(60, int((meters / 1000) * 180))
    return {'durationSec': duration_sec, 'distanceM': meters}


def normalize_location_key(stop):
    address = str(stop.get('address') or '').strip().lower()
    if address and address != '-':
        return f'address:{address}'
    lat = float(stop.get('lat') or 0)
    lng = float(stop.get('lng') or 0)
    return f'latlng:{lat:.5f},{lng:.5f}'


def group_stops_by_location(stops):
    groups = []
    lookup = {}
    for stop in stops:
        key = normalize_location_key(stop)
        group = lookup.get(key)
        if group:
            group['stops'].append(stop)
            continue
        group = {
            'key': key,
            'lat': float(stop.get('lat') or 0),
            'lng': float(stop.get('lng') or 0),
            'address': stop.get('address') or '-',
            'label': stop.get('address') or stop.get('name') or '未命名站點',
            'stops': [stop],
        }
        lookup[key] = group
        groups.append(group)
    return groups


def evaluate_route(route):
    total_duration = 0
    total_distance = 0
    for i in range(len(route) - 1):
        seg = infer_segment(route[i], route[i + 1])
        total_duration += seg['durationSec']
        total_distance += seg['distanceM']
    return total_duration, total_distance


def sort_group_stops(group):
    stops = list(group.get('stops') or [])
    deliveries = [stop for stop in stops if stop.get('type') == 'delivery']
    pickups = [stop for stop in stops if stop.get('type') == 'pickup']
    others = [stop for stop in stops if stop.get('type') not in {'delivery', 'pickup'}]
    return deliveries + pickups + others


def validate_business_route(route):
    pickup_seen = False
    for stop in route:
        stop_type = stop.get('type') if isinstance(stop, dict) else None
        if stop_type == 'pickup':
            pickup_seen = True
        elif pickup_seen and stop_type == 'delivery':
            return False
    return True


def build_maps_url(route):
    deduped = []
    for idx, stop in enumerate(route):
        if idx in {0, len(route) - 1}:
            deduped.append(stop)
            continue
        if normalize_location_key(stop) == normalize_location_key(route[idx - 1]):
            continue
        deduped.append(stop)
    origin = f"{deduped[0]['lat']},{deduped[0]['lng']}"
    destination = f"{deduped[-1]['lat']},{deduped[-1]['lng']}"
    waypoints = '|'.join([f"{r['lat']},{r['lng']}" for r in deduped[1:-1]])
    return (
        'https://www.google.com/maps/dir/?api=1'
        f'&origin={quote(origin)}'
        f'&destination={quote(destination)}'
        '&travelmode=driving'
        f'&waypoints={quote(waypoints)}'
    )


def optimize_trip(payload):
    factory = payload.get('factory')
    stops = payload.get('stops', [])
    if not factory or not isinstance(stops, list):
        raise ValueError('factory/stops invalid')

    deliveries = [s for s in stops if s.get('type') == 'delivery']
    pickups = [s for s in stops if s.get('type') == 'pickup']
    location_groups = group_stops_by_location(stops)

    if not stops:
        raise ValueError('stops required')

    best_route = None
    best_duration = None
    best_distance = None
    best_groups = []
    candidate_count = 0

    for group_order in itertools.permutations(location_groups):
        ordered_groups = []
        for group in group_order:
            ordered_groups.append({**group, 'stops': sort_group_stops(group)})
        ordered_stops = [stop for group in ordered_groups for stop in group['stops']]
        route = [factory] + ordered_stops + [factory]
        if not validate_business_route(route):
            continue
        duration, distance = evaluate_route(route)
        candidate_count += 1
        if best_duration is None or duration < best_duration:
            best_route = route
            best_duration = duration
            best_distance = distance
            best_groups = [
                {
                    'key': group['key'],
                    'label': group['label'],
                    'address': group['address'],
                    'stopIds': [stop.get('id') for stop in group['stops']],
                    'stops': group['stops'],
                }
                for group in ordered_groups
            ]

    if best_route is None:
        raise ValueError('No valid route satisfies delivery-before-pickup rules')

    return {
        'originalStops': stops,
        'grouped': {
            'deliveries': deliveries,
            'pickups': pickups,
            'locations': [
                {
                    'key': group['key'],
                    'label': group['label'],
                    'address': group['address'],
                    'stopIds': [stop.get('id') for stop in group['stops']],
                }
                for group in location_groups
            ],
        },
        'candidateCount': candidate_count,
        'bestRoute': {
            'pointIds': [p.get('id') for p in best_route],
            'orderedStops': best_route,
            'orderedGroups': best_groups,
            'totalDurationSec': best_duration,
            'totalDistanceM': best_distance,
        },
        'googleMapsUrl': build_maps_url(best_route),
    }
