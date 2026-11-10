import { dbReady, pipeline } from "./_db.js";
import { avisar } from "./_push.js";

// Resumo da manhã (a Vercel chama todo dia ~7h de Cumuruxatiba, ver "crons" no vercel.json).
// Roda no máximo uma vez por dia, mesmo se for chamado de novo.
const today = () => new Date(Date.now() - 3 * 36e5).toISOString().slice(0, 10);
const add = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const br = (d) => d.slice(8, 10) + "/" + d.slice(5, 7);
const first = (n) => String(n || "").trim().split(/\s+/)[0];
const WK = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!dbReady()) return res.status(200).json({ ok: false, motivo: "sem banco" });
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ ok: false });
  const t = today();
  const [lock] = await pipeline([["SET", `inga:g:resumo:${t}`, "1", "NX", "EX", 60 * 60 * 30]]);
  if (lock !== "OK") return res.status(200).json({ ok: true, motivo: "já enviado hoje" });

  const [rooms, resv, leadIds] = await pipeline([["GET", "inga:g:rooms"], ["HGETALL", "inga:g:res"], ["ZREVRANGE", "inga:leads", 0, 99]]);
  let nq = 7;
  try { nq = (JSON.parse(rooms) || []).length || 7; } catch {}
  const R = [];
  if (Array.isArray(resv)) for (let i = 1; i < resv.length; i += 2) { try { const r = JSON.parse(resv[i]); if (r.status !== "cancelada") R.push(r); } catch {} }
  let pedidos = 0;
  if (Array.isArray(leadIds) && leadIds.length) {
    const lr = await pipeline(leadIds.map((id) => ["HMGET", `inga:lead:${id}`, "name", "phone", "reserva", "descartado"]));
    pedidos = lr.filter((a) => Array.isArray(a) && (a[0] || a[1]) && !a[2] && !a[3]).length;
  }
  const saldo = (r) => Math.max(0, (+r.valor || 0) - (+r.pago || 0));
  const chegam = R.filter((r) => r.entrada === t && r.status !== "saiu");
  const saem = R.filter((r) => r.saida === t && (r.status === "hospedado" || r.status === "confirmada"));
  const ocup = R.filter((r) => r.entrada <= t && r.saida > t && r.status !== "saiu").length;
  const paradas = R.filter((r) => r.status === "pre" && r.entrada >= t && Date.now() - (r.criadoEm || 0) > 2 * 864e5).length;
  const cobrar = saem.filter((r) => saldo(r) > 0).reduce((s, r) => s + saldo(r), 0);

  const linhas = [];
  linhas.push(chegam.length ? `🛎️ Chegam: ${chegam.map((r) => first(r.nome)).join(", ")}` : "🛎️ Ninguém chega hoje");
  if (saem.length) linhas.push(`🧳 Saem: ${saem.map((r) => first(r.nome)).join(", ")}${cobrar ? ` (cobrar R$ ${cobrar.toLocaleString("pt-BR")})` : ""}`);
  linhas.push(`🛏️ ${ocup} de ${nq} quartos ocupados`);
  if (pedidos) linhas.push(`📥 ${pedidos} pedido${pedidos > 1 ? "s" : ""} do site esperando resposta`);
  if (paradas) linhas.push(`⏳ ${paradas} pré-reserva${paradas > 1 ? "s" : ""} sem confirmar há mais de 2 dias`);

  // Dica inteligente: próximo fim de semana com muitos quartos livres
  let dica = "";
  for (let i = 1; i <= 10; i++) {
    const d = add(t, i), w = new Date(d + "T12:00:00Z").getUTCDay();
    if (w !== 5 && w !== 6) continue;
    const livres = nq - R.filter((r) => r.entrada <= d && r.saida > d).length;
    if (livres >= Math.ceil(nq / 2)) { dica = `💡 ${WK[w]} (${br(d)}) ainda tem ${livres} quartos livres. Que tal um post ou promoção?`; break; }
  }
  if (dica) linhas.push(dica);

  const r = await avisar("resumo", { title: "Bom dia! O dia na Ingá ☀️", body: linhas.join("\n"), url: "/gestao#hoje", tag: "resumo-" + t });
  return res.status(200).json({ ok: true, ...r });
}
