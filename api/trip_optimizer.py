"""Address-based trips with optional Google road distance matrix.

Without a server API key, only a business-order itinerary is returned. No invented
coordinates, distance or travel time are substituted for unavailable road data.
"""
import itertools
import json
import os
from urllib.parse import quote
from urllib.request import Request, urlopen

MAX_STOPS = 24


def normalize_location_key(stop):
    address = str(stop.get('address') or '').strip()
    if not address or address == '-':
        raise ValueError('每個站點都必須填寫真實地址')
    return address.lower()


def validate_business_route(route):
    pickup_seen = False
    for stop in route:
        kind = stop.get('type')
        if kind == 'pickup':pickup_seen = True
        elif kind == 'delivery' and pickup_seen:return False
    return True


def build_maps_url(route):
    places = [stop['address'] for index, stop in enumerate(route)
              if index in (0, len(route)-1) or normalize_location_key(stop) != normalize_location_key(route[index-1])]
    # Google Maps URLs support at most nine intermediate waypoints on desktop.
    if len(places) > 11:return None
    return ('https://www.google.com/maps/dir/?api=1&travelmode=driving'
            f'&origin={quote(places[0])}&destination={quote(places[-1])}'
            f'&waypoints={quote("|".join(places[1:-1]))}')


def road_matrix(addresses, key):
    """Google Routes matrix, bounded to 25 addresses / 625 elements."""
    size = len(addresses)
    if not 1 <= size <= MAX_STOPS + 1:
        raise ValueError('道路服務地址數量超出限制')
    payload = {
        'origins': [{'waypoint': {'address': address}} for address in addresses],
        'destinations': [{'waypoint': {'address': address}} for address in addresses],
        'travelMode': 'DRIVE',
        'routingPreference': 'TRAFFIC_UNAWARE',
    }
    request = Request(
        'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
        data=json.dumps(payload).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': key,
            'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,status,condition',
        },
        method='POST',
    )
    try:
        with urlopen(request, timeout=15) as response:
            elements = json.loads(response.read())
    except Exception:
        raise ValueError('道路導航服務暫時無法使用；請檢查 Routes API 設定及額度，或依真實地址開啟 Google Maps') from None
    matrix = [[None] * size for _ in addresses]
    if not isinstance(elements, list):
        raise ValueError('道路導航回傳資料格式無效')
    for element in elements:
        try:
            origin = element.get('originIndex', 0)
            destination = element.get('destinationIndex', 0)
            if not isinstance(origin, int) or not isinstance(destination, int) or not (0 <= origin < size and 0 <= destination < size):
                raise ValueError()
            if element.get('condition') != 'ROUTE_EXISTS' or element.get('status', {}).get('code', 0) != 0:
                raise ValueError()
            same_address = addresses[origin].strip().lower() == addresses[destination].strip().lower()
            distance = float(element.get('distanceMeters', 0) if same_address else element['distanceMeters'])
            duration = float((element.get('duration', '0s') if same_address else element['duration']).removesuffix('s'))
            import math
            if not math.isfinite(distance) or not math.isfinite(duration) or min(distance, duration) < 0:
                raise ValueError()
            matrix[origin][destination] = (duration, distance)
        except (KeyError, TypeError, ValueError, AttributeError):
            raise ValueError('有站點無法定位或沒有可行道路，請確認地址') from None
    if any(value is None for row in matrix for value in row):
        raise ValueError('道路導航回傳資料不完整')
    return matrix


def optimize_trip(payload):
    factory = payload.get('factory')
    stops = payload.get('stops')
    if not isinstance(factory,dict) or not isinstance(stops,list) or not stops:raise ValueError('factory/stops invalid')
    if len(stops) > MAX_STOPS:raise ValueError(f'每趟最多 {MAX_STOPS} 個站點，請拆分車趟')
    points = [dict(factory), *[dict(stop) for stop in stops if isinstance(stop,dict)]]
    if len(points) != len(stops)+1:raise ValueError('站點資料格式錯誤')
    for point in points:normalize_location_key(point)
    if any(stop.get('type') not in {'delivery','pickup'} for stop in stops):raise ValueError('站點必須是送貨或取貨')
    # Remove legacy, fabricated lat/lng values; the provider receives addresses.
    for point in points:
        point.pop('lat',None);point.pop('lng',None)
    key = os.environ.get('GOOGLE_MAPS_API_KEY','').strip()
    matrix = road_matrix([point['address'] for point in points],key) if key else None
    indices = list(range(1,len(points)))
    candidates = 0
    if payload.get('preserveOrder'):
        ordered = indices
        if not validate_business_route([points[i] for i in ordered]):raise ValueError('路線必須先送貨再取貨')
    elif matrix and len(stops) <= 7:
        valid = (order for order in itertools.permutations(indices) if validate_business_route([points[i] for i in order]))
        best = None
        for order in valid:
            candidates += 1
            path = [0,*order,0]
            score = sum(matrix[a][b][0] for a,b in zip(path,path[1:]))
            if best is None or score < best[0]:best=(score,list(order))
        ordered=best[1]
    else:
        ordered=[];current=0
        for kind in ('delivery','pickup'):
            remaining=[i for i in indices if points[i]['type']==kind]
            while remaining:
                following=min(remaining,key=lambda i:matrix[current][i][0]) if matrix else remaining[0]
                ordered.append(following);remaining.remove(following);current=following
    path=[0,*ordered,0]
    route=[points[i] for i in path]
    duration=sum(matrix[a][b][0] for a,b in zip(path,path[1:])) if matrix else None
    distance=sum(matrix[a][b][1] for a,b in zip(path,path[1:])) if matrix else None
    chunks=[]
    for start in range(0,len(route)-1,10):chunks.append(build_maps_url(route[start:start+11]))
    return {'originalStops':points[1:],'grouped':{'deliveries':[p for p in points[1:] if p['type']=='delivery'],'pickups':[p for p in points[1:] if p['type']=='pickup']},
            'candidateCount':candidates or 1,'routeMode':'road' if matrix else 'address-only',
            'notice': ('依道路行車時間排序；超過 7 站採逐站選擇較近路線，非保證最短路線。' if matrix else '尚未設定道路導航服務：僅依送貨優先排列真實地址，未計算距離或時間。'),
            'bestRoute':{'pointIds':[p.get('id') for p in route],'orderedStops':route,'orderedGroups':[],'totalDurationSec':duration,'totalDistanceM':distance},
            'googleMapsUrl':build_maps_url(route),'googleMapsUrls':[url for url in chunks if url]}
