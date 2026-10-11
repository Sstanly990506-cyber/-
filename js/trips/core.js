// Local fallback preserves real addresses and business order without invented metrics.
export function evaluateRoute() {
  return { totalDurationSec: null, totalDistanceM: null };
}
export function buildGoogleMapsUrl(route) {
  if (route.length < 2 || route.length > 11) return null;
  const location = point => {
    if (!point.address || point.address === '-') throw new Error('每個站點都必須填寫真實地址');
    return encodeURIComponent(point.address);
  };
  return `https://www.google.com/maps/dir/?api=1&origin=${location(route[0])}&destination=${location(route.at(-1))}&travelmode=driving&waypoints=${route.slice(1,-1).map(location).join('%7C')}`;
}
export function validateBusinessRoute(route) {
  let pickupSeen = false;
  for (const stop of route) {
    if (stop.type === 'pickup') pickupSeen = true;
    if (pickupSeen && stop.type === 'delivery') return false;
  }
  return true;
}
export function optimizeTrip(factory, stops) {
  if (!stops.length || stops.length > 24) throw new Error('每趟需有 1 到 24 個站點');
  if ([factory, ...stops].some(point => !point.address || point.address === '-')) throw new Error('每個站點都必須填寫真實地址');
  const ordered = [...stops.filter(s => s.type === 'delivery'), ...stops.filter(s => s.type === 'pickup')];
  const route = [factory, ...ordered, factory];
  const urls = [];
  for (let start = 0; start < route.length - 1; start += 10) urls.push(buildGoogleMapsUrl(route.slice(start, start + 11)));
  return { originalStops: stops, candidateCount: 1, routeMode: 'address-only', notice: '道路服務無法連線：僅排列真實地址，未計算距離或時間。',
    bestRoute: { pointIds: route.map(s => s.id), orderedStops: route, totalDurationSec: null, totalDistanceM: null }, googleMapsUrl: buildGoogleMapsUrl(route), googleMapsUrls: urls };
}
