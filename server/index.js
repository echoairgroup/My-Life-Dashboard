import express from "express";
import cors from "cors";
import ICAL from "ical.js";

const app = express();
const PORT = process.env.PORT || 10000;
app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

const MAGISTER = process.env.MAGISTER_FEED_URL || "";
const NEWSKY_ID = process.env.NEWSKY_AIRLINE_ID || "6671c567ed19d758f72965d4";
const NEWSKY_KEY = process.env.NEWSKY_API_KEY || "";
const SIMBRIEF = process.env.SIMBRIEF_USERNAME || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_FALLBACK_MODEL = "gemini-2.5-flash-lite";
const AI_BUILD = "gemini35-lite-with-25-lite-fallback-2026-09-24";

async function callGemini(instructions, input, model = GEMINI_MODEL, image = null, attempt = 0) {
  if (!GEMINI_KEY) throw Error("GEMINI_API_KEY ontbreekt in Render Environment");

  const prompt = (instructions ? instructions + "\n\n" : "") + String(input ?? "");
  const parts = [{ text: prompt }];
  if (image?.data && image?.mimeType) {
    parts.push({
      inline_data: {
        mime_type: image.mimeType,
        data: image.data
      }
    });
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent",
    {
      method: "POST",
      headers: {
        "x-goog-api-key": GEMINI_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }]
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || ("Gemini HTTP " + response.status);
    const overloaded =
      response.status === 429 ||
      response.status === 503 ||
      /high demand|overloaded|temporar|unavailable|capacity|resource exhausted/i.test(message);

    if (overloaded && attempt === 0) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      return callGemini(instructions, input, model, image, 1);
    }

    if (model === GEMINI_MODEL && overloaded) {
      return callGemini(instructions, input, GEMINI_FALLBACK_MODEL, image, 0);
    }

    throw Error(message);
  }

  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  return { text: text || "Geen antwoord ontvangen.", model };
}

let cache = {
  m: { at: 0, data: [] },
  n: { at: 0, data: [], diagnostics: [] },
  s: { at: 0, data: null }
};

const fresh = x => x.at && Date.now() - x.at < 120000;
const pick = (o, ...keys) => {
  for (const key of keys) {
    const value = key.split(".").reduce((a, b) => a?.[b], o);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
};
const arraysDeep = (value, seen = new Set()) => {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const out = [];
  if (Array.isArray(value)) out.push(value);
  for (const v of Object.values(value)) if (v && typeof v === "object") out.push(...arraysDeep(v, seen));
  return out;
};
const asNumber = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const durationMinutes = v => {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^\d{3,4}$/.test(s)) {
    const n = Number(s);
    return Math.floor(n / 100) * 60 + n % 100;
  }
  if (/^\d+:\d{2}$/.test(s)) {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  }
  return asNumber(s);
};
const clean = x => String(x ?? "").replace(/\\n/g, " ").replace(/\\,/g, ",").trim();

async function magister() {
  if (!MAGISTER) return { configured: false, events: [] };
  if (fresh(cache.m)) return { configured: true, events: cache.m.data };
  const url = MAGISTER.replace(/^webcal:/i, "https:");
  const r = await fetch(url);
  if (!r.ok) throw Error("Magister HTTP " + r.status);
  const component = new ICAL.Component(ICAL.parse(await r.text()));
  const events = component.getAllSubcomponents("vevent")
    .map(v => {
      const e = new ICAL.Event(v);
      const start = e.startDate?.toJSDate?.();
      const end = e.endDate?.toJSDate?.();
      return {
        id: v.getFirstPropertyValue("uid") || crypto.randomUUID(),
        title: clean(e.summary),
        start: start?.toISOString(),
        end: end?.toISOString(),
        location: clean(e.location),
        description: clean(e.description),
        source: "magister"
      };
    })
    .filter(x => x.start);
  cache.m = { at: Date.now(), data: events };
  return { configured: true, events };
}

