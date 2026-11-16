// ISPU / AQMS basemap overlay: renders transparent 256x256 PNG tiles ({z}/{x}/{y})
// whose colour field comes from station readings.
//
//   import basemap from "./basemap.js";
//   app.register(basemap, { prefix: "/api/basemap" });
//   // -> GET /api/basemap/{z}/{x}/{y}.png
//
// Stations are read from this same app's `/api/measurements/now` (via app.inject,
// no network hop) and refreshed at most once per `ttlMs`.

import { createHash } from "node:crypto";
import { PNG } from "pngjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MILE = 1609.344; // metres


// Colour blending between neighbouring stations (distances in units of the fade band, measured from the core edge)
const RENDER_VERSION = 4; // bump when the picture changes, so browsers drop their cached tiles

const TILE = 256;
const EARTH_R = 6371008.8;
const MAX_LAT = 85.0511287798;
const MAX_ZOOM = 22;

// ISPU categories (Permen LHK P.14/2020)
const GREEN = [46, 204, 64];
const BLUE = [41, 121, 255];
const YELLOW = [255, 214, 0];
const RED = [229, 57, 53];
const BLACK = [20, 20, 20];

const ISPU_BANDS = [
  { max: 50, rgb: GREEN }, //      1-50   Baik
  { max: 100, rgb: BLUE }, //     51-100  Sedang
  { max: 200, rgb: YELLOW }, //  101-200  Tidak Sehat
  { max: 300, rgb: RED }, //     201-300  Sangat Tidak Sehat
  { max: Infinity, rgb: BLACK }, // 301+   Berbahaya
];

export const ispuToRgb = (v) => ISPU_BANDS.find((b) => v <= b.max).rgb;

const DEFAULTS = {
  coreMiles: 1, //                   solid colour (the ISPU is "valid") within this radius of a station
  transparentMiles: 2, //            fully transparent from this radius on; the gradient lives in between
  source: "/api/measurements/now", // endpoint (on this app) that supplies the stations
  ttlMs: 60_000, //                  how long loaded stations are reused
  cacheMax: 2000, //                 rendered tiles kept in memory
  maxAlpha: 0.7, //                  overlay opacity, 0..1
  minRadiusPx: 0, //                 keep stations at least this wide at low zoom (0 = off)
  allowOrigin: "*", //               Access-Control-Allow-Origin for tiles; false = leave headers to the app
  blend: "srgb", //                  colour space used to mix neighbouring stations: "srgb" (softest) | "oklab" (more vivid midpoints)
};

// ---------------------------------------------------------------------------
// Colour helpers (OKLab is optional: vivid midpoints, e.g. a teal strip between green and blue)
// ---------------------------------------------------------------------------
const toLinear = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklab([r8, g8, b8]) {
  const r = toLinear(r8);
  const g = toLinear(g8);
  const b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab -> sRGB in 0..255 floats (not rounded, so the caller can dither). */
function oklabToRgb(L, a, b, out) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  out[0] = 255 * Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, r)))));
  out[1] = 255 * Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, g)))));
  out[2] = 255 * Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, bl)))));
}

/** Per-pixel noise in [-0.5, 0.5) from world pixel coords (identical across tile borders). */
const dither = (wx, wy) => {
  const v = 52.9829189 * ((0.06711056 * wx + 0.00583715 * wy) % 1);
  return (v % 1) - 0.5;
};

// ---------------------------------------------------------------------------
// Station data
// ---------------------------------------------------------------------------

/**
 * `/api/measurements/now` rows -> render markers. Latest reading per station wins;
 * rows without a valid position or ispu_index are skipped.
 * @param {Array<{station_uuid:string, lat_long:[number,number], ispu_index:number|null, datetime?:string}>} rows
 */
