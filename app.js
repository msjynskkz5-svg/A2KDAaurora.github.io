// Simple React app using CDN React/ReactDOM (no build step)
// This version fetches real weather + space-weather data where possible.

// --- Types (JSDoc-style comments just for clarity) ---

/**
 * @typedef {Object} UserLocation
 * @property {string} id
 * @property {string} name
 * @property {string} [country]
 * @property {string} [region]
 * @property {number} latitude
 * @property {number} longitude
 * @property {string} timezone
 * @property {"gps"|"manual"} source
 */

/**
 * @typedef {"VeryUnlikely"|"Low"|"Good"|"Excellent"} ViewingChanceCategory
 */

/**
 * @typedef {Object} ViewingChanceScore
 * @property {number} value
 * @property {ViewingChanceCategory} category
 */

/**
 * @typedef {Object} ViewingConditionsSummary
 * @property {"Low"|"Moderate"|"High"|"Unknown"} auroraActivity
 * @property {string} cloudsText
 * @property {string} moonText
 * @property {string} darknessText
 * @property {string} lightPollutionText
 */

/**
 * @typedef {Object} TonightSummary
 * @property {string} date
 * @property {UserLocation} location
 * @property {ViewingChanceCategory} bestCategory
 * @property {number} bestScore
 * @property {{start: string, end: string}|undefined} bestTimeWindow
 * @property {string} headline
 * @property {string} bestDirection
 * @property {string} explanation
 * @property {ViewingConditionsSummary} conditions
 * @property {string} lastUpdated
 */

/**
 * @typedef {Object} HourlyAuroraForecast
 * @property {string} time
 * @property {ViewingChanceScore} score
 * @property {number} cloudsPercent
 * @property {boolean} moonAboveHorizon
 */

/**
 * @typedef {"ok"|"partial"|"missing"} DataStatus
 */

/**
 * @typedef {Object} DataAvailability
 * @property {DataStatus} weather
 * @property {DataStatus} spaceWeather
 * @property {DataStatus} ovation
 * @property {DataStatus} lightPollution
 * @property {string[]} notes
 */

// --- Time helpers (timezone-aware display) ---

function formatLocalTimeLabel(iso, timeZone) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(d);
}

function formatLocalDateTime(iso, timeZone) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(d);
}

// --- Data fetching helpers ---

/**
 * Try to get user location via browser geolocation.
 * Falls back to Inverness, UK if not available.
 * @returns {Promise<UserLocation>}
 */
function getUserLocation() {
  return new Promise(function (resolve) {
    if (!("geolocation" in navigator)) {
      // Fallback: Inverness, UK
      resolve({
        id: "fallback-inverness",
        name: "Near Inverness",
        country: "United Kingdom",
        region: "Scotland",
        latitude: 57.4778,
        longitude: -4.2247,
        timezone: "Europe/London",
        source: "manual",
      });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        resolve({
          id: "gps",
          name: "Your location",
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          country: "",
          region: "",
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          source: "gps",
        });
      },
      function () {
        // Fallback: Inverness, UK
        resolve({
          id: "fallback-inverness",
          name: "Near Inverness",
          country: "United Kingdom",
          region: "Scotland",
          latitude: 57.4778,
          longitude: -4.2247,
          timezone: "Europe/London",
          source: "manual",
        });
      },
      { enableHighAccuracy: false, timeout: 8000 }
    );
  });
}

/**
 * Fetch weather (cloud cover + sunrise/sunset) from Open-Meteo.
 * @param {UserLocation} location
 */
async function fetchWeather(location) {
  const url =
    "https://api.open-meteo.com/v1/forecast?" +
    "latitude=" +
    encodeURIComponent(location.latitude) +
    "&longitude=" +
    encodeURIComponent(location.longitude) +
    "&hourly=cloud_cover" +
    "&daily=sunrise,sunset" +
    "&forecast_days=1" +
    "&timezone=auto";

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Weather fetch failed: " + res.status);
  }
  const data = await res.json();
  return data;
}

/**
 * Fetch simple space-weather data from NOAA SWPC.
 * We'll just use latest Bz and solar wind speed as a rough indicator.
 */
