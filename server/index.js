import express from "express";
import cors from "cors";
import ICAL from "ical.js";
import { initSync, putSync, getSync } from "./sync.js";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

/* =========================================================
   ENVIRONMENT
========================================================= */

const MAGISTER = process.env.MAGISTER_FEED_URL || "";
const NEWSKY_ID =
  process.env.NEWSKY_AIRLINE_ID || "6671c567ed19d758f72965d4";
const NEWSKY_KEY = process.env.NEWSKY_API_KEY || "";
const SIMBRIEF = process.env.SIMBRIEF_USERNAME || "";

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";

const ENV_GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const ENV_GEMINI_FALLBACK_MODEL =
  process.env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite";

/*
 * Models exposed in the My Life AI model selector.
 * These are current Gemini API text/multimodal models.
 */
const GEMINI_MODELS = {
  "gemini-3.5-flash-lite": {
    name: "Gemini 3.5 Flash-Lite",
    description: "Snel, stabiel en geschikt voor dagelijkse chat, vision en widgets."
  },
  "gemini-3.1-flash-lite": {
    name: "Gemini 3.1 Flash-Lite",
    description: "Efficiënte fallback voor hoge belasting en snelle taken."
  }
};

/*
 * Fallback model
 *
 * IMPORTANT:
 * Do NOT use gemini-2.5-flash-lite here.
 * That model is no longer available to new users/projects.
 */
const isAllowedGeminiModel = model =>
  typeof model === "string" &&
  Object.prototype.hasOwnProperty.call(GEMINI_MODELS, model);

const GEMINI_MODEL = isAllowedGeminiModel(ENV_GEMINI_MODEL)
  ? ENV_GEMINI_MODEL
  : "gemini-3.5-flash-lite";

const GEMINI_FALLBACK_MODEL = isAllowedGeminiModel(
  ENV_GEMINI_FALLBACK_MODEL
)
  ? ENV_GEMINI_FALLBACK_MODEL
  : "gemini-3.1-flash-lite";

const AI_BUILD =
  "stable-flash-lite-home-widgets-2026-09-25";

/* =========================================================
   GEMINI AI
========================================================= */

async function callGemini(
  instructions,
  input,
  model = GEMINI_MODEL,
  image = null,
  attempt = 0,
  fallbackUsed = false
) {
  if (!GEMINI_KEY) {
    const error = new Error(
      "GEMINI_API_KEY ontbreekt in Render Environment"
    );
    error.code = "AI_NOT_CONFIGURED";
    error.status = 503;
    throw error;
  }

  const prompt =
    (instructions ? instructions + "\n\n" : "") +
    String(input ?? "");

  const parts = [{ text: prompt }];

  if (image?.data && image?.mimeType) {
    parts.push({
      inline_data: {
        mime_type: image.mimeType,
        data: image.data
      }
    });
  }

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent";

  let response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": GEMINI_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }]
      })
    });
  } catch (networkError) {
    const error = new Error(
      "Kan Gemini niet bereiken: " + networkError.message
    );
    error.code = "AI_NETWORK_ERROR";
    error.status = 502;
    throw error;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data?.error?.message ||
      "Gemini HTTP " + response.status;

    const status = response.status;

    const overloaded =
      status === 429 ||
      status === 503 ||
      /high demand|overloaded|temporar|unavailable|capacity|resource exhausted/i.test(
        message
      );

    const invalidModel =
      status === 404 &&
      /model|not found|unsupported/i.test(message);

    const retryable =
      overloaded ||
      status === 408 ||
      status === 500 ||
      status === 502 ||
      status === 504;

    if (retryable && attempt === 0) {
      await new Promise(resolve =>
        setTimeout(resolve, 1200)
      );

      return callGemini(
        instructions,
        input,
        model,
        image,
        1,
        fallbackUsed
      );
    }

    if (
      (overloaded || invalidModel) &&
      model !== GEMINI_FALLBACK_MODEL &&
      !fallbackUsed
    ) {
      return callGemini(
        instructions,
        input,
        GEMINI_FALLBACK_MODEL,
        image,
        0,
        true
      );
    }

    const error = new Error(message);
    error.code =
      overloaded
        ? "AI_RATE_LIMIT"
        : invalidModel
          ? "AI_MODEL_ERROR"
          : status === 401 || status === 403
            ? "AI_AUTH_ERROR"
            : status === 400
              ? "AI_BAD_REQUEST"
              : "AI_PROVIDER_ERROR";
    error.status =
      status === 401 || status === 403
        ? 502
        : status === 429
          ? 429
          : 502;
    error.model = model;
    error.providerStatus = status;
    throw error;
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("") || "";

  if (!text.trim()) {
    const error = new Error(
      "Gemini gaf geen tekst terug (" +
      (data?.candidates?.[0]?.finishReason || "UNKNOWN") +
      ")."
    );
    error.code = "AI_EMPTY_RESPONSE";
    error.status = 502;
    error.model = model;
    throw error;
  }

  return {
    text: text.trim(),
    model,
    fallbackUsed
  };
}

