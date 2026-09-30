// Клиент REST API Битрикс24 через входящий вебхук: троттлинг (2 запроса/с), повтор при QUERY_LIMIT_EXCEEDED,
// постраничная выборка списков и кэш справочников.

const MIN_GAP_MS = Number(process.env.BITRIX24_MIN_GAP_MS ?? 520);
const TIMEOUT_MS = 15000;
let chain = Promise.resolve();
let lastCall = 0;

function baseUrl() {
  const url = (process.env.BITRIX24_WEBHOOK_URL || '').trim();
  if (!url) {
    throw new Error('Не задан BITRIX24_WEBHOOK_URL — адрес входящего вебхука вида https://ваш-портал.bitrix24.ru/rest/1/abc123xyz/ ' +
      '(Битрикс24 → Разработчикам → Другое → Входящий вебхук, права: crm, task, user).');
  }
  return url.endsWith('/') ? url : url + '/';
}

async function throttle() {
  const run = chain.then(async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
  });
  chain = run.catch(() => {});
  return run;
}

/** Вызов метода REST API. Возвращает весь ответ ({ result, next, total }). */
export async function call(method, params = {}, retry = true) {
  const url = baseUrl() + method + '.json';
  await throttle();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Битрикс24 не ответил за ${TIMEOUT_MS / 1000} с или недоступен (${method}): ${e.message}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: 'BAD_JSON', error_description: text.slice(0, 200) }; }
  // Битрикс24 иногда отдаёт пустой код ошибки и только описание (например, «Not found» у crm.deal.get)
  if (data.error !== undefined || data.error_description) {
    if (data.error === 'QUERY_LIMIT_EXCEEDED' && retry) {
      await new Promise(r => setTimeout(r, 1000));
      return call(method, params, false);
    }
    if (res.status === 401 || data.error === 'NO_AUTH_FOUND' || data.error === 'invalid_token') {
      throw new Error('Битрикс24 отклонил вебхук: проверьте адрес BITRIX24_WEBHOOK_URL и что вебхук не удалён.');
    }
    if (data.error === 'insufficient_scope' || data.error === 'ACCESS_DENIED') {
      throw new Error(`Вебхуку не хватает прав для ${method}: добавьте права crm, task и user в настройках вебхука.`);
    }
    throw new Error(`Битрикс24 ${method}: ${data.error_description || data.error}`);
  }
  if (!res.ok) throw new Error(`Битрикс24 ${method}: HTTP ${res.status}`);
  return data;
}

/** Результат метода. */
export async function get(method, params) {
  return (await call(method, params)).result;
}

/** Постраничная выборка списка (по 50 записей) до limit. pick достаёт массив из result (для tasks.task.list — result.tasks). */
export async function list(method, params, limit = 50, pick = r => r) {
  const out = [];
  let start = 0;
  while (out.length < limit) {
    const data = await call(method, { ...params, start });
    const items = pick(data.result) || [];
    out.push(...items);
    if (data.next === undefined || data.next === null || !items.length) break;
    start = data.next;
  }
  return out.slice(0, limit);
}

// ---------- справочники с кэшем ----------

let cache = null;
const TTL = 10 * 60 * 1000;

export async function dictionaries() {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const users = await list('user.get', { FILTER: { ACTIVE: true } }, 500);
  const cats = (await get('crm.category.list', { entityTypeId: 2 }))?.categories || [];
  if (!cats.some(c => Number(c.id) === 0)) cats.unshift({ id: 0, name: 'Общая', isDefault: 'Y' });
  const categories = [];
  for (const c of cats) {
    const entity = Number(c.id) === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${c.id}`;
    const stages = await list('crm.status.list', { filter: { ENTITY_ID: entity }, order: { SORT: 'ASC' } }, 200);
    categories.push({
      id: Number(c.id), name: c.name, is_default: c.isDefault === 'Y' || Number(c.id) === 0,
      stages: stages.map(s => ({ id: s.STATUS_ID, name: s.NAME, semantics: semantics(s.EXTRA?.SEMANTICS) })),
    });
  }
  const userName = new Map(users.map(u => [String(u.ID), [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || u.EMAIL || `#${u.ID}`]));
  const stageName = new Map(categories.flatMap(c => c.stages.map(s => [s.id, s.name])));
  const catName = new Map(categories.map(c => [String(c.id), c.name]));
  const data = {
    users, categories,
    user: id => (id ? userName.get(String(id)) || `#${id}` : undefined),
    stage: id => stageName.get(id) || id,
    category: id => catName.get(String(id ?? 0)) || `#${id}`,
  };
  cache = { at: Date.now(), data };
  return data;
}

function semantics(s) {
  if (s === 'success') return 'won';
  if (s === 'failure' || s === 'apology') return 'lost';
  return 'open';
}

// ---------- помощники ----------

/** ISO-строка для фильтров Битрикс24 из «ГГГГ-ММ-ДД» или ISO. */
export function iso(d) {
  if (!d) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : d;
}

export function daysBetween(a, b) {
  if (!a || !b) return undefined;
  return Math.round((new Date(b) - new Date(a)) / 86400000 * 10) / 10;
}

export function multi(field) {
  return Array.isArray(field) ? field.map(x => x.VALUE).filter(Boolean) : [];
}

export function isPhoneOrEmail(q) {
  return /@/.test(q) ? 'EMAIL' : /^[+\d\s()-]{6,}$/.test(q) ? 'PHONE' : null;
}

/** Сброс кэша (для тестов). */
export function resetCache() { cache = null; }
