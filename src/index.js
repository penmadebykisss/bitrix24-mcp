#!/usr/bin/env node
// Точка входа: stdio-сервер MCP, доступ к порталу — из BITRIX24_WEBHOOK_URL.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

await createServer().connect(new StdioServerTransport());