/* =========================================================
   CACHE
========================================================= */

let cache = {
  m: {
    at: 0,
    data: []
  },

  n: {
    at: 0,
    data: [],
    diagnostics: []
  },

  s: {
    at: 0,
    data: null
  }
};

const fresh = x =>
  x.at &&
  Date.now() - x.at < 120000;

/* =========================================================
   GENERAL HELPERS
========================================================= */

const pick = (object, ...keys) => {
  for (const key of keys) {
    const value = key
      .split(".")
      .reduce(
        (a, b) => a?.[b],
        object
      );

    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }

  return "";
};

const arraysDeep = (
  value,
  seen = new Set()
) => {
  if (
    !value ||
    typeof value !== "object" ||
    seen.has(value)
  ) {
    return [];
  }

  seen.add(value);

  const out = [];

  if (Array.isArray(value)) {
    out.push(value);
  }

  for (const v of Object.values(value)) {
    if (
      v &&
      typeof v === "object"
    ) {
      out.push(
        ...arraysDeep(v, seen)
      );
    }
  }

  return out;
};

const asNumber = value => {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : 0;
};

const durationMinutes = value => {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return 0;
  }

  if (typeof value === "number") {
    return value;
  }

  const string = String(value).trim();

  /*
   * HHMM format
   */
  if (/^\d{3,4}$/.test(string)) {
    const number = Number(string);

    return (
      Math.floor(number / 100) * 60 +
      (number % 100)
    );
  }

  /*
   * HH:MM format
   */
  if (/^\d+:\d{2}$/.test(string)) {
    const [hours, minutes] =
      string.split(":").map(Number);

    return hours * 60 + minutes;
  }

  return asNumber(string);
};

const clean = value =>
  String(value ?? "")
    .replace(/\\n/g, " ")
    .replace(/\\,/g, ",")
    .trim();

/* =========================================================
   MAGISTER
========================================================= */

async function magister() {
  if (!MAGISTER) {
    return {
      configured: false,
      events: []
    };
  }

  if (fresh(cache.m)) {
    return {
      configured: true,
      events: cache.m.data
    };
  }

  const url = MAGISTER.replace(
    /^webcal:/i,
    "https:"
  );

  const response = await fetch(url);

  if (!response.ok) {
    throw Error(
      "Magister HTTP " +
        response.status
    );
  }

  const component = new ICAL.Component(
    ICAL.parse(await response.text())
  );

  const events = component
    .getAllSubcomponents("vevent")
    .map(eventComponent => {
      const event =
        new ICAL.Event(eventComponent);

      const start =
        event.startDate
          ?.toJSDate?.();

      const end =
        event.endDate
          ?.toJSDate?.();

      return {
        id:
          eventComponent.getFirstPropertyValue(
            "uid"
          ) ||
          crypto.randomUUID(),

        title: clean(event.summary),

        start:
          start?.toISOString(),

        end:
          end?.toISOString(),

        location:
          clean(event.location),

        description:
          clean(event.description),

        source: "magister"
      };
    })
    .filter(event => event.start);

  cache.m = {
    at: Date.now(),
    data: events
  };

  return {
    configured: true,
    events
  };
}

