import type {
  Server,
  Channel,
  Category,
  Role,
  Member,
  Message,
  MessageAuthor,
  Attachment,
  ReactionGroup,
  Invite,
  Ban,
  AuditLogEntry,
  ReadState,
  VoiceState,
  SharedFolder,
  SharedFile,
  ChannelFile,
} from 'ecto-shared';

interface ProfileData {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  discriminator?: string;
}

export function formatServer(
  row: {
    id: string;
    name: string;
    description: string | null;
    iconUrl: string | null;
    bannerUrl: string | null;
    address: string | null;
    centralConnected: boolean;
    adminUserId: string | null;
    defaultChannelId: string | null;
  },
  config?: { setupCompleted: boolean },
): Server {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon_url: row.iconUrl,
    banner_url: row.bannerUrl,
    address: row.address ?? '',
    central_connected: row.centralConnected,
    setup_completed: config?.setupCompleted ?? true,
    admin_user_id: row.adminUserId,
    default_channel_id: row.defaultChannelId ?? null,
  };
}

export function formatChannel(row: {
  id: string;
  serverId: string;
  categoryId: string | null;
  name: string;
  type: string;
  topic: string | null;
  position: number;
  slowmodeSeconds: number;
  nsfw: boolean;
}, myPermissions?: number): Channel {
  return {
    id: row.id,
    server_id: row.serverId,
    category_id: row.categoryId,
    name: row.name,
    type: row.type as 'text' | 'voice' | 'page',
    topic: row.topic,
    position: row.position,
    slowmode_seconds: row.slowmodeSeconds,
    nsfw: row.nsfw,
    ...(myPermissions !== undefined && { my_permissions: myPermissions }),
  };
}

export function formatCategory(row: {
  id: string;
  serverId: string;
  name: string;
  position: number;
}): Category {
  return {
    id: row.id,
    server_id: row.serverId,
    name: row.name,
    position: row.position,
  };
}

export function formatRole(row: {
  id: string;
  serverId: string;
  name: string;
  color: string | null;
  permissions: number;
  position: number;
  isDefault: boolean;
}): Role {
  return {
    id: row.id,
    server_id: row.serverId,
    name: row.name,
    color: row.color,
    permissions: row.permissions,
    position: row.position,
    is_default: row.isDefault,
  };
}

export function formatMember(
  row: {
    id: string;
    serverId: string;
    userId: string;
    identityType: string;
    nickname: string | null;
    allowDms: boolean;
    joinedAt: Date;
  },
  profile: ProfileData,
  roleIds: string[],
): Member {
  return {
    id: row.id,
    server_id: row.serverId,
    user_id: row.userId,
    identity_type: row.identityType as 'global' | 'local',
    nickname: row.nickname,
    allow_dms: row.allowDms,
    joined_at: row.joinedAt.toISOString(),
    roles: roleIds,
    username: profile.username,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
    discriminator: profile.discriminator,
  };
}

export function formatMessageAuthor(
  profile: ProfileData,
  userId: string,
  nickname: string | null,
): MessageAuthor {
  return {
    id: userId,
    username: profile.username,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
    nickname,
  };
}

export function formatAttachment(row: {
  id: string;
  filename: string;
  url: string;
  contentType: string;
  sizeBytes: number;
}): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    url: row.url,
    content_type: row.contentType,
    size_bytes: row.sizeBytes,
  };
}

export function formatMessage(
  row: {
    id: string;
    channelId: string;
    authorId: string;
    content: string | null;
    type: number;
    replyTo: string | null;
    pinned: boolean;
    mentionEveryone: boolean;
    mentionRoles: string[] | null;
    mentionUsers: string[] | null;
    webhookId?: string | null;
    editedAt: Date | null;
    createdAt: Date;
  },
  author: MessageAuthor,
  messageAttachments: Attachment[],
  reactions: ReactionGroup[],
): Message {
  return {
    id: row.id,
    channel_id: row.channelId,
    author,
    content: row.content,
    type: row.type,
    reply_to: row.replyTo,
    pinned: row.pinned,
    mention_everyone: row.mentionEveryone,
    mention_roles: row.mentionRoles ?? [],
    mentions: row.mentionUsers ?? [],
    edited_at: row.editedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    attachments: messageAttachments,
    reactions,
    webhook_id: row.webhookId ?? null,
  };
}

