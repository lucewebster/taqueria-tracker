// Create the map and center it on Melbourne
const map = L.map('map', {
  zoomControl: false
}).setView([-37.8136, 144.9631], 13);

L.control.zoom({ position: 'topleft' }).addTo(map);

// Add a clean, muted base map layer
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors'
}).addTo(map);

const locationIcon = L.divIcon({
  className: 'custom-marker',
  html: '<span></span>',
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  popupAnchor: [0, -30]
});

const storageKey = 'acoquria-locations';
const starterLocation = null;

let selectedLatLng = null;
let selectedMarker = null;
let editLocationId = null;
let locations = JSON.parse(localStorage.getItem(storageKey) || '[]');
let csvLocations = [];
let userMarker = null;
let routeLine = null;

if (!locations.length) {
  locations = [];
  localStorage.setItem(storageKey, JSON.stringify(locations));
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseTimeString(text) {
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] || '0');
  const suffix = match[3] && match[3].toLowerCase();

  if (suffix) {
    if (hour === 12) hour = suffix === 'am' ? 0 : 12;
    else if (suffix === 'pm') hour += 12;
  }

  if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
    return hour * 60 + minute;
  }

  return null;
}

const weekDayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function formatMinutesToTime(minutes) {
  const normalized = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const suffix = hour >= 12 ? 'pm' : 'am';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${minute.toString().padStart(2, '0')} ${suffix}`;
}

function parseDayPeriods(text) {
  const normalized = String(text || '').trim();
  if (!normalized || /closed|shut/i.test(normalized)) return [];

  return normalized
    .split(';')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const match = segment.match(/^(\d{1,2}(?::\d{2})?)\s*-\s*(\d{1,2}(?::\d{2})?)$/);
      if (!match) return null;

      const start = parseTimeString(match[1]);
      let end = parseTimeString(match[2]);

      if (start === null || end === null) return null;
      if (end <= start) end += 24 * 60;

      return {
        start,
        end,
        raw: `${match[1]}-${match[2]}`
      };
    })
    .filter(Boolean);
}

function getPeriodsForDay(dayIndex, schedule) {
  const todayPeriods = schedule[weekDayKeys[dayIndex]] || [];
  const previousDayIndex = (dayIndex + 6) % 7;
  const overflowPeriods = (schedule[weekDayKeys[previousDayIndex]] || [])
    .filter((period) => period.end > 24 * 60)
    .map((period) => ({
      start: 0,
      end: period.end - 24 * 60,
      raw: period.raw
    }));

  return [...todayPeriods, ...overflowPeriods];
}

function findNextOpening(schedule, dayIndex, currentMinutes) {
  for (let offset = 0; offset < 7; offset += 1) {
    const index = (dayIndex + offset) % 7;
    const periods = schedule[weekDayKeys[index]] || [];
    const validPeriods = periods.filter((period) => offset > 0 || period.start > currentMinutes);
    if (validPeriods.length) {
      const nextPeriod = validPeriods.reduce((current, candidate) => (candidate.start < current.start ? candidate : current));
      return { dayIndex: index, offset, period: nextPeriod };
    }
  }
  return null;
}

function determineOpenStatus(schedule, dayIndex, currentMinutes) {
  const todaysPeriods = getPeriodsForDay(dayIndex, schedule);
  const openPeriod = todaysPeriods.find((period) => currentMinutes >= period.start && currentMinutes < period.end);
  if (openPeriod) {
    return { isOpen: true, period: openPeriod };
  }

  const nextOpening = findNextOpening(schedule, dayIndex, currentMinutes);
  return { isOpen: false, nextOpening };
}

function getOpenStatusFromSchedule(schedule, now = new Date()) {
  const dayIndex = now.getDay();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const status = determineOpenStatus(schedule, dayIndex, currentMinutes);

  if (status.isOpen) {
    return {
      isOpen: true,
      label: `Open — closes at ${formatMinutesToTime(status.period.end)}`,
      closesAt: formatMinutesToTime(status.period.end)
    };
  }

  if (status.nextOpening) {
    const dayLabel = status.nextOpening.offset === 0 ? '' : status.nextOpening.offset === 1 ? ' tomorrow' : ` ${weekDayKeys[status.nextOpening.dayIndex].slice(0, 3)}`;
    return {
      isOpen: false,
      label: `Closed — opens${dayLabel} at ${formatMinutesToTime(status.nextOpening.period.start)}`,
      opensAt: formatMinutesToTime(status.nextOpening.period.start)
    };
  }

  return {
    isOpen: false,
    label: 'Closed',
    opensAt: null
  };
}

function getOpenStatusFromRawHours(openingHours) {
  if (!openingHours) return null;
  const normalized = openingHours.trim().toLowerCase();

  if (/open\s*24/i.test(normalized)) {
    return { isOpen: true, label: 'Open now' };
  }

  if (/closed|shut/i.test(normalized)) {
    return { isOpen: false, label: 'Closed now' };
  }

  const matches = [...normalized.matchAll(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi)].map((m) => m[1]);
  if (matches.length < 2) return { isOpen: false, label: 'Closed now' };

  const start = parseTimeString(matches[0]);
  let end = parseTimeString(matches[1]);
  if (start === null || end === null) return { isOpen: false, label: 'Closed now' };

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  if (end <= start) end += 24 * 60;

  if (currentMinutes >= start && currentMinutes < end) {
    return {
      isOpen: true,
      label: `Open — closes at ${formatMinutesToTime(end)}`
    };
  }

  if (currentMinutes < start) {
    return {
      isOpen: false,
      label: `Closed — opens at ${formatMinutesToTime(start)}`
    };
  }

  return { isOpen: false, label: 'Closed now' };
}

function getOpenStatus(location) {
  if (location.weeklySchedule) {
    return getOpenStatusFromSchedule(location.weeklySchedule);
  }
  return getOpenStatusFromRawHours(location.openingHours);
}

function buildScheduleHtml(weeklySchedule) {
  return weekDayKeys
    .map((day) => {
      const dayLabel = `${day[0].toUpperCase()}${day.slice(1)}`;
      const periods = weeklySchedule[day] || [];
      const text = periods.length ? periods.map((period) => escapeHtml(period.raw)).join('; ') : 'Closed';
      return `<div><strong>${dayLabel}:</strong> ${text}</div>`;
    })
    .join('');
}

function buildPopupHtml(location) {
  const description = location.description ? `<p>${escapeHtml(location.description)}</p>` : '';
  const status = getOpenStatus(location);

  const statusText = status
    ? `<p><span class="status ${status.isOpen ? 'open' : 'closed'}">${status.isOpen ? 'Open' : 'Closed'}</span> ${escapeHtml(status.label.replace(/^(Open|Closed)\s*[-–]?\s*/i, ''))}</p>`
    : '';

  const hoursHtml = location.weeklySchedule
    ? ''
    : location.openingHours
    ? `<p><strong>Opening hours:</strong> ${escapeHtml(location.openingHours)}</p>`
    : '';

  return `
    <div class="popup-content">
      <h3>${escapeHtml(location.name)}</h3>
      ${statusText}
      ${description}
      ${hoursHtml}
      <button class="direction-btn" type="button">Get directions</button>
    </div>
  `;
}

function getDistanceKm(from, to) {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

const userLocationIcon = L.icon({
  iconUrl: 'images/person_icon.png',
  iconSize: [22, 22],
  iconAnchor: [11, 22],
  popupAnchor: [0, -18]
});

function formatDistance(distanceKm) {
  if (distanceKm >= 1) {
    return `${distanceKm.toFixed(1)} km`;
  }
  return `${Math.round(distanceKm * 1000)} m`;
}

function requestUserLocation() {
  if (!navigator.geolocation) {
    alert('Geolocation is not supported by your browser.');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude } = position.coords;

      if (userMarker) {
        map.removeLayer(userMarker);
      }

      userMarker = L.marker([latitude, longitude], { icon: userLocationIcon })
        .addTo(map)
        .bindPopup('<div class="popup-content"><p>You are here</p></div>', { closeButton: false })
        .openPopup();

      map.setView([latitude, longitude], 14);
    },
    (error) => {
      alert('Unable to retrieve your location.');
      console.error(error);
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    }
  );
}

function showRouteTo(location) {
  const destination = `${location.name}, Melbourne`;
  const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`;
  window.open(googleMapsUrl, '_blank');
}

