import crypto from "node:crypto";
import { dbReady, pipeline, dayKey } from "./_db.js";

// Login e senha ficam nas variáveis ADMIN_USER e ADMIN_PASS da Vercel (nunca no código).
function same(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const tries = new Map();

export default async function handler(req, res) {
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
  if (!dbReady()) return res.status(503).json({ erro: "O banco do contador ainda não foi conectado na Vercel." });

  const days = [];
  for (let i = 29; i >= 0; i--) days.push(dayKey(new Date(Date.now() - i * 864e5)));
  const cmds = [["HGETALL", "inga:total"], ["PFCOUNT", "inga:uniq:all"], ["HGETALL", "inga:device"], ["HGETALL", "inga:src"]];
  days.forEach((d) => cmds.push(["HGETALL", `inga:day:${d}`], ["PFCOUNT", `inga:uniq:${d}`]));
  const r = await pipeline(cmds);
  const toObj = (a) => { const o = {}; if (Array.isArray(a)) for (let i = 0; i < a.length; i += 2) o[a[i]] = +a[i + 1]; else if (a) Object.assign(o, a); return o; };
  const series = days.map((d, i) => ({ dia: d, ...toObj(r[4 + i * 2]), pessoas: +r[5 + i * 2] || 0 }));
  return res.status(200).json({
    total: toObj(r[0]),
    pessoasTotal: +r[1] || 0,
    dispositivo: toObj(r[2]),
    origem: toObj(r[3]),
    dias: series,
    agora: new Date().toISOString(),
  });
}