async function fetchSpaceWeather() {
  // Magnetic data (Bz, Bt)
  const magUrl =
    "https://services.swpc.noaa.gov/products/solar-wind/mag-5-minute.json";
  const plasmaUrl =
    "https://services.swpc.noaa.gov/products/solar-wind/plasma-5-minute.json";

  const [magRes, plasmaRes] = await Promise.all([
    fetch(magUrl),
    fetch(plasmaUrl),
  ]);
  if (!magRes.ok || !plasmaRes.ok) {
    throw new Error("Space-weather fetch failed");
  }

  const magJson = await magRes.json();
  const plasmaJson = await plasmaRes.json();

  // Each JSON is an array where first element is headers
  const lastMag = magJson[magJson.length - 1];
  const magHeaders = magJson[0];
  const idxBz = magHeaders.indexOf("bz_gsm");
  const idxBt = magHeaders.indexOf("bt");

  const lastPlasma = plasmaJson[plasmaJson.length - 1];
  const plasmaHeaders = plasmaJson[0];
  const idxSpeed = plasmaHeaders.indexOf("speed");

  const bz = idxBz >= 0 ? parseFloat(lastMag[idxBz]) : NaN;
  const bt = idxBt >= 0 ? parseFloat(lastMag[idxBt]) : NaN;
  const speed = idxSpeed >= 0 ? parseFloat(lastPlasma[idxSpeed]) : NaN;

  // Simple classification
  let activityLabel = "Unknown";
  let baseStrength = 3; // 0–10 internal

  if (!isNaN(bz) && !isNaN(speed)) {
    if (bz < -5 && speed > 550) {
      activityLabel = "High";
      baseStrength = 8;
    } else if (bz < -2 && speed > 450) {
      activityLabel = "Moderate";
      baseStrength = 6;
    } else {
      activityLabel = "Low";
      baseStrength = 3;
    }
  }

  return {
    bz,
    bt,
    speed,
    activityLabel,
    baseStrength,
  };
}

/**
 * Build hourly forecasts and tonight summary from raw data.
 * This is a simplified first version of the "brain".
 */
