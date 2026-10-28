const DB_NAME = "ticket-vault";
const DB_VERSION = 1;
const STORE_TRIPS = "trips";
const STORE_SEGMENTS = "segments";
const STORE_TICKETS = "tickets";
const DIRECTION_LABELS = {
  outbound: "Outbound",
  inbound: "Inbound",
  "round-trip": "Round Trip",
  local: "Round Trip"
};

let db;
let activeTripId = null;
let deferredInstallPrompt = null;
let swipeStartX = 0;
let swipeStartY = 0;
const objectUrls = new Set();

const dashboard = document.getElementById("dashboard");
const tripFormPanel = document.getElementById("tripFormPanel");
const tripDetail = document.getElementById("tripDetail");
const tripList = document.getElementById("tripList");
const emptyState = document.getElementById("emptyState");
const tripCount = document.getElementById("tripCount");
const tripForm = document.getElementById("tripForm");
const segmentForm = document.getElementById("segmentForm");
const segmentList = document.getElementById("segmentList");
const installBtn = document.getElementById("installBtn");

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const next = request.result;
      if (!next.objectStoreNames.contains(STORE_TRIPS)) {
        const trips = next.createObjectStore(STORE_TRIPS, { keyPath: "id", autoIncrement: true });
        trips.createIndex("startDate", "startDate");
      }
      if (!next.objectStoreNames.contains(STORE_SEGMENTS)) {
        const segments = next.createObjectStore(STORE_SEGMENTS, { keyPath: "id", autoIncrement: true });
        segments.createIndex("tripId", "tripId");
      }
      if (!next.objectStoreNames.contains(STORE_TICKETS)) {
        const tickets = next.createObjectStore(STORE_TICKETS, { keyPath: "id", autoIncrement: true });
        tickets.createIndex("tripId", "tripId");
        tickets.createIndex("segmentId", "segmentId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function store(name, mode = "readonly") {
  return db.transaction(name, mode).objectStore(name);
}

function addRecord(storeName, value) {
  const tx = db.transaction(storeName, "readwrite");
  const request = tx.objectStore(storeName).add(value);
  return Promise.all([requestToPromise(request), txDone(tx)]).then(([id]) => id);
}

function getById(storeName, id) {
  return requestToPromise(store(storeName).get(id));
}

function getAll(storeName) {
  return requestToPromise(store(storeName).getAll());
}

function getByIndex(storeName, indexName, key) {
  return requestToPromise(store(storeName).index(indexName).getAll(key));
}

async function addTripWithSegment(trip, segment, files) {
  const tripId = await addRecord(STORE_TRIPS, trip);
  const segmentId = await addRecord(STORE_SEGMENTS, { ...segment, tripId });
  await addTickets(tripId, segmentId, files);
  return tripId;
}

async function addTickets(tripId, segmentId, files) {
  const list = Array.from(files || []);
  for (const file of list) {
    await addRecord(STORE_TICKETS, {
      tripId,
      segmentId,
      fileName: file.name,
      fileType: file.type || "application/octet-stream",
      blob: file,
      createdAt: Date.now()
    });
  }
}

async function deleteTrip(tripId) {
  const [segments, tickets] = await Promise.all([
    getByIndex(STORE_SEGMENTS, "tripId", tripId),
    getByIndex(STORE_TICKETS, "tripId", tripId)
  ]);
  const tx = db.transaction([STORE_TRIPS, STORE_SEGMENTS, STORE_TICKETS], "readwrite");
  tx.objectStore(STORE_TRIPS).delete(tripId);
  for (const segment of segments) {
    tx.objectStore(STORE_SEGMENTS).delete(segment.id);
  }
  for (const ticket of tickets) {
    tx.objectStore(STORE_TICKETS).delete(ticket.id);
  }
  await txDone(tx);
}

function formatRange(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const sameYear = start.getFullYear() === end.getFullYear();
  const startFmt = start.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
  const endFmt = end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${startFmt} – ${endFmt}`;
}

function localToday() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function isTripActive(trip) {
  const today = localToday();
  return today >= trip.startDate && today <= trip.endDate;
}

function monthKey(startDate) {
  return String(startDate).slice(0, 7);
}

function monthLabel(startDate) {
  const date = new Date(`${startDate}T00:00:00`);
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function directionLabel(value) {
  return DIRECTION_LABELS[value] || value;
}

function show(view) {
  dashboard.classList.toggle("hidden", view !== "dashboard");
  tripFormPanel.classList.toggle("hidden", view !== "form");
  tripDetail.classList.toggle("hidden", view !== "detail");
}

function revokeUrls() {
  for (const url of objectUrls) {
    URL.revokeObjectURL(url);
  }
  objectUrls.clear();
}

function fileUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  return url;
}

async function goHome() {
  activeTripId = null;
  revokeUrls();
  await renderDashboard();
  show("dashboard");
}

function createTripCard(trip, segments, tickets) {
  const active = isTripActive(trip);
  const button = document.createElement("button");
  button.type = "button";
  button.className = active ? "trip-card is-active" : "trip-card";
  const title = document.createElement("strong");
  title.textContent = trip.name;
  const dates = document.createElement("span");
  dates.className = "date-line";
  dates.textContent = formatRange(trip.startDate, trip.endDate);
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `${segments.length} segments · ${tickets.length} tickets`;
  button.appendChild(title);
  if (active) {
    const badges = document.createElement("div");
    badges.className = "badge-row";
    const badge = document.createElement("span");
    badge.className = "badge badge-active";
    badge.textContent = "Active today";
    badges.appendChild(badge);
    button.appendChild(badges);
  }
  button.append(dates, meta);
  button.addEventListener("click", () => openTrip(trip.id));
  return button;
}

async function renderDashboard() {
  const trips = await getAll(STORE_TRIPS);
  trips.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || a.id - b.id);
  tripList.innerHTML = "";
  tripCount.textContent = `${trips.length} stored`;
  emptyState.classList.toggle("hidden", trips.length > 0);
  let currentMonth = "";
  let monthTrips = null;
  for (const trip of trips) {
    const key = monthKey(trip.startDate);
    if (key !== currentMonth) {
      currentMonth = key;
      const group = document.createElement("li");
      group.className = "month-group";
      const heading = document.createElement("h3");
      heading.className = "month-label";
      heading.textContent = monthLabel(trip.startDate);
      monthTrips = document.createElement("ul");
      monthTrips.className = "month-trips";
      group.append(heading, monthTrips);
      tripList.appendChild(group);
    }
    const [segments, tickets] = await Promise.all([
      getByIndex(STORE_SEGMENTS, "tripId", trip.id),
      getByIndex(STORE_TICKETS, "tripId", trip.id)
    ]);
    const item = document.createElement("li");
    item.appendChild(createTripCard(trip, segments, tickets));
    monthTrips.appendChild(item);
  }
}

async function openTrip(tripId) {
  activeTripId = tripId;
  const trip = await getById(STORE_TRIPS, tripId);
  if (!trip) {
    show("dashboard");
    return;
  }
  document.getElementById("detailName").textContent = trip.name;
  document.getElementById("detailDates").textContent = formatRange(trip.startDate, trip.endDate);
  await renderSegments(tripId);
  show("detail");
}

async function renderSegments(tripId) {
  revokeUrls();
  const segments = await getByIndex(STORE_SEGMENTS, "tripId", tripId);
  segmentList.innerHTML = "";
  for (const segment of segments) {
    const tickets = await getByIndex(STORE_TICKETS, "segmentId", segment.id);
    const item = document.createElement("li");
    item.className = "segment-card";
    const title = document.createElement("span");
    title.className = "badge badge-dir";
    title.textContent = directionLabel(segment.direction);
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `Group of ${segment.groupSize}`;
    const wrap = document.createElement("div");
    wrap.className = "tickets";
    for (const ticket of tickets) {
      const link = document.createElement("a");
      link.className = "ticket-link";
      link.href = fileUrl(ticket.blob);
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = ticket.fileName || ticket.fileType;
      wrap.appendChild(link);
    }
    item.append(title, meta, wrap);
    segmentList.appendChild(item);
  }
}

function filesFromForm(form) {
  const input = form.querySelector('input[type="file"]');
  return input ? input.files : [];
}

document.getElementById("newTripBtn").addEventListener("click", () => {
  tripForm.reset();
  show("form");
});

document.getElementById("cancelFormBtn").addEventListener("click", () => {
  show("dashboard");
});

document.getElementById("backBtn").addEventListener("click", () => {
  goHome();
});

tripDetail.addEventListener("touchstart", (event) => {
  const touch = event.changedTouches[0];
  swipeStartX = touch.clientX;
  swipeStartY = touch.clientY;
}, { passive: true });

tripDetail.addEventListener("touchend", (event) => {
  const touch = event.changedTouches[0];
  const dx = touch.clientX - swipeStartX;
  const dy = touch.clientY - swipeStartY;
  if (Math.abs(dx) < 72 || Math.abs(dx) <= Math.abs(dy) * 1.4) return;
  goHome();
}, { passive: true });

document.getElementById("deleteTripBtn").addEventListener("click", async () => {
  if (!activeTripId) return;
  await deleteTrip(activeTripId);
  activeTripId = null;
  revokeUrls();
  await renderDashboard();
  show("dashboard");
});

tripForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(tripForm);
  const startDate = data.get("startDate");
  const endDate = data.get("endDate");
  if (endDate < startDate) return;
  await addTripWithSegment(
    {
      name: String(data.get("name")).trim(),
      startDate,
      endDate,
      createdAt: Date.now()
    },
    {
      direction: data.get("direction"),
      groupSize: Number(data.get("groupSize"))
    },
    filesFromForm(tripForm)
  );
  tripForm.reset();
  await renderDashboard();
  show("dashboard");
});

segmentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeTripId) return;
  const data = new FormData(segmentForm);
  const segmentId = await addRecord(STORE_SEGMENTS, {
    tripId: activeTripId,
    direction: data.get("direction"),
    groupSize: Number(data.get("groupSize"))
  });
  await addTickets(activeTripId, segmentId, filesFromForm(segmentForm));
  segmentForm.reset();
  await renderSegments(activeTripId);
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installBtn.classList.remove("hidden");
});

installBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  if (choice.outcome === "accepted") {
    installBtn.classList.add("hidden");
  }
  deferredInstallPrompt = null;
});

window.addEventListener("appinstalled", () => {
  installBtn.classList.add("hidden");
  deferredInstallPrompt = null;
});

async function registerWorker() {
  if (!("serviceWorker" in navigator)) return;
  await navigator.serviceWorker.register("./sw.js");
}

async function start() {
  db = await openDatabase();
  await renderDashboard();
  show("dashboard");
  await registerWorker();
}

start();
