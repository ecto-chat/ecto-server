import { z } from 'zod/v4';
import fs from 'node:fs';
import path from 'node:path';
import { router, protectedProcedure } from '../init.js';
import {
  sharedFolders,
  sharedFiles,
  sharedItemPermissionOverrides,
  attachments,
  messages,
  channels,
  categories,
  serverConfig,
  roles,
  channelPermissionOverrides,
  categoryPermissionOverrides,
} from '../../db/schema/index.js';
import { eq, and, desc, lt, sql, inArray, isNull } from 'drizzle-orm';
import { Permissions, generateUUIDv7, computePermissions, hasPermission } from 'ecto-shared';
import {
  formatSharedFolder,
  formatSharedFile,
  formatChannelFile,
  formatAttachment,
} from '../../utils/format.js';
import {
  requirePermission,
  buildPermissionContext,
  buildBatchPermissionContext,
} from '../../utils/permission-context.js';
import { batchFilterByBrowseFiles, resolveSharedItemAccess } from '../../utils/shared-permissions.js';
import { insertAuditLog } from '../../utils/audit-log.js';
import { ectoError } from '../../utils/errors.js';
import { resolveUserProfiles } from '../../utils/resolve-profile.js';
import { eventDispatcher } from '../../ws/event-dispatcher.js';
import { config } from '../../config/index.js';