export function measurementsToMarkers(rows) {
  const latest = new Map();
  for (const r of rows ?? []) {
    const [lat, lon] = Array.isArray(r?.lat_long) ? r.lat_long.map(Number) : [];
    const ispu = r?.ispu_index == null ? NaN : Number(r.ispu_index);
    if (!Number.isFinite(ispu) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > MAX_LAT || Math.abs(lon) > 180) continue;
    const id = r.station_uuid ?? `${lat},${lon}`;
    const t = Date.parse(r.datetime) || 0;
    const prev = latest.get(id);
    if (!prev || t >= prev.t) latest.set(id, { t, id, lat, lon, ispu });
  }
  return [...latest.values()].map(({ id, lat, lon, ispu }) => ({ id, lat, lon, ispu }));
}

/** Pre-compute what the renderer needs per marker. */
function prepare(markers, blend) {
  return markers.map((m) => {
    const latR = (m.lat * Math.PI) / 180;
    const rgb = m.rgb ?? ispuToRgb(m.ispu);
    return {
      mix: blend === "srgb" ? rgb : rgbToOklab(rgb), // the 3 numbers that get weight-averaged
      latR,
      lonR: (m.lon * Math.PI) / 180,
      cosLat: Math.cos(latR),
    };
  });
}

/** Short fingerprint of the marker set: changes only when the picture would. */
function fingerprint(markers) {
  const h = createHash("sha1");
  h.update(`v${RENDER_VERSION};`);
  for (const m of [...markers].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    h.update(`${m.id}|${m.lat}|${m.lon}|${ispuToRgb(m.ispu).join(",")};`);
  }
  return h.digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Tile rendering
// ---------------------------------------------------------------------------
const mercLat = (fy) => Math.atan(Math.sinh(Math.PI * (1 - 2 * fy))); // fy: 0 (top) .. 1 (bottom)

const EMPTY_TILE = PNG.sync.write(new PNG({ width: TILE, height: TILE }), { deflateLevel: 9 });

const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10); // C2: no visible edge where the fade starts/ends

/**
 * Render a continuous heatmap using compact Gaussian radial-basis weights.
 *
 * Colour and opacity use the same smooth spatial kernel. This avoids distinct
 * solid circles around stations and lets nearby stations form one continuous
 * colour field. coreMiles defines a small flat area around each station;
 * influence then falls smoothly to zero at transparentMiles.
 *
 * @param {Array<{lat:number, lon:number, ispu?:number, rgb?:number[]}>} markers
 * @returns {Buffer} PNG
 */
