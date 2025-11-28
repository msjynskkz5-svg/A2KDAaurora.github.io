// A2KDA Aurora - main app logic
// - LightPollution module
// - AuroraBrain scoring
// - Simple solar darkness model
// - Darkness-aware score adjustment
// - v1 Clouds and Moon integration
// - App wiring (location, KP slider, panels, sky brightness override, hourly chart)

(function () {
  "use strict";

  // -------- Light pollution module --------
  const LightPollution = (function () {
    // Grid-based data derived from World Atlas of Artificial Night Sky Brightness (if present)
    let gridMeta = null;   // { lat_min, lon_min, resolution_deg, rows, cols, unit }
    let gridValues = null; // Array of sky brightness values
    let gridLoadAttempted = false;

    async function loadGridIfNeeded() {
      if (gridLoadAttempted) return;
      gridLoadAttempted = true;

      try {
        const res = await fetch("lightpollution_grid.json");
        if (!res.ok) {
          console.warn("Light pollution grid JSON not found, using heuristic only.");
          return;
        }
        const data = await res.json();
        if (!data.values || !Array.isArray(data.values)) {
          console.warn("Light pollution grid JSON missing 'values' array.");
          return;
        }

        gridMeta = {
          lat_min: data.lat_min,
          lon_min: data.lon_min,
          resolution_deg: data.resolution_deg,
          rows: data.rows,
          cols: data.cols,
          unit: data.unit || "mag_per_arcsec2"
        };
        gridValues = data.values;
        console.log("Light pollution grid loaded:", gridMeta);
      } catch (err) {
        console.error("Failed to load light pollution grid JSON:", err);
      }
    }

    function normalizeLightPollution(options) {
      const opts = options || {};
      const bortle = typeof opts.bortle === "number" ? opts.bortle : null;
      const skyBrightness =
        typeof opts.skyBrightness === "number" ? opts.skyBrightness : null;

      if (bortle != null) {
        const clamped = Math.min(9, Math.max(1, bortle));
        return (clamped - 1) / 8;
      }

      if (skyBrightness != null) {
        const min = 18;    // brighter (worse)
        const max = 21.5;  // darker (better)
        const v = Math.min(max, Math.max(min, skyBrightness));
        const norm = 1 - (v - min) / (max - min);
        return norm;
      }

      return 0.5;
    }

    function classifyLightPollutionValue(normalized) {
      const n = Math.min(1, Math.max(0, normalized));
      if (n < 0.33) {
        return { label: "Dark skies", code: "dark" };
      } else if (n < 0.66) {
        return { label: "Suburban skies", code: "suburban" };
      } else {
        return { label: "Urban / bright skies", code: "urban" };
      }
    }

    function sampleGrid(lat, lon) {
      if (!gridMeta || !gridValues) return null;

      const { lat_min, lon_min, resolution_deg, rows, cols } = gridMeta;
      if (
        typeof lat !== "number" ||
        typeof lon !== "number" ||
        resolution_deg <= 0
      ) {
        return null;
      }

      // Wrap lon into [-180, 180)
      let lonWrapped = ((lon + 180) % 360 + 360) % 360 - 180;

      const row = Math.floor((lat - lat_min) / resolution_deg);
      const col = Math.floor((lonWrapped - lon_min) / resolution_deg);

      if (row < 0 || row >= rows || col < 0 || col >= cols) return null;

      const idx = row * cols + col;
      const raw = gridValues[idx];

      if (raw == null || isNaN(raw)) return null;

      return { skyBrightness: Number(raw) };
    }

    async function getLightPollution(lat, lon) {
      // Try to load the grid once
      await loadGridIfNeeded();

      // 1) If grid data is available, sample it
      const sampled = sampleGrid(lat, lon);
      if (sampled && typeof sampled.skyBrightness === "number") {
        const normalized = normalizeLightPollution({
          skyBrightness: sampled.skyBrightness
        });
        const classification = classifyLightPollutionValue(normalized);
        return {
          source: "world-atlas-grid",
          normalized,
          classification,
          bortleClass: undefined,
          skyBrightness: sampled.skyBrightness
        };
      }

      // 2) Fallback heuristic based on latitude/longitude only
      let heuristicNorm = 0.5;

      if (typeof lat === "number" && typeof lon === "number") {
        const absLat = Math.abs(lat);
        if (absLat > 66) {
          heuristicNorm = 0.22;
        } else if (absLat > 58) {
          heuristicNorm = 0.32;
        } else if (absLat > 50) {
          heuristicNorm = 0.42;
        } else if (absLat > 40) {
          heuristicNorm = 0.58;
        } else {
          heuristicNorm = 0.72;
        }

        const absLon = Math.abs(lon);
        if (absLon > 150 || absLon < 20) {
          heuristicNorm -= 0.05;
        }
      }

      const normalized = Math.min(1, Math.max(0, heuristicNorm));
      const classification = classifyLightPollutionValue(normalized);

      return {
        source: "fallback",
        normalized,
        classification,
        bortleClass: undefined,
        skyBrightness: undefined
      };
    }

    return {
      normalizeLightPollution,
      classifyLightPollutionValue,
      getLightPollution
    };
  })();

  // -------- Aurora brain module (pre-darkness, pre-moon) --------
  const AuroraBrain = (function () {
    function kpScore(kp) {
      const k = Math.min(9, Math.max(0, Number(kp) || 0));
      return (k / 9) * 60;
    }

    function locationScore(distanceToOvalKm) {
      const maxDist = 1500;
      const d = Math.min(maxDist, Math.max(0, Number(distanceToOvalKm) || 0));
      return 30 * (1 - d / maxDist);
    }

    function lightPollutionPenalty(lightPollution, kp) {
      const lp = Math.min(1, Math.max(0, Number(lightPollution) || 0));
      const basePenalty = 30 * lp;

      const k = Math.min(9, Math.max(0, Number(kp) || 0));
      const kpReliefFactor = Math.min(1, k / 7);
      const effectivePenalty = basePenalty * (1 - kpReliefFactor * 0.7);

      return effectivePenalty;
    }

    // Dialled-back time-of-night tweak: small bonus around local midnight only.
    function timeOfNightAdjustment(timeLocalHour) {
      if (typeof timeLocalHour !== "number") return 0;
      const h = ((timeLocalHour % 24) + 24) % 24;

      if (h >= 22 || h < 2) return +3; // around local midnight
      if ((h >= 3 && h <= 4) || (h >= 20 && h <= 21)) return +1; // shoulders
      return 0; // no explicit daytime penalty here – handled by darkness model
    }

    // Computes a "base" score ignoring detailed darkness & moon.
    function computeBrain(inputs) {
      const {
        kp,
        distanceToOvalKm,
        geomagneticLatitude,
        lightPollution,
        cloudCover,
        timeLocalHour
      } = inputs;

      const debug = [];

      const sKp = kpScore(kp);
      debug.push(`KP index ${kp} contributes ${sKp.toFixed(1)} points.`);

      const sLoc = locationScore(distanceToOvalKm);
      debug.push(
        `Your position relative to the auroral oval contributes ${sLoc.toFixed(
          1
        )} points.`
      );

      const lpPenalty = lightPollutionPenalty(lightPollution, kp);
      if (lightPollution < 0.33) {
        debug.push(
          `Dark skies – only a small light pollution penalty (${lpPenalty.toFixed(
            1
          )} points).`
        );
      } else if (lightPollution < 0.66) {
        debug.push(
          `Moderate light pollution – medium penalty (${lpPenalty.toFixed(
            1
          )} points).`
        );
      } else {
        debug.push(
          `Bright urban skies – heavy light pollution penalty (${lpPenalty.toFixed(
            1
          )} points).`
        );
      }

      let score = sKp + sLoc - lpPenalty;

      if (typeof cloudCover === "number") {
        const cc = Math.min(1, Math.max(0, cloudCover));
        const cloudPenalty = 25 * cc;
        score -= cloudPenalty;
        debug.push(
          `Cloud cover reduces the score by ${cloudPenalty.toFixed(
            1
          )} points (cover: ${(cc * 100).toFixed(0)}%).`
        );
      }

      const timeAdj = timeOfNightAdjustment(timeLocalHour);
      if (timeAdj !== 0) {
        score += timeAdj;
        const timeLabel = formatHourLocal(timeLocalHour);
        debug.push(
          `Local time adjustment of ${timeAdj.toFixed(
            1
          )} points based on local time ${timeLabel}.`
        );
      }

      score = Math.max(0, Math.min(100, score));
      debug.push(
        `Base visibility score before darkness adjustment: ${score.toFixed(
          0
        )} / 100.`
      );

      return {
        score,
        debug,
        kpScore: sKp,
        locationScore: sLoc,
        lightPollutionPenalty: lpPenalty,
        geomagneticLatitude
      };
    }

    return {
      kpScore,
      locationScore,
      lightPollutionPenalty,
      timeOfNightAdjustment,
      computeBrain
    };
  })();

  // -------- Simple solar darkness model --------

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  function toDeg(rad) {
    return (rad * 180) / Math.PI;
  }

  function dayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 1);
    const diff = date - start;
    return Math.floor(diff / 86400000) + 1;
  }

  function wrapHour(h) {
    let v = h % 24;
    if (v < 0) v += 24;
    return v;
  }

  function isoToLocalHour(isoString) {
    if (!isoString) return null;
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return null;
    const hour = d.getHours();
    const minutes = d.getMinutes();
    const seconds = d.getSeconds();
    return hour + minutes / 60 + seconds / 3600;
  }

  function isHourBetween(h, start, end) {
    if (start == null || end == null) return false;
    h = wrapHour(h);
    start = wrapHour(start);
    end = wrapHour(end);
    if (start === end) return false;
    if (start < end) {
      return h >= start && h < end;
    } else {
      return h >= start || h < end;
    }
  }

  function formatHourLocal(h) {
    if (h == null || !isFinite(h)) return "";
    const wh = wrapHour(h);
    const hour = Math.floor(wh);
    const minutes = Math.round((wh - hour) * 60);
    const hh = hour.toString().padStart(2, "0");
    const mm = minutes.toString().padStart(2, "0");
    return `${hh}:${mm}`;
  }

  function computeDarknessInfo(lat, lon, date) {
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    if (!isFinite(lat) || !isFinite(lon)) return null;

    const d = date || new Date();
    const N = dayOfYear(d);
    const latRad = toRad(lat);
    const decl = toRad(
      23.45 * Math.sin(toRad((360 * (284 + N)) / 365))
    );

    // Approximate solar noon using longitude and local timezone
    const tzOffsetHours = -d.getTimezoneOffset() / 60; // e.g. +1 for CET
    const centralMeridian = tzOffsetHours * 15; // degrees
    const solarNoon = 12 + (centralMeridian - lon) / 15; // local clock hours

    function hourAngleForAltitude(h0Deg) {
      const h0 = toRad(h0Deg);
      const cosH =
        (Math.sin(h0) - Math.sin(latRad) * Math.sin(decl)) /
        (Math.cos(latRad) * Math.cos(decl));

      if (cosH < -1) {
        // Sun always above this altitude (relative to this threshold)
        return { alwaysAbove: true, exists: false };
      }
      if (cosH > 1) {
        // Sun always below this altitude
        return { alwaysBelow: true, exists: false };
      }

      const H = Math.acos(cosH);
      const Hdeg = toDeg(H);
      return { exists: true, Hdeg };
    }

    // Sunrise / sunset (~ upper limb, includes refraction)
    const sun0 = hourAngleForAltitude(-0.833);
    let sunrise = null;
    let sunset = null;
    let hasDay = false;
    let alwaysDaylight = false;
    let alwaysNight = false;

    if (sun0.exists) {
      const Hsun = sun0.Hdeg;
      sunrise = wrapHour(solarNoon - Hsun / 15);
      sunset = wrapHour(solarNoon + Hsun / 15);
      hasDay = true;
    } else if (sun0.alwaysAbove) {
      alwaysDaylight = true;
    } else if (sun0.alwaysBelow) {
      alwaysNight = true;
    }

    // Astronomical darkness (Sun 18° below horizon)
    const astro = hourAngleForAltitude(-18);
    let astroDawn = null;
    let astroDusk = null;
    let hasAstronomicalNight = false;
    let neverDark = false;
    let alwaysAstronomicalDark = false;

    if (astro.exists) {
      const Hastro = astro.Hdeg;
      astroDawn = wrapHour(solarNoon - Hastro / 15);
      astroDusk = wrapHour(solarNoon + Hastro / 15);
      hasAstronomicalNight = true;
    } else if (astro.alwaysAbove) {
      // Sun never 18° below horizon → no full astronomical night
      neverDark = true;
    } else if (astro.alwaysBelow) {
      // Sun always deeper than 18° → essentially full darkness
      alwaysAstronomicalDark = true;
    }

    const hourNow = d.getHours() + d.getMinutes() / 60;
    let isDaylightNow = false;

    if (hasDay) {
      isDaylightNow = isHourBetween(hourNow, sunrise, sunset);
    } else if (alwaysDaylight) {
      isDaylightNow = true;
    }

    let isDarkNow = false;
    if (alwaysAstronomicalDark) {
      isDarkNow = true;
    } else if (hasAstronomicalNight) {
      isDarkNow = isHourBetween(hourNow, astroDusk, astroDawn);
    }

    return {
      date: d,
      sunrise,
      sunset,
      astroDawn,
      astroDusk,
      hasDay,
      alwaysDaylight,
      alwaysNight,
      hasAstronomicalNight,
      neverDark,
      alwaysAstronomicalDark,
      isDaylightNow,
      isDarkNow
    };
  }

  function buildDarknessFromLiveTimes(results) {
    if (!results) return null;

    const sunrise = isoToLocalHour(results.sunrise);
    const sunset = isoToLocalHour(results.sunset);
    const astroDawn = isoToLocalHour(results.astronomical_twilight_begin);
    const astroDusk = isoToLocalHour(results.astronomical_twilight_end);

    if (astroDawn == null || astroDusk == null) return null;

    const now = new Date();
    const hourNow = now.getHours() + now.getMinutes() / 60;

    const hasDay = sunrise != null && sunset != null;
    const hasAstronomicalNight = true;

    const isDaylightNow = hasDay && isHourBetween(hourNow, sunrise, sunset);
    const isDarkNow = isHourBetween(hourNow, astroDusk, astroDawn);

    return {
      date: now,
      sunrise,
      sunset,
      astroDawn,
      astroDusk,
      hasDay,
      alwaysDaylight: false,
      alwaysNight: false,
      hasAstronomicalNight,
      neverDark: false,
      alwaysAstronomicalDark: false,
      isDaylightNow,
      isDarkNow,
      source: "live-api"
    };
  }

  // Darkness → scale factor + explanation, based on the *current* time context in the object.
  function computeDarknessFactorAndNote(darkness) {
    if (!darkness) {
      return {
        factor: 1,
        note:
          "Darkness model unavailable – leaving the score unchanged for day/night."
      };
    }

    const {
      alwaysAstronomicalDark,
      alwaysNight,
      neverDark,
      hasAstronomicalNight,
      hasDay,
      isDaylightNow,
      isDarkNow
    } = darkness;

    // Fully dark all the time (polar night / always-under-18°)
    if (alwaysAstronomicalDark || (alwaysNight && !neverDark)) {
      return {
        factor: 1,
        note:
          "No darkness penalty – the sky is effectively dark throughout this date at your latitude."
      };
    }

    // Never fully dark (midnight sun regime)
    if (neverDark) {
      return {
        factor: 0.5,
        note:
          "Score scaled to 50% because the sky never reaches full astronomical darkness at this time of year."
      };
    }

    // Normal case with a proper dark window
    if (hasAstronomicalNight) {
      if (isDarkNow) {
        return {
          factor: 1,
          note:
            "No darkness penalty – you are within the main dark window for your location."
        };
      }
      if (isDaylightNow) {
        return {
          factor: 0.25,
          note:
            "Score scaled to 25% because it is currently daylight outside the main dark window."
        };
      }
      // Twilight: not fully dark, not fully day
      return {
        factor: 0.6,
        note:
          "Score scaled to 60% because you are in twilight just outside the main dark window."
      };
    }

    // Fallback: we only know coarse day/night, no astronomical night
    if (hasDay) {
      if (isDaylightNow) {
        return {
          factor: 0.3,
          note: "Score scaled to 30% because it is currently daylight."
        };
      }
      return {
        factor: 0.6,
        note:
          "Score scaled to 60% based on partial darkness, without a clear astronomical-night window."
      };
    }

    return {
      factor: 1,
      note:
        "Darkness model did not give clear day/night flags – leaving the score unchanged."
    };
  }

  // -------- Simple Moon model (phase & brightness) --------

  function computeMoonInfo(date) {
    const d = date ? new Date(date) : new Date();
    const synodicMonth = 29.53058867; // days
    // Known reference new moon: 2000-01-06 18:14 UTC
    const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
    const days = (d.getTime() - knownNewMoon) / 86400000;
    let phase = days / synodicMonth;
    phase = phase - Math.floor(phase); // wrap into [0,1)

    // Approximate illumination fraction: 0 = new, 1 = full
    const illumination = 0.5 * (1 - Math.cos(2 * Math.PI * phase));

    let phaseName;
    if (phase < 0.03 || phase > 0.97) {
      phaseName = "New Moon";
    } else if (phase < 0.22) {
      phaseName = "Waxing crescent";
    } else if (phase < 0.28) {
      phaseName = "First quarter";
    } else if (phase < 0.47) {
      phaseName = "Waxing gibbous";
    } else if (phase < 0.53) {
      phaseName = "Full Moon";
    } else if (phase < 0.72) {
      phaseName = "Waning gibbous";
    } else if (phase < 0.78) {
      phaseName = "Last quarter";
    } else {
      phaseName = "Waning crescent";
    }

    return { phase, illumination, phaseName };
  }

  function getMoonPhaseIcon(phase) {
    if (typeof phase !== "number") return "🌙";
    if (phase < 0.03 || phase > 0.97) return "🌑";
    if (phase < 0.22) return "🌒";
    if (phase < 0.28) return "🌓";
    if (phase < 0.47) return "🌔";
    if (phase < 0.53) return "🌕";
    if (phase < 0.72) return "🌖";
    if (phase < 0.78) return "🌗";
    return "🌘";
  }

  function renderMoonLabel(moon) {
    const icon = getMoonPhaseIcon(moon ? moon.phase : null);
    const phaseLabel = moon && moon.phaseName ? moon.phaseName : "Moon phase";
    return `
      <div class=\"hourly-row-label\" aria-label=\"${phaseLabel}\">\n        <span class=\"moon-phase-icon\" role=\"img\" aria-label=\"${phaseLabel}\">${icon}</span>\n        <span>Moon brightness</span>\n      </div>
    `;
  }

  function computeMoonPenalty(moon, darknessContext) {
    if (!moon || !darknessContext) return 0;

    // If it's essentially daytime (or polar day), let the daylight penalty handle it
    if (darknessContext.alwaysDaylight || darknessContext.isDaylightNow) {
      return 0;
    }

    const illum = Math.min(1, Math.max(0, moon.illumination || 0));
    if (illum < 0.1) return 0; // very dark Moon – negligible effect

    const maxPenalty = 18; // max points full Moon can knock off
    return maxPenalty * illum;
  }

  // -------- App wiring --------

  function initApp() {
    const locMainEl = document.getElementById("location-main");
    const locDetailEl = document.getElementById("location-detail");
    const locMetaEl = document.getElementById("location-meta");
    const lpBadgeEl = document.querySelector("[data-role='light-pollution-badge']");
    const lpIndicatorInner = lpBadgeEl.querySelector(".lp-indicator-inner");
    const kpInputEl = document.getElementById("kp-input");
    const kpValueEl = document.getElementById("kp-value");
    const verdictContainer = document.querySelector("[data-role='aurora-verdict']");
    const verdictTextEl = document.getElementById("verdict-text");
    const verdictScoreEl = document.getElementById("verdict-score");
    const debugListEl = document.querySelector("[data-role='aurora-debug']");
    const footerTimeEl = document.getElementById("footer-time");
    const searchInputEl = document.getElementById("search-input");
    const searchButtonEl = document.getElementById("search-button");
    const gpsButtonEl = document.getElementById("gps-button");
    const lpModeOptionsEl = document.getElementById("lp-mode-options");
    const lpModeHintEl = document.getElementById("lp-mode-hint");
    const hourlyBarEl = document.getElementById("hourly-bar");
    const nextDarkSubtitleEl = document.getElementById("next-dark-subtitle");

    // Tonight / classic panels
    const tonightTitleEl = document.getElementById("tonight-title");
    const tonightLocationSubEl = document.getElementById("tonight-location-sub");
    const tonightChanceEl = document.getElementById("tonight-chance");
    const tonightGeomagEl = document.getElementById("tonight-geomag");
    const chipAuroraEl = document.getElementById("chip-aurora");
    const chipDarknessEl = document.getElementById("chip-darkness");
    const chipCloudsEl = document.getElementById("chip-clouds");
    const chipMoonEl = document.getElementById("chip-moon");
    const detailDarknessEl = document.getElementById("detail-darkness");
    const detailCloudsEl = document.getElementById("detail-clouds");
    const detailMoonEl = document.getElementById("detail-moon");
    const auroraOvalImgEl = document.getElementById("aurora-oval-img");
    const auroraOvalStatusEl = document.getElementById("aurora-oval-status");
    const auroraOvalRefreshEl = document.getElementById("aurora-oval-refresh");

    const state = {
      lat: null,
      lon: null,
      geomagneticLatitude: null,
      distanceToOvalKm: null,
      lightPollution: 0.5,
      autoLightPollution: 0.5,
      lpMode: "auto", // 'auto' | 'dark' | 'suburban' | 'urban'
      kp: parseFloat(kpInputEl.value) || 3.5,
      cloudCover: 0.2, // default cloud cover until live weather arrives
      hourlyCloudCover: [],
      weatherSource: "pending",
      weatherUpdatedAt: null,
      locationShort: "your location",
      darkness: null,
      darknessLive: null,
      darknessSource: "model"
    };

    function updateFooterTime() {
      const now = new Date();
      const timeStr = now.toLocaleString(undefined, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit"
      });
      footerTimeEl.textContent = `Local time detected as ${timeStr}.`;
    }

    function approxGeomagneticLatitude(lat) {
      if (typeof lat !== "number") return null;
      return lat - 11;
    }

    function approxDistanceToOvalKm(geomagLat) {
      if (typeof geomagLat !== "number") return null;
      const ovalLat = 67;
      const deltaLat = Math.abs(geomagLat - ovalLat);
      return deltaLat * 111;
    }

    function setLocationDisplay(options) {
      const {
        labelMain,
        labelDetail,
        sourceLabel,
        sourceKind,
        coordsText,
        shortLabel
      } = options;

      if (labelMain) locMainEl.textContent = labelMain;
      if (labelDetail) locDetailEl.textContent = labelDetail;

      state.locationShort = shortLabel || labelMain || "your location";

      locMetaEl.innerHTML = "";
      const src = document.createElement("span");
      src.className = "meta-pill";
      src.textContent = `Source: ${sourceLabel}`;
      locMetaEl.appendChild(src);

      if (coordsText) {
        const coords = document.createElement("span");
        coords.className = "meta-pill";
        coords.textContent = coordsText;
        locMetaEl.appendChild(coords);
      }

      if (sourceKind === "ip") {
        src.style.borderColor = "rgba(234,179,8,0.9)";
      } else if (sourceKind === "gps") {
        src.style.borderColor = "rgba(34,197,94,0.9)";
      } else if (sourceKind === "search") {
        src.style.borderColor = "rgba(56,189,248,0.9)";
      } else if (sourceKind === "default") {
        src.style.borderColor = "rgba(96,165,250,0.9)";
      }

      tonightTitleEl.textContent = `Tonight at ${state.locationShort}`;
      tonightLocationSubEl.textContent =
        "Tonight’s view based on current KP and a simple sky model.";
    }

    function renderLightPollutionBadge(lpResult) {
      if (!lpBadgeEl) return;

      if (!lpResult) {
        lpBadgeEl.className = "lp-badge lp-badge-unknown";
        lpBadgeEl.title =
          "Light pollution estimate is unavailable – using a default middle-of-the-road value.";
        lpBadgeEl.querySelector(".lp-badge-label-strong").textContent =
          "Light pollution:";
        lpBadgeEl.querySelector(".lp-badge-label").textContent = "unknown";
        lpIndicatorInner.style.height = "50%";
        return;
      }

      const { normalized, classification } = lpResult;
      lpBadgeEl.className = `lp-badge lp-badge-${classification.code}`;
      lpBadgeEl.querySelector(".lp-badge-label-strong").textContent =
        "Light pollution:";
      lpBadgeEl.querySelector(".lp-badge-label").textContent =
        classification.label;
      lpBadgeEl.title = `Normalized light pollution: ${(
        normalized * 100
      ).toFixed(0)} / 100 (0 = dark, 100 = very bright)`;

      const darkHeight = 10;
      const brightHeight = 90;
      const height = darkHeight + (brightHeight - darkHeight) * normalized;
      lpIndicatorInner.style.height = `${height}%`;
    }

    function updateDarknessUI(darkness) {
      if (!chipDarknessEl || !detailDarknessEl || !darkness) return;

      if (darkness.alwaysAstronomicalDark || (darkness.alwaysNight && !darkness.neverDark)) {
        chipDarknessEl.textContent = "Dark all day at this time of year.";
        detailDarknessEl.textContent =
          "At your latitude and on this date the Sun stays well below the horizon, so the sky is effectively dark all day. Aurora visibility will be limited mainly by weather and light pollution.";
        if (nextDarkSubtitleEl) {
          nextDarkSubtitleEl.textContent =
            "Viewing chance across representative hours – the sky stays fully dark at this time of year.";
        }
      } else if (darkness.neverDark) {
        chipDarknessEl.textContent = "Sky never gets fully dark tonight.";
        detailDarknessEl.textContent =
          "The Sun never reaches full astronomical darkness (18° below the horizon) at this time of year. Very bright aurora may still be visible in the darkest hours.";
        if (nextDarkSubtitleEl) {
          nextDarkSubtitleEl.textContent =
            "Late-night hours at this latitude; the sky stays in bright twilight rather than full darkness.";
        }
      } else if (darkness.hasAstronomicalNight) {
        const start = formatHourLocal(darkness.astroDusk);
        const end = formatHourLocal(darkness.astroDawn);
        chipDarknessEl.textContent = `Dark enough from about ${start}–${end}.`;

        const sunriseStr =
          darkness.sunrise != null ? formatHourLocal(darkness.sunrise) : null;
        const sunsetStr =
          darkness.sunset != null ? formatHourLocal(darkness.sunset) : null;
        let extra = "";
        if (sunsetStr && sunriseStr) {
          extra = ` (sunset ${sunsetStr}, sunrise ${sunriseStr})`;
        }

        const sourceNote =
          darkness.source === "live-api"
            ? "Times loaded from a live sunrise/sunset service for your coordinates."
            : "We approximate astronomical-night when the Sun is 18° below the horizon.";

        detailDarknessEl.textContent =
          `${sourceNote} For today that gives a dark window from about ${start}–${end}${extra}.`;

        if (nextDarkSubtitleEl) {
          nextDarkSubtitleEl.textContent =
            `Aurora visibility score across key dark hours tonight (${start}–${end}) using live times for your location.`;
        }
      } else if (darkness.hasDay) {
        const sunriseStr = formatHourLocal(darkness.sunrise);
        const sunsetStr = formatHourLocal(darkness.sunset);
        chipDarknessEl.textContent = `Roughly dark between sunset ${sunsetStr} and sunrise ${sunriseStr}.`;
        detailDarknessEl.textContent =
          "We estimate sunrise and sunset with a simple solar model based on your latitude, longitude and date. In a future version we’ll refine twilight handling further.";
        if (nextDarkSubtitleEl) {
          nextDarkSubtitleEl.textContent =
            "Aurora visibility score across the next few hours, using a simple solar darkness model.";
        }
      } else {
        chipDarknessEl.textContent = "Darkness timings unavailable.";
        detailDarknessEl.textContent =
          "We couldn’t estimate darkness timings for this location and date.";
        if (nextDarkSubtitleEl) {
          nextDarkSubtitleEl.textContent =
            "Prototype bar chart – darkness timings are unavailable for this location.";
        }
      }
    }

    function updateTonightSummary(result) {
      let label = "Low chance";
      let cls = "chance-low";

      if (result.verdict === "yes") {
        label = "Good chance";
        cls = "chance-high";
      } else if (result.verdict === "maybe") {
        label = "Low to moderate chance";
        cls = "chance-medium";
      }

      tonightChanceEl.textContent = label;
      tonightChanceEl.className = `tonight-chance ${cls}`;

      const kp = state.kp;
      let activityText = "Low";
      if (kp >= 7) activityText = "Very high";
      else if (kp >= 5) activityText = "High";
      else if (kp >= 3.5) activityText = "Moderate";

      chipAuroraEl.textContent = activityText;

      tonightGeomagEl.textContent =
        `KP index ${kp.toFixed(1)} with your latitude gives a ` +
        `${activityText.toLowerCase()} level of geomagnetic activity; ` +
        `clouds and moonlight are now factored in using a simple v1 model.`;
    }

    function renderAuroraVerdict(result, context) {
      const { verdict, score, debug } = result;
      const localHour =
        context && typeof context.localHour === "number"
          ? context.localHour
          : null;
      const darkness = context && context.darkness ? context.darkness : null;

      let isDaytime = false;
      if (darkness) {
        isDaytime = !!darkness.isDaylightNow;
      } else if (localHour !== null) {
        const hour = ((localHour % 24) + 24) % 24;
        isDaytime = hour >= 7 && hour < 17;
      }

      verdictContainer.dataset.state = verdict;

      // Base text from final score/verdict
      if (verdict === "yes") {
        verdictTextEl.textContent =
          "Conditions look good – you have a solid chance of seeing aurora from here. 🌌";
      } else if (verdict === "maybe") {
        verdictTextEl.textContent =
          "It’s possible, but conditions are borderline. A darker spot or higher KP would really help.";
      } else {
        verdictTextEl.textContent =
          "It’s unlikely right now. You’d need much stronger activity or darker skies.";
      }

      // Daylight override, using solar model where possible
      if (isDaytime) {
        let msg =
          "It’s currently daylight at your location, so you won’t see the aurora until after dark.";
        if (darkness && (darkness.hasAstronomicalNight || darkness.alwaysAstronomicalDark)) {
          if (darkness.alwaysAstronomicalDark) {
            msg += " The sky stays fully dark throughout this date at your latitude.";
          } else {
            const start = formatHourLocal(darkness.astroDusk);
            const end = formatHourLocal(darkness.astroDawn);
            msg += ` Tonight it should be dark enough roughly between ${start} and ${end}.`;
          }
        }
        verdictTextEl.textContent = msg;
      }

      verdictScoreEl.textContent = `Score ${score.toFixed(0)} / 100`;

      if (debugListEl) {
        debugListEl.innerHTML = "";
        (debug || []).forEach((line) => {
          const li = document.createElement("li");
          li.textContent = line;
          debugListEl.appendChild(li);
        });

        if (darkness) {
          if (isDaytime) {
            const li = document.createElement("li");
            if (darkness.hasAstronomicalNight || darkness.alwaysAstronomicalDark) {
              if (darkness.alwaysAstronomicalDark) {
                li.textContent =
                  "The Sun is above the horizon right now, but remains well below -18° at night – the sky is fully dark when the Sun is down.";
              } else {
                const start = formatHourLocal(darkness.astroDusk);
                const end = formatHourLocal(darkness.astroDawn);
                li.textContent =
                  `It is too bright to see aurora at the moment; your main dark window is roughly ${start}–${end}.`;
              }
            } else if (darkness.neverDark) {
              li.textContent =
                "Even at night the Sun doesn’t reach full astronomical darkness at this latitude and date, so the sky stays in twilight.";
            } else {
              li.textContent =
                "It is currently daylight; we’ll refine twilight and darkness windows further in a later version.";
            }
            debugListEl.appendChild(li);
          } else if (darkness.hasAstronomicalNight && darkness.isDarkNow) {
            const li = document.createElement("li");
            const start = formatHourLocal(darkness.astroDusk);
            const end = formatHourLocal(darkness.astroDawn);
            li.textContent =
              `You are within the main dark window (${start}–${end}) for your location.`;
            debugListEl.appendChild(li);
          } else if (darkness.neverDark) {
            const li = document.createElement("li");
            li.textContent =
              "The sky never gets fully dark at this latitude at this time of year; aurora will compete with bright twilight.";
            debugListEl.appendChild(li);
          }
        }
      }

      updateTonightSummary(result);
    }

    function clamp01(v) {
      if (typeof v !== "number" || Number.isNaN(v)) return null;
      return Math.min(1, Math.max(0, v));
    }

    // Live clouds UI (driven by weather API when available)
    function updateCloudsUI() {
      if (!chipCloudsEl || !detailCloudsEl) return;

      const pct =
        typeof state.cloudCover === "number"
          ? Math.round(state.cloudCover * 100)
          : null;
      let desc = "Mostly clear";
      if (pct != null) {
        if (pct >= 70) desc = "Heavily overcast";
        else if (pct >= 40) desc = "Partly cloudy";
      } else {
        desc = "Cloud data unavailable";
      }

      const pctText = pct != null ? `~${pct}% cloud` : "using fallback";
      chipCloudsEl.textContent = `${desc} (${pctText}).`;

      if (state.weatherSource === "open-meteo" && state.weatherUpdatedAt) {
        const updated = state.weatherUpdatedAt.toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit"
        });
        detailCloudsEl.textContent = `Live cloud cover from Open-Meteo for your coordinates. Last updated ${updated}.`;
      } else {
        detailCloudsEl.textContent =
          "Using a fallback 20% cloud cover until live weather can be fetched for your location.";
      }
    }

    function mapCloudCoverForTime(targetDate) {
      if (!state.hourlyCloudCover || !state.hourlyCloudCover.length) {
        return null;
      }

      const targetTs = targetDate.getTime();
      let best = null;

      state.hourlyCloudCover.forEach((entry) => {
        if (!entry || !entry.time || typeof entry.cover !== "number") return;
        const diff = Math.abs(entry.time.getTime() - targetTs);
        if (!best || diff < best.diff) {
          best = { cover: entry.cover, diff };
        }
      });

      // Only trust reasonably close hourly values (within ~90 minutes)
      if (best && best.diff <= 90 * 60 * 1000) {
        return best.cover;
      }

      return best ? best.cover : null;
    }

    async function refreshWeather(lat, lon) {
      try {
        if (typeof lat !== "number" || typeof lon !== "number") return;

        const url =
          "https://api.open-meteo.com/v1/forecast?hourly=cloud_cover&current_weather=true&forecast_days=2&timezone=auto&latitude=" +
          encodeURIComponent(lat) +
          "&longitude=" +
          encodeURIComponent(lon);

        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) {
          throw new Error("Weather fetch failed with status " + res.status);
        }

        const data = await res.json();

        let cloud = null;
        if (
          data.current_weather &&
          typeof data.current_weather.cloudcover === "number"
        ) {
          cloud = clamp01(data.current_weather.cloudcover / 100);
        }

        const hourly = [];
        if (
          data.hourly &&
          Array.isArray(data.hourly.time) &&
          Array.isArray(data.hourly.cloud_cover)
        ) {
          const len = Math.min(
            data.hourly.time.length,
            data.hourly.cloud_cover.length
          );
          for (let i = 0; i < len; i++) {
            const t = data.hourly.time[i];
            const c = data.hourly.cloud_cover[i];
            if (typeof c !== "number") continue;
            const parsed = new Date(t);
            if (Number.isNaN(parsed.getTime())) continue;
            const cover = clamp01(c / 100);
            if (cover == null) continue;
            hourly.push({ time: parsed, cover });
          }
        }

        if (cloud == null && hourly.length) {
          cloud = hourly[0].cover;
        }

        if (cloud != null) {
          state.cloudCover = cloud;
        }
        state.hourlyCloudCover = hourly;
        state.weatherSource = "open-meteo";
        state.weatherUpdatedAt = new Date();

        updateCloudsUI();
        recomputeAurora();
      } catch (err) {
        console.warn("Weather fetch failed – keeping fallback clouds", err);
        state.weatherSource = "fallback";
        if (typeof state.cloudCover !== "number") {
          state.cloudCover = 0.2;
        }
        updateCloudsUI();
        recomputeAurora();
      }
    }

    // v1: Moon UI
    function updateMoonUI(moon) {
      if (!chipMoonEl || !detailMoonEl || !moon) return;
      const pct = Math.round((moon.illumination || 0) * 100);
      chipMoonEl.textContent = `${moon.phaseName} (~${pct}% illuminated).`;
      detailMoonEl.textContent =
        "We use an approximate Moon phase model to estimate how much the Moon brightens the sky. In this v1 it reduces the score slightly when the Moon is bright, especially during dark hours.";
    }

    async function refreshDarknessFromSunriseSunset(lat, lon) {
      try {
        if (typeof lat !== "number" || typeof lon !== "number") return;
        const url =
          "https://api.sunrise-sunset.org/json?formatted=0&lat=" +
          encodeURIComponent(lat) +
          "&lng=" +
          encodeURIComponent(lon);

        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) {
          throw new Error("Sunrise-sunset fetch failed with status " + res.status);
        }

        const data = await res.json();
        if (!data || data.status !== "OK" || !data.results) {
          throw new Error("Unexpected sunrise-sunset response");
        }

        const live = buildDarknessFromLiveTimes(data.results);
        if (live) {
          state.darknessLive = live;
          state.darknessSource = "live-api";
          recomputeAurora();
        }
      } catch (err) {
        console.warn("Falling back to model darkness times", err);
        state.darknessLive = null;
      }
    }

    // -------- Hourly chart: uses darkness + clouds + moon + brain --------
    function renderHourlyChart(darkness, baseInputs, moonInfo) {
      if (!hourlyBarEl) return;

      hourlyBarEl.innerHTML = "";

      const addPlaceholderRows = (count = 8) => {
        const timeRow = document.createElement("div");
        timeRow.className = "hourly-row";
        timeRow.innerHTML = `<div class=\"hourly-row-label\">Times</div>`;
        const timeTrack = document.createElement("div");
        timeTrack.className = "hourly-row-track";
        for (let i = 0; i < count; i++) {
          const cell = document.createElement("div");
          cell.className = "hour-cell hour-cell-time";
          cell.textContent = "--:--";
          timeTrack.appendChild(cell);
        }
        timeRow.appendChild(timeTrack);

        const scoreRow = document.createElement("div");
        scoreRow.className = "hourly-row";
        scoreRow.innerHTML = `<div class=\"hourly-row-label\">Viewing score</div>`;
        const scoreTrack = document.createElement("div");
        scoreTrack.className = "hourly-row-track";
        for (let i = 0; i < count; i++) {
          const cell = document.createElement("div");
          cell.className = "hour-cell hour-cell-score";
          cell.innerHTML = `
            <div class=\"hour-score-bar\"> <div class=\"hour-score-bar-fill\" style=\"height: 50%;\"></div> </div>
            <div class=\"hour-score-value\">--%</div>
            <div class=\"hour-cell-note\">Waiting for location…</div>
          `;
          scoreTrack.appendChild(cell);
        }
        scoreRow.appendChild(scoreTrack);

        const cloudRow = document.createElement("div");
        cloudRow.className = "hourly-row";
        cloudRow.innerHTML = `<div class=\"hourly-row-label\">Cloud cover</div>`;
        const cloudTrack = document.createElement("div");
        cloudTrack.className = "hourly-row-track";
        for (let i = 0; i < count; i++) {
          const cell = document.createElement("div");
          cell.className = "hour-cell hour-cell-note";
          cell.textContent = "--";
          cloudTrack.appendChild(cell);
        }
        cloudRow.appendChild(cloudTrack);

        const moonRow = document.createElement("div");
        moonRow.className = "hourly-row";
        moonRow.innerHTML = renderMoonLabel(computeMoonInfo(new Date()));
        const moonTrack = document.createElement("div");
        moonTrack.className = "hourly-row-track";
        for (let i = 0; i < count; i++) {
          const cell = document.createElement("div");
          cell.className = "hour-cell hour-cell-note";
          cell.textContent = "--";
          moonTrack.appendChild(cell);
        }
        moonRow.appendChild(moonTrack);

        hourlyBarEl.appendChild(timeRow);
        hourlyBarEl.appendChild(scoreRow);
        hourlyBarEl.appendChild(cloudRow);
        hourlyBarEl.appendChild(moonRow);
      };

      if (!state.lat || !state.lon || !darkness) {
        addPlaceholderRows();
        return;
      }

      const now = new Date();
      const hourNow = now.getHours() + now.getMinutes() / 60;
      const moon = moonInfo || computeMoonInfo(now);

      const hourDates = [];
      const buildDateForHour = (hourValue, baseDate) => {
        const d = new Date(baseDate);
        d.setHours(0, 0, 0, 0);
        const hoursWhole = Math.floor(hourValue);
        const minutes = Math.round((hourValue - hoursWhole) * 60);
        d.setHours(hoursWhole, minutes, 0, 0);
        return d;
      };

      if (
        darkness.hasAstronomicalNight &&
        darkness.astroDusk != null &&
        darkness.astroDawn != null
      ) {
        const duskDate = buildDateForHour(darkness.astroDusk, now);
        const dawnDate = buildDateForHour(darkness.astroDawn, duskDate);
        if (dawnDate <= duskDate) {
          dawnDate.setDate(dawnDate.getDate() + 1);
        }

        if (now > dawnDate) {
          duskDate.setDate(duskDate.getDate() + 1);
          dawnDate.setDate(dawnDate.getDate() + 1);
        }

        const startDate = new Date(duskDate);
        if (startDate.getMinutes() > 0) {
          startDate.setHours(startDate.getHours() + 1, 0, 0, 0);
        }

        let cursor = startDate;
        let safety = 0;
        while (cursor <= dawnDate && safety < 48) {
          hourDates.push(new Date(cursor));
          cursor = new Date(cursor.getTime() + 3600000);
          safety++;
        }
      } else if (darkness.alwaysAstronomicalDark || darkness.alwaysNight) {
        let startHour = Math.floor(hourNow);
        const startDate = new Date(now);
        startDate.setMinutes(0, 0, 0);
        startDate.setHours(startHour, 0, 0, 0);
        for (let i = 0; i < 12; i++) {
          const d = new Date(startDate.getTime() + i * 3600000);
          hourDates.push(d);
        }
      } else {
        let startHour = Math.floor(hourNow);
        const startDate = new Date(now);
        startDate.setMinutes(0, 0, 0);
        startDate.setHours(startHour, 0, 0, 0);
        for (let i = 0; i < 8; i++) {
          const d = new Date(startDate.getTime() + i * 3600000);
          hourDates.push(d);
        }
      }

      if (!hourDates.length) {
        addPlaceholderRows();
        return;
      }

      const hourEntries = hourDates.map((hourDate) => {
        const localHour =
          hourDate.getHours() + hourDate.getMinutes() / 60;

        const inputs = {
          kp: baseInputs.kp,
          distanceToOvalKm: baseInputs.distanceToOvalKm,
          geomagneticLatitude: baseInputs.geomagneticLatitude,
          lightPollution: baseInputs.lightPollution,
          cloudCover:
            mapCloudCoverForTime(hourDate) ?? baseInputs.cloudCover,
          timeLocalHour: localHour
        };

        const baseResult = AuroraBrain.computeBrain(inputs);
        let score = baseResult.score;

        let isDayHour = false;
        if (darkness.hasDay && darkness.sunrise != null && darkness.sunset != null) {
          isDayHour = isHourBetween(localHour, darkness.sunrise, darkness.sunset);
        } else if (darkness.alwaysDaylight) {
          isDayHour = true;
        }

        let isDarkHour = false;
        if (darkness.alwaysAstronomicalDark) {
          isDarkHour = true;
        } else if (
          darkness.hasAstronomicalNight &&
          darkness.astroDusk != null &&
          darkness.astroDawn != null
        ) {
          isDarkHour = isHourBetween(localHour, darkness.astroDusk, darkness.astroDawn);
        }

        const darknessForHour = {
          ...darkness,
          isDaylightNow: isDayHour,
          isDarkNow: isDarkHour
        };

        const moonPenaltyHour = computeMoonPenalty(moon, darknessForHour);
        if (moonPenaltyHour > 0) {
          score = Math.max(0, Math.min(100, score - moonPenaltyHour));
        }

        const df = computeDarknessFactorAndNote(darknessForHour);
        const factor = df.factor;
        score = Math.max(0, Math.min(100, score * factor));

        const scoreRounded = Math.round(score);
        const barHeight = Math.max(8, Math.min(100, scoreRounded));

        const cloudPct =
          typeof inputs.cloudCover === "number"
            ? Math.round(inputs.cloudCover * 100)
            : null;

        const moonPct = Math.round((moon.illumination || 0) * 100);

        return {
          localHour,
          label: formatHourLocal(localHour),
          scoreRounded,
          barHeight,
          cloudPct,
          moonPct,
          isDayHour
        };
      });

      const timeRow = document.createElement("div");
      timeRow.className = "hourly-row";
      timeRow.innerHTML = `<div class=\"hourly-row-label\">Times (evening to dawn)</div>`;
      const timeTrack = document.createElement("div");
      timeTrack.className = "hourly-row-track";
      hourEntries.forEach((entry) => {
        const cell = document.createElement("div");
        cell.className = "hour-cell hour-cell-time";
        cell.textContent = entry.label;
        timeTrack.appendChild(cell);
      });
      timeRow.appendChild(timeTrack);

      const scoreRow = document.createElement("div");
      scoreRow.className = "hourly-row";
      scoreRow.innerHTML = `<div class=\"hourly-row-label\">Viewing score</div>`;
      const scoreTrack = document.createElement("div");
      scoreTrack.className = "hourly-row-track";
      hourEntries.forEach((entry) => {
        const cell = document.createElement("div");
        cell.className = "hour-cell hour-cell-score";
        cell.innerHTML = `
          <div class=\"hour-score-bar\"> <div class=\"hour-score-bar-fill\" style=\"height: ${100 - entry.barHeight}%;\"></div> </div>
          <div class=\"hour-score-value\">${entry.scoreRounded}%</div>
          <div class=\"hour-cell-note\">${entry.isDayHour ? "Daylight" : "Dark"}</div>
        `;
        scoreTrack.appendChild(cell);
      });
      scoreRow.appendChild(scoreTrack);

      const cloudRow = document.createElement("div");
      cloudRow.className = "hourly-row";
      cloudRow.innerHTML = `<div class=\"hourly-row-label\">Cloud cover</div>`;
      const cloudTrack = document.createElement("div");
      cloudTrack.className = "hourly-row-track";
      hourEntries.forEach((entry) => {
        const cell = document.createElement("div");
        cell.className = "hour-cell hour-cell-note";
        cell.textContent = entry.cloudPct != null ? `${entry.cloudPct}%` : "--";
        cloudTrack.appendChild(cell);
      });
      cloudRow.appendChild(cloudTrack);

      const moonRow = document.createElement("div");
      moonRow.className = "hourly-row";
      moonRow.innerHTML = renderMoonLabel(moon);
      const moonTrack = document.createElement("div");
      moonTrack.className = "hourly-row-track";
      hourEntries.forEach((entry) => {
        const cell = document.createElement("div");
        cell.className = `hour-cell hour-cell-note ${entry.isDayHour ? "hour-cell-muted" : ""}`;
        cell.textContent = `${entry.moonPct}%`;
        moonTrack.appendChild(cell);
      });
      moonRow.appendChild(moonTrack);

      hourlyBarEl.appendChild(timeRow);
      hourlyBarEl.appendChild(scoreRow);
      hourlyBarEl.appendChild(cloudRow);
      hourlyBarEl.appendChild(moonRow);
    }

    function recomputeAurora() {
      if (state.lat == null || state.lon == null) {
        verdictTextEl.textContent =
          "We’re still waiting for a location before we can score your chances.";
        verdictScoreEl.textContent = "Score — / 100";
        verdictContainer.dataset.state = "";
        if (hourlyBarEl) {
          hourlyBarEl.innerHTML = "";
        }
        updateCloudsUI();
        return;
      }

      const now = new Date();
      const localHour = now.getHours() + now.getMinutes() / 60;

      // Update darkness info – prefer live sunrise/sunset when available
      let darkness = state.darknessLive || computeDarknessInfo(state.lat, state.lon, now);
      if (darkness && !darkness.source) {
        darkness = { ...darkness, source: state.darknessLive ? "live-api" : "model" };
      }
      state.darkness = darkness;
      state.darknessSource = darkness ? darkness.source : "model";
      if (darkness) {
        updateDarknessUI(darkness);
      }

      // Update clouds & moon UI
      updateCloudsUI();
      const moon = computeMoonInfo(now);
      updateMoonUI(moon);

      const geomagLat =
        state.geomagneticLatitude != null
          ? state.geomagneticLatitude
          : approxGeomagneticLatitude(state.lat);
      const distanceKm =
        state.distanceToOvalKm != null
          ? state.distanceToOvalKm
          : approxDistanceToOvalKm(geomagLat);

      state.geomagneticLatitude = geomagLat;
      state.distanceToOvalKm = distanceKm;

      const cloudCover =
        typeof state.cloudCover === "number" ? state.cloudCover : 0.2;

      const baseInputs = {
        kp: state.kp,
        distanceToOvalKm: distanceKm,
        geomagneticLatitude: geomagLat,
        lightPollution: state.lightPollution,
        cloudCover
      };

      // Hourly chart uses the same "base brain + moon + darkness factor per hour"
      renderHourlyChart(darkness, baseInputs, moon);

      // Main brain: compute base score, then apply moon penalty, then darkness factor
      const baseResult = AuroraBrain.computeBrain({
        ...baseInputs,
        timeLocalHour: localHour
      });

      let scoreAfterMoon = baseResult.score;
      let moonPenaltyNow = 0;
      if (moon) {
        moonPenaltyNow = computeMoonPenalty(moon, darkness);
        if (moonPenaltyNow > 0) {
          scoreAfterMoon = Math.max(0, scoreAfterMoon - moonPenaltyNow);
        }
      }

      let darknessFactor = 1;
      let darknessNote = null;
      if (darkness) {
        const df = computeDarknessFactorAndNote(darkness);
        darknessFactor = df.factor;
        darknessNote = df.note;
      }

      let adjustedScore = scoreAfterMoon * darknessFactor;
      adjustedScore = Math.max(0, Math.min(100, adjustedScore));

      const debug = baseResult.debug ? baseResult.debug.slice() : [];
      if (moonPenaltyNow > 0) {
        const moonPct = Math.round((moon.illumination || 0) * 100);
        debug.push(
          `Moon brightness reduces the score by ${moonPenaltyNow.toFixed(
            1
          )} points (illumination ~${moonPct}%).`
        );
        debug.push(
          `Score after moon adjustment: ${scoreAfterMoon.toFixed(0)} / 100.`
        );
      } else {
        debug.push(
          "Moon has negligible effect on the score in this simple v1 model."
        );
      }

      if (darknessNote) {
        debug.push(darknessNote);
      } else {
        debug.push(
          `Darkness model did not apply a penalty (factor ${darknessFactor.toFixed(
            2
          )}).`
        );
      }

      if (darknessFactor !== 1) {
        debug.push(
          `Score after darkness adjustment: ${adjustedScore.toFixed(0)} / 100.`
        );
      } else {
        debug.push(
          `Score unchanged by darkness (factor 1.00): ${adjustedScore.toFixed(
            0
          )} / 100.`
        );
      }

      // Final verdict thresholds on the darkness-adjusted score
      let verdict;
      if (adjustedScore >= 65) {
        verdict = "yes";
      } else if (adjustedScore >= 35) {
        verdict = "maybe";
      } else {
        verdict = "no";
      }
      debug.push(
        `Final visibility verdict after darkness adjustment: ${verdict.toUpperCase()}.`
      );

      const result = {
        ...baseResult,
        score: adjustedScore,
        verdict,
        darknessFactor,
        debug
      };

      renderAuroraVerdict(result, { localHour, darkness });
    }

    function onKpChange() {
      const val = parseFloat(kpInputEl.value) || 0;
      state.kp = val;
      kpValueEl.textContent = `KP ${val.toFixed(1)}`;
      recomputeAurora();
    }

    function applyKpToUi(kpValue) {
      if (!kpInputEl) return;

      const min = kpInputEl.min !== undefined ? parseFloat(kpInputEl.min) : 0;
      const max = kpInputEl.max !== undefined ? parseFloat(kpInputEl.max) : 9;
      const clamped = Math.min(max, Math.max(min, kpValue));

      kpInputEl.value = clamped.toFixed(1);
      onKpChange();
    }

    async function fetchLatestKpFromNoaa() {
      const url =
        "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
      const response = await fetch(url, { cache: "no-cache" });

      if (!response.ok) {
        throw new Error("NOAA KP fetch failed with status " + response.status);
      }

      const data = await response.json();

      // Expect an array, first row is header
      if (!Array.isArray(data) || data.length < 2) {
        throw new Error("Unexpected NOAA KP data shape");
      }

      const lastRow = data[data.length - 1];

      const timeTag = lastRow[0];       // "YYYY-MM-DD HH:mm:ss.sss"
      const kpFractionStr = lastRow[2]; // Kp_fraction
      const kpStr = lastRow[1];         // Kp integer

      let kp = Number.parseFloat(kpFractionStr);
      if (!Number.isFinite(kp)) {
        kp = Number.parseFloat(kpStr);
      }
      if (!Number.isFinite(kp)) {
        throw new Error("NOAA KP values not parseable");
      }

      return { kp, timeTag };
    }

    function initKpLiveMode() {
      const toggleEl = document.getElementById("kp-live-toggle");
      const statusEl = document.getElementById("kp-live-status");

      // If the HTML isn't present (older layout), do nothing
      if (!toggleEl || !statusEl) {
        return;
      }

      let intervalId = null;

      async function updateFromLiveKp() {
        try {
          statusEl.textContent = "Fetching latest NOAA KP…";

          const { kp, timeTag } = await fetchLatestKpFromNoaa();

          applyKpToUi(kp);

          let displayTime = timeTag;
          try {
            // Convert "YYYY-MM-DD HH:mm:ss.sss" → "YYYY-MM-DDTHH:mm:ss.sssZ"
            const iso = timeTag.replace(" ", "T") + "Z";
            const d = new Date(iso);
            if (!Number.isNaN(d.getTime())) {
              displayTime = d.toUTCString();
            }
          } catch (_) {
            // keep original if parsing fails
          }

          statusEl.textContent = `Live KP ≈ ${kp.toFixed(1)} (NOAA, ${displayTime})`;
        } catch (err) {
          console.warn("Failed to update live KP:", err);
          toggleEl.checked = false;
          stopLiveUpdates("Live KP unavailable – using manual value.");
        }
      }

      function stopLiveUpdates(manualLabel) {
        if (intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
        statusEl.textContent = manualLabel || "Live KP off – using manual value.";
      }

      function startLiveUpdates() {
        // Turn ON: fetch now and every hour
        if (intervalId !== null) {
          clearInterval(intervalId);
        }
        toggleEl.checked = true;
        updateFromLiveKp();
        intervalId = window.setInterval(updateFromLiveKp, 60 * 60 * 1000);
      }

      toggleEl.addEventListener("change", () => {
        if (toggleEl.checked) {
          startLiveUpdates();
        } else {
          stopLiveUpdates();
        }
      });

      // Auto-start live KP so the geomagnetic activity section is fed by the
      // real aurora prediction feed by default.
      startLiveUpdates();
    }

    let auroraOvalObjectUrl = null;

    function setAuroraOvalStatus(text) {
      if (!auroraOvalStatusEl) return;
      auroraOvalStatusEl.textContent = text;
    }

    async function refreshAuroraOval() {
      if (!auroraOvalImgEl || !auroraOvalStatusEl) return;

      const url =
        "https://services.swpc.noaa.gov/images/aurora-forecast-northern-hemisphere.jpg";

      try {
        setAuroraOvalStatus("Fetching latest NOAA aurora image…");
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Aurora oval fetch failed with status " + response.status);
        }

        const blob = await response.blob();

        if (auroraOvalObjectUrl) {
          URL.revokeObjectURL(auroraOvalObjectUrl);
        }

        auroraOvalObjectUrl = URL.createObjectURL(blob);
        auroraOvalImgEl.src = auroraOvalObjectUrl;

        const lastModified = response.headers.get("last-modified");
        let stamp = "just now";
        if (lastModified) {
          const parsed = new Date(lastModified);
          if (!Number.isNaN(parsed.getTime())) {
            stamp = parsed.toUTCString();
          }
        }

        setAuroraOvalStatus(
          `Live aurora oval from NOAA OVATION — updated ${stamp}.`
        );
      } catch (err) {
        console.warn("Failed to load aurora oval image", err);
        setAuroraOvalStatus(
          "Couldn’t load the live NOAA aurora oval. Please try again."
        );
      }
    }

    function initAuroraOvalLive() {
      if (!auroraOvalImgEl || !auroraOvalStatusEl) return;

      refreshAuroraOval();

      if (auroraOvalRefreshEl) {
        auroraOvalRefreshEl.addEventListener("click", () => {
          refreshAuroraOval();
        });
      }

      window.setInterval(refreshAuroraOval, 30 * 60 * 1000);
    }

    async function updateLightPollution(lat, lon, options) {
      try {
        const result = await LightPollution.getLightPollution(lat, lon);

        let normalized = result.normalized;
        const ctx = options && options.placeContext;

        // Simple adjustment based on place type:
        // - large-settlement: push towards bright
        // - settlement: ensure at least suburban
        // - dark-nature: clamp to dark
        if (ctx === "large-settlement") {
          normalized = Math.max(normalized, 0.8);
        } else if (ctx === "settlement") {
          normalized = Math.max(normalized, 0.6);
        } else if (ctx === "dark-nature") {
          normalized = Math.min(normalized, 0.25);
        }

        // Store auto-estimate regardless of current mode
        state.autoLightPollution = normalized;

        if (state.lpMode === "auto") {
          state.lightPollution = normalized;
          const adjusted = {
            ...result,
            normalized,
            classification: LightPollution.classifyLightPollutionValue(normalized)
          };
          renderLightPollutionBadge(adjusted);
        }

        // If we're in manual mode, we do not override the user's chosen value,
        // but we still recompute from that.
        recomputeAurora();
      } catch (err) {
        console.error("Failed to estimate light pollution", err);
        state.autoLightPollution = 0.5;
        if (state.lpMode === "auto") {
          state.lightPollution = 0.5;
          renderLightPollutionBadge(null);
        }
        recomputeAurora();
      }
    }

    function useDefaultRumLocation() {
      // Isle of Rùm default fallback: ~57.0 N, -6.33 W
      const lat = 57.0;
      const lon = -6.33;
      state.lat = lat;
      state.lon = lon;

      const coordsText = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;

      setLocationDisplay({
        labelMain: "Isle of Rùm \u2022 Scotland, UK",
        labelDetail:
          "Using a default dark-sky location because we couldn’t determine your exact position.",
        sourceLabel: "Default fallback (Isle of Rùm)",
        sourceKind: "default",
        coordsText,
        shortLabel: "Isle of Rùm"
      });

      updateLightPollution(lat, lon, { placeContext: "dark-nature" });
      refreshDarknessFromSunriseSunset(lat, lon);
      refreshWeather(lat, lon);
    }

    function useIpLocationFallback() {
      fetch("https://ipapi.co/json/")
        .then((res) => res.json())
        .then((data) => {
          const city = data.city || "your area";
          const country = data.country_name || data.country || "your country";
          const latRaw = data.latitude ?? data.lat;
          const lonRaw = data.longitude ?? data.lon;

          const lat =
            typeof latRaw === "string" ? parseFloat(latRaw) : latRaw;
          const lon =
            typeof lonRaw === "string" ? parseFloat(lonRaw) : lonRaw;

          state.lat =
            typeof lat === "number" && !Number.isNaN(lat) ? lat : null;
          state.lon =
            typeof lon === "number" && !Number.isNaN(lon) ? lon : null;

          const coordsText =
            state.lat != null && state.lon != null
              ? `Approx. ${state.lat.toFixed(2)}°, ${state.lon.toFixed(2)}°`
              : null;

          setLocationDisplay({
            labelMain: `Near ${city} \u2022 ${country}`,
            labelDetail: "Location estimated from your network (IP).",
            sourceLabel: "IP-based (approximate)",
            sourceKind: "ip",
            coordsText,
            shortLabel: `Near ${city}`
          });

          if (state.lat != null && state.lon != null) {
            updateLightPollution(state.lat, state.lon);
            refreshDarknessFromSunriseSunset(state.lat, state.lon);
            refreshWeather(state.lat, state.lon);
          } else {
            // If we somehow didn't get usable coordinates, fall back to default.
            useDefaultRumLocation();
          }
        })
        .catch((err) => {
          console.error("IP location failed", err);
          // Ultimate fallback: default dark-sky location
          useDefaultRumLocation();
        });
    }

    function initLocationViaGps() {
      if (!navigator.geolocation) {
        useIpLocationFallback();
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          state.lat = latitude;
          state.lon = longitude;

          const coordsText = `${latitude.toFixed(3)}°, ${longitude.toFixed(
            3
          )}° (±${Math.round(accuracy)} m)`;

          setLocationDisplay({
            labelMain: "Location from your device",
            labelDetail:
              "Using your device’s location services. This is typically accurate to a few hundred metres.",
            sourceLabel: "Device location (precise)",
            sourceKind: "gps",
            coordsText,
            shortLabel: "Your device location"
          });

          updateLightPollution(latitude, longitude);
          refreshDarknessFromSunriseSunset(latitude, longitude);
          refreshWeather(latitude, longitude);
        },
        (err) => {
          console.warn("Geolocation failed, falling back to IP", err);
          useIpLocationFallback();
        },
        {
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 600000
        }
      );
    }

    function geocodeSearch(query) {
      const url =
        "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" +
        encodeURIComponent(query);

      searchButtonEl.disabled = true;
      fetch(url, {
        headers: {
          "Accept-Language": "en",
          "User-Agent": "Aurora Planner/1.0 (https://a2kdaaurora.github.io)"
        }
      })
        .then((res) => res.json())
        .then((results) => {
          if (!results || !results.length) {
            alert("No results found for that place.");
            return;
          }

          const r = results[0];
          const lat = parseFloat(r.lat);
          const lon = parseFloat(r.lon);

          state.lat = lat;
          state.lon = lon;

          const name = r.display_name.split(",")[0];
          const coordsText = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;

          setLocationDisplay({
            labelMain: name,
            labelDetail: "Location chosen via search.",
            sourceLabel: "Manual search",
            sourceKind: "search",
            coordsText,
            shortLabel: name
          });

          // Derive a simple place context from the Nominatim result
          const category = r.category || r.class || "";
          const type = r.type || "";
          const importance = typeof r.importance === "number"
            ? r.importance
            : parseFloat(r.importance || "0");

          let placeContext = null;

          if (category === "place" && (type === "city" || type === "town")) {
            if (importance && importance > 0.7) {
              placeContext = "large-settlement";
            } else {
              placeContext = "settlement";
            }
          } else if (
            category === "place" &&
            (type === "village" || type === "hamlet" || type === "suburb")
          ) {
            placeContext = "settlement";
          } else if (
            category === "natural" ||
            category === "leisure" ||
            category === "boundary"
          ) {
            if (
              type === "desert" ||
              type === "nature_reserve" ||
              type === "national_park" ||
              type === "forest" ||
              type === "heath" ||
              type === "moor" ||
              type === "peak" ||
              type === "mountain"
            ) {
              placeContext = "dark-nature";
            }
          }

          updateLightPollution(lat, lon, { placeContext });
          refreshDarknessFromSunriseSunset(lat, lon);
          refreshWeather(lat, lon);
        })
        .catch((err) => {
          console.error("Search failed", err);
          alert("Search failed – please try again or use GPS / IP.");
        })
        .finally(() => {
          searchButtonEl.disabled = false;
        });
    }

    function handleLpModeClick(e) {
      const btn = e.target.closest(".lp-mode-btn");
      if (!btn) return;

      const mode = btn.getAttribute("data-mode");
      if (!mode || !["auto", "dark", "suburban", "urban"].includes(mode)) return;

      state.lpMode = mode;

      // Update button active styles
      const buttons = lpModeOptionsEl.querySelectorAll(".lp-mode-btn");
      buttons.forEach((b) => {
        if (b === btn) {
          b.classList.add("lp-mode-btn-active");
        } else {
          b.classList.remove("lp-mode-btn-active");
        }
      });

      let norm;
      if (mode === "auto") {
        norm = state.autoLightPollution;
        state.lightPollution = norm;
        lpModeHintEl.textContent =
          "Auto is a rough guess from your location or a grid-based model. Adjust if you know your local sky.";
      } else if (mode === "dark") {
        norm = 0.2;
        state.lightPollution = norm;
        lpModeHintEl.textContent =
          "Using your chosen sky brightness: dark rural skies.";
      } else if (mode === "suburban") {
        norm = 0.5;
        state.lightPollution = norm;
        lpModeHintEl.textContent =
          "Using your chosen sky brightness: typical suburban or small-town skies.";
      } else if (mode === "urban") {
        norm = 0.85;
        state.lightPollution = norm;
        lpModeHintEl.textContent =
          "Using your chosen sky brightness: bright city or town-centre skies.";
      }

      if (typeof norm === "number") {
        const manualResult = {
          normalized: norm,
          classification: LightPollution.classifyLightPollutionValue(norm)
        };
        renderLightPollutionBadge(manualResult);
      }

      recomputeAurora();
    }
    
    function init() {
      updateFooterTime();
      updateCloudsUI();
      initKpLiveMode();
      initAuroraOvalLive();

      kpInputEl.addEventListener("input", onKpChange);

      gpsButtonEl.addEventListener("click", () => {
        initLocationViaGps();
      });
  
      searchButtonEl.addEventListener("click", () => {
        const q = searchInputEl.value.trim();
        if (!q) return;
        geocodeSearch(q);
      });

      searchInputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const q = searchInputEl.value.trim();
          if (!q) return;
          geocodeSearch(q);
        }
      });

      if (lpModeOptionsEl) {
        lpModeOptionsEl.addEventListener("click", handleLpModeClick);
      }

      // Default flow is GPS → IP → Isle of Rùm
      initLocationViaGps();
      onKpChange();
    }

    init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();
/**
 * Register service worker for PWA installability and offline support.
 * This runs after the main Aurora Now app has initialised.
 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("service-worker.js")
      .catch((err) => {
        console.warn("Service worker registration failed:", err);
      });
  });
}