function buildForecast(location, weatherData, spaceWeather) {
  const now = Date.now();

  let timezone = weatherData && weatherData.timezone
    ? weatherData.timezone
    : location.timezone;

  /** @type {UserLocation} */
  const loc = Object.assign({}, location, { timezone: timezone });

  /** @type {HourlyAuroraForecast[]} */
  const hourly = [];

  if (
    weatherData &&
    weatherData.hourly &&
    Array.isArray(weatherData.hourly.time) &&
    Array.isArray(weatherData.hourly.cloud_cover)
  ) {
    const times = weatherData.hourly.time;
    const clouds = weatherData.hourly.cloud_cover;
    for (let i = 0; i < times.length; i++) {
      const t = new Date(times[i]);
      if (t.getTime() >= now && hourly.length < 8) {
        const cloud = clouds[i];
        const base =
          spaceWeather && typeof spaceWeather.baseStrength === "number"
            ? spaceWeather.baseStrength
            : 3;

        // Simple viewing score: base strength reduced by cloud cover
        let scoreValue = base * (1 - cloud / 100);
        if (scoreValue < 0) scoreValue = 0;
        if (scoreValue > 10) scoreValue = 10;

        let category = "VeryUnlikely";
        if (scoreValue >= 8) category = "Excellent";
        else if (scoreValue >= 5) category = "Good";
        else if (scoreValue >= 3) category = "Low";

        hourly.push({
          time: times[i],
          score: { value: scoreValue, category: category },
          cloudsPercent: cloud,
          moonAboveHorizon: false, // placeholder for now
        });
      }
    }
  }

  // If we somehow have no hours, create a very simple fallback single hour
  if (hourly.length === 0) {
    const fallbackTime = new Date(now + 60 * 60 * 1000).toISOString();
    hourly.push({
      time: fallbackTime,
      score: { value: 3, category: "Low" },
      cloudsPercent: 50,
      moonAboveHorizon: false,
    });
  }

  // Find best hour
  let best = hourly[0];
  for (let i = 1; i < hourly.length; i++) {
    if (hourly[i].score.value > best.score.value) {
      best = hourly[i];
    }
  }

  const bestScore = best.score.value;
  const bestCategory = best.score.category;

  // Derive a simple best time window: first & last hour above a threshold
  const threshold = Math.max(4, bestScore - 2); // dynamic-ish
  let windowStart = null;
  let windowEnd = null;
  for (let i = 0; i < hourly.length; i++) {
    if (hourly[i].score.value >= threshold) {
      if (!windowStart) windowStart = hourly[i].time;
      windowEnd = hourly[i].time;
    }
  }

  const todayIso = new Date().toISOString().slice(0, 10);

  // Simple darkness text from daily sunrise/sunset if available
  let darknessText = "Nighttime hours not yet calculated";
  if (
    weatherData &&
    weatherData.daily &&
    Array.isArray(weatherData.daily.sunset) &&
    Array.isArray(weatherData.daily.sunrise)
  ) {
    const sunsetIso = weatherData.daily.sunset[0];
    const sunriseIso = weatherData.daily.sunrise[0];
    darknessText =
      "Sunset " +
      formatLocalTimeLabel(sunsetIso, timezone) +
      " – Sunrise " +
      formatLocalTimeLabel(sunriseIso, timezone);
  }

  // Simple clouds text from average clouds in best half of hours
  let avgCloud = 0;
  for (let i = 0; i < hourly.length; i++) {
    avgCloud += hourly[i].cloudsPercent;
  }
  avgCloud = avgCloud / hourly.length;
  const cloudsText =
    avgCloud < 25
      ? "Mostly clear (" + Math.round(avgCloud) + "%)"
      : avgCloud < 60
      ? "Patchy cloud (" + Math.round(avgCloud) + "%)"
      : "Cloudy (" + Math.round(avgCloud) + "%)";

  const auroraActivity =
    spaceWeather && spaceWeather.activityLabel
      ? spaceWeather.activityLabel
      : "Unknown";

  const headline =
    bestCategory === "Excellent"
      ? "Excellent chance tonight"
      : bestCategory === "Good"
      ? "Good chance tonight"
      : bestCategory === "Low"
      ? "Low chance tonight"
      : "Aurora very unlikely tonight";

  // Very simple direction placeholder for now
  const bestDirection = "North or North–Northwest";

  const explanationPieces = [];
  if (auroraActivity === "High") {
    explanationPieces.push("Strong geomagnetic activity");
  } else if (auroraActivity === "Moderate") {
    explanationPieces.push("Moderate geomagnetic activity");
  } else if (auroraActivity === "Low") {
    explanationPieces.push("Geomagnetic activity looks low");
  } else {
    explanationPieces.push("Aurora activity estimate is uncertain");
  }

  explanationPieces.push(cloudsText.toLowerCase());

  const explanation = explanationPieces.join(", ") + ".";

  /** @type {TonightSummary} */
  const summary = {
    date: todayIso,
    location: loc,
    bestCategory: bestCategory,
    bestScore: bestScore,
    bestTimeWindow:
      windowStart && windowEnd
        ? { start: windowStart, end: windowEnd }
        : undefined,
    headline: headline,
    bestDirection: bestDirection,
    explanation: explanation,
    conditions: {
      auroraActivity: auroraActivity,
      cloudsText: cloudsText,
      moonText: "Moon data coming soon",
      darknessText: darknessText,
      lightPollutionText: "Light pollution not yet included",
    },
    lastUpdated: new Date().toISOString(),
  };

  return { summary: summary, hours: hourly };
}

// --- UI components ---

function DataStatusBanner({ availability }) {
  const hasIssues =
    availability.weather !== "ok" ||
    availability.spaceWeather !== "ok" ||
    availability.ovation !== "ok" ||
    availability.lightPollution !== "ok";

  if (!hasIssues && availability.notes.length === 0) {
    return null;
  }

  return React.createElement(
    "div",
    { className: "data-banner" },
    React.createElement("strong", null, "Data status:"),
    React.createElement(
      "ul",
      null,
      availability.notes.map(function (note, idx) {
        return React.createElement("li", { key: idx }, note);
      })
    )
  );
}

