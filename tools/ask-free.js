// Роутер бесплатных ИИ: задача идёт тому, кто для неё лучше, при отказе — следующему.
//   --kind short (по умолчанию для коротких): Groq → Gemini → Cerebras → Mistral → OpenRouter
//       пачки вариантов: названия, подписи-шутки, теги, хештеги — Groq самый быстрый
//   --kind long  (по умолчанию для длинных > 1500 симв.): Gemini → Groq → Cerebras → Mistral → OpenRouter
//       описания, пересказ длинного текста, черновики писем
//   node C:\Games\rabota\tools\ask-free.js [--kind short|long] "задание"
//   node C:\Games\rabota\tools\ask-free.js [--kind short|long] --file prompt.txt
// Ключи только из переменных окружения (User). Печатает только ответ; в stderr — кто ответил.
// Только черновой текст, без личных данных Влада.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
let kind = null;
const ki = argv.indexOf('--kind');
if (ki !== -1) { kind = argv[ki + 1]; argv.splice(ki, 2); }
const prompt = argv[0] === '--file' ? fs.readFileSync(argv[1], 'utf8') : argv.join(' ');
if (!prompt.trim()) { console.error('usage: ask-free.js [--kind short|long] "задание" | --file prompt.txt'); process.exit(1); }
if (kind !== 'short' && kind !== 'long') kind = prompt.length > 1500 ? 'long' : 'short';

function logUsage(ai, ok, extra) {
  try { fs.appendFileSync(path.join(__dirname, 'ai-usage.jsonl'), JSON.stringify({ ts: Date.now(), ai, ok, ...extra }) + '\n'); } catch {}
}
function key(name) {
  if (process.env[name]) return process.env[name];
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${name}','User')`], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

// OpenAI-совместимые API
const OPENAI_LIKE = [
  { ai: 'groq', env: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b' },
  { ai: 'cerebras', env: 'CEREBRAS_API_KEY', url: 'https://api.cerebras.ai/v1/chat/completions', model: 'gpt-oss-120b' },
  { ai: 'mistral', env: 'MISTRAL_API_KEY', url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest' },
  { ai: 'openrouter', env: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openrouter/free' },
];

async function tryOpenAI(p) {
  const k = key(p.env);
  if (!k) return null;
  try {
    const r = await fetch(p.url, {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!r.ok || !text) { logUsage(p.ai, false, { status: r.status }); console.error(`[${p.ai}] нет ответа: ${r.status} ${JSON.stringify(j.error || j).slice(0, 160)}`); return null; }
    logUsage(p.ai, true, { chars: text.length });
    return text.trim();
  } catch (e) { logUsage(p.ai, false, { err: String(e).slice(0, 80) }); console.error(`[${p.ai}] ошибка: ${e}`); return null; }
}

function tryGemini() {
  const tmp = path.join(require('os').tmpdir(), `askfree_${process.pid}.txt`);
  fs.writeFileSync(tmp, prompt, 'utf8');
  const r = spawnSync('node', [path.join(__dirname, 'ask-gemini.js'), '--file', tmp], { encoding: 'utf8', timeout: 180000 });
  try { fs.unlinkSync(tmp); } catch {}
  const text = (r.stdout || '').trim();
  return r.status === 0 && text ? text : null; // ask-gemini.js сам пишет в ai-usage
}

(async () => {
  const gemini = { ai: 'gemini' };
  const [groq, ...rest] = OPENAI_LIKE;
  const order = kind === 'short' ? [groq, gemini, ...rest] : [gemini, groq, ...rest];
  for (const p of order) {
    if (p === gemini && process.env.ASKFREE_SKIP_GEMINI) continue;
    const out = p === gemini ? tryGemini() : await tryOpenAI(p);
    if (out) { console.error(`[${p.ai} · ${kind}]`); console.log(out); return; }
  }
  console.error('все бесплатные ИИ недоступны — сделай сам');
  process.exit(2);
})();
