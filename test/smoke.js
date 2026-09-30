// Дымовой тест: локальный мок REST API Битрикс24 + сервер как MCP-клиент. Проверяет запросы и разбор ответов всех инструментов.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const day = 86400000;
const ago = n => new Date(Date.now() - n * day).toISOString();
const ahead = n => new Date(Date.now() + n * day).toISOString();

const users = [{ ID: '1', NAME: 'Анна', LAST_NAME: 'Смирнова', EMAIL: 'anna@x.ru', ACTIVE: true }, { ID: '2', NAME: 'Борис', LAST_NAME: '', EMAIL: 'b@x.ru', ACTIVE: true }];
const stages = {
  DEAL_STAGE: [{ STATUS_ID: 'NEW', NAME: 'Новая' }, { STATUS_ID: 'PREPARATION', NAME: 'Переговоры' },
    { STATUS_ID: 'WON', NAME: 'Успешно', EXTRA: { SEMANTICS: 'success' } }, { STATUS_ID: 'LOSE', NAME: 'Провал', EXTRA: { SEMANTICS: 'failure' } }],
  DEAL_STAGE_3: [{ STATUS_ID: 'C3:NEW', NAME: 'Заявка' }],
};
const deals = [
  { ID: '11', TITLE: 'Сайт для кафе', OPPORTUNITY: '90000', CURRENCY_ID: 'RUB', CATEGORY_ID: '0', STAGE_ID: 'PREPARATION', STAGE_SEMANTIC_ID: 'P', ASSIGNED_BY_ID: '1', CONTACT_ID: '21', COMPANY_ID: '31', DATE_CREATE: ago(20), DATE_MODIFY: ago(12), CLOSED: 'N' },
  { ID: '12', TITLE: 'Лендинг', OPPORTUNITY: '40000', CURRENCY_ID: 'RUB', CATEGORY_ID: '0', STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S', ASSIGNED_BY_ID: '1', DATE_CREATE: ago(15), DATE_MODIFY: ago(5), CLOSEDATE: ago(5), CLOSED: 'Y' },
  { ID: '13', TITLE: 'CRM-интеграция', OPPORTUNITY: '150000', CURRENCY_ID: 'RUB', CATEGORY_ID: '0', STAGE_ID: 'LOSE', STAGE_SEMANTIC_ID: 'F', ASSIGNED_BY_ID: '2', DATE_CREATE: ago(10), DATE_MODIFY: ago(1), CLOSEDATE: ago(1), CLOSED: 'Y' },
  { ID: '14', TITLE: 'Бот', OPPORTUNITY: '30000', CURRENCY_ID: 'RUB', CATEGORY_ID: '3', STAGE_ID: 'C3:NEW', STAGE_SEMANTIC_ID: 'P', ASSIGNED_BY_ID: '2', DATE_CREATE: ago(3), DATE_MODIFY: ago(1), CLOSED: 'N' },
];
const contact = { ID: '21', NAME: 'Иван', LAST_NAME: 'Петров', PHONE: [{ VALUE: '+79001234567' }], EMAIL: [{ VALUE: 'ivan@cafe.ru' }], POST: 'Директор', COMPANY_ID: '31', ASSIGNED_BY_ID: '1', DATE_CREATE: ago(20) };
const tasks = [
  { id: '41', title: 'Перезвонить', deadline: ago(1), responsibleId: '1', status: '2', ufCrmTask: ['D_11'] },
  { id: '42', title: 'Отправить КП', deadline: ahead(3), responsibleId: '2', status: '2', ufCrmTask: ['D_14'] },
];
const log = [];

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const m = req.url.match(/^\/rest\/1\/secret\/([\w.]+)\.json$/);
    const p = body ? JSON.parse(body) : {};
    const send = (data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (!m) return send({ error: 'NO_AUTH_FOUND', error_description: 'Wrong authorization data' }, 401);
    const method = m[1];
    log.push({ method, p });
    const page = (items, size = 50) => {
      const start = p.start || 0;
      const slice = items.slice(start, start + size);
      return send({ result: slice, total: items.length, ...(start + size < items.length ? { next: start + size } : {}) });
    };
    const f = p.filter || {};
    switch (method) {
      case 'user.get': return page(users);
      case 'profile': return send({ result: { ID: '1' } });
      case 'crm.category.list': return send({ result: { categories: [{ id: 0, name: 'Общая', isDefault: 'Y' }, { id: 3, name: 'Боты', isDefault: 'N' }] } });
      case 'crm.status.list': return page(stages[f.ENTITY_ID] || []);
      case 'crm.deal.list': {
        let xs = deals;
        if (f['%TITLE']) xs = xs.filter(d => d.TITLE.toLowerCase().includes(f['%TITLE'].toLowerCase()));
        if (f.CATEGORY_ID !== undefined) xs = xs.filter(d => Number(d.CATEGORY_ID) === f.CATEGORY_ID);
        if (f.STAGE_SEMANTIC_ID) xs = xs.filter(d => d.STAGE_SEMANTIC_ID === f.STAGE_SEMANTIC_ID);
        if (f.CONTACT_ID) xs = xs.filter(d => f.CONTACT_ID.includes(Number(d.CONTACT_ID)));
        return page(xs);
      }
      case 'crm.deal.get': return p.id === 11 ? send({ result: deals[0] }) : send({ error: '', error_description: 'Not found' }, 400);
      case 'crm.deal.contact.items.get': return send({ result: [{ CONTACT_ID: 21, IS_PRIMARY: 'Y' }] });
      case 'crm.contact.get': return send({ result: contact });
      case 'crm.company.get': return send({ result: { ID: '31', TITLE: 'ООО Кафе', PHONE: [{ VALUE: '+74950000000' }] } });
      case 'tasks.task.list': {
        let xs = tasks;
        if (f.UF_CRM_TASK) xs = xs.filter(t => t.ufCrmTask.includes(f.UF_CRM_TASK));
        if (f['<DEADLINE']) xs = xs.filter(t => t.deadline < f['<DEADLINE']);
        return send({ result: { tasks: xs }, total: xs.length });
      }
      case 'crm.timeline.comment.list': return page([{ ID: '51', COMMENT: 'Клиент просил скидку', CREATED: ago(1), AUTHOR_ID: '1' }]);
      case 'crm.contact.add': return send({ result: 22 });
      case 'crm.deal.add': return send({ result: 15 });
      case 'crm.deal.update': return send({ result: true });
      case 'crm.duplicate.findbycomm': return send({ result: { CONTACT: [21] } });
      case 'crm.contact.list': {
        if (f.ID) return page([contact]);
        if (f['%LAST_NAME'] && 'Петров'.includes(f['%LAST_NAME'])) return page([contact]);
        if (f['%NAME'] && 'Иван'.includes(f['%NAME'])) return page([contact]);
        return page([]);
      }
      case 'crm.lead.add': return send({ result: 61 });
      case 'crm.timeline.comment.add': return send({ result: 52 });
      case 'tasks.task.add': return send({ result: { task: { id: '43' } } });
      case 'task.commentitem.add': return send({ result: 71 });
      case 'tasks.task.complete': return send({ result: { task: { id: '41' } } });
      default: return send({ error: 'ERROR_METHOD_NOT_FOUND', error_description: 'Method not found ' + method }, 404);
    }
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}/rest/1/secret/`;

let failed = 0;
async function connect(env) {
  const c = new Client({ name: 'smoke', version: '0' });
  const clean = { ...process.env }; delete clean.BITRIX24_WEBHOOK_URL;
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ['src/index.js'], env: { ...clean, BITRIX24_MIN_GAP_MS: '0', ...env } }));
  return c;
}
async function run(client, name, args, check) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || '';
  let ok;
  try { ok = check(r.isError ? null : JSON.parse(text), text, r.isError); } catch { ok = false; }
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
}
const last = method => [...log].reverse().find(l => l.method === method);

// Без настроек — понятная ошибка
const bare = await connect({});
const { tools } = await bare.listTools();
console.log(`tools (${tools.length}):`, tools.map(t => t.name).join(', '));
if (tools.length !== 13) { console.log('FAIL ожидалось 13 инструментов'); failed++; }
if (tools.some(t => !t.annotations || !t.description || t.description.length < 80)) { console.log('FAIL у инструмента нет аннотаций или описания'); failed++; }
await run(bare, 'b24_portal', {}, (d, t, e) => e && t.includes('BITRIX24_WEBHOOK_URL'));
await bare.close();

// Неверный вебхук
const wrong = await connect({ BITRIX24_WEBHOOK_URL: base.replace('secret', 'bad') });
await run(wrong, 'b24_portal', {}, (d, t, e) => e && t.includes('вебхук'));
await wrong.close();

const c = await connect({ BITRIX24_WEBHOOK_URL: base });
await run(c, 'b24_portal', {}, d => d.users.length === 2 && d.users[0].name === 'Анна Смирнова'
  && d.categories.length === 2 && d.categories[0].stages.find(s => s.id === 'WON').semantics === 'won' && d.categories[1].stages[0].id === 'C3:NEW');
await run(c, 'b24_search_deals', { query: 'сайт' }, d => d.count === 1 && d.deals[0].stage === 'Переговоры' && d.deals[0].responsible === 'Анна Смирнова'
  && last('crm.deal.list').p.filter['%TITLE'] === 'сайт');
await run(c, 'b24_search_deals', { result: 'won' }, d => d.count === 1 && d.deals[0].id === 12 && d.deals[0].result === 'won' && d.total_amount === 40000);
await run(c, 'b24_search_deals', { category_id: 3 }, d => d.count === 1 && d.deals[0].category === 'Боты');
await run(c, 'b24_get_deal', { id: 11 }, d => d.contacts[0].phones[0] === '+79001234567' && d.contacts[0].is_primary && d.company.title === 'ООО Кафе'
  && d.open_tasks.length === 1 && d.open_tasks[0].overdue && d.comments[0].text.includes('скидку'));
await run(c, 'b24_get_deal', { id: 999 }, (d, t, e) => e && t.includes('не найдена'));
await run(c, 'b24_create_deal', { title: 'Новый сайт', amount: 50000, contact_name: 'Ольга', phone: '+79990000000', category_id: 3 },
  d => d.deal_id === 15 && d.contact_id === 22 && last('crm.contact.add').p.fields.PHONE[0].VALUE === '+79990000000'
    && last('crm.deal.add').p.fields.CONTACT_ID === 22 && last('crm.deal.add').p.fields.CATEGORY_ID === 3);
await run(c, 'b24_update_deal', { id: 11, stage_id: 'WON' }, d => d.updated && last('crm.deal.update').p.fields.STAGE_ID === 'WON');
await run(c, 'b24_update_deal', { id: 11 }, (d, t, e) => e);
await run(c, 'b24_find_contact', { query: '8 900 123-45-67' }, d => d.contacts[0].emails[0] === 'ivan@cafe.ru' && d.deals[0].id === 11
  && last('crm.duplicate.findbycomm').p.type === 'PHONE');
await run(c, 'b24_find_contact', { query: 'Петров' }, d => d.count === 1 && d.contacts[0].name === 'Иван Петров');
await run(c, 'b24_create_lead', { title: 'Заявка с сайта', name: 'Пётр', phone: '+79991112233', source_id: 'WEB' }, d => d.lead_id === 61 && last('crm.lead.add').p.fields.SOURCE_ID === 'WEB');
await run(c, 'b24_add_comment', { entity_id: 11, text: 'Созвонились' }, d => d.comment_id === 52 && last('crm.timeline.comment.add').p.fields.ENTITY_TYPE === 'deal');
await run(c, 'b24_tasks', { scope: 'overdue' }, d => d.count === 1 && d.tasks[0].id === 41 && d.by_responsible[0].overdue === 1);
await run(c, 'b24_tasks', {}, d => d.count === 2);
await run(c, 'b24_create_task', { title: 'Позвонить', deadline: '2026-10-01', deal_id: 11 }, d => d.task_id === 43 && d.responsible_id === 1
  && last('tasks.task.add').p.fields.UF_CRM_TASK[0] === 'D_11' && last('tasks.task.add').p.fields.DEADLINE === '2026-10-01T18:00:00');
await run(c, 'b24_complete_task', { id: 41, result: 'Дозвонился' }, d => d.completed && last('task.commentitem.add').p.FIELDS.POST_MESSAGE === 'Дозвонился');
await run(c, 'b24_pipeline_report', {}, d => d.deals === 4 && d.won.amount === 40000 && d.lost.count === 1 && d.win_rate_pct === 50
  && d.avg_cycle_days === 10 && d.stages.find(s => s.stage_id === 'PREPARATION').deals === 1 && d.managers[0].manager === 'Анна Смирнова');
await run(c, 'b24_stale_deals', { days: 7 }, d => d.deals.length === 1 && d.deals[0].id === 11 && d.deals[0].reasons[0].startsWith('нет изменений'));
await c.close();

mock.close();
console.log(failed ? `\nПровалено: ${failed}` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
