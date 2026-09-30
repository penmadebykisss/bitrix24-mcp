// MCP-сервер Битрикс24: сделки, лиды, контакты, задачи и комментарии в CRM, плюс аналитика отдела продаж —
// отчёт по воронке и зависшие сделки. Подключение через входящий вебхук (BITRIX24_WEBHOOK_URL).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as b24 from './api.js';

export const VERSION = '1.0.0';

export function createServer() {
const server = new McpServer({ name: 'bitrix24', version: VERSION }, {
  instructions: 'Битрикс24 CRM и задачи. Сначала вызовите b24_portal: он даёт id воронок (категорий), стадий и сотрудников для фильтров и записи. ' +
    'Вопросы руководителя («как идут продажи», «кто лучше закрывает», «что зависло») — b24_pipeline_report, b24_stale_deals, b24_tasks. ' +
    'Перед звонком клиенту — b24_find_contact и b24_get_deal. Инструменты создания и изменения пишут в живой портал: ' +
    'покажите пользователю, что будет записано, и дождитесь согласия. ' +
    'Start with b24_portal for category, stage and user ids; write tools change live CRM data and need user confirmation.',
});

const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = e => ({ isError: true, content: [{ type: 'text', text: 'Ошибка: ' + (e?.message || String(e)) }] });
const safe = fn => async args => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

const Id = z.number().int().positive();
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}/).describe('Дата ГГГГ-ММ-ДД или дата-время ISO');
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const writeIdempotent = { ...write, idempotentHint: true };
const WRITE_NOTE = ' Изменяет данные в Битрикс24: покажите пользователю, что будет записано, и получите согласие.';
const NEEDS = ' Требует BITRIX24_WEBHOOK_URL (входящий вебхук с правами crm, task, user); лимит 2 запроса/с соблюдается автоматически.';

const DEAL_SELECT = ['ID', 'TITLE', 'OPPORTUNITY', 'CURRENCY_ID', 'CATEGORY_ID', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'ASSIGNED_BY_ID',
  'CONTACT_ID', 'COMPANY_ID', 'SOURCE_ID', 'DATE_CREATE', 'DATE_MODIFY', 'CLOSEDATE', 'CLOSED', 'COMMENTS'];

const SEM = { P: 'open', S: 'won', F: 'lost' };

function dealView(x, d) {
  return {
    id: Number(x.ID), title: x.TITLE, amount: Number(x.OPPORTUNITY || 0), currency: x.CURRENCY_ID,
    category: d.category(x.CATEGORY_ID), category_id: Number(x.CATEGORY_ID || 0),
    stage: d.stage(x.STAGE_ID), stage_id: x.STAGE_ID, result: SEM[x.STAGE_SEMANTIC_ID] || 'open',
    responsible: d.user(x.ASSIGNED_BY_ID), responsible_id: Number(x.ASSIGNED_BY_ID) || undefined,
    contact_id: Number(x.CONTACT_ID) || undefined, company_id: Number(x.COMPANY_ID) || undefined,
    source: x.SOURCE_ID || undefined,
    created_at: x.DATE_CREATE, updated_at: x.DATE_MODIFY, closed_at: x.CLOSED === 'Y' ? x.CLOSEDATE : undefined,
  };
}

function contactView(c, d) {
  return {
    id: Number(c.ID), name: [c.NAME, c.SECOND_NAME, c.LAST_NAME].filter(Boolean).join(' '),
    phones: b24.multi(c.PHONE), emails: b24.multi(c.EMAIL), post: c.POST || undefined,
    company_id: Number(c.COMPANY_ID) || undefined, responsible: d.user(c.ASSIGNED_BY_ID),
    created_at: c.DATE_CREATE,
  };
}

function taskView(t, d) {
  const deadline = t.deadline || undefined;
  return {
    id: Number(t.id), title: t.title, status: Number(t.status),
    responsible: d.user(t.responsibleId), responsible_id: Number(t.responsibleId) || undefined,
    deadline, overdue: deadline ? new Date(deadline) < new Date() : false,
    crm: t.ufCrmTask?.length ? t.ufCrmTask : undefined,
  };
}

// ================= Справочники =================