export function renderTile(markers, z, x, y, options = {}) {
  const { maxAlpha, minRadiusPx, blend, coreMiles, transparentMiles } =
    { ...DEFAULTS, ...options };

  if (!markers.length) return EMPTY_TILE;

  const ms = prepare(markers, blend);
  const worldPx = TILE * 2 ** z;
  const x0 = x * TILE;
  const y0 = y * TILE;

  const latTop = mercLat(y0 / worldPx);
  const latBot = mercLat((y0 + TILE) / worldPx);
  const lonW = (x0 / worldPx) * 2 * Math.PI - Math.PI;
  const lonE = ((x0 + TILE) / worldPx) * 2 * Math.PI - Math.PI;

  const mpp =
    (Math.cos(mercLat((y0 + TILE / 2) / worldPx)) * 2 * Math.PI * EARTH_R) /
    worldPx;

  const core = Math.max(coreMiles * MILE, minRadiusPx * mpp);
  const outer = Math.max(transparentMiles * MILE, core + 1);
  const fade = outer - core;

  // Include every station whose influence can reach this tile.
  const reachFilter = (reach) => {
    const dLat = reach / EARTH_R;
    const worstLat = Math.min(
      Math.max(Math.abs(latTop), Math.abs(latBot)) + dLat,
      1.5,
    );
    const dLon = dLat / Math.max(0.01, Math.cos(worstLat));

    return (m) =>
      m.latR >= latBot - dLat &&
      m.latR <= latTop + dLat &&
      m.lonR >= lonW - dLon &&
      m.lonR <= lonE + dLon;
  };

  const near = ms.filter(reachFilter(outer));
  if (!near.length) return EMPTY_TILE;

  const n = near.length;
  const colTerm = near.map((m) => {
    const arr = new Float64Array(TILE);
    for (let px = 0; px < TILE; px++) {
      const lon = ((x0 + px + 0.5) / worldPx) * 2 * Math.PI - Math.PI;
      const sin = Math.sin((lon - m.lonR) / 2);
      arr[px] = sin * sin;
    }
    return arr;
  });

  const rowTerm = new Float64Array(n);
  const rowCos = new Float64Array(n);
  const png = new PNG({ width: TILE, height: TILE });
  const buf = png.data;
  const k = 2 * EARTH_R;
  const alphaScale = 255 * maxAlpha;
  const useLab = blend !== "srgb";
  const rgbOut = [0, 0, 0];

  for (let py = 0; py < TILE; py++) {
    const lat = mercLat((y0 + py + 0.5) / worldPx);
    const cosLat = Math.cos(lat);

    for (let i = 0; i < n; i++) {
      const sin = Math.sin((lat - near[i].latR) / 2);
      rowTerm[i] = sin * sin;
      rowCos[i] = cosLat * near[i].cosLat;
    }

    for (let px = 0; px < TILE; px++) {
      let weightSum = 0;
      let density = 0;
      let c0 = 0;
      let c1 = 0;
      let c2 = 0;

      for (let i = 0; i < n; i++) {
        let hav = rowTerm[i] + rowCos[i] * colTerm[i][px];
        hav = Math.min(1, Math.max(0, hav));

        const distance = k * Math.asin(Math.sqrt(hav));
        if (distance >= outer) continue;

        // Flat at the station core, then a Gaussian spatial falloff.
        const t = Math.max(0, (distance - core) / fade);
        const gaussian = Math.exp(-3.5 * t * t);
        const edgeFade = smootherstep(1 - t);
        const weight = gaussian * edgeFade;
        if (weight <= 1e-8) continue;

        density += weight;
        weightSum += weight;

        const color = near[i].mix;
        c0 += weight * color[0];
        c1 += weight * color[1];
        c2 += weight * color[2];
      }

      if (weightSum <= 0) continue;

      const o = (py * TILE + px) * 4;
      const alpha = 1 - Math.exp(-3 * density);

      if (useLab) {
        oklabToRgb(c0 / weightSum, c1 / weightSum, c2 / weightSum, rgbOut);
      } else {
        rgbOut[0] = c0 / weightSum;
        rgbOut[1] = c1 / weightSum;
        rgbOut[2] = c2 / weightSum;
      }

      // World-pixel dithering is stable across adjacent tile boundaries.
      const wx = x0 + px;
      const wy = y0 + py;
      const d = dither(wx, wy);

      buf[o] = Math.round(rgbOut[0] + d);
      buf[o + 1] = Math.round(rgbOut[1] + d);
      buf[o + 2] = Math.round(rgbOut[2] + d);
      buf[o + 3] = Math.round(alpha * alphaScale + dither(wy + 31, wx + 17));
    }
  }

  return PNG.sync.write(png, { deflateLevel: 3 });
}

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

/**
 * @param {import("fastify").FastifyInstance} app
 * @param {object} [opts]
 * @param {string} [opts.source]      URL on this app that returns `{ data: [...] }` (default `/api/measurements/now`)
 * @param {() => Promise<object[]>} [opts.loadRows]  override: return measurement rows directly (tests)
 * @param {number} [opts.ttlMs]       reuse loaded stations this long (default 60000)
 * @param {number} [opts.cacheMax]    max rendered tiles kept (default 2000)
 * @param {number} [opts.coreMiles]  radius with solid colour, in miles (default 1)
 * @param {number} [opts.transparentMiles] radius where the overlay is fully transparent, in miles (default 2; must be > coreMiles)
 * @param {number} [opts.maxAlpha]    overlay opacity 0..1 (default 0.7)
 * @param {number} [opts.minRadiusPx] minimum on-screen station size at low zoom (default 0)
 * @param {string|false} [opts.allowOrigin] CORS origin sent on tile routes (default "*"; false = don't set CORS/CORP headers)
 * @param {"oklab"|"srgb"} [opts.blend] colour space for mixing neighbouring stations (default "srgb")
 */
