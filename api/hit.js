import { dbReady, pipeline, dayKey, V } from "./_db.js";

const EVENTS = new Set(["view", "whatsapp", "reserva", "voos", "rota", "tour360"]);
const TTL = 60 * 60 * 24 * 400; // guarda cada dia por ~13 meses
const dec = (v) => { try { return decodeURIComponent(String(v || "")).slice(0, 60); } catch { return String(v || "").slice(0, 60); } };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  if (!dbReady()) return res.status(204).end();
  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    const ev = EVENTS.has(body?.e) ? body.e : null;
    const vid = String(body?.v || "").slice(0, 64);
    if (!ev || !vid) return res.status(400).end();
    const ua = String(req.headers["user-agent"] || "");
    if (/bot|crawl|spider|preview|facebookexternalhit|whatsapp|headless|lighthouse|screenshot|puppeteer|playwright|phantom|selenium|python|curl|wget|node-fetch|axios|go-http|vercel|slack|telegram|discord|skype|linkedin|pinterest|embedly|google-inspectiontool|chrome-lighthouse/i.test(ua) || !ua) return res.status(204).end();

    const day = dayKey();
    const k = (name) => `${V}${name}:${day}`;
    const cmds = [["HINCRBY", `${V}total`, ev, 1], ["HINCRBY", `${V}day:${day}`, ev, 1], ["EXPIRE", `${V}day:${day}`, TTL]];
    if (ev === "view") {
      cmds.push(["PFADD", `${V}uniq:${day}`, vid], ["EXPIRE", `${V}uniq:${day}`, TTL], ["PFADD", `${V}uniq:all`, vid]);
      const device = /Mobi|Android|iPhone/i.test(ua) ? "celular" : "computador";
      const ref = String(body?.r || "").replace(/^www\./, "").slice(0, 60);
      const src = !ref ? "direto" : /instagram|linktr/.test(ref) ? "instagram" : /facebook|fb\./.test(ref) ? "facebook" : /google/.test(ref) ? "google" : /whatsapp|wa\.me/.test(ref) ? "whatsapp" : /booking/.test(ref) ? "booking" : /tripadvisor/.test(ref) ? "tripadvisor" : ref.includes("vercel.app") || ref.includes("pousada") ? null : ref;
      // localização aproximada que a Vercel informa (cidade, estado, país) — sem guardar IP
      const city = dec(req.headers["x-vercel-ip-city"]);
      const region = dec(req.headers["x-vercel-ip-country-region"]);
      const country = dec(req.headers["x-vercel-ip-country"]);
      const add = (name, field) => { if (field) cmds.push(["HINCRBY", k(name), field, 1], ["EXPIRE", k(name), TTL]); };
      add("dev", device);
      if (src) add("src", src);
      if (country) add("pais", country);
      if (region && country) add("estado", `${region}|${country}`);
      if (city) add("cidade", `${city}|${region}|${country}`);
      // novo ou de volta
      cmds.push(["SADD", `${V}seen`, vid]);
    }
    const r = await pipeline(cmds);
    if (ev === "view") {
      const added = r[r.length - 1];
      await pipeline([["HINCRBY", `${V}ret:${day}`, added ? "novos" : "voltaram", 1], ["EXPIRE", `${V}ret:${day}`, TTL]]);
    }
    return res.status(204).end();
  } catch (e) {
    return res.status(204).end();
  }
}