function categoryToDisplay(bestCategory) {
  switch (bestCategory) {
    case "Excellent":
      return { label: "Excellent chance", color: "#2e7d32" };
    case "Good":
      return { label: "Good chance", color: "#00796b" };
    case "Low":
      return { label: "Low chance", color: "#f9a825" };
    case "VeryUnlikely":
    default:
      return { label: "Very unlikely", color: "#757575" };
  }
}

function Chip({ label }) {
  return React.createElement("span", { className: "chip" }, label);
}

function TonightCard({ summary }) {
  const display = categoryToDisplay(summary.bestCategory);
  const label = display.label;
  const color = display.color;
  const timeZone = summary.location.timezone;

  const bestWindow =
    summary.bestTimeWindow &&
    formatLocalTimeLabel(summary.bestTimeWindow.start, timeZone) +
      " – " +
      formatLocalTimeLabel(summary.bestTimeWindow.end, timeZone);

  return React.createElement(
    "div",
    { className: "tonight-card" },
    React.createElement(
      "div",
      { className: "tonight-card-title" },
      "Tonight at ",
      summary.location.name
    ),
    React.createElement(
      "div",
      { className: "tonight-card-headline", style: { color: color } },
      label
    ),
    bestWindow &&
      React.createElement(
        "div",
        { style: { marginBottom: 4 } },
        "Best between ",
        React.createElement("strong", null, bestWindow)
      ),
    React.createElement(
      "div",
      { style: { marginBottom: 4 } },
      "Look ",
      React.createElement("strong", null, summary.bestDirection)
    ),
    React.createElement(
      "div",
      { className: "tonight-card-text" },
      summary.explanation
    ),
    React.createElement(
      "div",
      { className: "chip-row" },
      React.createElement(Chip, {
        label: "Aurora activity: " + summary.conditions.auroraActivity,
      }),
      React.createElement(Chip, {
        label: "Clouds: " + summary.conditions.cloudsText,
      }),
      React.createElement(Chip, {
        label: "Moon: " + summary.conditions.moonText,
      }),
      React.createElement(Chip, {
        label: "Darkness: " + summary.conditions.darknessText,
      }),
      React.createElement(Chip, {
        label: "Light pollution: " + summary.conditions.lightPollutionText,
      })
    ),
    React.createElement(
      "div",
      {
        style: {
          marginTop: 10,
          fontSize: 11,
          opacity: 0.7,
        },
      },
      "Last updated: ",
      formatLocalDateTime(summary.lastUpdated, summary.location.timezone)
    )
  );
}

function categoryColor(category) {
  switch (category) {
    case "Excellent":
      return "#2e7d32";
    case "Good":
      return "#00796b";
    case "Low":
      return "#f9a825";
    case "VeryUnlikely":
    default:
      return "#757575";
  }
}

function Timeline({ hours, locationTimezone }) {
  return React.createElement(
    "div",
    { className: "timeline" },
    React.createElement(
      "div",
      { style: { fontSize: 13, marginBottom: 8 } },
      "Next hours"
    ),
    React.createElement(
      "div",
      { className: "timeline-hours" },
      hours.map(function (h) {
        return React.createElement(
          "div",
          { key: h.time, className: "timeline-hour" },
          React.createElement(
            "div",
            { style: { marginBottom: 4 } },
            formatLocalTimeLabel(h.time, locationTimezone)
          ),
          React.createElement(
            "div",
            { className: "timeline-bar-outer" },
            React.createElement("div", {
              className: "timeline-bar-inner",
              style: {
                height: (h.score.value / 10) * 100 + "%",
                background: categoryColor(h.score.category),
              },
            })
          ),
          React.createElement(
            "div",
            { style: { marginTop: 4 } },
            "☁️ ",
            String(Math.round(h.cloudsPercent)),
            "%"
          ),
          React.createElement(
            "div",
            null,
            h.moonAboveHorizon ? "🌙" : " "
          )
        );
      })
    )
  );
}

