// Simple React app using CDN React/ReactDOM (no build step)

// --- Mock data (can be replaced later with real API data) ---

const mockLocation = {
  id: "mock",
  name: "Near Tromsø",
  country: "Norway",
  region: "Troms og Finnmark",
  latitude: 69.65,
  longitude: 18.96,
  timezone: "Europe/Oslo",
  source: "manual",
};

const mockTonightSummary = {
  date: "2025-11-16",
  location: mockLocation,
  bestCategory: "Good",
  bestScore: 7.2,
  bestTimeWindow: {
    start: "2025-11-16T21:30:00+01:00",
    end: "2025-11-16T23:00:00+01:00",
  },
  headline: "Good chance tonight",
  bestDirection: "North–Northwest",
  explanation:
    "Strong geomagnetic activity with mostly clear skies and a dim moon.",

  conditions: {
    auroraActivity: "High",
    cloudsText: "Mostly clear (20–30%)",
    moonText: "Waxing crescent, low in sky",
    darknessText: "Astronomical darkness 17:48–06:12",
    lightPollutionText: "Rural sky (Bortle 3–4)",
  },

  lastUpdated: "2025-11-16T20:05:00+01:00",
};

const mockHourlyForecast = [
  {
    time: "2025-11-16T18:00:00+01:00",
    score: { value: 3, category: "Low" },
    cloudsPercent: 40,
    moonAboveHorizon: true,
  },
  {
    time: "2025-11-16T19:00:00+01:00",
    score: { value: 4, category: "Low" },
    cloudsPercent: 35,
    moonAboveHorizon: true,
  },
  {
    time: "2025-11-16T20:00:00+01:00",
    score: { value: 6, category: "Good" },
    cloudsPercent: 30,
    moonAboveHorizon: true,
  },
  {
    time: "2025-11-16T21:00:00+01:00",
    score: { value: 7, category: "Good" },
    cloudsPercent: 25,
    moonAboveHorizon: true,
  },
  {
    time: "2025-11-16T22:00:00+01:00",
    score: { value: 8, category: "Excellent" },
    cloudsPercent: 20,
    moonAboveHorizon: false,
  },
  {
    time: "2025-11-16T23:00:00+01:00",
    score: { value: 8, category: "Excellent" },
    cloudsPercent: 22,
    moonAboveHorizon: false,
  },
  {
    time: "2025-11-17T00:00:00+01:00",
    score: { value: 6, category: "Good" },
    cloudsPercent: 30,
    moonAboveHorizon: false,
  },
  {
    time: "2025-11-17T01:00:00+01:00",
    score: { value: 4, category: "Low" },
    cloudsPercent: 45,
    moonAboveHorizon: false,
  },
];

const mockDataAvailability = {
  weather: "ok",
  spaceWeather: "partial",
  ovation: "missing",
  lightPollution: "ok",
  notes: [
    "Space weather data is partially available – aurora activity estimates may be less precise.",
    "Auroral oval model is currently unavailable; visibility bands are based on typical behaviour for your latitude.",
  ],
};

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

// --- Components ---

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
      availability.notes.map((note, idx) =>
        React.createElement("li", { key: idx }, note)
      )
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
  const { label, color } = categoryToDisplay(summary.bestCategory);
  const timeZone = summary.location.timezone;

  const bestWindow =
    summary.bestTimeWindow &&
    `${formatLocalTimeLabel(summary.bestTimeWindow.start, timeZone)} – ${formatLocalTimeLabel(
      summary.bestTimeWindow.end,
      timeZone
    )}`;

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
      { className: "tonight-card-headline", style: { color } },
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
        label: `Aurora activity: ${summary.conditions.auroraActivity}`,
      }),
      React.createElement(Chip, {
        label: `Clouds: ${summary.conditions.cloudsText}`,
      }),
      React.createElement(Chip, {
        label: `Moon: ${summary.conditions.moonText}`,
      }),
      React.createElement(Chip, {
        label: `Darkness: ${summary.conditions.darknessText}`,
      }),
      React.createElement(Chip, {
        label: `Light pollution: ${summary.conditions.lightPollutionText}`,
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
      "Tonight by the hour"
    ),
    React.createElement(
      "div",
      { className: "timeline-hours" },
      hours.map((h) =>
        React.createElement(
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
                height: `${(h.score.value / 10) * 100}%`,
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
        )
      )
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
  const summary = mockTonightSummary;
  const hours = mockHourlyForecast;
  const availability = mockDataAvailability;

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
    React.createElement(DataStatusBanner, { availability }),
    React.createElement(TonightCard, { summary }),
    React.createElement(Timeline, {
      hours,
      locationTimezone: summary.location.timezone,
    }),
    React.createElement(ConditionsRow, { summary }),
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