/* =========================================================
   NEWSKY
========================================================= */

async function newsky() {
  if (!NEWSKY_KEY) {
    throw Object.assign(
      Error(
        "NEWSKY_API_KEY ontbreekt in Render Environment"
      ),
      {
        diagnostics: []
      }
    );
  }

  if (fresh(cache.n)) {
    return {
      configured: true,
      flights: cache.n.data,
      diagnostics:
        cache.n.diagnostics
    };
  }

  const end = new Date();

  const startDate = new Date(end);

  startDate.setDate(
    end.getDate() - 90
  );

  let skip = 0;

  const diagnostics = [];
  const all = [];

  while (skip < 1000) {
    const body = {
      start:
        startDate.toISOString(),

      end:
        end.toISOString(),

      skip,

      count: 100,

      includeDeleted: false
    };

    const response = await fetch(
      "https://newsky.app/api/airline-api/flights/bydate",
      {
        method: "POST",

        headers: {
          Authorization:
            "Bearer " + NEWSKY_KEY,

          "Content-Type":
            "application/json",

          accept:
            "application/json"
        },

        body: JSON.stringify(body)
      }
    );

    const raw =
      await response.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }

    diagnostics.push({
      status:
        response.status,

      keys:
        data &&
        typeof data === "object" &&
        !Array.isArray(data)
          ? Object.keys(data).slice(
              0,
              30
            )
          : [],

      bodyPreview:
        data
          ? undefined
          : raw.slice(0, 300)
    });

    if (!response.ok) {
      throw Object.assign(
        Error(
          "NewSky HTTP " +
            response.status
        ),
        {
          diagnostics
        }
      );
    }

    const candidates =
      arraysDeep(data).filter(
        array =>
          array.some(
            item =>
              item &&
              typeof item ===
                "object" &&
              !Array.isArray(item)
          )
      );

    const list =
      (Array.isArray(data)
        ? data
        : null) ||

      data?.results ||

      data?.flights ||

      data?.data ||

      data?.items ||

      data?.rows ||

      candidates.sort(
        (a, b) =>
          b.length - a.length
      )[0] ||

      [];

    const page = list
      .filter(
        flight =>
          flight &&
          typeof flight === "object"
      )
      .map(flight => ({
        id: String(
          pick(
            flight,
            "_id",
            "id",
            "flightId",
            "uuid"
          ) ||
            crypto.randomUUID()
        ),

        flightNumber: String(
          pick(
            flight,
            "flightNumber",
            "callsign",
            "flight_number",
            "flight.number",
            "number"
          ) || ""
        ),

        dep: String(
          pick(
            flight,
            "dep.icao",
            "dep",
            "departure.icao",
            "departure",
            "origin.icao",
            "origin",
            "originIcao",
            "departureIcao"
          ) || ""
        ),

        arr: String(
          pick(
            flight,
            "arr.icao",
            "arr",
            "arrival.icao",
            "arrival",
            "destination.icao",
            "destination",
            "destinationIcao",
            "arrivalIcao"
          ) || ""
        ),

        aircraft: String(
          pick(
            flight,
            "aircraft.icao",
            "aircraft",
            "airframe.icao",
            "airframe",
            "aircraftType",
            "aircraftCode"
          ) || ""
        ),

        duration:
          durationMinutes(
            pick(
              flight,
              "duration",
              "flightTime",
              "durationMinutes",
              "flight_time",
              "time"
            ) || 0
          ),

        distance: asNumber(
          pick(
            flight,
            "distance",
            "distanceNm",
            "distanceNM",
            "flightDistance",
            "nm"
          ) || 0
        ),

        rating: asNumber(
          pick(
            flight,
            "rating",
            "score",
            "stars",
            "flightRating"
          ) || 0
        ),

        date:
          pick(
            flight,
            "date",
            "depTime",
            "departureTime",
            "createdAt",
            "completedAt",
            "finishedAt",
            "dateTime"
          ) || null,

        source: "newsky"
      }))
      .filter(
        flight =>
          flight.dep &&
          flight.arr
      );

    all.push(...page);

    if (list.length < 100) {
      break;
    }

    skip += 100;
  }

  const unique = [
    ...new Map(
      all.map(flight => [
        flight.id,
        flight
      ])
    ).values()
  ];

  cache.n = {
    at: Date.now(),
    data: unique,
    diagnostics
  };

  return {
    configured: true,
    flights: unique,
    diagnostics
  };
}

