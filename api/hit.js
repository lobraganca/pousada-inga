import { dbReady, pipeline, dayKey } from "./_db.js";

const EVENTS = new Set(["view", "whatsapp", "reserva", "voos", "rota", "tour360"]);
const TTL = 60 * 60 * 24 * 400; // guarda cada dia por ~13 meses

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
    if (/bot|crawler|spider|preview|facebookexternalhit|whatsapp/i.test(ua)) return res.status(204).end();

    const day = dayKey();
    const cmds = [
      ["HINCRBY", `inga:total`, ev, 1],
      ["HINCRBY", `inga:day:${day}`, ev, 1],
      ["EXPIRE", `inga:day:${day}`, TTL],
    ];
    if (ev === "view") {
      cmds.push(["PFADD", `inga:uniq:${day}`, vid], ["EXPIRE", `inga:uniq:${day}`, TTL], ["PFADD", "inga:uniq:all", vid]);
      const mobile = /Mobi|Android|iPhone/i.test(ua) ? "celular" : "computador";
      cmds.push(["HINCRBY", "inga:device", mobile, 1]);
      const ref = String(body?.r || "").replace(/^www\./, "").slice(0, 60);
      const src = !ref ? "direto" : /instagram/.test(ref) ? "instagram" : /facebook|fb\./.test(ref) ? "facebook" : /google/.test(ref) ? "google" : /whatsapp|wa\.me/.test(ref) ? "whatsapp" : ref.includes("vercel.app") || ref.includes("pousada") ? null : ref;
      if (src) cmds.push(["HINCRBY", "inga:src", src, 1]);
    }
    await pipeline(cmds);
    return res.status(204).end();
  } catch (e) {
    return res.status(204).end();
  }
}
