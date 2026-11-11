import { dbReady, pipeline } from "./_db.js";

// Disponibilidade pública para o calendário do site: só datas, nenhum dado de hóspede.
// "cheio": noites em que todos os quartos estão ocupados.
// "tipos": noites em que não sobra nenhum quarto daquele tipo (Casa na Árvore, Duplo, Triplo, Quádruplo).
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const add = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=120, stale-while-revalidate=300");
  const vazio = { cheio: [], tipos: { arvore: [], duplo: [], triplo: [], quadruplo: [] } };
  if (!dbReady()) return res.status(200).json(vazio);
  try {
    const [rooms, resv] = await pipeline([["GET", "inga:g:rooms"], ["HGETALL", "inga:g:res"]]);
    let Q = null;
    try { Q = JSON.parse(rooms); } catch {}
    if (!Array.isArray(Q) || !Q.length) Q = [{ id: "r1", nome: "Casa na Árvore" }, { id: "r2", nome: "Duplo 1" }, { id: "r3", nome: "Duplo 2" }, { id: "r4", nome: "Duplo 3" }, { id: "r5", nome: "Triplo 1" }, { id: "r6", nome: "Triplo 2" }, { id: "r7", nome: "Triplo 3" }];
    const tipo = (q) => (norm(q.nome).includes("arvore") ? "arvore" : norm(q.nome).includes("quadruplo") ? "quadruplo" : norm(q.nome).includes("triplo") ? "triplo" : norm(q.nome).includes("duplo") ? "duplo" : "outro");
    const hoje = new Date(Date.now() - 3 * 36e5).toISOString().slice(0, 10), fim = add(hoje, 420);
    const occ = new Map(); // data -> Set(quarto)
    if (Array.isArray(resv)) for (let i = 1; i < resv.length; i += 2) {
      let r; try { r = JSON.parse(resv[i]); } catch { continue; }
      if (!r || r.status === "cancelada" || r.saida <= hoje || r.entrada >= fim) continue;
      for (let d = r.entrada < hoje ? hoje : r.entrada; d < r.saida && d < fim; d = add(d, 1)) { if (!occ.has(d)) occ.set(d, new Set()); occ.get(d).add(r.quarto); }
    }
    const out = { cheio: [], tipos: { arvore: [], duplo: [], triplo: [], quadruplo: [] } };
    const porTipo = {};
    Q.forEach((q) => { const t = tipo(q); (porTipo[t] = porTipo[t] || []).push(q.id); });
    for (const [d, set] of [...occ.entries()].sort()) {
      if (Q.every((q) => set.has(q.id))) out.cheio.push(d);
      for (const t of ["arvore", "duplo", "triplo", "quadruplo"]) if (porTipo[t] && porTipo[t].every((id) => set.has(id))) out.tipos[t].push(d);
    }
    return res.status(200).json(out);
  } catch {
    return res.status(200).json(vazio);
  }
}