server.registerTool('b24_portal', {
  title: 'Портал: воронки, стадии, сотрудники',
  description: 'Справочник портала Битрикс24: users (id, name, email, active), categories — воронки сделок (id, name, is_default) со stages (id вида C1:NEW, name, semantics: open/won/lost). ' +
    'Вызывайте первым в разговоре: id воронок, стадий и сотрудников нужны фильтрам b24_search_deals, b24_tasks, b24_pipeline_report и записи в b24_create_deal / b24_update_deal. ' +
    'Результат кэшируется на 10 минут.' + NEEDS + ' Только чтение.',
  inputSchema: {},
  annotations: readOnly,
}, safe(async () => {
  const d = await b24.dictionaries();
  return {
    users: d.users.map(u => ({ id: Number(u.ID), name: d.user(u.ID), email: u.EMAIL || undefined, active: u.ACTIVE !== false })),
    categories: d.categories,
  };
}));

// ================= Сделки =================

server.registerTool('b24_search_deals', {
  title: 'Поиск сделок',
  description: 'Ищет сделки по подстроке в названии и фильтрам: воронка (category_id), стадия (stage_id), ответственный, результат (open/won/lost), период создания. ' +
    'Возвращает count, total_amount и deals (id, title, amount, category, stage, result, responsible, contact_id, даты), свежие изменения первыми. ' +
    'Полная карточка с контактом, задачами и комментариями — b24_get_deal; сводная аналитика — b24_pipeline_report; зависшие сделки — b24_stale_deals.' + NEEDS + ' Только чтение.',
  inputSchema: {
    query: z.string().optional().describe('Подстрока названия сделки'),
    category_id: z.number().int().min(0).optional().describe('ID воронки (из b24_portal); 0 — общая'),
    stage_id: z.string().optional().describe('ID стадии, например NEW или C2:PREPARATION (из b24_portal)'),
    responsible_id: Id.optional().describe('ID ответственного (из b24_portal)'),
    result: z.enum(['open', 'won', 'lost']).optional().describe('Только открытые, выигранные или проигранные'),
    created_from: DateStr.optional().describe('Созданы не раньше этой даты'),
    created_to: DateStr.optional().describe('Созданы не позже этой даты'),
    limit: z.number().int().min(1).max(500).default(50).describe('Максимум сделок в ответе'),
  },
  annotations: readOnly,
}, safe(async ({ query, category_id, stage_id, responsible_id, result, created_from, created_to, limit }) => {
  const filter = {
    ...(query ? { '%TITLE': query } : {}),
    ...(category_id !== undefined ? { CATEGORY_ID: category_id } : {}),
    ...(stage_id ? { STAGE_ID: stage_id } : {}),
    ...(responsible_id ? { ASSIGNED_BY_ID: responsible_id } : {}),
    ...(result ? { STAGE_SEMANTIC_ID: { open: 'P', won: 'S', lost: 'F' }[result] } : {}),
    ...(created_from ? { '>=DATE_CREATE': b24.iso(created_from) } : {}),
    ...(created_to ? { '<=DATE_CREATE': b24.iso(created_to) } : {}),
  };
  const [deals, d] = await Promise.all([
    b24.list('crm.deal.list', { filter, select: DEAL_SELECT, order: { DATE_MODIFY: 'DESC' } }, limit),
    b24.dictionaries(),
  ]);
  return { count: deals.length, total_amount: deals.reduce((s, x) => s + Number(x.OPPORTUNITY || 0), 0), deals: deals.map(x => dealView(x, d)) };
}));