async function newsky() {
  if (!NEWSKY_KEY) throw Object.assign(Error("NEWSKY_API_KEY ontbreekt in Render Environment"), { diagnostics: [] });
  if (fresh(cache.n)) return { configured: true, flights: cache.n.data, diagnostics: cache.n.diagnostics };
  const end = new Date();
  const startDate = new Date(end);
  startDate.setDate(end.getDate() - 90);
  let skip = 0;
  const diagnostics = [];
  const all = [];

  while (skip < 1000) {
    const body = {
      start: startDate.toISOString(),
      end: end.toISOString(),
      skip,
      count: 100,
      includeDeleted: false
    };
    const r = await fetch("https://newsky.app/api/airline-api/flights/bydate", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + NEWSKY_KEY,
        "Content-Type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(body)
    });
    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    diagnostics.push({
      status: r.status,
      keys: data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data).slice(0, 30) : [],
      bodyPreview: data ? undefined : raw.slice(0, 300)
    });
    if (!r.ok) throw Object.assign(Error("NewSky HTTP " + r.status), { diagnostics });

    const candidates = arraysDeep(data).filter(a => a.some(x => x && typeof x === "object" && !Array.isArray(x)));
    const list = (Array.isArray(data) ? data : null) ||
      data?.results || data?.flights || data?.data || data?.items || data?.rows ||
      candidates.sort((a, b) => b.length - a.length)[0] || [];

    const page = list.filter(f => f && typeof f === "object").map(f => ({
      id: String(pick(f, "_id", "id", "flightId", "uuid") || crypto.randomUUID()),
      flightNumber: String(pick(f, "flightNumber", "callsign", "flight_number", "flight.number", "number") || ""),
      dep: String(pick(f, "dep.icao", "dep", "departure.icao", "departure", "origin.icao", "origin", "originIcao", "departureIcao") || ""),
      arr: String(pick(f, "arr.icao", "arr", "arrival.icao", "arrival", "destination.icao", "destination", "destinationIcao", "arrivalIcao") || ""),
      aircraft: String(pick(f, "aircraft.icao", "aircraft", "airframe.icao", "airframe", "aircraftType", "aircraftCode") || ""),
      duration: durationMinutes(pick(f, "duration", "flightTime", "durationMinutes", "flight_time", "time") || 0),
      distance: asNumber(pick(f, "distance", "distanceNm", "distanceNM", "flightDistance", "nm") || 0),
      rating: asNumber(pick(f, "rating", "score", "stars", "flightRating") || 0),
      date: pick(f, "date", "depTime", "departureTime", "createdAt", "completedAt", "finishedAt", "dateTime") || null,
      source: "newsky"
    })).filter(f => f.dep && f.arr);

    all.push(...page);
    if (list.length < 100) break;
    skip += 100;
  }

  const unique = [...new Map(all.map(f => [f.id, f])).values()];
  cache.n = { at: Date.now(), data: unique, diagnostics };
  return { configured: true, flights: unique, diagnostics };
}

async function simbrief() {
  if (!SIMBRIEF) return { configured: false, flight: null };
  if (fresh(cache.s)) return { configured: true, flight: cache.s.data };
  const url = "https://www.simbrief.com/api/xml.fetcher.php?username=" + encodeURIComponent(SIMBRIEF) + "&json=1";
  const r = await fetch(url);
  if (!r.ok) throw Error("SimBrief HTTP " + r.status);
  const d = await r.json();
  const g = d.general || {}, o = d.origin || {}, a = d.destination || {}, ac = d.aircraft || {}, t = d.times || {}, at = d.atc || {};
  const flight = {
    id: String(pick(g, "static_id", "flight_number") || Date.now()),
    flightNumber: String(pick(g, "flight_number") || ""),
    dep: String(pick(o, "icao_code", "icao") || ""),
    arr: String(pick(a, "icao_code", "icao") || ""),
    aircraft: String(pick(ac, "icaocode", "icao", "name") || ""),
    route: String(pick(g, "route") || ""),
    cruiseAltitude: String(pick(g, "initial_altitude") || ""),
    distance: asNumber(pick(g, "air_distance", "distance") || 0),
    duration: durationMinutes(pick(t, "est_time_enroute", "sched_time") || 0),
    departure: pick(t, "sched_out", "est_out") || null,
    callsign: String(pick(at, "callsign") || ""),
    source: "simbrief"
  };
  cache.s = { at: Date.now(), data: flight };
  return { configured: true, flight };
}