export const hubFilesRouter = router({
  // ── Shared Tab — Folders ──────────────────────────────────────────

  listFolders: protectedProcedure
    .input(z.object({ parent_id: z.string().uuid().nullable() }))
    .query(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.BROWSE_FILES);
      const d = ctx.db;

      const condition = input.parent_id
        ? and(eq(sharedFolders.serverId, ctx.serverId), eq(sharedFolders.parentId, input.parent_id))
        : and(eq(sharedFolders.serverId, ctx.serverId), isNull(sharedFolders.parentId));

      const folders = await d
        .select()
        .from(sharedFolders)
        .where(condition)
        .orderBy(sharedFolders.name);

      // Get file counts and total sizes for each folder
      const folderIds = folders.map((f) => f.id);
      const stats = folderIds.length > 0
        ? await d
            .select({
              folderId: sharedFiles.folderId,
              fileCount: sql<number>`count(*)::int`,
              totalSize: sql<number>`coalesce(sum(${sharedFiles.sizeBytes}), 0)::int`,
            })
            .from(sharedFiles)
            .where(inArray(sharedFiles.folderId, folderIds))
            .groupBy(sharedFiles.folderId)
        : [];

      const statsMap = new Map(stats.map((s) => [s.folderId, s]));

      // Get unique uploaders per folder
      const uploaderRows = folderIds.length > 0
        ? await d
            .select({
              folderId: sharedFiles.folderId,
              uploadedBy: sharedFiles.uploadedBy,
            })
            .from(sharedFiles)
            .where(inArray(sharedFiles.folderId, folderIds))
            .groupBy(sharedFiles.folderId, sharedFiles.uploadedBy)
        : [];

      // Resolve uploader profiles
      const allUploaderIds = [...new Set(uploaderRows.map((r) => r.uploadedBy))];
      const profiles = allUploaderIds.length > 0
        ? await resolveUserProfiles(d, allUploaderIds)
        : new Map<string, { username: string }>();

      // Build contributors map: folderId → { user_id, username }[]
      const contributorsMap = new Map<string, { user_id: string; username: string }[]>();
      for (const row of uploaderRows) {
        const fId = row.folderId;
        if (!fId) continue;
        let list = contributorsMap.get(fId);
        if (!list) { list = []; contributorsMap.set(fId, list); }
        list.push({
          user_id: row.uploadedBy,
          username: profiles.get(row.uploadedBy)?.username ?? 'Unknown',
        });
      }

      // Filter by per-item BROWSE_FILES permission
      const { items: visibleFolders, overrideItemIds } = await batchFilterByBrowseFiles(
        d, ctx.serverId, ctx.user.id, folders, 'folder',
      );

      return visibleFolders.map((f) => {
        const s = statsMap.get(f.id);
        return formatSharedFolder(
          f, s?.fileCount ?? 0, s?.totalSize ?? 0,
          contributorsMap.get(f.id) ?? [],
          overrideItemIds.has(f.id),
        );
      });
    }),

  createFolder: protectedProcedure
    .input(z.object({
      name: z.string().min(1).max(255),
      parent_id: z.string().uuid().nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = ctx.db;

      // Validate parent exists if specified
      if (input.parent_id) {
        const [parent] = await d
          .select({ id: sharedFolders.id })
          .from(sharedFolders)
          .where(and(eq(sharedFolders.id, input.parent_id), eq(sharedFolders.serverId, ctx.serverId)))
          .limit(1);
        if (!parent) throw ectoError('NOT_FOUND', 2000, 'Parent folder not found');

        // Check UPLOAD_SHARED_FILES resolved through parent folder chain
        const effective = await resolveSharedItemAccess(d, ctx.serverId, ctx.user.id, 'folder', input.parent_id);
        if (!hasPermission(effective, Permissions.UPLOAD_SHARED_FILES)) {
          throw ectoError('FORBIDDEN', 5001, 'Insufficient permissions');
        }
      } else {
        await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.UPLOAD_SHARED_FILES);
      }

      const id = generateUUIDv7();
      const [folder] = await d.insert(sharedFolders).values({
        id,
        serverId: ctx.serverId,
        parentId: input.parent_id,
        name: input.name,
        createdBy: ctx.user.id,
      }).returning();

      const result = formatSharedFolder(folder!, 0, 0);
      eventDispatcher.dispatchToAll('shared_folder.create', result);
      return result;
    }),

  renameFolder: protectedProcedure
    .input(z.object({
      folder_id: z.string().uuid(),
      name: z.string().min(1).max(255),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = ctx.db;
      const [folder] = await d
        .select()
        .from(sharedFolders)
        .where(and(eq(sharedFolders.id, input.folder_id), eq(sharedFolders.serverId, ctx.serverId)))
        .limit(1);

      if (!folder) throw ectoError('NOT_FOUND', 2000, 'Folder not found');

      // Creator can rename with UPLOAD_SHARED_FILES, others need MANAGE_FILES
      if (folder.createdBy === ctx.user.id) {
        await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.UPLOAD_SHARED_FILES);
      } else {
        await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_FILES);
      }

      await d
        .update(sharedFolders)
        .set({ name: input.name })
        .where(eq(sharedFolders.id, input.folder_id));

      return { success: true };
    }),

  deleteFolder: protectedProcedure
    .input(z.object({ folder_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const d = ctx.db;
      const [folder] = await d
        .select()
        .from(sharedFolders)
        .where(and(eq(sharedFolders.id, input.folder_id), eq(sharedFolders.serverId, ctx.serverId)))
        .limit(1);

      if (!folder) throw ectoError('NOT_FOUND', 2000, 'Folder not found');

      // Check MANAGE_FILES resolved through folder's override chain
      if (folder.createdBy === ctx.user.id) {
        const effective = await resolveSharedItemAccess(d, ctx.serverId, ctx.user.id, 'folder', input.folder_id);
        if (!hasPermission(effective, Permissions.UPLOAD_SHARED_FILES)) {
          throw ectoError('FORBIDDEN', 5001, 'Insufficient permissions');
        }
      } else {
        const effective = await resolveSharedItemAccess(d, ctx.serverId, ctx.user.id, 'folder', input.folder_id);
        if (!hasPermission(effective, Permissions.MANAGE_FILES)) {
          throw ectoError('FORBIDDEN', 5001, 'Insufficient permissions');
        }
      }

      // Use recursive CTE to find all descendant folder IDs
      const descendantRows = await d.execute(sql`
        WITH RECURSIVE folder_tree AS (
          SELECT id FROM shared_folders WHERE id = ${input.folder_id}
          UNION ALL
          SELECT sf.id FROM shared_folders sf
          INNER JOIN folder_tree ft ON sf.parent_id = ft.id
        )
        SELECT id FROM folder_tree
      `) as { rows: { id: string }[] };

      const allFolderIds = descendantRows.rows.map((r) => r.id);

      if (allFolderIds.length > 0) {
        // Get file IDs in descendant folders for override cleanup
        const descendantFileRows = await d
          .select({ id: sharedFiles.id })
          .from(sharedFiles)
          .where(inArray(sharedFiles.folderId, allFolderIds));
        const descendantFileIds = descendantFileRows.map((r) => r.id);

        // Delete overrides for descendant folders and their files
        await d.delete(sharedItemPermissionOverrides).where(
          inArray(sharedItemPermissionOverrides.itemId, [...allFolderIds, ...descendantFileIds]),
        );

        // Delete shared files and folders
        await d.delete(sharedFiles).where(inArray(sharedFiles.folderId, allFolderIds));
        await d.delete(sharedFolders).where(inArray(sharedFolders.id, allFolderIds));
      }

      // Delete disk directory
      for (const folderId of allFolderIds) {
        const dirPath = path.join(config.UPLOAD_DIR, ctx.serverId, 'shared', folderId);
        await fs.promises.rm(dirPath, { recursive: true, force: true }).catch(() => {});
      }

      await insertAuditLog(d, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'shared_folder.delete',
        targetType: 'shared_folder',
        targetId: input.folder_id,
        details: { name: folder.name },
      });

      eventDispatcher.dispatchToAll('shared_folder.delete', { id: input.folder_id });
      return { success: true };
    }),

  // ── Shared Tab — Files ────────────────────────────────────────────

  listSharedFiles: protectedProcedure
    .input(z.object({
      folder_id: z.string().uuid().nullable(),
      cursor: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }))
    .query(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.BROWSE_FILES);
      const d = ctx.db;
      const limit = input.limit ?? 50;

      const conditions = [eq(sharedFiles.serverId, ctx.serverId)];
      if (input.folder_id) {
        conditions.push(eq(sharedFiles.folderId, input.folder_id));
      } else {
        conditions.push(isNull(sharedFiles.folderId));
      }
      if (input.cursor) {
        conditions.push(lt(sharedFiles.id, input.cursor));
      }

      const rows = await d
        .select()
        .from(sharedFiles)
        .where(and(...conditions))
        .orderBy(desc(sharedFiles.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const files = hasMore ? rows.slice(0, limit) : rows;

      // Resolve uploader names
      const uploaderIds = [...new Set(files.map((f) => f.uploadedBy))];
      const profiles = await resolveUserProfiles(d, uploaderIds);

      // Filter by per-item BROWSE_FILES permission
      const { items: visibleFiles, overrideItemIds } = await batchFilterByBrowseFiles(
        d, ctx.serverId, ctx.user.id,
        files.map((f) => ({ ...f, id: f.id, folder_id: f.folderId })),
        'file',
      );

      return {
        files: visibleFiles.map((f) =>
          formatSharedFile(f, profiles.get(f.uploadedBy)?.username ?? 'Unknown', overrideItemIds.has(f.id)),
        ),
        has_more: hasMore,
      };
    }),

  deleteSharedFile: protectedProcedure
    .input(z.object({ file_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const d = ctx.db;
      const [file] = await d
        .select()
        .from(sharedFiles)
        .where(and(eq(sharedFiles.id, input.file_id), eq(sharedFiles.serverId, ctx.serverId)))
        .limit(1);

      if (!file) throw ectoError('NOT_FOUND', 2000, 'File not found');

      // Check permissions through file's folder override chain
      const effective = await resolveSharedItemAccess(d, ctx.serverId, ctx.user.id, 'file', input.file_id);
      if (file.uploadedBy === ctx.user.id) {
        if (!hasPermission(effective, Permissions.BROWSE_FILES)) {
          throw ectoError('FORBIDDEN', 5001, 'Insufficient permissions');
        }
      } else {
        if (!hasPermission(effective, Permissions.MANAGE_FILES)) {
          throw ectoError('FORBIDDEN', 5001, 'Insufficient permissions');
        }
      }

      // Delete overrides for this file
      await d.delete(sharedItemPermissionOverrides).where(
        and(
          eq(sharedItemPermissionOverrides.itemType, 'file'),
          eq(sharedItemPermissionOverrides.itemId, input.file_id),
        ),
      );
      await d.delete(sharedFiles).where(eq(sharedFiles.id, input.file_id));

      // Delete from disk
      const folderPart = file.folderId ?? 'root';
      const dirPath = path.join(config.UPLOAD_DIR, ctx.serverId, 'shared', folderPart, input.file_id);
      await fs.promises.rm(dirPath, { recursive: true, force: true }).catch(() => {});

      await insertAuditLog(d, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'shared_file.delete',
        targetType: 'shared_file',
        targetId: input.file_id,
        details: { filename: file.filename },
      });

      eventDispatcher.dispatchToAll('shared_file.delete', { id: input.file_id, folder_id: file.folderId });
      return { success: true };
    }),

  // ── Server Tab — Channel Files ────────────────────────────────────

  listChannelFiles: protectedProcedure
    .input(z.object({
      channel_id: z.string().uuid().optional(),
      cursor: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }))
    .query(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.BROWSE_FILES);
      const d = ctx.db;
      const limit = input.limit ?? 50;

      // Build query joining attachments → messages → channels → categories
      const conditions = [
        eq(channels.serverId, ctx.serverId),
        eq(messages.deleted, false),
      ];
      if (input.channel_id) {
        conditions.push(eq(messages.channelId, input.channel_id));
      }
      if (input.cursor) {
        conditions.push(lt(attachments.id, input.cursor));
      }

      const rows = await d
        .select({
          attachment: attachments,
          messageId: messages.id,
          channelId: messages.channelId,
          authorId: messages.authorId,
          channelName: channels.name,
          categoryName: categories.name,
        })
        .from(attachments)
        .innerJoin(messages, eq(attachments.messageId, messages.id))
        .innerJoin(channels, eq(messages.channelId, channels.id))
        .leftJoin(categories, eq(channels.categoryId, categories.id))
        .where(and(...conditions))
        .orderBy(desc(attachments.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;

      // Filter by per-channel READ_MESSAGES permission
      const uniqueChannelIds = [...new Set(items.map((r) => r.channelId))];
      const permContexts = await buildBatchPermissionContext(d, ctx.serverId, ctx.user.id, uniqueChannelIds);
      const readableChannels = new Set<string>();
      for (const [chId, pCtx] of permContexts) {
        const effective = computePermissions(pCtx);
        if (hasPermission(effective, Permissions.READ_MESSAGES)) {
          readableChannels.add(chId);
        }
      }

      const filtered = items.filter((r) => readableChannels.has(r.channelId));

      // Resolve uploader names
      const uploaderIds = [...new Set(filtered.map((r) => r.authorId))];
      const profiles = await resolveUserProfiles(d, uploaderIds);

      return {
        files: filtered.map((r) =>
          formatChannelFile(
            r.attachment,
            r.messageId,
            r.channelId,
            r.channelName,
            r.categoryName,
            r.authorId,
            profiles.get(r.authorId)?.username ?? 'Unknown',
          ),
        ),
        has_more: hasMore,
      };
    }),

  deleteChannelFile: protectedProcedure
    .input(z.object({ attachment_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_FILES);
      const d = ctx.db;

      // Fetch attachment
      const [attachment] = await d
        .select()
        .from(attachments)
        .where(eq(attachments.id, input.attachment_id))
        .limit(1);

      if (!attachment || !attachment.messageId) {
        throw ectoError('NOT_FOUND', 2000, 'Attachment not found');
      }

      // Fetch message → verify server ownership
      const [message] = await d
        .select({
          id: messages.id,
          channelId: messages.channelId,
          content: messages.content,
        })
        .from(messages)
        .innerJoin(channels, eq(messages.channelId, channels.id))
        .where(and(eq(messages.id, attachment.messageId), eq(channels.serverId, ctx.serverId)))
        .limit(1);

      if (!message) throw ectoError('NOT_FOUND', 2000, 'Message not found');

      // Delete attachment row
      await d.delete(attachments).where(eq(attachments.id, input.attachment_id));

      // Delete physical file
      const dirPath = path.join(config.UPLOAD_DIR, ctx.serverId, message.channelId, input.attachment_id);
      await fs.promises.rm(dirPath, { recursive: true, force: true }).catch(() => {});

      // Check if message has remaining attachments
      const remaining = await d
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.messageId, message.id))
        .limit(1);

      // If no attachments left and no text content, soft-delete the message
      if (remaining.length === 0 && (!message.content || message.content.trim() === '')) {
        await d
          .update(messages)
          .set({ deleted: true })
          .where(eq(messages.id, message.id));
        eventDispatcher.dispatchToChannel(message.channelId, 'message.delete', {
          id: message.id,
          channel_id: message.channelId,
        });
      } else {
        // Dispatch message update so chat UI refreshes attachments
        const updatedAttachments = await d
          .select()
          .from(attachments)
          .where(eq(attachments.messageId, message.id));
        eventDispatcher.dispatchToChannel(message.channelId, 'message.update', {
          id: message.id,
          channel_id: message.channelId,
          attachments: updatedAttachments.map(formatAttachment),
        });
      }

      eventDispatcher.dispatchToAll('channel_file.delete', { id: input.attachment_id });

      await insertAuditLog(d, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'channel_file.delete',
        targetType: 'attachment',
        targetId: input.attachment_id,
        details: { filename: attachment.filename, message_id: message.id },
      });

      return { success: true };
    }),

  // ── Channel File Stats ───────────────────────────────────────────

  channelFileStats: protectedProcedure.query(async ({ ctx }) => {
    await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.BROWSE_FILES);
    const d = ctx.db;

    // Get all text channels for this server
    const textChannels = await d
      .select({ id: channels.id, categoryId: channels.categoryId })
      .from(channels)
      .where(and(eq(channels.serverId, ctx.serverId), eq(channels.type, 'text')));

    if (textChannels.length === 0) return [];

    const channelIds = textChannels.map((c) => c.id);

    // Aggregate attachment stats per channel
    const statsRows = await d
      .select({
        channelId: messages.channelId,
        lastUploadAt: sql<string | null>`max(${attachments.createdAt})`,
        totalSizeBytes: sql<number>`coalesce(sum(${attachments.sizeBytes}), 0)::int`,
      })
      .from(attachments)
      .innerJoin(messages, and(eq(attachments.messageId, messages.id), eq(messages.deleted, false)))
      .where(inArray(messages.channelId, channelIds))
      .groupBy(messages.channelId);

    const statsMap = new Map(statsRows.map((r) => [r.channelId, r]));

    // Get all roles for this server
    const serverRoles = await d
      .select({ id: roles.id, permissions: roles.permissions, isDefault: roles.isDefault })
      .from(roles)
      .where(eq(roles.serverId, ctx.serverId));

    // Get all channel-level permission overrides for text channels (role targets only)
    const chOverrides = await d
      .select({
        channelId: channelPermissionOverrides.channelId,
        targetId: channelPermissionOverrides.targetId,
        allow: channelPermissionOverrides.allow,
        deny: channelPermissionOverrides.deny,
      })
      .from(channelPermissionOverrides)
      .where(
        and(
          inArray(channelPermissionOverrides.channelId, channelIds),
          eq(channelPermissionOverrides.targetType, 'role'),
        ),
      );

    // Group channel overrides by channel_id → role_id
    const chOverrideMap = new Map<string, Map<string, { allow: number; deny: number }>>();
    for (const o of chOverrides) {
      let map = chOverrideMap.get(o.channelId);
      if (!map) { map = new Map(); chOverrideMap.set(o.channelId, map); }
      map.set(o.targetId, { allow: o.allow, deny: o.deny });
    }

    // Get all category-level permission overrides (role targets only)
    const catIds = [...new Set(textChannels.map((c) => c.categoryId).filter(Boolean))] as string[];
    const catOverrideMap = new Map<string, Map<string, { allow: number; deny: number }>>();
    if (catIds.length > 0) {
      const catOverrides = await d
        .select({
          categoryId: categoryPermissionOverrides.categoryId,
          targetId: categoryPermissionOverrides.targetId,
          allow: categoryPermissionOverrides.allow,
          deny: categoryPermissionOverrides.deny,
        })
        .from(categoryPermissionOverrides)
        .where(
          and(
            inArray(categoryPermissionOverrides.categoryId, catIds),
            eq(categoryPermissionOverrides.targetType, 'role'),
          ),
        );
      for (const o of catOverrides) {
        let map = catOverrideMap.get(o.categoryId);
        if (!map) { map = new Map(); catOverrideMap.set(o.categoryId, map); }
        map.set(o.targetId, { allow: o.allow, deny: o.deny });
      }
    }

    // Filter by user's READ_MESSAGES access
    const userCtxs = await buildBatchPermissionContext(d, ctx.serverId, ctx.user.id, channelIds);
    const userAccessibleChannels = new Set<string>();
    for (const [chId, pCtx] of userCtxs) {
      const effective = computePermissions(pCtx);
      if (hasPermission(effective, Permissions.READ_MESSAGES)) {
        userAccessibleChannels.add(chId);
      }
    }

    // Compute per-channel: which roles have READ_MESSAGES access
    return textChannels.filter((ch) => userAccessibleChannels.has(ch.id)).map((ch) => {
      const stat = statsMap.get(ch.id);
      const chOvr = chOverrideMap.get(ch.id);
      const catOvr = ch.categoryId ? catOverrideMap.get(ch.categoryId) : undefined;

      const accessRoleIds: string[] = [];
      for (const role of serverRoles) {
        let effective = role.permissions;

        // Apply category override if exists
        const cOvr = catOvr?.get(role.id);
        if (cOvr) {
          effective = (effective & ~cOvr.deny) | cOvr.allow;
        }

        // Apply channel override if exists (takes precedence)
        const chRoleOvr = chOvr?.get(role.id);
        if (chRoleOvr) {
          effective = (effective & ~chRoleOvr.deny) | chRoleOvr.allow;
        }

        // Administrator always has access
        if (hasPermission(effective, Permissions.ADMINISTRATOR) || hasPermission(effective, Permissions.READ_MESSAGES)) {
          accessRoleIds.push(role.id);
        }
      }

      return {
        channel_id: ch.id,
        last_upload_at: stat?.lastUploadAt ?? null,
        total_size_bytes: stat?.totalSizeBytes ?? 0,
        access_role_ids: accessRoleIds,
      };
    });
  }),

  // ── Shared Item Permissions ──────────────────────────────────────

  getItemOverrides: protectedProcedure
    .input(z.object({
      item_type: z.enum(['folder', 'file']),
      item_id: z.string().uuid(),
    }))
    .query(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_FILES);
      const d = ctx.db;

      const overrides = await d
        .select()
        .from(sharedItemPermissionOverrides)
        .where(
          and(
            eq(sharedItemPermissionOverrides.itemType, input.item_type),
            eq(sharedItemPermissionOverrides.itemId, input.item_id),
          ),
        );

      return overrides.map((o) => ({
        id: o.id,
        item_type: o.itemType as 'folder' | 'file',
        item_id: o.itemId,
        target_type: o.targetType as 'role',
        target_id: o.targetId,
        allow: o.allow,
        deny: o.deny,
      }));
    }),

  updateItemOverrides: protectedProcedure
    .input(z.object({
      item_type: z.enum(['folder', 'file']),
      item_id: z.string().uuid(),
      permission_overrides: z.array(z.object({
        target_type: z.literal('role'),
        target_id: z.string().uuid(),
        allow: z.number().int(),
        deny: z.number().int(),
      })),
    }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_FILES);
      const d = ctx.db;

      // Delete existing overrides for this item
      await d.delete(sharedItemPermissionOverrides).where(
        and(
          eq(sharedItemPermissionOverrides.itemType, input.item_type),
          eq(sharedItemPermissionOverrides.itemId, input.item_id),
        ),
      );

      // Insert new overrides (skip entries with allow=0, deny=0)
      const toInsert = input.permission_overrides.filter((o) => o.allow !== 0 || o.deny !== 0);
      if (toInsert.length > 0) {
        await d.insert(sharedItemPermissionOverrides).values(
          toInsert.map((o) => ({
            id: generateUUIDv7(),
            itemType: input.item_type,
            itemId: input.item_id,
            targetType: o.target_type,
            targetId: o.target_id,
            allow: o.allow,
            deny: o.deny,
          })),
        );
      }

      await insertAuditLog(d, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'shared_item.permissions_update',
        targetType: input.item_type === 'folder' ? 'shared_folder' : 'shared_file',
        targetId: input.item_id,
        details: { overrides_count: toInsert.length },
      });

      eventDispatcher.dispatchToAll('shared_item.permissions_update', {
        item_type: input.item_type,
        item_id: input.item_id,
      });

      return { success: true };
    }),

  // ── Quota ─────────────────────────────────────────────────────────

  getStorageQuota: protectedProcedure.query(async ({ ctx }) => {
    await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.BROWSE_FILES);
    const d = ctx.db;

    const [usage] = await d
      .select({
        usedBytes: sql<number>`coalesce(sum(${sharedFiles.sizeBytes}), 0)::int`,
      })
      .from(sharedFiles)
      .where(eq(sharedFiles.serverId, ctx.serverId));

    const [cfg] = await d
      .select({ maxSharedStorageBytes: serverConfig.maxSharedStorageBytes })
      .from(serverConfig)
      .where(eq(serverConfig.serverId, ctx.serverId))
      .limit(1);

    return {
      used_bytes: usage?.usedBytes ?? 0,
      max_bytes: cfg?.maxSharedStorageBytes ?? 104857600,
    };
  }),
});
