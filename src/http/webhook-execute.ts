import type http from 'node:http';
import { db } from '../db/index.js';
import { webhooks, messages, channels } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import { generateUUIDv7, parseMentions, MessageType } from 'ecto-shared';
import { formatMessage, formatMessageAuthor } from '../utils/format.js';
import { eventDispatcher } from '../ws/event-dispatcher.js';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 1_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handleWebhookExecute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) {
  // Parse /webhooks/:id/:token
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'webhooks') {
    jsonResponse(res, 404, { error: 'Not found' });
    return;
  }

  const webhookId = parts[1]!;
  const token = parts[2]!;

  const d = db();

  // Look up webhook by id + token
  const [webhook] = await d
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.token, token)))
    .limit(1);

  if (!webhook) {
    jsonResponse(res, 404, { error: 'Webhook not found or invalid token' });
    return;
  }

  // Verify the channel still exists
  const [channel] = await d
    .select()
    .from(channels)
    .where(eq(channels.id, webhook.channelId))
    .limit(1);

  if (!channel) {
    jsonResponse(res, 404, { error: 'Channel not found' });
    return;
  }

  // Parse request body
  let body: { content?: string; username?: string; avatar_url?: string };
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!body.content || typeof body.content !== 'string' || body.content.length === 0) {
    jsonResponse(res, 400, { error: 'content is required and must be a non-empty string' });
    return;
  }

  if (body.content.length > 4000) {
    jsonResponse(res, 400, { error: 'content must be 4000 characters or fewer' });
    return;
  }

  // Parse mentions in webhook message content
  const parsed = parseMentions(body.content);

  const id = generateUUIDv7();
  await d.insert(messages).values({
    id,
    channelId: webhook.channelId,
    authorId: webhook.createdBy,
    content: body.content,
    type: MessageType.DEFAULT,
    webhookId: webhook.id,
    mentionEveryone: parsed.mentionEveryone,
    mentionRoles: parsed.roles.length > 0 ? parsed.roles : null,
    mentionUsers: parsed.users.length > 0 ? parsed.users : null,
  });

  // Build author from webhook data (override name/avatar if provided)
  const author = formatMessageAuthor(
    {
      username: body.username ?? webhook.name,
      display_name: body.username ?? webhook.name,
      avatar_url: body.avatar_url ?? webhook.avatarUrl,
    },
    webhook.createdBy,
    null,
  );

  const [row] = await d.select().from(messages).where(eq(messages.id, id)).limit(1);
  const formatted = formatMessage(row!, author, [], []);

  eventDispatcher.dispatchToChannel(webhook.channelId, 'message.create', formatted);

  jsonResponse(res, 200, formatted);
}
