import { dbReady, pipeline } from "./_db.js";

// Guarda pedidos de reserva começados no site (nome/WhatsApp), para a pousada poder retornar.
const TTL = 60 * 60 * 24 * 120; // 120 dias
const clean = (v, n) => String(v ?? "").replace(/[<>]/g, "").trim().slice(0, n);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  if (!dbReady()) return res.status(204).end();
  try {
    let b = req.body;
    if (typeof b === "string") b = JSON.parse(b || "{}");
    const id = clean(b.id, 40).replace(/[^\w-]/g, "");
    const name = clean(b.name, 80), phone = clean(b.phone, 20).replace(/\D/g, "");
    if (!id || (!name && !phone)) return res.status(204).end();
    const key = `inga:lead:${id}`;
    const now = Date.now();
    const city = (() => { try { return decodeURIComponent(String(req.headers["x-vercel-ip-city"] || "")); } catch { return ""; } })();
    const fields = {
      id, name, phone, cidadeInformada: clean(b.city, 60), cidadeAprox: clean(city, 60), estadoAprox: clean(req.headers["x-vercel-ip-country-region"], 10),
      start: clean(b.start, 10), end: clean(b.end, 10), ad: clean(b.ad, 2), ch: clean(b.ch, 2), pet: b.pet ? "sim" : "não",
      room: clean(b.room, 40), rooms: clean(b.rooms, 2), occ: clean(b.occ, 120), obs: clean(b.obs, 300), step: clean(b.step, 1), lang: clean(b.lang, 2), atualizado: String(now),
    };
    const cmds = [["HSET", key, ...Object.entries(fields).flat()], ["HSETNX", key, "criado", String(now)], ["EXPIRE", key, TTL], ["ZADD", "inga:leads", now, id]];
    if (b.sent) cmds.push(["HSET", key, "enviado", "sim"]);
    await pipeline(cmds);
    return res.status(204).end();
  } catch {
    return res.status(204).end();
  }
}
