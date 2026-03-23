import { DEFAULT_FACTORY } from './constants.js';

/** @typedef {'delivery'|'pickup'} StopType */
/**
 * @typedef {Object} TripStop
 * @property {string} id
 * @property {string} name
 * @property {string} address
 * @property {number} lat
 * @property {number} lng
 * @property {StopType} type
 * @property {string} relatedOrderId
 * @property {string=} note
 */

function permute(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  arr.forEach((item, idx) => {
    const rest = arr.slice(0, idx).concat(arr.slice(idx + 1));
    permute(rest).forEach((tail) => out.push([item, ...tail]));
  });
  return out;
}

function hashText(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

export function inferLatLngFromAddress(address = '') {
  const h = hashText(address || 'UNKNOWN');
  return {
    lat: DEFAULT_FACTORY.lat + ((h % 1000) - 500) / 10000,
    lng: DEFAULT_FACTORY.lng + (((h >> 10) % 1000) - 500) / 10000,
  };
}

function segment(a, b) {
  const dx = (Number(a.lat) - Number(b.lat)) * 111000;
  const dy = (Number(a.lng) - Number(b.lng)) * 101000;
  const distanceM = Math.round(Math.sqrt(dx * dx + dy * dy));
  const durationSec = Math.max(60, Math.round((distanceM / 1000) * 180));
  return { distanceM, durationSec };
}

function normalizeLocationKey(stop) {
  const address = String(stop.address || '').trim().toLowerCase();
  if (address && address !== '-') return `address:${address}`;
  return `latlng:${Number(stop.lat || 0).toFixed(5)},${Number(stop.lng || 0).toFixed(5)}`;
}

function groupStopsByLocation(stops) {
  const groups = [];
  const map = new Map();
  stops.forEach((stop) => {
    const key = normalizeLocationKey(stop);
    const existing = map.get(key);
    if (existing) {
      existing.stops.push(stop);
      return;
    }
    const group = {
      key,
      lat: Number(stop.lat || 0),
      lng: Number(stop.lng || 0),
      address: stop.address || '-',
      label: stop.address || stop.name || '未命名站點',
      stops: [stop],
    };
    map.set(key, group);
    groups.push(group);
  });
  return groups;
}

export function evaluateRoute(route) {
  let totalDurationSec = 0;
  let totalDistanceM = 0;
  for (let i = 0; i < route.length - 1; i += 1) {
    const seg = segment(route[i], route[i + 1]);
    totalDurationSec += seg.durationSec;
    totalDistanceM += seg.distanceM;
  }
  return { totalDurationSec, totalDistanceM };
}

export function buildGoogleMapsUrl(route) {
  const deduped = route.filter((point, idx) => idx === 0
    || idx === route.length - 1
    || normalizeLocationKey(point) !== normalizeLocationKey(route[idx - 1]));
  const origin = `${deduped[0].lat},${deduped[0].lng}`;
  const destination = `${deduped[deduped.length - 1].lat},${deduped[deduped.length - 1].lng}`;
  const waypoints = deduped.slice(1, -1).map((p) => `${p.lat},${p.lng}`).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving&waypoints=${encodeURIComponent(waypoints)}`;
}

function sortGroupStops(group) {
  const deliveries = group.stops.filter((stop) => stop.type === 'delivery');
  const pickups = group.stops.filter((stop) => stop.type === 'pickup');
  const others = group.stops.filter((stop) => !['delivery', 'pickup'].includes(stop.type));
  return [...deliveries, ...pickups, ...others];
}

export function validateBusinessRoute(route) {
  let pickupSeen = false;
  for (const stop of route) {
    if (!stop || !stop.type) continue;
    if (stop.type === 'pickup') pickupSeen = true;
    if (pickupSeen && stop.type === 'delivery') return false;
  }
  return true;
}

export function optimizeTrip(factory, stops) {
  const deliveries = stops.filter((s) => s.type === 'delivery');
  const pickups = stops.filter((s) => s.type === 'pickup');
  const groups = groupStopsByLocation(stops);

  let best = null;
  let candidateCount = 0;

  permute(groups).forEach((groupOrder) => {
    const orderedGroups = groupOrder.map((group) => {
      const orderedGroupStops = sortGroupStops(group);
      return { ...group, stops: orderedGroupStops };
    });
    const orderedStops = orderedGroups.flatMap((group) => group.stops);
    const route = [factory, ...orderedStops, factory];
    if (!validateBusinessRoute(route)) return;
    const score = evaluateRoute(route);
    candidateCount += 1;
    if (!best || score.totalDurationSec < best.totalDurationSec) {
      best = {
        ...score,
        orderedStops: route,
        orderedGroups: orderedGroups.map((group) => ({
          key: group.key,
          label: group.label,
          address: group.address,
          stopIds: group.stops.map((stop) => stop.id),
          stops: group.stops,
        })),
      };
    }
  });

  if (!best) {
    throw new Error('No valid route satisfies delivery-before-pickup rules');
  }

  return {
    originalStops: stops,
    grouped: { deliveries, pickups, locations: groups.map((group) => ({ key: group.key, label: group.label, address: group.address, stopIds: group.stops.map((stop) => stop.id) })) },
    candidateCount,
    bestRoute: {
      pointIds: best.orderedStops.map((s) => s.id),
      orderedStops: best.orderedStops,
      orderedGroups: best.orderedGroups,
      totalDurationSec: best.totalDurationSec,
      totalDistanceM: best.totalDistanceM,
    },
    googleMapsUrl: buildGoogleMapsUrl(best.orderedStops),
  };
}