server.registerTool('b24_get_deal', {
  title: 'Карточка сделки',
  description: 'Полная карточка одной сделки по id: всё из b24_search_deals плюс comments сделки, contacts (телефоны, e-mail, должность), company, open_tasks (со сроком и флагом overdue) и последние комментарии таймлайна. ' +
    'Используйте перед звонком или письмом клиенту; id берите из b24_search_deals или b24_find_contact. Несуществующий id вернёт ошибку «не найдена». Делает 4–6 запросов.' + NEEDS + ' Только чтение.',
  inputSchema: { id: Id.describe('ID сделки'), comments_limit: z.number().int().min(0).max(50).default(10).describe('Сколько последних комментариев таймлайна вернуть') },
  annotations: readOnly,
}, safe(async ({ id, comments_limit }) => {
  let deal;
  try { deal = await b24.get('crm.deal.get', { id }); } catch (e) {
    if (/not found|не найден/i.test(e.message)) throw new Error(`Сделка ${id} не найдена`);
    throw e;
  }
  if (!deal) throw new Error(`Сделка ${id} не найдена`);
  const d = await b24.dictionaries();
  const links = await b24.get('crm.deal.contact.items.get', { id }) || [];
  const contacts = [];
  for (const l of links) {
    const c = await b24.get('crm.contact.get', { id: l.CONTACT_ID });
    if (c) contacts.push({ ...contactView(c, d), is_primary: l.IS_PRIMARY === 'Y' });
  }
  const company = Number(deal.COMPANY_ID) ? await b24.get('crm.company.get', { id: deal.COMPANY_ID }) : null;
  const tasks = await b24.list('tasks.task.list', {
    filter: { UF_CRM_TASK: `D_${id}`, '<REAL_STATUS': 4 },
    select: ['ID', 'TITLE', 'DEADLINE', 'RESPONSIBLE_ID', 'STATUS', 'UF_CRM_TASK'],
  }, 50, r => r?.tasks);
  const comments = comments_limit ? await b24.list('crm.timeline.comment.list', {
    filter: { ENTITY_ID: id, ENTITY_TYPE: 'deal' }, select: ['ID', 'COMMENT', 'CREATED', 'AUTHOR_ID'], order: { ID: 'DESC' },
  }, comments_limit) : [];
  return {
    ...dealView(deal, d), description: deal.COMMENTS || undefined,
    contacts, company: company ? { id: Number(company.ID), title: company.TITLE, phones: b24.multi(company.PHONE) } : undefined,
    open_tasks: tasks.map(t => taskView(t, d)),
    comments: comments.map(c => ({ id: Number(c.ID), text: c.COMMENT, author: d.user(c.AUTHOR_ID), created_at: c.CREATED })),
  };
}));

server.registerTool('b24_create_deal', {
  title: 'Создать сделку',
  description: 'Создаёт сделку в Битрикс24, при необходимости вместе с новым контактом (contact_name + phone/email) или привязывает существующий contact_id. ' +
    'Возвращает deal_id и contact_id. Воронку и стадию берите из b24_portal; без них сделка попадёт в первую стадию общей воронки. ' +
    'Перед созданием проверьте b24_find_contact, чтобы не плодить дубли контактов.' + WRITE_NOTE + NEEDS,
  inputSchema: {
    title: z.string().min(1).describe('Название сделки'),
    amount: z.number().min(0).optional().describe('Сумма'),
    currency: z.string().length(3).default('RUB').describe('Валюта, например RUB'),
    category_id: z.number().int().min(0).optional().describe('ID воронки'),
    stage_id: z.string().optional().describe('ID стадии'),
    responsible_id: Id.optional().describe('ID ответственного'),
    contact_id: Id.optional().describe('ID существующего контакта'),
    contact_name: z.string().optional().describe('Имя нового контакта'),
    phone: z.string().optional().describe('Телефон нового контакта'),
    email: z.string().optional().describe('E-mail нового контакта'),
    comment: z.string().optional().describe('Описание сделки'),
  },
  annotations: write,
}, safe(async ({ title, amount, currency, category_id, stage_id, responsible_id, contact_id, contact_name, phone, email, comment }) => {
  let cid = contact_id;
  if (!cid && (contact_name || phone || email)) {
    cid = Number(await b24.get('crm.contact.add', { fields: {
      NAME: contact_name || phone || email,
      ...(phone ? { PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }] } : {}),
      ...(email ? { EMAIL: [{ VALUE: email, VALUE_TYPE: 'WORK' }] } : {}),
      ...(responsible_id ? { ASSIGNED_BY_ID: responsible_id } : {}),
    } }));
  }
  const id = Number(await b24.get('crm.deal.add', { fields: {
    TITLE: title, CURRENCY_ID: currency,
    ...(amount !== undefined ? { OPPORTUNITY: amount } : {}),
    ...(category_id !== undefined ? { CATEGORY_ID: category_id } : {}),
    ...(stage_id ? { STAGE_ID: stage_id } : {}),
    ...(responsible_id ? { ASSIGNED_BY_ID: responsible_id } : {}),
    ...(cid ? { CONTACT_ID: cid } : {}),
    ...(comment ? { COMMENTS: comment } : {}),
  } }));
  return { deal_id: id, contact_id: cid || undefined };
}));

