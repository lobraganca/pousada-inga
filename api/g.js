import crypto from "node:crypto";
import { dbReady, dbMissing, pipeline } from "./_db.js";
import { vapid, salvarInscricao, lerInscricao, removerInscricao, avisar } from "./_push.js";

// Sistema de gestão de reservas (/gestao).
// A dona entra com ADMIN_USER/ADMIN_PASS (variáveis da Vercel) e cadastra a equipe.
// Tudo fica no mesmo banco Upstash, com chaves "inga:g:*".
const K = {
  users: "inga:g:users",       // hash login -> JSON {nome, papel, salt, hash}
  sess: (t) => `inga:g:sess:${t}`,
  rooms: "inga:g:rooms",       // string JSON [{id,nome,cap}]
  res: "inga:g:res",           // hash id -> JSON reserva
  log: "inga:g:log",           // lista de eventos
};
const SESS_TTL = 60 * 60 * 24 * 30;
const DEFAULT_ROOMS = [
  { id: "r1", nome: "Casa na Árvore", cap: 2 },
  { id: "r2", nome: "Duplo 1", cap: 2 },
  { id: "r3", nome: "Duplo 2", cap: 2 },
  { id: "r4", nome: "Duplo 3", cap: 2 },
  { id: "r5", nome: "Triplo 1", cap: 3 },
  { id: "r6", nome: "Triplo 2", cap: 3 },
  { id: "r7", nome: "Triplo 3", cap: 3 },
];
const STATUS = ["pre", "confirmada", "hospedado", "saiu", "cancelada"];
const ORIGENS = ["site", "whatsapp", "telefone", "booking", "airbnb", "balcao", "outro"];

const tries = new Map();
const same = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());
const txt = (v, n = 120) => String(v ?? "").replace(/[<>]/g, "").trim().slice(0, n);
const num = (v) => { const x = Math.round((parseFloat(String(v ?? "").replace(",", ".")) || 0) * 100) / 100; return x < 0 ? 0 : Math.min(x, 1e7); };
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const slug = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9._-]/g, "").slice(0, 30);
const overlap = (a, b) => a.quarto === b.quarto && a.entrada < b.saida && b.entrada < a.saida;
const active = (r) => r.status !== "cancelada";

class Err extends Error { constructor(code, msg) { super(msg); this.code = code; } }

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "POST") throw new Err(405, "Use POST");
    let b = req.body;
    if (typeof b === "string") b = J(b || "{}", {});
    b = b || {};
    if (!dbReady()) throw new Err(503, `O banco ainda não foi conectado na Vercel. Falta: ${dbMissing()}.`);
    if (b.acao === "entrar") return res.status(200).json(await entrar(req, b));
    const me = await quem(b.token);
    const out = await acao(me, b);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(e.code || 500).json({ erro: String(e.message || e) });
  }
}

async function entrar(req, b) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0] || "?";
  const t = tries.get(ip) || { n: 0, at: 0 };
  if (t.n >= 8 && Date.now() - t.at < 10 * 60e3) throw new Err(429, "Muitas tentativas. Espere 10 minutos.");
  const login = slug(b.login), pass = String(b.senha || "");
  let user = null;
  const U = process.env.ADMIN_USER, P = process.env.ADMIN_PASS;
  if (U && P && same(String(b.login || "").trim(), U) && same(pass, P)) user = { login: "dona", nome: txt(process.env.ADMIN_NAME, 40) || "Dona", papel: "admin" };
  if (!user && login) {
    const [raw] = await pipeline([["HGET", K.users, login]]);
    const u = J(raw, null);
    if (u && u.ativo !== false && same(hashPw(pass, u.salt), u.hash)) user = { login, nome: u.nome, papel: u.papel || "equipe" };
  }
  if (!user) { tries.set(ip, { n: t.n + 1, at: Date.now() }); throw new Err(401, "Login ou senha incorretos."); }
  tries.delete(ip);
  const token = crypto.randomBytes(24).toString("hex");
  await pipeline([["SET", K.sess(token), JSON.stringify(user), "EX", SESS_TTL]]);
  return { token, user };
}