app.get("/health", (_, res) => res.json({
  ok: true,
  service: "my-life-dashboard-api",
  ai: Boolean(GEMINI_KEY),
  aiProvider: "gemini",
  aiModel: GEMINI_MODEL,
  aiBuild: AI_BUILD
}));

app.get("/api/ai/status", (_, res) => res.json({
  configured: Boolean(GEMINI_KEY),
  provider: "Gemini",
  model: GEMINI_MODEL,
  fallbackModel: GEMINI_FALLBACK_MODEL,
  build: AI_BUILD
}));

app.post("/api/ai/chat", async (req, res) => {
  try {
    const context = req.body?.context || {};
    const question = String(req.body?.message || "");
    const image = req.body?.image && typeof req.body.image === "object" ? req.body.image : null;
    const profile = context.aiProfile || {};
    const instructions =
      "Je bent de persoonlijke assistent van My Life Dashboard. " +
      "Help met planning, school, taken, doelen, Flight Sim en widgets. " +
      "Gebruik persoonlijke feiten uitsluitend uit de dashboardcontext en wees eerlijk als informatie ontbreekt. " +
      "Respecteer ook deze persoonlijke AI-instellingen: " + JSON.stringify(profile) + ". " +
      "Dashboardcontext: " + JSON.stringify(context);
    const result = await callGemini(instructions, question, GEMINI_MODEL, image);
    res.json({ text: result.text, model: result.model, provider: "Gemini" });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/ai/widget", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "");
    const instructions =
      "Ontwerp een veilige zelfstandige HTML-widget voor een persoonlijk dashboard. " +
      "Antwoord uitsluitend met JSON met de velden name, description, html, css en js. " +
      "Geen markdown fences, externe scripts, netwerkrequests of browseracties die data verwijderen. " +
      "Gebruik window.MyLifeWidgetData voor dashboardgegevens. " +
      "De HTML, CSS en JS moeten direct in een sandboxed iframe kunnen draaien. " +
      "Widgetverzoek: " + prompt;
    const result = await callGemini(instructions, "");
    const cleaned = result.text.replace(/^\s*\`\`\`json\s*/i, "").replace(/\s*\`\`\`\s*$/i, "").trim();
    res.json({ widget: JSON.parse(cleaned), model: result.model, provider: "Gemini" });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/integrations/status", (_, res) =>
  res.json({ magister: Boolean(MAGISTER), newsky: Boolean(NEWSKY_KEY), simbrief: Boolean(SIMBRIEF) })
);
app.get("/api/magister/events", async (_, res) => {
  try { res.json(await magister()); }
  catch (e) { res.status(502).json({ configured: Boolean(MAGISTER), events: [], error: e.message }); }
});
app.get("/api/newsky/flights", async (_, res) => {
  try { res.json(await newsky()); }
  catch (e) { res.status(502).json({ configured: Boolean(NEWSKY_KEY), flights: [], error: e.message, diagnostics: e.diagnostics || [] }); }
});
app.get("/api/simbrief/latest", async (_, res) => {
  try { res.json(await simbrief()); }
  catch (e) { res.status(502).json({ configured: Boolean(SIMBRIEF), flight: null, error: e.message }); }
});
app.get("/api/dashboard/sync", async (_, res) => {
  const result = {
    syncedAt: new Date().toISOString(),
    magister: { events: [] },
    newsky: { flights: [] },
    simbrief: { flight: null }
  };
  await Promise.all([
    magister().then(v => result.magister = v).catch(e => result.magister = { events: [], error: e.message }),
    newsky().then(v => result.newsky = v).catch(e => result.newsky = { flights: [], error: e.message, diagnostics: e.diagnostics || [] }),
    simbrief().then(v => result.simbrief = v).catch(e => result.simbrief = { flight: null, error: e.message })
  ]);
  res.json(result);
});

app.listen(PORT, () => console.log("My Life Dashboard API on " + PORT));