server.registerTool('b24_update_deal', {
  title: 'Изменить сделку',
  description: 'Меняет сделку: стадию (перевод по воронке), сумму, ответственного, название или описание. Передавайте только то, что меняется; без полей — ошибка. ' +
    'Для закрытия сделки выберите стадию с semantics won/lost из b24_portal. Повторный вызов с теми же данными ничего не меняет.' + WRITE_NOTE + NEEDS,
  inputSchema: {
    id: Id.describe('ID сделки'),
    stage_id: z.string().optional().describe('Новая стадия'),
    amount: z.number().min(0).optional().describe('Новая сумма'),
    responsible_id: Id.optional().describe('Новый ответственный'),
    title: z.string().optional().describe('Новое название'),
    comment: z.string().optional().describe('Новое описание'),
  },
  annotations: writeIdempotent,
}, safe(async ({ id, stage_id, amount, responsible_id, title, comment }) => {
  const fields = {
    ...(stage_id ? { STAGE_ID: stage_id } : {}),
    ...(amount !== undefined ? { OPPORTUNITY: amount } : {}),
    ...(responsible_id ? { ASSIGNED_BY_ID: responsible_id } : {}),
    ...(title ? { TITLE: title } : {}),
    ...(comment ? { COMMENTS: comment } : {}),
  };
  if (!Object.keys(fields).length) throw new Error('Укажите хотя бы одно поле для изменения');
  await b24.get('crm.deal.update', { id, fields });
  return { updated: true, id, fields: Object.keys(fields) };
}));

// ================= Контакты и лиды =================

server.registerTool('b24_find_contact', {
  title: 'Найти контакт',
  description: 'Находит контакты по телефону, e-mail или имени/фамилии. Телефон и e-mail ищутся через поиск дублей Битрикс24 (формат номера не важен), имя — по подстроке. ' +
    'Возвращает contacts (id, name, phones, emails, post, company_id, responsible) и deals — открытые сделки найденных контактов. Используйте перед звонком и перед созданием сделки.' + NEEDS + ' Только чтение.',
  inputSchema: { query: z.string().min(2).describe('Телефон, e-mail или имя'), limit: z.number().int().min(1).max(50).default(10) },
  annotations: readOnly,
}, safe(async ({ query, limit }) => {
  const d = await b24.dictionaries();
  const kind = b24.isPhoneOrEmail(query.trim());
  let contacts;
  const select = ['ID', 'NAME', 'SECOND_NAME', 'LAST_NAME', 'PHONE', 'EMAIL', 'POST', 'COMPANY_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE'];
  if (kind) {
    const found = await b24.get('crm.duplicate.findbycomm', { entity_type: 'CONTACT', type: kind, values: [query.trim()] });
    const ids = (found?.CONTACT || []).slice(0, limit);
    contacts = ids.length ? await b24.list('crm.contact.list', { filter: { ID: ids }, select }, limit) : [];
  } else {
    const byLast = await b24.list('crm.contact.list', { filter: { '%LAST_NAME': query }, select }, limit);
    const byName = await b24.list('crm.contact.list', { filter: { '%NAME': query }, select }, limit);
    const seen = new Set();
    contacts = [...byLast, ...byName].filter(c => !seen.has(c.ID) && seen.add(c.ID)).slice(0, limit);
  }
  const ids = contacts.map(c => Number(c.ID));
  const deals = ids.length ? await b24.list('crm.deal.list', {
    filter: { CONTACT_ID: ids, STAGE_SEMANTIC_ID: 'P' }, select: DEAL_SELECT, order: { DATE_MODIFY: 'DESC' },
  }, 50) : [];
  return { count: contacts.length, contacts: contacts.map(c => contactView(c, d)), deals: deals.map(x => dealView(x, d)) };
}));