async function quem(token) {
  token = String(token || "").replace(/[^a-f0-9]/g, "");
  if (!token) throw new Err(401, "Entre de novo.");
  const [raw] = await pipeline([["GET", K.sess(token)]]);
  const u = J(raw, null);
  if (!u) throw new Err(401, "Sua sessão terminou. Entre de novo.");
  u.token = token;
  return u;
}

async function carregar() {
  const [rooms, resv, leadIds, users] = await pipeline([["GET", K.rooms], ["HGETALL", K.res], ["ZREVRANGE", "inga:leads", 0, 99], ["HGETALL", K.users]]);
  const R = J(rooms, null) || DEFAULT_ROOMS;
  const reservas = [];
  if (Array.isArray(resv)) for (let i = 1; i < resv.length; i += 2) { const r = J(resv[i], null); if (r) reservas.push(r); }
  else if (resv && typeof resv === "object") for (const v of Object.values(resv)) { const r = J(v, null); if (r) reservas.push(r); }
  let pedidos = [];
  if (Array.isArray(leadIds) && leadIds.length) {
    const lr = await pipeline(leadIds.map((id) => ["HGETALL", `inga:lead:${id}`]));
    pedidos = lr.map((a) => { const o = {}; if (Array.isArray(a)) for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; else if (a) Object.assign(o, a); return o; })
      .filter((o) => o.id && (o.name || o.phone) && !o.reserva && !o.descartado);
  }
  const equipe = [];
  if (Array.isArray(users)) for (let i = 0; i < users.length; i += 2) { const u = J(users[i + 1], {}); equipe.push({ login: users[i], nome: u.nome, papel: u.papel, ativo: u.ativo !== false }); }
  return { quartos: R, reservas, pedidos, equipe };
}

function validar(r, todas) {
  if (!r.nome) throw new Err(400, "Escreva o nome do hóspede.");
  if (!isDay(r.entrada) || !isDay(r.saida)) throw new Err(400, "Escolha as datas de entrada e saída.");
  if (r.saida <= r.entrada) throw new Err(400, "A saída precisa ser depois da entrada.");
  if (active(r)) {
    const c = todas.find((x) => x.id !== r.id && active(x) && overlap(x, r));
    if (c) throw new Err(409, `Esse quarto já está reservado para ${c.nome} de ${br(c.entrada)} a ${br(c.saida)}.`);
  }
}
const br = (d) => d.split("-").reverse().join("/");

async function logar(me, o) {
  await pipeline([["LPUSH", K.log, JSON.stringify({ em: Date.now(), por: me.nome, ...o })], ["LTRIM", K.log, 0, 299]]);
}