export function formatInvite(
  row: {
    id: string;
    serverId: string;
    code: string;
    createdBy: string;
    maxUses: number | null;
    useCount: number;
    expiresAt: Date | null;
    revoked: boolean;
    createdAt: Date;
  },
  creatorName: string,
): Invite {
  return {
    id: row.id,
    server_id: row.serverId,
    code: row.code,
    created_by: row.createdBy,
    max_uses: row.maxUses,
    use_count: row.useCount,
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked: row.revoked,
    created_at: row.createdAt.toISOString(),
    creator_name: creatorName,
  };
}

export function formatBan(
  row: {
    id: string;
    serverId: string;
    userId: string;
    bannedBy: string;
    reason: string | null;
    createdAt: Date;
  },
  username: string,
  bannedByName: string,
): Ban {
  return {
    id: row.id,
    server_id: row.serverId,
    user_id: row.userId,
    banned_by: row.bannedBy,
    reason: row.reason,
    created_at: row.createdAt.toISOString(),
    username,
    banned_by_name: bannedByName,
  };
}

export function formatAuditLogEntry(
  row: {
    id: string;
    serverId: string;
    actorId: string;
    action: string;
    targetType: string | null;
    targetId: string | null;
    details: unknown;
    createdAt: Date;
  },
  actorName: string,
): AuditLogEntry {
  return {
    id: row.id,
    server_id: row.serverId,
    actor_id: row.actorId,
    action: row.action as AuditLogEntry['action'],
    target_type: row.targetType as AuditLogEntry['target_type'],
    target_id: row.targetId,
    details: (row.details as Record<string, unknown>) ?? null,
    created_at: row.createdAt.toISOString(),
    actor_name: actorName,
  };
}

export function formatReadState(row: {
  userId: string;
  channelId: string;
  lastReadMessageId: string | null;
  mentionCount: number;
}): ReadState {
  return {
    user_id: row.userId,
    channel_id: row.channelId,
    last_read_message_id: row.lastReadMessageId,
    mention_count: row.mentionCount,
  };
}

export function formatVoiceState(state: {
  userId: string;
  channelId: string;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMute: boolean;
  serverDeaf: boolean;
  videoEnabled: boolean;
  connectedAt: string;
}): VoiceState {
  return {
    user_id: state.userId,
    channel_id: state.channelId,
    self_mute: state.selfMute,
    self_deaf: state.selfDeaf,
    server_mute: state.serverMute,
    server_deaf: state.serverDeaf,
    video_enabled: state.videoEnabled,
    connected_at: state.connectedAt,
  };
}

export function formatSharedFolder(
  row: {
    id: string;
    name: string;
    parentId: string | null;
    createdBy: string;
    createdAt: Date;
  },
  fileCount: number,
  totalSizeBytes: number,
  contributors: { user_id: string; username: string }[] = [],
  hasOverrides = false,
): SharedFolder {
  return {
    id: row.id,
    name: row.name,
    parent_id: row.parentId,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    file_count: fileCount,
    total_size_bytes: totalSizeBytes,
    contributors,
    ...(hasOverrides && { has_overrides: true }),
  };
}

export function formatSharedFile(
  row: {
    id: string;
    folderId: string | null;
    filename: string;
    url: string;
    contentType: string;
    sizeBytes: number;
    uploadedBy: string;
    createdAt: Date;
  },
  uploaderName: string,
  hasOverrides = false,
): SharedFile {
  return {
    id: row.id,
    folder_id: row.folderId,
    filename: row.filename,
    url: row.url,
    content_type: row.contentType,
    size_bytes: row.sizeBytes,
    uploaded_by: row.uploadedBy,
    uploaded_by_name: uploaderName,
    created_at: row.createdAt.toISOString(),
    ...(hasOverrides && { has_overrides: true }),
  };
}

export function formatChannelFile(
  row: {
    id: string;
    filename: string;
    url: string;
    contentType: string;
    sizeBytes: number;
    createdAt: Date;
  },
  messageId: string,
  channelId: string,
  channelName: string,
  categoryName: string | null,
  uploadedBy: string,
  uploaderName: string,
): ChannelFile {
  return {
    id: row.id,
    filename: row.filename,
    url: row.url,
    content_type: row.contentType,
    size_bytes: row.sizeBytes,
    message_id: messageId,
    channel_id: channelId,
    channel_name: channelName,
    category_name: categoryName,
    uploaded_by: uploadedBy,
    uploaded_by_name: uploaderName,
    created_at: row.createdAt.toISOString(),
  };
}
