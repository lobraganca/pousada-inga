// Conexão com o banco Upstash Redis.
// Aceita as variáveis da integração da Vercel (KV_*) ou as do site da Upstash (UPSTASH_*),
// e tolera erros comuns de colagem: aspas, espaços, barra no fim, ou a URL "rediss://".
const clean = (v) => String(v || "").trim()
  .replace(/^(export\s+)?(UPSTASH|KV|REDIS)[A-Z_]*\s*=\s*/, "") // colaram "NOME=valor" no campo do valor
  .replace(/^["'`]+|["'`]+$/g, "").trim();

function resolve() {
  let url = clean(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
  let token = clean(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
  const redisUrl = clean(process.env.REDIS_URL || process.env.KV_URL);
  // Se colaram a URL redis(s)://default:TOKEN@host:6379, dá para tirar dela a URL REST e o token.
  const fromRedis = (u) => {
    const m = /^rediss?:\/\/[^:]*:([^@]+)@([^:/]+)/.exec(u);
    return m ? { url: `https://${m[2]}`, token: decodeURIComponent(m[1]) } : null;
  };
  if (/^rediss?:\/\//.test(url)) { const x = fromRedis(url); if (x) { url = x.url; token = token || x.token; } }
  if (!url && redisUrl) { const x = fromRedis(redisUrl); if (x) { url = x.url; token = token || x.token; } }
  if (url && !/^https?:\/\//.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  return { url, token };
}
const { url: URL_, token: TOKEN } = resolve();

export const dbReady = () => Boolean(URL_ && TOKEN);
export const dbMissing = () => [!URL_ && "UPSTASH_REDIS_REST_URL", !TOKEN && "UPSTASH_REDIS_REST_TOKEN"].filter(Boolean).join(" e ");

export async function pipeline(cmds) {
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(URL_)) throw new Error(`O valor da UPSTASH_REDIS_REST_URL na Vercel está errado. No campo "Value" deve ficar só o endereço, algo como https://nome-123.upstash.io (sem o nome da variável). Hoje ele começa com: "${URL_.replace(/^https:\/\//, "").slice(0, 26)}…"`);
  let r;
  try {
    r = await fetch(`${URL_}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmds),
    });
  } catch (e) {
    throw new Error(`Não consegui falar com o banco. Confira a UPSTASH_REDIS_REST_URL (deve começar com https:// e terminar em .upstash.io). Valor atual começa com: "${URL_.slice(0, 24)}…"`);
  }
  if (r.status === 401 || r.status === 403) throw new Error("O banco recusou o token. Confira a UPSTASH_REDIS_REST_TOKEN (use o token normal, não o “read-only”).");
  if (!r.ok) throw new Error(`O banco respondeu com erro ${r.status}.`);
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error("O banco respondeu num formato inesperado. Confira se a URL é a “REST URL” da Upstash.");
  const bad = data.find((x) => x && x.error);
  if (bad) throw new Error(`O banco recusou um comando: ${bad.error}`);
  return data.map((x) => x.result);
}

// Data no fuso de Cumuruxatiba (UTC−3, sem horário de verão)
export function dayKey(d = new Date()) {
  return new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 10);
}
