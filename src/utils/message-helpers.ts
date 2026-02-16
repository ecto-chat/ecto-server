import type { ReactionGroup } from 'ecto-shared';
import type { Db } from '../db/index.js';
import { attachments, reactions, members } from '../db/schema/index.js';
import { eq, and, inArray } from 'drizzle-orm';
import { formatMessage, formatAttachment, formatMessageAuthor } from './format.js';
import { resolveUserProfiles } from './resolve-profile.js';

/** Group flat reaction rows into ReactionGroup[] with `me` flag */
export function groupReactions(
  reactionRows: { emoji: string; userId: string }[],
  currentUserId: string,
): ReactionGroup[] {
  const groups = new Map<string, { emoji: string; users: string[] }>();
  for (const r of reactionRows) {
    const g = groups.get(r.emoji) ?? { emoji: r.emoji, users: [] };
    g.users.push(r.userId);
    groups.set(r.emoji, g);
  }
  return [...groups.values()].map((g) => ({
    emoji: g.emoji,
    count: g.users.length,
    users: g.users,
    me: g.users.includes(currentUserId),
  }));
}

/**
 * Batch-load attachments, reactions, profiles, and nicknames for a set of messages,
 * then format them into the API response shape.
 */
export async function hydrateMessages(
  d: Db,
  serverId: string,
  currentUserId: string,
  rawMessages: { id: string; authorId: string; [key: string]: unknown }[],
) {
  if (rawMessages.length === 0) return [];

  const msgIds = rawMessages.map((m) => m.id);
  const authorIds = [...new Set(rawMessages.map((m) => m.authorId))];

  const [attachmentRows, reactionRows, profiles, memberRows] = await Promise.all([
    d.select().from(attachments).where(inArray(attachments.messageId, msgIds)),
    d.select().from(reactions).where(inArray(reactions.messageId, msgIds)),
    resolveUserProfiles(d, authorIds),
    d
      .select({ userId: members.userId, nickname: members.nickname })
      .from(members)
      .where(and(eq(members.serverId, serverId), inArray(members.userId, authorIds))),
  ]);

  const attachmentsByMsg = new Map<string, typeof attachmentRows>();
  for (const a of attachmentRows) {
    if (!a.messageId) continue;
    const arr = attachmentsByMsg.get(a.messageId) ?? [];
    arr.push(a);
    attachmentsByMsg.set(a.messageId, arr);
  }

  const reactionsByMsg = new Map<string, typeof reactionRows>();
  for (const r of reactionRows) {
    const arr = reactionsByMsg.get(r.messageId) ?? [];
    arr.push(r);
    reactionsByMsg.set(r.messageId, arr);
  }

  const nicknameMap = new Map(memberRows.map((m) => [m.userId, m.nickname]));

  return rawMessages.map((m) => {
    const profile = profiles.get(m.authorId) ?? { username: 'Unknown', display_name: null, avatar_url: null };
    const author = formatMessageAuthor(profile, m.authorId, nicknameMap.get(m.authorId) ?? null);
    const msgAttachments = (attachmentsByMsg.get(m.id) ?? []).map(formatAttachment);
    const msgReactions = groupReactions(
      (reactionsByMsg.get(m.id) ?? []).map((r) => ({ emoji: r.emoji, userId: r.userId })),
      currentUserId,
    );
    return formatMessage(m as Parameters<typeof formatMessage>[0], author, msgAttachments, msgReactions);
  });
}