function renderMarkers() {
  map.eachLayer((layer) => {
    if (layer instanceof L.Marker) {
      map.removeLayer(layer);
    }
  });

  locations.forEach((location) => {
    const marker = L.marker([location.lat, location.lng], { icon: locationIcon })
      .addTo(map)
      .bindTooltip(escapeHtml(location.name), { direction: 'top', offset: [0, -8] })
      .bindPopup(buildPopupHtml(location), { closeButton: false });

    marker.on('popupopen', (event) => {
      const popupNode = event.popup.getElement();
      const button = popupNode.querySelector('.direction-btn');
      if (button) {
        button.addEventListener('click', () => showRouteTo(location));
      }
    });
  });
}

function parseWeeklySchedule(rawData) {
  const schedule = {};
  weekDayKeys.forEach((day) => {
    schedule[day] = parseDayPeriods(rawData[day]);
  });
  return schedule;
}

async function loadCsvLocations() {
  try {
    const response = await fetch('csv_files/taco_info.csv');
    if (!response.ok) throw new Error(`CSV fetch failed: ${response.status}`);
    const csvText = await response.text();
    const lines = csvText.trim().split('\n');
    const [headerLine, ...rows] = lines;
    const headers = headerLine.split(',').map((value) => value.trim().toLowerCase());

    csvLocations = rows
      .map((row) => row.split(',').map((value) => value.trim()))
      .filter((values) => values.length === headers.length)
      .map((values) => {
        const rowData = headers.reduce((acc, key, index) => {
          acc[key] = values[index];
          return acc;
        }, {});

        return {
          id: `csv-${rowData.name.replace(/\s+/g, '-').toLowerCase()}`,
          name: rowData.name,
          description: '',
          openingHours: '',
          weeklySchedule: parseWeeklySchedule(rowData),
          lat: Number(rowData.latitude),
          lng: Number(rowData.longitude)
        };
      });

    locations = [...csvLocations, ...locations.filter((entry) => entry.id !== 'starter-melbourne')];
    renderMarkers();
    requestUserLocation();
  } catch (error) {
    console.error('Error loading CSV locations:', error);
  }
}


loadCsvLocations();