/* =========================================================
   SIMBRIEF
========================================================= */

async function simbrief() {
  if (!SIMBRIEF) {
    return {
      configured: false,
      flight: null
    };
  }

  if (fresh(cache.s)) {
    return {
      configured: true,
      flight: cache.s.data
    };
  }

  const url =
    "https://www.simbrief.com/api/xml.fetcher.php" +
    "?username=" +
    encodeURIComponent(SIMBRIEF) +
    "&json=1";

  const response =
    await fetch(url);

  if (!response.ok) {
    throw Error(
      "SimBrief HTTP " +
        response.status
    );
  }

  const data =
    await response.json();

  const general =
    data.general || {};

  const origin =
    data.origin || {};

  const destination =
    data.destination || {};

  const aircraft =
    data.aircraft || {};

  const times =
    data.times || {};

  const atc =
    data.atc || {};

  const flight = {
    id: String(
      pick(
        general,
        "static_id",
        "flight_number"
      ) || Date.now()
    ),

    flightNumber: String(
      pick(
        general,
        "flight_number"
      ) || ""
    ),

    dep: String(
      pick(
        origin,
        "icao_code",
        "icao"
      ) || ""
    ),

    arr: String(
      pick(
        destination,
        "icao_code",
        "icao"
      ) || ""
    ),

    aircraft: String(
      pick(
        aircraft,
        "icaocode",
        "icao",
        "name"
      ) || ""
    ),

    route: String(
      pick(
        general,
        "route"
      ) || ""
    ),

    cruiseAltitude: String(
      pick(
        general,
        "initial_altitude"
      ) || ""
    ),

    distance: asNumber(
      pick(
        general,
        "air_distance",
        "distance"
      ) || 0
    ),

    duration:
      durationMinutes(
        pick(
          times,
          "est_time_enroute",
          "sched_time"
        ) || 0
      ),

    departure:
      pick(
        times,
        "sched_out",
        "est_out"
      ) || null,

    callsign: String(
      pick(
        atc,
        "callsign"
      ) || ""
    ),

    source: "simbrief"
  };

  cache.s = {
    at: Date.now(),
    data: flight
  };

  return {
    configured: true,
    flight
  };
}

/* =========================================================
   AI / API HELPERS
========================================================= */

const sendAiError = (res, error, fallbackMessage) => {
  const status =
    Number.isInteger(error?.status) ? error.status : 502;

  return res.status(status).json({
    error: error?.code || "AI_ERROR",
    message:
      error?.message ||
      fallbackMessage ||
      "Er ging iets mis met de AI.",
    provider: "Gemini",
    model: error?.model || null
  });
};