export default async function basemap(app, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (!(cfg.coreMiles >= 0) || !(cfg.transparentMiles > cfg.coreMiles)) {
    throw new Error("basemap: transparentMiles must be greater than coreMiles");
  }

  const loadRows =
    opts.loadRows ??
    (async () => {
      const res = await app.inject({ method: "GET", url: cfg.source });
      if (res.statusCode !== 200) throw new Error(`${cfg.source} responded ${res.statusCode}`);
      return res.json().data;
    });

  /** @type {{markers: object[], version: string, at: number} | null} */
  let state = null;
  let loading = null;
  const tiles = new Map(); // "z/x/y" -> PNG (insertion order = LRU order); belongs to state.version

  async function refresh() {
    const markers = measurementsToMarkers(await loadRows());
    const version = fingerprint(markers);
    if (!state || state.version !== version) tiles.clear();
    state = { markers, version, at: Date.now() };
    return state;
  }

  async function getState() {
    if (state && Date.now() - state.at < cfg.ttlMs) return state;
    loading ??= refresh().finally(() => (loading = null)); // concurrent requests share one load
    try {
      return await loading;
    } catch (err) {
      if (state) {
        app.log.warn({ err }, "basemap: refresh failed, serving stale stations");
        state.at = Date.now() - cfg.ttlMs + 5_000; // retry in 5 s
        return state;
      }
      throw err;
    }
  }

  function getTile(st, z, x, y) {
    const key = `${z}/${x}/${y}`;
    let png = tiles.get(key);
    if (png) {
      tiles.delete(key);
      tiles.set(key, png);
      return png;
    }
    png = renderTile(st.markers, z, x, y, cfg);
    tiles.set(key, png);
    if (tiles.size > cfg.cacheMax) tiles.delete(tiles.keys().next().value);
    return png;
  }

  // Tiles are meant to be embedded by map pages on other origins (Leaflet, MapLibre...).
  // Runs after the app's own onRequest hooks (helmet, cors), so it wins over their defaults.
  if (cfg.allowOrigin) {
    const embeddable = async (request, reply) => {
      reply
        .header("Access-Control-Allow-Origin", cfg.allowOrigin) // needed when the layer uses crossOrigin: true
        .header("Cross-Origin-Resource-Policy", "cross-origin"); // helmet's default "same-origin" blocks <img> embeds
    };
    app.addHook("onRequest", embeddable);
    app.addHook("onSend", async (request, reply, payload) => {
      await embeddable(request, reply); // again, in case another plugin sets these in onSend
      return payload;
    });
  }

  // GET <prefix>/{z}/{x}/{y}.png
  app.get(
    "/:z/:x/:y.png",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            z: { type: "integer", minimum: 0, maximum: MAX_ZOOM },
            x: { type: "integer", minimum: 0 },
            y: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { z, x, y } = request.params;
      if (x >= 2 ** z || y >= 2 ** z) return reply.code(404).send();

      let st;
      try {
        st = await getState();
      } catch (err) {
        request.log.error({ err }, "basemap: cannot load stations");
        return reply.code(503).send({ error: "stations unavailable" });
      }

      const etag = `"${st.version}-${z}-${x}-${y}"`;
      reply.header("Cache-Control", "public, max-age=60").header("ETag", etag);
      if (request.headers["if-none-match"] === etag) return reply.code(304).send();
      return reply.type("image/png").send(getTile(st, z, x, y));
    },
  );
}