server.registerTool('b24_create_lead', {
  title: 'Создать лид',
  description: 'Создаёт лид (входящую заявку) в Битрикс24: название, имя, телефон, e-mail, сумма, источник, комментарий. Возвращает lead_id. ' +
    'Используйте для заявок, которые ещё не квалифицированы; для подтверждённой продажи — b24_create_deal.' + WRITE_NOTE + NEEDS,
  inputSchema: {
    title: z.string().min(1).describe('Название лида'),
    name: z.string().optional().describe('Имя клиента'),
    phone: z.string().optional(), email: z.string().optional(),
    amount: z.number().min(0).optional().describe('Предполагаемая сумма'),
    source_id: z.string().optional().describe('Источник, например WEB, CALL, EMAIL, ADVERTISING'),
    comment: z.string().optional(),
    responsible_id: Id.optional(),
  },
  annotations: write,
}, safe(async ({ title, name, phone, email, amount, source_id, comment, responsible_id }) => {
  const id = Number(await b24.get('crm.lead.add', { fields: {
    TITLE: title,
    ...(name ? { NAME: name } : {}),
    ...(phone ? { PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }] } : {}),
    ...(email ? { EMAIL: [{ VALUE: email, VALUE_TYPE: 'WORK' }] } : {}),
    ...(amount !== undefined ? { OPPORTUNITY: amount } : {}),
    ...(source_id ? { SOURCE_ID: source_id } : {}),
    ...(comment ? { COMMENTS: comment } : {}),
    ...(responsible_id ? { ASSIGNED_BY_ID: responsible_id } : {}),
  } }));
  return { lead_id: id };
}));

server.registerTool('b24_add_comment', {
  title: 'Комментарий в таймлайн',
  description: 'Добавляет комментарий в таймлайн сделки, лида, контакта или компании — итог звонка, договорённости, заметка. Возвращает comment_id. ' +
    'Каждый вызов добавляет новый комментарий.' + WRITE_NOTE + NEEDS,
  inputSchema: {
    entity_type: z.enum(['deal', 'lead', 'contact', 'company']).default('deal'),
    entity_id: Id.describe('ID сущности'),
    text: z.string().min(1).describe('Текст комментария'),
  },
  annotations: write,
}, safe(async ({ entity_type, entity_id, text }) => {
  const id = Number(await b24.get('crm.timeline.comment.add', { fields: { ENTITY_ID: entity_id, ENTITY_TYPE: entity_type, COMMENT: text } }));
  return { comment_id: id };
}));

// ================= Задачи =================

server.registerTool('b24_tasks', {
  title: 'Задачи сотрудников',
  description: 'Список незакрытых задач: scope=overdue — просроченные, today — со сроком сегодня, open — все открытые. Фильтр по ответственному. ' +
    'Возвращает count, by_responsible (сколько у кого, из них просрочено) и tasks (id, title, responsible, deadline, overdue, crm-привязки вида D_123). ' +
    'Отвечает на «что просрочено у менеджеров» и «какие задачи на сегодня».' + NEEDS + ' Только чтение.',
  inputSchema: {
    scope: z.enum(['overdue', 'today', 'open']).default('open'),
    responsible_id: Id.optional(),
    limit: z.number().int().min(1).max(500).default(100),
  },
  annotations: readOnly,
}, safe(async ({ scope, responsible_id, limit }) => {
  const now = new Date();
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 0);
  const filter = {
    '<REAL_STATUS': 4,
    ...(responsible_id ? { RESPONSIBLE_ID: responsible_id } : {}),
    ...(scope === 'overdue' ? { '<DEADLINE': now.toISOString() } : {}),
    ...(scope === 'today' ? { '<=DEADLINE': endOfDay.toISOString() } : {}),
  };
  const [tasks, d] = await Promise.all([
    b24.list('tasks.task.list', { filter, select: ['ID', 'TITLE', 'DEADLINE', 'RESPONSIBLE_ID', 'STATUS', 'UF_CRM_TASK'], order: { DEADLINE: 'asc' } }, limit, r => r?.tasks),
    b24.dictionaries(),
  ]);
  const views = tasks.map(t => taskView(t, d));
  const by = {};
  for (const t of views) {
    const k = t.responsible || '—';
    by[k] ??= { responsible: k, tasks: 0, overdue: 0 };
    by[k].tasks++; if (t.overdue) by[k].overdue++;
  }
  return { count: views.length, by_responsible: Object.values(by).sort((a, b) => b.overdue - a.overdue), tasks: views };
}));

