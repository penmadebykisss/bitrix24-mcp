# bitrix24-mcp — Битрикс24 для ИИ-агентов

[![penmadebykisss/bitrix24-mcp MCP server](https://glama.ai/mcp/servers/penmadebykisss/bitrix24-mcp/badges/score.svg)](https://glama.ai/mcp/servers/penmadebykisss/bitrix24-mcp)
[![CI](https://github.com/penmadebykisss/bitrix24-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/penmadebykisss/bitrix24-mcp/actions/workflows/ci.yml)

MCP-сервер, который подключает Claude, Cursor и других ИИ-ассистентов к **Битрикс24**: сделки, лиды, контакты,
задачи и комментарии в таймлайне — плюс **аналитика отдела продаж**, которую руководитель обычно собирает руками:
отчёт по воронке с конверсией и рейтингом менеджеров, зависшие сделки без движения и без задач, просроченные задачи.

Подключается за минуту через **входящий вебхук** — без приложения в маркете и без OAuth.

Спросите ассистента:
- *«Как идут продажи за сентябрь? Кто из менеджеров лучше закрывает?»*
- *«Какие сделки зависли больше недели и на какую сумму?»*
- *«Что просрочено у менеджеров на сегодня?»*
- *«Найди клиента +7 900 123-45-67 и подготовь меня к звонку»*
- *«Создай сделку „Сайт для кафе“ на 90 000 в воронке „Проекты“ с контактом Иван, +7 900…, и поставь Анне задачу перезвонить завтра»*

## Инструменты

| Инструмент | Что делает |
|---|---|
| `b24_portal` | Сотрудники, воронки сделок и стадии с id и признаком won/lost |
| `b24_search_deals` | Поиск сделок по названию, воронке, стадии, ответственному, результату, периоду |
| `b24_get_deal` | Карточка сделки: контакты с телефонами, компания, открытые задачи, комментарии таймлайна |
| `b24_find_contact` | Поиск контакта по телефону (формат не важен), e-mail или имени + его открытые сделки |
| `b24_tasks` | Открытые, просроченные или сегодняшние задачи с разбивкой по сотрудникам |
| `b24_pipeline_report` | Отчёт по воронке: стадии, выиграно/проиграно, конверсия, средний цикл, рейтинг менеджеров |
| `b24_stale_deals` | Зависшие сделки: без изменений N дней и без открытых задач, крупные первыми |
| `b24_create_deal` ✏️ | Сделка сразу с новым или существующим контактом |
| `b24_update_deal` ✏️ | Стадия, сумма, ответственный, название, описание |
| `b24_create_lead` ✏️ | Лид (входящая заявка) с телефоном, e-mail и источником |
| `b24_add_comment` ✏️ | Комментарий в таймлайн сделки, лида, контакта или компании |
| `b24_create_task` ✏️ | Задача сотруднику со сроком и привязкой к сделке/лиду/контакту |
| `b24_complete_task` ✏️ | Закрыть задачу с комментарием-результатом |

✏️ — изменяют данные в портале; ассистент должен показать, что запишет, и получить ваше согласие.

## Подключение

1. В Битрикс24: **Разработчикам → Другое → Входящий вебхук**. Отметьте права **CRM (crm)**, **Задачи (task)** и
   **Пользователи (user)**, сохраните.
2. Скопируйте адрес вебхука вида `https://ваш-портал.bitrix24.ru/rest/1/abc123xyz/` — это `BITRIX24_WEBHOOK_URL`.

Вебхук действует от имени создавшего его сотрудника и видит то же, что он. Храните адрес как пароль.

Нужен [Node.js](https://nodejs.org) 18+.

### Claude Desktop

```json
{
  "mcpServers": {
    "bitrix24": {
      "command": "npx",
      "args": ["-y", "github:penmadebykisss/bitrix24-mcp"],
      "env": { "BITRIX24_WEBHOOK_URL": "https://ваш-портал.bitrix24.ru/rest/1/abc123xyz/" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add bitrix24 -e BITRIX24_WEBHOOK_URL=https://ваш-портал.bitrix24.ru/rest/1/abc123xyz/ -- npx -y github:penmadebykisss/bitrix24-mcp
```

### Cursor, Windsurf и другие

Команда `npx`, аргументы `-y github:penmadebykisss/bitrix24-mcp`, переменная `BITRIX24_WEBHOOK_URL`.

### Docker

```bash
docker build -t bitrix24-mcp .
docker run -i --rm -e BITRIX24_WEBHOOK_URL=https://ваш-портал.bitrix24.ru/rest/1/abc123xyz/ bitrix24-mcp
```

## Ограничения

- Лимит REST API для вебхуков — около 2 запросов в секунду; сервер сам выдерживает интервал и повторяет запрос при `QUERY_LIMIT_EXCEEDED`.
- Отчёт по воронке считает до 2000 сделок за период, поиск зависших — до 1000 открытых сделок.
- Коробочная версия Битрикс24 тоже поддерживается — адрес вебхука будет на вашем домене.

## Проверка

```bash
npm test   # мок REST API Битрикс24, реальный портал не нужен
```

## Нужна настройка или доработка?

Подключу этот сервер под ключ: вебхук и права, настройка под ваши воронки и поля, ежедневные сводки руководителю
в Telegram, интеграции Битрикс24 с другими сервисами. Пишите в Telegram **[@penmadebykisss](https://t.me/penmadebykisss)**
или оставьте заявку на [penmadebykisss.github.io](https://penmadebykisss.github.io).

*Need help setting this up or a custom MCP server? Telegram [@penmadebykisss](https://t.me/penmadebykisss).*

## English

**bitrix24-mcp** connects AI assistants to **Bitrix24** CRM via an inbound webhook: search, read and edit deals,
create deals with contacts, leads, contact lookup by phone or e-mail (duplicate search), timeline comments, tasks —
plus **sales analytics**: pipeline report (stage totals, win rate, average cycle, manager leaderboard), stale deals
with no activity and no open tasks, overdue tasks by employee. Set `BITRIX24_WEBHOOK_URL`
(Developer resources → Other → Inbound webhook with `crm`, `task`, `user` scopes).

```bash
npx -y github:penmadebykisss/bitrix24-mcp
```

**Ready-made agent skill:** [Bitrix24 CRM Sales Assistant](https://www.agensi.io/skills/bitrix24-crm-sales-assistant) on Agensi — free SKILL.md with usage rules and configs for Claude Code, Claude Desktop, Cursor, VS Code, Windsurf and Codex.

## Смотрите также

- [amocrm-kommo-mcp](https://github.com/penmadebykisss/amocrm-kommo-mcp) — то же для amoCRM и Kommo
- [ru-business-mcp](https://github.com/penmadebykisss/ru-business-mcp) — проверка контрагентов, курсы ЦБ, пени, производственный календарь
- [ru-docs-mcp](https://github.com/penmadebykisss/ru-docs-mcp) — счета с QR-кодом и акты в PDF
- [rf-marketplaces-mcp](https://github.com/penmadebykisss/rf-marketplaces-mcp) — аналитика Wildberries

## Лицензия

MIT
