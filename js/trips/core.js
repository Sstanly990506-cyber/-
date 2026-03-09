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
  const origin = `${route[0].lat},${route[0].lng}`;
  const destination = `${route[route.length - 1].lat},${route[route.length - 1].lng}`;
  const waypoints = route.slice(1, -1).map((p) => `${p.lat},${p.lng}`).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving&waypoints=${encodeURIComponent(waypoints)}`;
}

export function validateBusinessRoute(route) {
  const body = route.slice(1, -1);
  let seenPickup = false;
  for (const stop of body) {
    if (stop.type === 'pickup') seenPickup = true;
    if (seenPickup && stop.type === 'delivery') return false;
  }
  return true;
}

export function optimizeTrip(factory, stops) {
  const deliveries = stops.filter((s) => s.type === 'delivery');
  const pickups = stops.filter((s) => s.type === 'pickup');

  let best = null;
  let candidateCount = 0;

  permute(deliveries).forEach((d) => {
    permute(pickups).forEach((p) => {
      const route = [factory, ...d, ...p, factory];
      const score = evaluateRoute(route);
      candidateCount += 1;
      if (!best || score.totalDurationSec < best.totalDurationSec) {
        best = { ...score, orderedStops: route };
      }
    });
  });

  return {
    originalStops: stops,
    grouped: { deliveries, pickups },
    candidateCount,
    bestRoute: {
      pointIds: best.orderedStops.map((s) => s.id),
      orderedStops: best.orderedStops,
      totalDurationSec: best.totalDurationSec,
      totalDistanceM: best.totalDistanceM,
    },
    googleMapsUrl: buildGoogleMapsUrl(best.orderedStops),
  };
}