server.registerTool('b24_create_task', {
  title: 'Поставить задачу',
  description: 'Ставит задачу сотруднику, при желании привязывает к сделке, лиду или контакту (появится в карточке CRM). Возвращает task_id. ' +
    'Если ответственный не указан, задача ставится владельцу вебхука.' + WRITE_NOTE + NEEDS,
  inputSchema: {
    title: z.string().min(1).describe('Что сделать'),
    deadline: DateStr.optional().describe('Срок'),
    responsible_id: Id.optional().describe('Кому (из b24_portal)'),
    description: z.string().optional(),
    deal_id: Id.optional().describe('Привязать к сделке'),
    lead_id: Id.optional().describe('Привязать к лиду'),
    contact_id: Id.optional().describe('Привязать к контакту'),
  },
  annotations: write,
}, safe(async ({ title, deadline, responsible_id, description, deal_id, lead_id, contact_id }) => {
  const crm = [deal_id && `D_${deal_id}`, lead_id && `L_${lead_id}`, contact_id && `C_${contact_id}`].filter(Boolean);
  let rid = responsible_id;
  if (!rid) rid = Number((await b24.get('profile'))?.ID) || undefined;
  const r = await b24.get('tasks.task.add', { fields: {
    TITLE: title,
    ...(rid ? { RESPONSIBLE_ID: rid } : {}),
    ...(deadline ? { DEADLINE: b24.iso(deadline.length === 10 ? `${deadline}T18:00:00` : deadline) } : {}),
    ...(description ? { DESCRIPTION: description } : {}),
    ...(crm.length ? { UF_CRM_TASK: crm } : {}),
  } });
  return { task_id: Number(r?.task?.id), responsible_id: rid, crm: crm.length ? crm : undefined };
}));

server.registerTool('b24_complete_task', {
  title: 'Закрыть задачу',
  description: 'Отмечает задачу выполненной, при желании с комментарием-результатом. Повторный вызов для уже закрытой задачи не меняет данные.' + WRITE_NOTE + NEEDS,
  inputSchema: { id: Id.describe('ID задачи'), result: z.string().optional().describe('Итог — добавится комментарием') },
  annotations: writeIdempotent,
}, safe(async ({ id, result }) => {
  if (result) await b24.get('task.commentitem.add', { TASKID: id, FIELDS: { POST_MESSAGE: result } });
  await b24.get('tasks.task.complete', { taskId: id });
  return { completed: true, id };
}));

// ================= Аналитика =================

