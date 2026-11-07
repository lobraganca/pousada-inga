// Conexão com o banco Upstash Redis (criado em Vercel → Storage).
// A Vercel cria as variáveis automaticamente ao conectar o banco ao projeto.
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const dbReady = () => Boolean(URL_ && TOKEN);

export async function pipeline(cmds) {
  const r = await fetch(`${URL_}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error(`Banco respondeu ${r.status}`);
  return (await r.json()).map((x) => x.result);
}

// Data no fuso de Cumuruxatiba (UTC−3, sem horário de verão)
export function dayKey(d = new Date()) {
  return new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 10);
}
