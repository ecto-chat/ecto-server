import type { ActivityItem, MessageAuthor } from 'ecto-shared';

export function formatActivityItem(
  row: {
    id: string;
    type: string;
    actorId: string;
    messageId: string | null;
    channelId: string | null;
    conversationId: string | null;
    contentPreview: string | null;
    emoji: string | null;
    read: boolean;
    createdAt: Date;
  },
  actor: MessageAuthor,
  serverId: string,
  serverName?: string,
  channelName?: string,
): ActivityItem {
  return {
    id: row.id,
    type: row.type as ActivityItem['type'],
    actor,
    content_preview: row.contentPreview ?? '',
    emoji: row.emoji ?? undefined,
    message_id: row.messageId ?? undefined,
    source: {
      server_id: serverId,
      server_name: serverName,
      channel_id: row.channelId ?? undefined,
      channel_name: channelName,
      conversation_id: row.conversationId ?? undefined,
    },
    read: row.read,
    created_at: row.createdAt.toISOString(),
  };
}