server.registerTool('b24_pipeline_report', {
  title: 'Отчёт по воронке',
  description: 'Сводка отдела продаж за период по сделкам, созданным в нём: deals, amount, open/won/lost (количество и сумма), win_rate_pct (выиграно / закрыто), avg_cycle_days (от создания до выигрыша), ' +
    'stages — открытые сделки по стадиям, managers — по каждому менеджеру сделки, выиграно, сумма выигранного и конверсия. ' +
    'Отвечает на «как идут продажи в этом месяце» и «кто из менеджеров лучше закрывает». Без дат — все сделки (до 2000).' + NEEDS + ' Только чтение.',
  inputSchema: {
    date_from: DateStr.optional(), date_to: DateStr.optional(),
    category_id: z.number().int().min(0).optional().describe('Только эта воронка'),
  },
  annotations: readOnly,
}, safe(async ({ date_from, date_to, category_id }) => {
  const filter = {
    ...(category_id !== undefined ? { CATEGORY_ID: category_id } : {}),
    ...(date_from ? { '>=DATE_CREATE': b24.iso(date_from) } : {}),
    ...(date_to ? { '<=DATE_CREATE': b24.iso(date_to) } : {}),
  };
  const [deals, d] = await Promise.all([
    b24.list('crm.deal.list', { filter, select: DEAL_SELECT }, 2000),
    b24.dictionaries(),
  ]);
  const sum = xs => xs.reduce((s, x) => s + Number(x.OPPORTUNITY || 0), 0);
  const open = deals.filter(x => x.STAGE_SEMANTIC_ID !== 'S' && x.STAGE_SEMANTIC_ID !== 'F');
  const won = deals.filter(x => x.STAGE_SEMANTIC_ID === 'S');
  const lost = deals.filter(x => x.STAGE_SEMANTIC_ID === 'F');
  const cycles = won.map(x => b24.daysBetween(x.DATE_CREATE, x.CLOSEDATE)).filter(v => v !== undefined && v >= 0);
  const stages = {};
  for (const x of open) {
    stages[x.STAGE_ID] ??= { stage_id: x.STAGE_ID, stage: d.stage(x.STAGE_ID), deals: 0, amount: 0 };
    stages[x.STAGE_ID].deals++; stages[x.STAGE_ID].amount += Number(x.OPPORTUNITY || 0);
  }
  const managers = {};
  for (const x of deals) {
    const k = x.ASSIGNED_BY_ID || '0';
    managers[k] ??= { manager: d.user(k) || '—', deals: 0, won: 0, lost: 0, won_amount: 0 };
    const m = managers[k];
    m.deals++;
    if (x.STAGE_SEMANTIC_ID === 'S') { m.won++; m.won_amount += Number(x.OPPORTUNITY || 0); }
    if (x.STAGE_SEMANTIC_ID === 'F') m.lost++;
  }
  const rate = (w, l) => (w + l ? Math.round(w / (w + l) * 1000) / 10 : null);
  return {
    period: { from: date_from, to: date_to }, deals: deals.length, amount: sum(deals),
    open: { count: open.length, amount: sum(open) }, won: { count: won.length, amount: sum(won) }, lost: { count: lost.length, amount: sum(lost) },
    win_rate_pct: rate(won.length, lost.length),
    avg_cycle_days: cycles.length ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length * 10) / 10 : null,
    stages: Object.values(stages).sort((a, b) => b.amount - a.amount),
    managers: Object.values(managers).map(m => ({ ...m, win_rate_pct: rate(m.won, m.lost) })).sort((a, b) => b.won_amount - a.won_amount),
  };
}));

server.registerTool('b24_stale_deals', {
  title: 'Зависшие сделки',
  description: 'Открытые сделки без движения: не менялись больше days дней и/или без открытых задач. Возвращает count, amount_at_risk и deals с reasons ' +
    '(«нет изменений N дней», «нет открытых задач»), самые крупные первыми. Отвечает на «что у нас зависло» и «где теряем деньги».' + NEEDS + ' Только чтение.',
  inputSchema: {
    days: z.number().int().min(1).max(365).default(7).describe('Сколько дней без изменений считать зависанием'),
    category_id: z.number().int().min(0).optional(),
    responsible_id: Id.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  },
  annotations: readOnly,
}, safe(async ({ days, category_id, responsible_id, limit }) => {
  const border = new Date(Date.now() - days * 86400000);
  const [deals, tasks, d] = await Promise.all([
    b24.list('crm.deal.list', {
      filter: { STAGE_SEMANTIC_ID: 'P', ...(category_id !== undefined ? { CATEGORY_ID: category_id } : {}), ...(responsible_id ? { ASSIGNED_BY_ID: responsible_id } : {}) },
      select: DEAL_SELECT, order: { OPPORTUNITY: 'DESC' },
    }, 1000),
    b24.list('tasks.task.list', { filter: { '<REAL_STATUS': 4 }, select: ['ID', 'UF_CRM_TASK'] }, 2000, r => r?.tasks),
    b24.dictionaries(),
  ]);
  const withTasks = new Set(tasks.flatMap(t => t.ufCrmTask || []));
  const stale = [];
  for (const x of deals) {
    const reasons = [];
    const idle = b24.daysBetween(x.DATE_MODIFY, new Date().toISOString());
    if (new Date(x.DATE_MODIFY) < border) reasons.push(`нет изменений ${Math.floor(idle)} дн.`);
    if (!withTasks.has(`D_${x.ID}`)) reasons.push('нет открытых задач');
    if (reasons.length && (reasons.length > 1 || new Date(x.DATE_MODIFY) < border)) stale.push({ ...dealView(x, d), idle_days: Math.floor(idle), reasons });
  }
  const top = stale.slice(0, limit);
  return { count: stale.length, amount_at_risk: stale.reduce((s, x) => s + x.amount, 0), deals: top };
}));

return server;
}
