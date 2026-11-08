import crypto from "node:crypto";
import { dbReady, dbMissing, pipeline, dayKey } from "./_db.js";

// Login e senha ficam nas variáveis ADMIN_USER e ADMIN_PASS da Vercel (nunca no código).
function same(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const tries = new Map();
const toObj = (a, raw) => { const o = {}; if (Array.isArray(a)) for (let i = 0; i < a.length; i += 2) o[a[i]] = raw ? a[i + 1] : (+a[i + 1] || 0); else if (a) Object.assign(o, a); return o; };
const sumInto = (acc, o) => { for (const [k, v] of Object.entries(o)) acc[k] = (acc[k] || 0) + (+v || 0); return acc; };
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));

export default async function handler(req, res) {
  try { return await main(req, res); }
  catch (e) { return res.status(500).json({ erro: String((e && e.message) || e) }); }
}

async function main(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ erro: "Use POST" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0] || "?";
  const t = tries.get(ip) || { n: 0, at: 0 };
  if (t.n >= 8 && Date.now() - t.at < 10 * 60e3) return res.status(429).json({ erro: "Muitas tentativas. Espere 10 minutos." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const U = process.env.ADMIN_USER, P = process.env.ADMIN_PASS;
  if (!U || !P) return res.status(503).json({ erro: "Login ainda não configurado na Vercel (ADMIN_USER e ADMIN_PASS)." });
  if (!same(body?.user || "", U) || !same(body?.pass || "", P)) {
    tries.set(ip, { n: t.n + 1, at: Date.now() });
    return res.status(401).json({ erro: "Login ou senha incorretos." });
  }
  tries.delete(ip);
  if (!dbReady()) return res.status(503).json({ erro: `O banco do contador ainda não foi conectado na Vercel. Falta: ${dbMissing()}.` });

  // ações sobre pedidos
  if (body.acao === "contatado" && body.id) {
    const id = String(body.id).replace(/[^\w-]/g, "").slice(0, 40);
    await pipeline([["HSET", `inga:lead:${id}`, "contatado", body.valor ? String(Date.now()) : ""]]);
    return res.status(200).json({ ok: true });
  }
  if (body.acao === "apagar" && body.id) {
    const id = String(body.id).replace(/[^\w-]/g, "").slice(0, 40);
    await pipeline([["DEL", `inga:lead:${id}`], ["ZREM", "inga:leads", id]]);
    return res.status(200).json({ ok: true });
  }

  // período
  let to = isDay(body.ate) ? body.ate : dayKey();
  let from = isDay(body.de) ? body.de : dayKey(new Date(Date.now() - 29 * 864e5));
  if (from > to) [from, to] = [to, from];
  const days = [];
  for (let d = new Date(from + "T12:00:00Z"); d <= new Date(to + "T12:00:00Z") && days.length < 400; d = new Date(d.getTime() + 864e5)) days.push(d.toISOString().slice(0, 10));

  const per = ["day", "dev", "src", "pais", "estado", "cidade", "ret"];
  const cmds = [["PFCOUNT", "inga:uniq:all"], ["PFCOUNT", ...days.map((d) => `inga:uniq:${d}`)]];
  days.forEach((d) => { cmds.push(["PFCOUNT", `inga:uniq:${d}`]); per.forEach((p) => cmds.push(["HGETALL", `inga:${p}:${d}`])); });
  cmds.push(["ZREVRANGE", "inga:leads", 0, 199]);
  const r = await pipeline(cmds);

  const out = { de: from, ate: to, pessoasTotal: +r[0] || 0, pessoasPeriodo: +r[1] || 0, dias: [], dispositivo: {}, origem: {}, pais: {}, estado: {}, cidade: {}, retorno: {} };
  let i = 2;
  for (const d of days) {
    const pessoas = +r[i++] || 0;
    const parts = per.map(() => toObj(r[i++]));
    out.dias.push({ dia: d, pessoas, ...parts[0] });
    sumInto(out.dispositivo, parts[1]); sumInto(out.origem, parts[2]); sumInto(out.pais, parts[3]);
    sumInto(out.estado, parts[4]); sumInto(out.cidade, parts[5]); sumInto(out.retorno, parts[6]);
  }
  const ids = r[i] || [];
  let leads = [];
  if (ids.length) {
    const lr = await pipeline(ids.map((id) => ["HGETALL", `inga:lead:${id}`]));
    leads = lr.map((x) => toObj(x, true)).filter((l) => l.id && (l.name || l.phone));
  }
  out.pedidos = leads;
  out.agora = new Date().toISOString();
  return res.status(200).json(out);
}
