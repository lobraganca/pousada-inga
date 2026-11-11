import { dbReady, pipeline } from "./_db.js";
import { avisar } from "./_push.js";

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
      room: clean(b.room, 120), rooms: clean(b.rooms, 2), occ: clean(b.occ, 120), obs: clean(b.obs, 300), step: clean(b.step, 1), lang: clean(b.lang, 2), atualizado: String(now),
    };
    const cmds = [["HSET", key, ...Object.entries(fields).flat()], ["HSETNX", key, "criado", String(now)], ["EXPIRE", key, TTL], ["ZADD", "inga:leads", now, id]];
    if (b.sent) cmds.push(["HSET", key, "enviado", "sim"]);
    // avisa a equipe uma única vez, quando já dá para entrar em contato (tem WhatsApp) ou a pessoa enviou
    const pronto = name.length >= 2 && (phone.length >= 10 || b.sent);
    if (pronto) cmds.push(["HSETNX", key, "avisado", String(now)]);
    const r = await pipeline(cmds);
    if (pronto && r[r.length - 1] === 1) {
      const br = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(8, 10) + "/" + d.slice(5, 7) : "");
      const quando = fields.start ? ` · ${br(fields.start)}${fields.end ? " a " + br(fields.end) : ""}` : "";
      const pessoas = fields.ad ? ` · ${fields.ad} adulto${fields.ad === "1" ? "" : "s"}${+fields.ch ? " + " + fields.ch + " criança" + (fields.ch === "1" ? "" : "s") : ""}` : "";
      await avisar("pedidos", { title: `📥 Pedido no site: ${name}`, body: `${b.sent ? "Enviou no WhatsApp" : "Ainda não enviou — chame!"}${quando}${pessoas}`, url: "/gestao#pedidos", tag: "lead-" + id });
    }
    return res.status(204).end();
  } catch {
    return res.status(204).end();
  }
}