function CondItem({ label, value }) {
  return React.createElement(
    "div",
    null,
    React.createElement("div", { className: "cond-label" }, label),
    React.createElement("div", { className: "cond-value" }, value)
  );
}

function ConditionsRow({ summary }) {
  const c = summary.conditions;
  return React.createElement(
    "div",
    { className: "conditions-row" },
    React.createElement(CondItem, {
      label: "Aurora activity",
      value: c.auroraActivity,
    }),
    React.createElement(CondItem, {
      label: "Clouds",
      value: c.cloudsText,
    }),
    React.createElement(CondItem, {
      label: "Moon",
      value: c.moonText,
    }),
    React.createElement(CondItem, {
      label: "Darkness",
      value: c.darknessText,
    }),
    React.createElement(CondItem, {
      label: "Light pollution",
      value: c.lightPollutionText,
    })
  );
}

function TonightScreen() {
  const ReactRef = React; // avoid confusion
  const useState = ReactRef.useState;
  const useEffect = ReactRef.useEffect;

  const [summary, setSummary] = useState(null);
  const [hours, setHours] = useState([]);
  const [availability, setAvailability] = useState({
    weather: "ok",
    spaceWeather: "ok",
    ovation: "missing",
    lightPollution: "missing",
    notes: [
      "Light pollution and moon data are not yet included in the calculations.",
    ],
  });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(function () {
    let cancelled = false;

    async function load() {
      try {
        let loc = await getUserLocation();

        /** @type {DataAvailability} */
        let avail = {
          weather: "ok",
          spaceWeather: "ok",
          ovation: "missing",
          lightPollution: "missing",
          notes: [
            "Light pollution and moon data are not yet included in the calculations.",
          ],
        };

        let weatherData = null;
        try {
          weatherData = await fetchWeather(loc);
        } catch (e) {
          console.error(e);
          avail.weather = "missing";
          avail.notes.push(
            "Weather data is unavailable; cloud cover is not included in tonight's estimate."
          );
        }

        let spaceWeather = null;
        try {
          spaceWeather = await fetchSpaceWeather();
        } catch (e) {
          console.error(e);
          avail.spaceWeather = "missing";
          avail.notes.push(
            "Space weather data is unavailable; aurora activity is assumed to be low."
          );
        }

        const result = buildForecast(loc, weatherData, spaceWeather);
        if (!cancelled) {
          setAvailability(avail);
          setSummary(result.summary);
          setHours(result.hours);
          setLoading(false);
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setError("Something went wrong while loading data.");
          setLoading(false);
        }
      }
    }

    load();

    return function () {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return React.createElement(
      "div",
      { className: "loading" },
      "Loading tonight's aurora information for your location..."
    );
  }

  if (error || !summary) {
    return React.createElement(
      "div",
      { className: "error" },
      "Sorry, we couldn't load tonight's aurora information right now."
    );
  }

  return React.createElement(
    "div",
    { className: "app-container" },
    React.createElement(
      "header",
      { style: { marginBottom: 12 } },
      React.createElement(
        "div",
        { className: "app-header-title" },
        "A2KDA Aurora"
      ),
      React.createElement(
        "div",
        { className: "app-header-subtitle" },
        summary.location.name,
        summary.location.country ? " • " + summary.location.country : ""
      )
    ),
    React.createElement(DataStatusBanner, { availability: availability }),
    React.createElement(TonightCard, { summary: summary }),
    React.createElement(Timeline, {
      hours: hours,
      locationTimezone: summary.location.timezone,
    }),
    React.createElement(ConditionsRow, { summary: summary }),
    React.createElement(
      "div",
      { className: "tip" },
      React.createElement("strong", null, "Tip: "),
      "Give your eyes 20–30 minutes to adjust to the dark and avoid bright white screens while watching for aurora."
    )
  );
}

function App() {
  return React.createElement(
    "div",
    { className: "app-shell" },
    React.createElement(TonightScreen, null)
  );
}

// Mount the React app
const rootElement = document.getElementById("root");
const root = ReactDOM.createRoot(rootElement);
root.render(React.createElement(App));