async function acao(me, b) {
  const admin = me.papel === "admin";
  switch (b.acao) {
    case "dados": {
      const d = await carregar();
      const [log] = await pipeline([["LRANGE", K.log, 0, 39]]);
      return { me: { nome: me.nome, papel: me.papel, login: me.login }, ...d, equipe: admin ? d.equipe : [], log: (log || []).map((x) => J(x, null)).filter(Boolean), agora: Date.now() };
    }
    case "sair": {
      await pipeline([["DEL", K.sess(me.token)]]);
      return { ok: true };
    }
    case "salvar": {
      const x = b.reserva || {};
      const { quartos, reservas } = await carregar();
      const old = x.id ? reservas.find((r) => r.id === x.id) : null;
      const r = {
        id: old ? old.id : "R" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"),
        quarto: quartos.some((q) => q.id === x.quarto) ? x.quarto : quartos[0].id,
        nome: txt(x.nome, 80), tel: txt(x.tel, 20).replace(/\D/g, ""), cidade: txt(x.cidade, 60),
        entrada: txt(x.entrada, 10), saida: txt(x.saida, 10),
        adultos: Math.max(1, Math.min(9, parseInt(x.adultos) || 2)), criancas: Math.max(0, Math.min(9, parseInt(x.criancas) || 0)), pet: !!x.pet,
        origem: ORIGENS.includes(x.origem) ? x.origem : "whatsapp",
        status: STATUS.includes(x.status) ? x.status : "confirmada",
        valor: num(x.valor), pago: num(x.pago), obs: txt(x.obs, 600), lead: txt(x.lead, 40).replace(/[^\w-]/g, ""),
        criadoPor: old ? old.criadoPor : me.nome, criadoEm: old ? old.criadoEm : Date.now(),
        alteradoPor: me.nome, alteradoEm: Date.now(),
      };
      validar(r, reservas);
      const cmds = [["HSET", K.res, r.id, JSON.stringify(r)]];
      if (r.lead && !old) cmds.push(["HSET", `inga:lead:${r.lead}`, "reserva", r.id, "contatado", String(Date.now())]);
      await pipeline(cmds);
      await logar(me, { tipo: old ? "editou" : "criou", res: r.id, nome: r.nome, quarto: r.quarto, entrada: r.entrada, saida: r.saida, status: r.status });
      if (!old) {
        const qn = (quartos.find((q) => q.id === r.quarto) || {}).nome || "";
        const volta = r.tel && reservas.some((x) => x.tel === r.tel && x.status !== "cancelada") ? " · ↺ hóspede voltando" : "";
        await avisar("reservas", { title: `Nova reserva: ${r.nome}`, body: `${qn} · ${br(r.entrada)} a ${br(r.saida)} · lançada por ${me.nome}${volta}`, url: "/gestao#reservas", tag: "res-" + r.id }, { exceto: me.login });
      }
      return { ok: true, reserva: r };
    }
    case "status": {
      const { reservas } = await carregar();
      const r = reservas.find((x) => x.id === b.id);
      if (!r) throw new Err(404, "Reserva não encontrada.");
      if (!STATUS.includes(b.status)) throw new Err(400, "Situação inválida.");
      const n = { ...r, status: b.status, alteradoPor: me.nome, alteradoEm: Date.now() };
      if (b.status === "saiu" && b.quitar) n.pago = n.valor;
      validar(n, reservas);
      await pipeline([["HSET", K.res, r.id, JSON.stringify(n)]]);
      await logar(me, { tipo: b.status, res: r.id, nome: r.nome, quarto: r.quarto });
      if (b.status === "cancelada") await avisar("reservas", { title: `Reserva cancelada: ${r.nome}`, body: `${br(r.entrada)} a ${br(r.saida)} · o quarto ficou livre · por ${me.nome}`, url: "/gestao#mapa", tag: "res-" + r.id }, { exceto: me.login });
      return { ok: true, reserva: n };
    }
    case "pagamento": {
      const { reservas } = await carregar();
      const r = reservas.find((x) => x.id === b.id);
      if (!r) throw new Err(404, "Reserva não encontrada.");
      const v = num(b.valor);
      if (!v) throw new Err(400, "Informe o valor recebido.");
      const n = { ...r, pago: Math.min(r.valor || 1e9, num((r.pago || 0) + v)), alteradoPor: me.nome, alteradoEm: Date.now() };
      await pipeline([["HSET", K.res, r.id, JSON.stringify(n)]]);
      await logar(me, { tipo: "pagamento", res: r.id, nome: r.nome, valor: v });
      return { ok: true, reserva: n };
    }
    case "apagar": {
      if (!admin) throw new Err(403, "Só a administradora pode apagar reservas. Use “Cancelar”.");
      const { reservas } = await carregar();
      const r = reservas.find((x) => x.id === b.id);
      await pipeline([["HDEL", K.res, String(b.id)]]);
      if (r) await logar(me, { tipo: "apagou", nome: r.nome });
      return { ok: true };
    }
    case "descartarPedido": {
      const id = txt(b.id, 40).replace(/[^\w-]/g, "");
      await pipeline([["HSET", `inga:lead:${id}`, "descartado", String(Date.now())]]);
      return { ok: true };
    }
    case "quartos": {
      if (!admin) throw new Err(403, "Só a administradora pode alterar os quartos.");
      const list = (Array.isArray(b.quartos) ? b.quartos : []).slice(0, 20).map((q, i) => ({ id: txt(q.id, 10).replace(/\W/g, "") || "r" + (i + 1) + Date.now().toString(36), nome: txt(q.nome, 40) || "Quarto " + (i + 1), cap: Math.max(1, Math.min(12, parseInt(q.cap) || 2)) }));
      if (!list.length) throw new Err(400, "Precisa ter pelo menos um quarto.");
      await pipeline([["SET", K.rooms, JSON.stringify(list)]]);
      await logar(me, { tipo: "quartos" });
      return { ok: true, quartos: list };
    }
    case "membro": {
      if (!admin) throw new Err(403, "Só a administradora pode cadastrar a equipe.");
      const login = slug(b.login);
      if (!login || login === "dona") throw new Err(400, "Escolha um login (só letras e números, sem espaço).");
      const [raw] = await pipeline([["HGET", K.users, login]]);
      const old = J(raw, null);
      if (!old && String(b.senha || "").length < 6) throw new Err(400, "A senha precisa ter pelo menos 6 caracteres.");
      const u = { nome: txt(b.nome, 40) || login, papel: b.papel === "admin" ? "admin" : "equipe", ativo: b.ativo !== false, salt: old?.salt, hash: old?.hash };
      if (b.senha) { if (String(b.senha).length < 6) throw new Err(400, "A senha precisa ter pelo menos 6 caracteres."); u.salt = crypto.randomBytes(12).toString("hex"); u.hash = hashPw(b.senha, u.salt); }
      await pipeline([["HSET", K.users, login, JSON.stringify(u)]]);
      await logar(me, { tipo: old ? "membro-editado" : "membro-novo", nome: u.nome });
      return { ok: true };
    }
    case "removerMembro": {
      if (!admin) throw new Err(403, "Só a administradora pode alterar a equipe.");
      await pipeline([["HDEL", K.users, slug(b.login)]]);
      await logar(me, { tipo: "membro-removido", nome: slug(b.login) });
      return { ok: true };
    }
    case "senha": {
      if (me.login === "dona") throw new Err(400, "A senha da dona é trocada nas variáveis da Vercel (ADMIN_PASS).");
      const [raw] = await pipeline([["HGET", K.users, me.login]]);
      const u = J(raw, null);
      if (!u || !same(hashPw(b.atual || "", u.salt), u.hash)) throw new Err(400, "A senha atual não confere.");
      if (String(b.nova || "").length < 6) throw new Err(400, "A nova senha precisa ter pelo menos 6 caracteres.");
      u.salt = crypto.randomBytes(12).toString("hex"); u.hash = hashPw(b.nova, u.salt);
      await pipeline([["HSET", K.users, me.login, JSON.stringify(u)]]);
      return { ok: true };
    }
    case "pushChave": {
      const k = await vapid();
      const atual = b.endpoint ? await lerInscricao(b.endpoint) : null;
      return { publicKey: k.publicKey, ativo: !!atual, prefs: atual?.prefs || null };
    }
    case "pushAtivar": {
      const r = await salvarInscricao(me, b.sub, b.prefs);
      return { ok: true, prefs: r.prefs };
    }
    case "pushDesativar": {
      if (b.endpoint) await removerInscricao(b.endpoint);
      return { ok: true };
    }
    case "pushTeste": {
      const atual = b.endpoint ? await lerInscricao(b.endpoint) : null;
      if (!atual) throw new Err(400, "Ative as notificações neste aparelho primeiro.");
      const { subId } = await import("./_push.js");
      const r = await avisar(null, { title: "Tudo certo! 🌿", body: `As notificações da Pousada Ingá estão funcionando neste aparelho, ${String(me.nome).split(" ")[0]}.`, tag: "teste" }, { so: subId(b.endpoint) });
      if (!r.enviados) throw new Err(502, "Não consegui enviar. Tente desativar e ativar de novo.");
      return { ok: true };
    }
    default:
      throw new Err(400, "Ação desconhecida.");
  }
}
