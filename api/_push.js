import crypto from "node:crypto";
import webpush from "web-push";
import { pipeline } from "./_db.js";

// Notificações no celular (Web Push) para a dona e a equipe.
// As chaves são criadas sozinhas na primeira vez e guardadas no banco: nada para configurar na Vercel.
const KEY = "inga:g:vapid";
const SUBS = "inga:g:push"; // hash id -> JSON {sub, login, nome, prefs, criado}
export const PREFS = { pedidos: true, reservas: true, tarefas: true, resumo: true };

let ready = null;
export async function vapid() {
  if (ready) return ready;
  let [raw] = await pipeline([["GET", KEY]]);
  let k = null;
  try { k = JSON.parse(raw); } catch {}
  if (!k || !k.publicKey) {
    k = webpush.generateVAPIDKeys();
    const [ok] = await pipeline([["SET", KEY, JSON.stringify(k), "NX"]]);
    if (ok !== "OK") { [raw] = await pipeline([["GET", KEY]]); k = JSON.parse(raw); }
  }
  webpush.setVapidDetails("mailto:reserva@pousadaingacumuru.com.br", k.publicKey, k.privateKey);
  ready = k;
  return k;
}

export const subId = (endpoint) => crypto.createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 24);

export async function salvarInscricao(me, sub, prefs) {
  if (!sub || !sub.endpoint || !sub.keys) throw new Error("Inscrição inválida.");
  const id = subId(sub.endpoint);
  const p = {};
  for (const k of Object.keys(PREFS)) p[k] = prefs && k in prefs ? !!prefs[k] : PREFS[k];
  await pipeline([["HSET", SUBS, id, JSON.stringify({ sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, login: me.login, nome: me.nome, prefs: p, criado: Date.now() })]]);
  return { id, prefs: p };
}

export async function lerInscricao(endpoint) {
  const [raw] = await pipeline([["HGET", SUBS, subId(endpoint)]]);
  try { return JSON.parse(raw); } catch { return null; }
}

export async function removerInscricao(endpoint) {
  await pipeline([["HDEL", SUBS, subId(endpoint)]]);
}

async function todas() {
  const [raw] = await pipeline([["HGETALL", SUBS]]);
  const out = [];
  if (Array.isArray(raw)) for (let i = 0; i < raw.length; i += 2) { try { out.push({ id: raw[i], ...JSON.parse(raw[i + 1]) }); } catch {} }
  return out;
}

// Envia para todos os aparelhos que querem esse tipo de aviso (menos, se pedido, os da própria pessoa que fez a ação).
// Nunca deixa um erro de notificação atrapalhar o resto do sistema.
export async function avisar(tipo, msg, { exceto, so } = {}) {
  try {
    const subs = (await todas()).filter((s) => (!tipo || s.prefs?.[tipo] !== false) && (!exceto || s.login !== exceto) && (!so || s.id === so));
    if (!subs.length) return { enviados: 0 };
    await vapid();
    const body = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url || "/gestao", tag: msg.tag || tipo || "inga" });
    const mortos = [];
    let n = 0;
    await Promise.all(subs.map((s) => webpush.sendNotification(s.sub, body, { TTL: 60 * 60 * 24, urgency: "high" })
      .then(() => { n++; })
      .catch((e) => { if (e && (e.statusCode === 404 || e.statusCode === 410)) mortos.push(s.id); })));
    if (mortos.length) await pipeline([["HDEL", SUBS, ...mortos]]);
    return { enviados: n };
  } catch {
    return { enviados: 0 };
  }
}
