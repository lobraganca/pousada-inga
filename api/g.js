import crypto from "node:crypto";
import { dbReady, dbMissing, pipeline, falhasLogin, limparFalhas } from "./_db.js";
import { vapid, salvarInscricao, lerInscricao, removerInscricao, avisar } from "./_push.js";

// Sistema de gestão de reservas (/gestao).
// A dona entra com ADMIN_USER/ADMIN_PASS (variáveis da Vercel) e cadastra a equipe.
// Tudo fica no mesmo banco Upstash, com chaves "inga:g:*".
const K = {
  users: "inga:g:users",       // hash login -> JSON {nome, papel, salt, hash}
  sess: (t) => `inga:g:sess:${t}`,
  rooms: "inga:g:rooms",       // string JSON [{id,nome,cap}]
  msgs: "inga:g:msgs",         // string JSON {chave: texto} — modelos de mensagem editados pela dona
  res: "inga:g:res",           // hash id -> JSON reserva
  log: "inga:g:log",           // lista de eventos
  espera: "inga:g:espera",     // hash id -> JSON lista de espera
  tarefas: "inga:g:tarefas",   // hash id -> JSON tarefa da equipe
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
  if ((t.n >= 8 && Date.now() - t.at < 10 * 60e3) || (await falhasLogin(ip)) >= 8) throw new Err(429, "Muitas tentativas. Espere 15 minutos.");
  const login = slug(b.login), pass = String(b.senha || "");
  let user = null;
  const U = process.env.ADMIN_USER, P = process.env.ADMIN_PASS;
  if (U && P && same(String(b.login || "").trim(), U) && same(pass, P)) user = { login: "dona", nome: txt(process.env.ADMIN_NAME, 40) || "Dona", papel: "admin" };
  if (!user && login) {
    const [raw] = await pipeline([["HGET", K.users, login]]);
    const u = J(raw, null);
    if (u && u.ativo !== false && same(hashPw(pass, u.salt), u.hash)) user = { login, nome: u.nome, papel: u.papel || "equipe" };
  }
  if (!user) { tries.set(ip, { n: t.n + 1, at: Date.now() }); await falhasLogin(ip, true); throw new Err(401, "Login ou senha incorretos."); }
  tries.delete(ip); await limparFalhas(ip);
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
  const [rooms, resv, leadIds, users, esp, tar, msgs] = await pipeline([["GET", K.rooms], ["HGETALL", K.res], ["ZREVRANGE", "inga:leads", 0, 99], ["HGETALL", K.users], ["HGETALL", K.espera], ["HGETALL", K.tarefas], ["GET", K.msgs]]);
  const vals = (h) => { const o = []; if (Array.isArray(h)) for (let i = 1; i < h.length; i += 2) { const x = J(h[i], null); if (x) o.push(x); } return o; };
  const espera = vals(esp).filter((e) => e.status !== "removido");
  const tarefas = vals(tar).filter((t) => !t.feito || Date.now() - (t.feitoEm || 0) < 3 * 864e5);
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
  return { quartos: R, reservas, pedidos, equipe, espera, tarefas, msgs: J(msgs, {}) || {} };
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
const br = (d) => String(d).slice(8, 10) + "/" + String(d).slice(5, 7);

async function logar(me, o) {
  await pipeline([["LPUSH", K.log, JSON.stringify({ em: Date.now(), por: me.nome, ...o })], ["LTRIM", K.log, 0, 299]]);
}

// Check-out cria a tarefa de arrumar o quarto e avisa a equipe.
async function limpeza(me, r) {
  const [rooms] = await pipeline([["GET", K.rooms]]);
  const q = (J(rooms, null) || DEFAULT_ROOMS).find((x) => x.id === r.quarto) || { nome: "quarto" };
  const t = { id: "T" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"), titulo: `Arrumar ${q.nome}`, quarto: r.quarto, tipo: "limpeza", res: r.id, hospede: r.nome, feito: false, criadoPor: me.nome, criadoEm: Date.now() };
  await pipeline([["HSET", K.tarefas, t.id, JSON.stringify(t)]]);
  await avisar("tarefas", { title: `🧹 Arrumar ${q.nome}`, body: `${String(r.nome).split(" ")[0]} fez check-out. Quarto liberado para limpeza.`, url: "/gestao#hoje", tag: "t-" + t.id });
  return t;
}

// Quando um quarto vaga (cancelamento), avisa se alguém da lista de espera cabe nas datas.
async function vagou(r, reservas) {
  try {
    const [esp, rooms] = await pipeline([["HGETALL", K.espera], ["GET", K.rooms]]);
    const Q = J(rooms, null) || DEFAULT_ROOMS;
    const lista = [];
    if (Array.isArray(esp)) for (let i = 1; i < esp.length; i += 2) { const e = J(esp[i], null); if (e && e.status === "esperando") lista.push(e); }
    const hoje = new Date(Date.now() - 3 * 36e5).toISOString().slice(0, 10);
    const ok = lista.filter((e) => e.saida > hoje && e.entrada < r.saida && r.entrada < e.saida && Q.some((q) => q.cap >= e.pessoas && !reservas.some((x) => x.status !== "cancelada" && x.quarto === q.id && x.entrada < e.saida && e.entrada < x.saida)));
    for (const e of ok.slice(0, 3)) await avisar("reservas", { title: `✨ Vagou para ${e.nome}!`, body: `Está na lista de espera para ${br(e.entrada)} a ${br(e.saida)} e agora tem quarto. Chame no WhatsApp!`, url: "/gestao#pedidos", tag: "esp-" + e.id });
  } catch {}
}

// Trava: só uma gravação de reserva por vez. Evita que duas pessoas, ao mesmo tempo,
// reservem o mesmo quarto nas mesmas datas (as duas checariam "livre" antes de gravar).
async function comTrava(fn) {
  const tk = crypto.randomBytes(8).toString("hex");
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    const [r] = await pipeline([["SET", "inga:g:lock", tk, "NX", "PX", 8000]]);
    ok = r === "OK";
    if (!ok) await new Promise((z) => setTimeout(z, 150));
  }
  if (!ok) throw new Err(503, "O sistema está salvando outra reserva. Tente de novo em instantes.");
  try { return await fn(); }
  finally { const [cur] = await pipeline([["GET", "inga:g:lock"]]); if (cur === tk) await pipeline([["DEL", "inga:g:lock"]]); }
}

async function acao(me, b) {
  if (b.acao === "salvar" || b.acao === "status") return comTrava(() => acaoBase(me, b));
  return acaoBase(me, b);
}

async function acaoBase(me, b) {
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
      if (b.status === "cancelada") {
        await avisar("reservas", { title: `Reserva cancelada: ${r.nome}`, body: `${br(r.entrada)} a ${br(r.saida)} · o quarto ficou livre · por ${me.nome}`, url: "/gestao#mapa", tag: "res-" + r.id }, { exceto: me.login });
        await vagou(r, reservas.map((x) => (x.id === n.id ? n : x)));
      }
      let tarefa = null;
      if (b.status === "saiu" && r.status !== "saiu") tarefa = await limpeza(me, n);
      return { ok: true, reserva: n, tarefa };
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
      if (r) { await logar(me, { tipo: "apagou", nome: r.nome }); if (r.status !== "cancelada" && r.status !== "saiu") await vagou(r, reservas.filter((x) => x.id !== r.id)); }
      return { ok: true };
    }
    case "descartarPedido": {
      const id = txt(b.id, 40).replace(/[^\w-]/g, "");
      await pipeline([["HSET", `inga:lead:${id}`, "descartado", String(Date.now())]]);
      return { ok: true };
    }
    case "quartos": {
      if (!admin) throw new Err(403, "Só a administradora pode alterar os quartos.");
      const list = (Array.isArray(b.quartos) ? b.quartos : []).slice(0, 20).map((q, i) => ({ id: txt(q.id, 10).replace(/\W/g, "") || "r" + (i + 1) + Date.now().toString(36), nome: txt(q.nome, 40) || "Quarto " + (i + 1), cap: Math.max(1, Math.min(12, parseInt(q.cap) || 2)), preco: num(q.preco) }));
      if (!list.length) throw new Err(400, "Precisa ter pelo menos um quarto.");
      await pipeline([["SET", K.rooms, JSON.stringify(list)]]);
      await logar(me, { tipo: "quartos" });
      return { ok: true, quartos: list };
    }
    case "mensagens": {
      if (!admin) throw new Err(403, "Só a administradora pode mudar as mensagens.");
      const CH = ["confirmacao", "sinal", "lembrete", "chegada", "saldo", "avaliacao", "espera"];
      const o = {};
      for (const k of CH) { const v = String((b.msgs || {})[k] || "").replace(/\r/g, "").slice(0, 1500).trim(); if (v) o[k] = v; }
      await pipeline([["SET", K.msgs, JSON.stringify(o)]]);
      await logar(me, { tipo: "mensagens" });
      return { ok: true, msgs: o };
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
    case "esperaSalvar": {
      const x = b.espera || {};
      const e = {
        id: x.id ? txt(x.id, 30).replace(/[^\w-]/g, "") : "E" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"),
        nome: txt(x.nome, 80), tel: txt(x.tel, 20).replace(/\D/g, ""), entrada: txt(x.entrada, 10), saida: txt(x.saida, 10),
        pessoas: Math.max(1, Math.min(12, parseInt(x.pessoas) || 2)), flex: !!x.flex, obs: txt(x.obs, 300),
        status: x.status === "avisado" ? "avisado" : "esperando", criadoPor: me.nome, criadoEm: Date.now(),
      };
      if (!e.nome) throw new Err(400, "Escreva o nome.");
      if (!isDay(e.entrada) || !isDay(e.saida) || e.saida <= e.entrada) throw new Err(400, "Confira as datas.");
      await pipeline([["HSET", K.espera, e.id, JSON.stringify(e)]]);
      await logar(me, { tipo: "espera", nome: e.nome, entrada: e.entrada, saida: e.saida });
      return { ok: true, espera: e };
    }
    case "esperaStatus": {
      const id = txt(b.id, 30).replace(/[^\w-]/g, "");
      const [raw] = await pipeline([["HGET", K.espera, id]]);
      const e = J(raw, null);
      if (!e) throw new Err(404, "Não encontrado na lista de espera.");
      if (b.status === "removido") await pipeline([["HDEL", K.espera, id]]);
      else { e.status = b.status === "avisado" ? "avisado" : "esperando"; e.avisadoEm = Date.now(); await pipeline([["HSET", K.espera, id, JSON.stringify(e)]]); }
      return { ok: true };
    }
    case "tarefaSalvar": {
      const x = b.tarefa || {};
      const { quartos } = await carregar();
      const t = { id: "T" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"), titulo: txt(x.titulo, 120), quarto: quartos.some((q) => q.id === x.quarto) ? x.quarto : "", para: txt(x.para, 40), prazo: isDay(x.prazo) ? x.prazo : "", tipo: "manual", feito: false, criadoPor: me.nome, criadoEm: Date.now() };
      if (!t.titulo) throw new Err(400, "Escreva a tarefa.");
      await pipeline([["HSET", K.tarefas, t.id, JSON.stringify(t)]]);
      await avisar("tarefas", { title: `📋 Nova tarefa${t.para ? " para " + t.para : ""}`, body: t.titulo + (t.prazo ? ` · até ${br(t.prazo)}` : "") + ` · por ${me.nome}`, url: "/gestao#hoje", tag: "t-" + t.id }, { exceto: me.login });
      return { ok: true, tarefa: t };
    }
    case "tarefaFeita": {
      const id = txt(b.id, 30).replace(/[^\w-]/g, "");
      const [raw] = await pipeline([["HGET", K.tarefas, id]]);
      const t = J(raw, null);
      if (!t) throw new Err(404, "Tarefa não encontrada.");
      t.feito = !!b.feito; t.feitoPor = t.feito ? me.nome : ""; t.feitoEm = t.feito ? Date.now() : 0;
      await pipeline([["HSET", K.tarefas, id, JSON.stringify(t)]]);
      if (t.feito) await logar(me, { tipo: "tarefa", nome: t.titulo });
      return { ok: true, tarefa: t };
    }
    case "tarefaApagar": {
      await pipeline([["HDEL", K.tarefas, txt(b.id, 30).replace(/[^\w-]/g, "")]]);
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