const extractJsonObject = text => {
  const cleaned = String(text || "")
    .replace(/^\s*\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`\s*$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first === -1 || last <= first) {
    throw new Error("Gemini gaf geen geldig JSON-object terug.");
  }

  return JSON.parse(cleaned.slice(first, last + 1));
};

const validateWidget = widget => {
  if (!widget || typeof widget !== "object" || Array.isArray(widget)) {
    throw new Error("Widget-output is geen geldig object.");
  }

  for (const key of ["name", "description", "html", "css", "js"]) {
    if (typeof widget[key] !== "string") {
      throw new Error("Widget-output mist het geldige veld: " + key);
    }
  }

  if (widget.name.length > 120 || widget.description.length > 500) {
    throw new Error("Widget-metadata is te lang.");
  }

  return {
    name: widget.name.trim(),
    description: widget.description.trim(),
    html: widget.html,
    css: widget.css,
    js: widget.js
  };
};

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  (_, res) =>
    res.json({
      ok: true,

      service:
        "my-life-dashboard-api",

      ai:
        Boolean(GEMINI_KEY),

      aiProvider:
        "gemini",

      aiModel:
        GEMINI_MODEL,

      aiFallbackModel:
        GEMINI_FALLBACK_MODEL,

      aiBuild:
        AI_BUILD
    })
);

/* =========================================================
   AI STATUS
========================================================= */

app.get(
  "/api/ai/models",
  (_, res) => {
    res.json({
      models: Object.entries(GEMINI_MODELS).map(([id, info]) => ({
        id,
        ...info
      })),
      defaultModel: GEMINI_MODEL,
      fallbackModel: GEMINI_FALLBACK_MODEL
    });
  }
);

app.get(
  "/api/ai/status",
  (_, res) =>
    res.json({
      configured:
        Boolean(GEMINI_KEY),

      provider:
        "Gemini",

      model:
        GEMINI_MODEL,

      fallbackModel:
        GEMINI_FALLBACK_MODEL,

      build:
        AI_BUILD
    })
);

/* =========================================================
   AI CHAT
========================================================= */

app.post(
  "/api/ai/chat",
  async (req, res) => {
    try {
      const context =
        req.body?.context || {};

      const question = String(
        req.body?.message || ""
      );

      const image =
        req.body?.image &&
        typeof req.body.image ===
          "object"
          ? req.body.image
          : null;

      const profile =
        context.aiProfile || {};

      const requestedModel =
        String(
          req.body?.model ||
          profile.model ||
          GEMINI_MODEL
        );

      const selectedModel =
        isAllowedGeminiModel(requestedModel)
          ? requestedModel
          : GEMINI_MODEL;

      const rawFocus = profile.focus || {};
      const legacyFocus = {
        school: profile.school,
        flights: profile.flight,
        planning: profile.planning,
        goals: profile.goals,
        tasks: profile.tasks,
        general: true
      };
      const mergedFocus = Object.keys(rawFocus).length
        ? rawFocus
        : legacyFocus;

      const enabledAreas = Object.entries(mergedFocus)
        .filter(([, enabled]) => enabled !== false)
        .map(([key]) => key)
        .join(", ") || "algemeen";

      const style = profile.tone || profile.style || "friendly";
      const toneRules = {
        friendly: "Vriendelijk, natuurlijk en behulpzaam.",
        direct: "Kort, direct en duidelijk. Geen opvulling.",
        coach: "Coachend en motiverend, maar niet overdreven enthousiast.",
        expert: "Deskundig, precies en duidelijk met voldoende uitleg.",
        detailed: "Uitgebreid en duidelijk, maar zonder onnodige herhaling.",
        casual: "Casual, menselijk en af en toe luchtig.",
      };

      const lengthRules = {
        short: "Houd antwoorden compact en geef alleen wat nodig is.",
        medium: "Geef een normale, overzichtelijke hoeveelheid uitleg.",
        long: "Geef meer context wanneer dat nuttig is, maar blijf relevant."
      };

      const conversation = Array.isArray(context.recentConversation)
        ? context.recentConversation.slice(-12)
        : [];
      const instructions =
        "Je bent de persoonlijke AI-assistent van My Life Dashboard. " +
        "Geef antwoorden die direct aansluiten op de vraag. " +
        "De dashboardcontext is de bron van waarheid voor persoonlijke gegevens. " +
        "Verzin nooit taken, lessen, vluchten, doelen, tijden, namen of andere persoonlijke feiten. " +
        "Als gegevens ontbreken of mogelijk verouderd zijn, zeg dat duidelijk in plaats van te gokken. " +
        "Gebruik recente integratiegegevens, wanneer aanwezig, voor Magister, NewSky en SimBrief. " +
        "BELANGRIJK: begin een vervolgvraag niet opnieuw met dezelfde begroeting of uitleg. " +
        "Herhaal geen advies, samenvatting, lijst of conclusie die al gegeven is tenzij de gebruiker er expliciet om vraagt. " +
        "Bouw voort op het gesprek en behandel alleen het nieuwe deel van de vraag. " +
        "Als het antwoord al eerder is gegeven, verwijs kort daarnaar en voeg alleen nieuwe informatie toe. " +
        "Gebruik de datum uit de dashboardcontext en interpreteer vandaag, morgen en andere relatieve datums daarop. " +
        "Respecteer de ingestelde focusgebieden: " + enabledAreas + ". " +
        "Reageerstijl: " + (toneRules[style] || toneRules.friendly) + " " +
        "Antwoordlengte: " + (lengthRules[profile.length] || lengthRules.medium) + " " +
        "Taal: " + String(profile.language || "Nederlands") + ". Antwoord uitsluitend in deze taal. " +
        "Humor: " + String(profile.humor ?? 40) + "%. Proactiviteit: " + String(profile.proactivity ?? 50) + "%. " +
        "Extra gebruikersinstructies: " + String(profile.custom || "geen") + ". " +
        "Naam van de gebruiker: " + String(profile.name || "onbekend") + ". " +
        "Recente conversatie: " + JSON.stringify(conversation) + ". " +
        "Dashboardcontext: " + JSON.stringify(context);

      const result =
        await callGemini(
          instructions,
          question,
          selectedModel,
          image
        );

      res.json({
        text:
          result.text,

        model:
          result.model,

        provider:
          "Gemini"
      });
    } catch (error) {
      sendAiError(
        res,
        error,
        "De AI kon je bericht niet verwerken."
      );
    }
  }
);

/* =========================================================
   AI WIDGET GENERATOR
========================================================= */

app.post(
  "/api/ai/widget",
  async (req, res) => {
    try {
      const prompt = String(
        req.body?.prompt || ""
      );

      const instructions =
        "Ontwerp een veilige zelfstandige HTML-widget voor een persoonlijk dashboard. " +
        "Antwoord uitsluitend met JSON met de velden name, description, html, css en js. " +
        "Geen markdown fences, externe scripts, netwerkrequests of browseracties die data verwijderen. " +
        "Gebruik window.MyLifeWidgetData voor dashboardgegevens wanneer dat relevant is. " +
        "Maak de widget zelfstandig, responsive en visueel verzorgd. " +
        "De HTML, CSS en JS moeten direct in een sandboxed iframe kunnen draaien. " +
        "Geen externe scripts, fetch, localStorage, cookies of top-level browseracties. " +
        "Widgetverzoek: " + prompt + ". " +
        "Beschikbare dashboardcontext: " + JSON.stringify(req.body?.context || {});

      const profile =
        req.body?.aiProfile || {};

      const requestedModel =
        String(
          req.body?.model ||
          profile.model ||
          GEMINI_MODEL
        );

      const selectedModel =
        isAllowedGeminiModel(requestedModel)
          ? requestedModel
          : GEMINI_MODEL;

      const result =
        await callGemini(
          instructions,
          "",
          selectedModel
        );

      const cleaned =
        result.text
          .replace(
            /^\s*```json\s*/i,
            ""
          )
          .replace(
            /\s*```\s*$/i,
            ""
          )
          .trim();

      const widget =
        validateWidget(
          extractJsonObject(result.text)
        );

      res.json({
        widget,
        model: result.model,
        provider: "Gemini"
      });
    } catch (error) {
      sendAiError(
        res,
        error,
        "De AI kon de widget niet genereren."
      );
    }
  }
);

/* =========================================================
   INTEGRATION STATUS
========================================================= */

app.get(
  "/api/integrations/status",
  (_, res) =>
    res.json({
      magister:
        Boolean(MAGISTER),

      newsky:
        Boolean(NEWSKY_KEY),

      simbrief:
        Boolean(SIMBRIEF)
    })
);

/* =========================================================
   MAGISTER API
========================================================= */

app.get(
  "/api/magister/events",
  async (_, res) => {
    try {
      res.json(
        await magister()
      );
    } catch (error) {
      res.status(502).json({
        configured:
          Boolean(MAGISTER),

        events: [],

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   NEWSKY API
========================================================= */

app.get(
  "/api/newsky/flights",
  async (_, res) => {
    try {
      res.json(
        await newsky()
      );
    } catch (error) {
      res.status(502).json({
        configured:
          Boolean(NEWSKY_KEY),

        flights: [],

        error:
          error.message,

        diagnostics:
          error.diagnostics || []
      });
    }
  }
);

/* =========================================================
   SIMBRIEF API
========================================================= */

app.get(
  "/api/simbrief/latest",
  async (_, res) => {
    try {
      res.json(
        await simbrief()
      );
    } catch (error) {
      res.status(502).json({
        configured:
          Boolean(SIMBRIEF),

        flight: null,

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   COMPLETE DASHBOARD SYNC
========================================================= */

app.get(
  "/api/dashboard/sync",
  async (_, res) => {
    const result = {
      syncedAt:
        new Date().toISOString(),

      magister: {
        events: []
      },

      newsky: {
        flights: []
      },

      simbrief: {
        flight: null
      }
    };

    await Promise.all([
      magister()
        .then(value => {
          result.magister =
            value;
        })
        .catch(error => {
          result.magister = {
            events: [],
            error:
              error.message
          };
        }),

      newsky()
        .then(value => {
          result.newsky =
            value;
        })
        .catch(error => {
          result.newsky = {
            flights: [],
            error:
              error.message,

            diagnostics:
              error.diagnostics || []
          };
        }),

      simbrief()
        .then(value => {
          result.simbrief =
            value;
        })
        .catch(error => {
          result.simbrief = {
            flight: null,
            error:
              error.message
          };
        })
    ]);

    res.json(result);
  }
);

/* =========================================================
   MULTI-DEVICE SYNC
========================================================= */

app.post("/api/sync/put", async (req, res) => {
  try {
    const syncId = String(req.body?.syncId || "");
    const result = await putSync(syncId, req.body?.state || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/sync/get/:syncId", async (req, res) => {
  try {
    const syncId = String(req.params.syncId || "");
    if (!/^[a-f0-9]{20,80}$/i.test(syncId)) {
      return res.status(400).json({ ok: false, error: "Ongeldige sync-code." });
    }
    const result = await getSync(syncId);
    if (!result) return res.status(404).json({ ok: false, error: "Sync-code niet gevonden." });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* =========================================================
   START SERVER
========================================================= */

initSync().catch(error => console.error("Sync database init failed:", error.message));

app.listen(
  PORT,
  () => {
    console.log(
      "My Life Dashboard API on " +
        PORT
    );

    console.log(
      "AI model: " +
        GEMINI_MODEL
    );

    console.log(
      "AI fallback: " +
        GEMINI_FALLBACK_MODEL
    );

    console.log(
      "AI build: " +
        AI_BUILD
    );
  }
);
