import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { newsPosts, newsComments, channels, members, servers, serverConfig } from '../../db/schema/index.js';
import { eq, and, lt, gt, desc, asc, sql } from 'drizzle-orm';
import { generateUUIDv7, Permissions, EctoErrorCode, ServerWsEvents } from 'ecto-shared';
import { requirePermission } from '../../utils/permission-context.js';
import { formatMessageAuthor } from '../../utils/format.js';
import { ectoError } from '../../utils/errors.js';
import { resolveUserProfile } from '../../utils/resolve-profile.js';
import { eventDispatcher } from '../../ws/event-dispatcher.js';
import { syncNewsPostToCentral, deleteNewsPostFromCentral } from '../../services/central-news-sync.js';
import type { Db } from '../../db/index.js';

async function getAuthorInfo(d: Db, serverId: string, userId: string) {
  const [member] = await d
    .select({ nickname: members.nickname, identityType: members.identityType })
    .from(members)
    .where(and(eq(members.serverId, serverId), eq(members.userId, userId)))
    .limit(1);

  const profile = await resolveUserProfile(d, userId, (member?.identityType as 'global' | 'local') ?? 'global');
  return formatMessageAuthor(profile, userId, member?.nickname ?? null);
}

export const newsRouter = router({
  listPosts: protectedProcedure
    .input(
      z.object({
        channel_id: z.string().uuid(),
        before: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.READ_MESSAGES, input.channel_id);

      const limit = input.limit ?? 20;
      const conditions = [eq(newsPosts.channelId, input.channel_id)];
      if (input.before) conditions.push(lt(newsPosts.id, input.before));

      const rows = await ctx.db
        .select()
        .from(newsPosts)
        .where(and(...conditions))
        .orderBy(desc(newsPosts.publishedAt))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;

      // Resolve authors
      const authorIds = [...new Set(items.map((r) => r.authorId))];
      const authors = new Map<string, Awaited<ReturnType<typeof getAuthorInfo>>>();
      for (const authorId of authorIds) {
        authors.set(authorId, await getAuthorInfo(ctx.db, ctx.serverId, authorId));
      }

      return {
        posts: items.map((r) => ({
          id: r.id,
          channel_id: r.channelId,
          author: authors.get(r.authorId)!,
          title: r.title,
          subtitle: r.subtitle ?? null,
          hero_image_url: r.heroImageUrl ?? null,
          content: r.content,
          published_at: r.publishedAt.toISOString(),
          created_at: r.createdAt.toISOString(),
          updated_at: r.updatedAt.toISOString(),
          comment_count: r.commentCount,
          submitted_to_discovery: r.submittedToDiscovery,
          discovery_validation_errors: r.discoveryValidationErrors ?? null,
        })),
        has_more: hasMore,
      };
    }),

  getPost: protectedProcedure
    .input(z.object({ post_id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [post] = await ctx.db
        .select()
        .from(newsPosts)
        .where(eq(newsPosts.id, input.post_id))
        .limit(1);

      if (!post) throw ectoError('NOT_FOUND', EctoErrorCode.NEWS_POST_NOT_FOUND, 'News post not found');

      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.READ_MESSAGES, post.channelId);

      const author = await getAuthorInfo(ctx.db, ctx.serverId, post.authorId);

      return {
        id: post.id,
        channel_id: post.channelId,
        author,
        title: post.title,
        subtitle: post.subtitle ?? null,
        hero_image_url: post.heroImageUrl ?? null,
        content: post.content,
        published_at: post.publishedAt.toISOString(),
        created_at: post.createdAt.toISOString(),
        updated_at: post.updatedAt.toISOString(),
        comment_count: post.commentCount,
        submitted_to_discovery: post.submittedToDiscovery,
        discovery_validation_errors: post.discoveryValidationErrors ?? null,
      };
    }),

  createPost: protectedProcedure
    .input(
      z.object({
        channel_id: z.string().uuid(),
        title: z.string().min(1).max(200),
        subtitle: z.string().max(500).optional(),
        hero_image_url: z.string().max(512).optional(),
        content: z.string().min(1).max(100_000),
        submit_to_discovery: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Verify channel is a news channel
      const [ch] = await ctx.db
        .select({ type: channels.type })
        .from(channels)
        .where(and(eq(channels.id, input.channel_id), eq(channels.serverId, ctx.serverId)))
        .limit(1);

      if (!ch || ch.type !== 'news') {
        throw ectoError('BAD_REQUEST', EctoErrorCode.NEWS_CHANNEL_REQUIRED, 'Channel is not a news channel');
      }

      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_NEWS, input.channel_id);

      const id = generateUUIDv7();
      const now = new Date();
      const submittedToDiscovery = input.submit_to_discovery ?? false;

      // Only central (global) users on approved discoverable servers can submit
      if (submittedToDiscovery) {
        const [member] = await ctx.db
          .select({ identityType: members.identityType })
          .from(members)
          .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, ctx.user.id)))
          .limit(1);
        if (member?.identityType !== 'global') {
          throw ectoError('FORBIDDEN', EctoErrorCode.DISCOVERY_CENTRAL_ACCOUNT_REQUIRED, 'Only central account users can submit to Ecto Discover');
        }
        const [cfg] = await ctx.db
          .select({ discoverable: serverConfig.discoverable, discoveryApproved: serverConfig.discoveryApproved })
          .from(serverConfig)
          .where(eq(serverConfig.serverId, ctx.serverId))
          .limit(1);
        if (!cfg?.discoverable || !cfg.discoveryApproved) {
          throw ectoError('FORBIDDEN', EctoErrorCode.DISCOVERY_NOT_APPROVED, 'Server is not approved for discovery');
        }
      }

      await ctx.db.insert(newsPosts).values({
        id,
        channelId: input.channel_id,
        authorId: ctx.user.id,
        title: input.title,
        subtitle: input.subtitle ?? null,
        heroImageUrl: input.hero_image_url ?? null,
        content: input.content,
        submittedToDiscovery,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const author = await getAuthorInfo(ctx.db, ctx.serverId, ctx.user.id);

      let discoveryValidationErrors: string[] | null = null;

      // Sync to central discovery only when opted in
      if (submittedToDiscovery) {
        const [srv] = await ctx.db.select().from(servers).where(eq(servers.id, ctx.serverId)).limit(1);
        if (srv) {
          discoveryValidationErrors = await syncNewsPostToCentral({
            id,
            server_id: ctx.serverId,
            server_address: srv.address ?? '',
            server_name: srv.name,
            server_icon_url: srv.iconUrl,
            author_id: ctx.user.id,
            author_name: author.display_name ?? author.username,
            author_avatar_url: author.avatar_url,
            title: input.title,
            subtitle: input.subtitle ?? null,
            hero_image_url: input.hero_image_url ?? null,
            published_at: now.toISOString(),
          });

          if (discoveryValidationErrors) {
            await ctx.db.update(newsPosts).set({ discoveryValidationErrors }).where(eq(newsPosts.id, id));
          }
        }
      }

      const result = {
        id,
        channel_id: input.channel_id,
        author,
        title: input.title,
        subtitle: input.subtitle ?? null,
        hero_image_url: input.hero_image_url ?? null,
        content: input.content,
        published_at: now.toISOString(),
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        comment_count: 0,
        submitted_to_discovery: submittedToDiscovery,
        discovery_validation_errors: discoveryValidationErrors,
      };

      eventDispatcher.dispatchToChannel(input.channel_id, ServerWsEvents.NEWS_POST_CREATE, result);

      return result;
    }),

  updatePost: protectedProcedure
    .input(
      z.object({
        post_id: z.string().uuid(),
        title: z.string().min(1).max(200).optional(),
        subtitle: z.string().max(500).nullable().optional(),
        hero_image_url: z.string().max(512).nullable().optional(),
        content: z.string().min(1).max(100_000).optional(),
        submit_to_discovery: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [post] = await ctx.db
        .select()
        .from(newsPosts)
        .where(eq(newsPosts.id, input.post_id))
        .limit(1);

      if (!post) throw ectoError('NOT_FOUND', EctoErrorCode.NEWS_POST_NOT_FOUND, 'News post not found');

      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_NEWS, post.channelId);

      // Posts submitted to discovery are locked — only allow retracting
      if (post.submittedToDiscovery) {
        const hasContentChanges = input.title !== undefined || input.subtitle !== undefined
          || input.hero_image_url !== undefined || input.content !== undefined;
        if (hasContentChanges) {
          throw ectoError('FORBIDDEN', EctoErrorCode.DISCOVERY_NOT_APPROVED, 'Retract from Ecto Discover before editing');
        }
      }

      // Only central (global) users on approved discoverable servers can submit
      if (input.submit_to_discovery === true && !post.submittedToDiscovery) {
        const [member] = await ctx.db
          .select({ identityType: members.identityType })
          .from(members)
          .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, ctx.user.id)))
          .limit(1);
        if (member?.identityType !== 'global') {
          throw ectoError('FORBIDDEN', EctoErrorCode.DISCOVERY_CENTRAL_ACCOUNT_REQUIRED, 'Only central account users can submit to Ecto Discover');
        }
        const [cfg] = await ctx.db
          .select({ discoverable: serverConfig.discoverable, discoveryApproved: serverConfig.discoveryApproved })
          .from(serverConfig)
          .where(eq(serverConfig.serverId, ctx.serverId))
          .limit(1);
        if (!cfg?.discoverable || !cfg.discoveryApproved) {
          throw ectoError('FORBIDDEN', EctoErrorCode.DISCOVERY_NOT_APPROVED, 'Server is not approved for discovery');
        }
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.title !== undefined) updates['title'] = input.title;
      if (input.subtitle !== undefined) updates['subtitle'] = input.subtitle;
      if (input.hero_image_url !== undefined) updates['heroImageUrl'] = input.hero_image_url;
      if (input.content !== undefined) updates['content'] = input.content;
      if (input.submit_to_discovery !== undefined) updates['submittedToDiscovery'] = input.submit_to_discovery;

      await ctx.db.update(newsPosts).set(updates).where(eq(newsPosts.id, input.post_id));

      const [updated] = await ctx.db.select().from(newsPosts).where(eq(newsPosts.id, input.post_id)).limit(1);
      if (!updated) throw ectoError('NOT_FOUND', EctoErrorCode.NEWS_POST_NOT_FOUND, 'News post not found');

      const author = await getAuthorInfo(ctx.db, ctx.serverId, updated.authorId);

      let discoveryValidationErrors: string[] | null = updated.discoveryValidationErrors ?? null;

      // Sync or retract from central discovery based on opt-in
      if (updated.submittedToDiscovery) {
        const [srv] = await ctx.db.select().from(servers).where(eq(servers.id, ctx.serverId)).limit(1);
        if (srv) {
          discoveryValidationErrors = await syncNewsPostToCentral({
            id: updated.id,
            server_id: ctx.serverId,
            server_address: srv.address ?? '',
            server_name: srv.name,
            server_icon_url: srv.iconUrl,
            author_id: updated.authorId,
            author_name: author.display_name ?? author.username,
            author_avatar_url: author.avatar_url,
            title: updated.title,
            subtitle: updated.subtitle ?? null,
            hero_image_url: updated.heroImageUrl ?? null,
            published_at: updated.publishedAt.toISOString(),
          });

          await ctx.db.update(newsPosts).set({ discoveryValidationErrors }).where(eq(newsPosts.id, updated.id));
        }
      } else if (input.submit_to_discovery === false && post.submittedToDiscovery) {
        // Retract: was previously submitted, now opted out
        deleteNewsPostFromCentral(updated.id);
        discoveryValidationErrors = null;
        await ctx.db.update(newsPosts).set({ discoveryValidationErrors: null }).where(eq(newsPosts.id, updated.id));
      }

      const result = {
        id: updated.id,
        channel_id: updated.channelId,
        author,
        title: updated.title,
        subtitle: updated.subtitle ?? null,
        hero_image_url: updated.heroImageUrl ?? null,
        content: updated.content,
        published_at: updated.publishedAt.toISOString(),
        created_at: updated.createdAt.toISOString(),
        updated_at: updated.updatedAt.toISOString(),
        comment_count: updated.commentCount,
        submitted_to_discovery: updated.submittedToDiscovery,
        discovery_validation_errors: discoveryValidationErrors,
      };

      eventDispatcher.dispatchToChannel(updated.channelId, ServerWsEvents.NEWS_POST_UPDATE, result);

      return result;
    }),

  deletePost: protectedProcedure
    .input(z.object({ post_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [post] = await ctx.db
        .select()
        .from(newsPosts)
        .where(eq(newsPosts.id, input.post_id))
        .limit(1);

      if (!post) throw ectoError('NOT_FOUND', EctoErrorCode.NEWS_POST_NOT_FOUND, 'News post not found');

      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_NEWS, post.channelId);

      await ctx.db.delete(newsPosts).where(eq(newsPosts.id, input.post_id));

      eventDispatcher.dispatchToChannel(post.channelId, ServerWsEvents.NEWS_POST_DELETE, {
        id: input.post_id,
        channel_id: post.channelId,
      });

      deleteNewsPostFromCentral(input.post_id);

      return { success: true };
    }),

  listComments: protectedProcedure
    .input(
      z.object({
        post_id: z.string().uuid(),
        after: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [post] = await ctx.db
        .select({ channelId: newsPosts.channelId })
        .from(newsPosts)
        .where(eq(newsPosts.id, input.post_id))
        .limit(1);

      if (!post) throw ectoError('NOT_FOUND', EctoErrorCode.NEWS_POST_NOT_FOUND, 'News post not found');

      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.READ_MESSAGES, post.channelId);

      const limit = input.limit ?? 50;
      const conditions = [eq(newsComments.postId, input.post_id)];
      if (input.after) conditions.push(gt(newsComments.id, input.after));

      const rows = await ctx.db
        .select()
        .from(newsComments)
        .where(and(...conditions))
        .orderBy(asc(newsComments.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;

      // Resolve authors
      const authorIds = [...new Set(items.map((r) => r.authorId))];
      const authors = new Map<string, Awaited<ReturnType<typeof getAuthorInfo>>>();
      for (const authorId of authorIds) {
        authors.set(authorId, await getAuthorInfo(ctx.db, ctx.serverId, authorId));
      }

      return {
        comments: items.map((r) => ({
          id: r.id,
          post_id: r.postId,
          author: authors.get(r.authorId)!,
          content: r.content,
          created_at: r.createdAt.toISOString(),
          edited_at: r.editedAt?.toISOString() ?? null,
        })),
        has_more: hasMore,
      };
    }),

  addComment: protectedProcedure
    .input(
      z.object({
        post_id: z.string().uuid(),
        content: z.string().min(1).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [post] = await ctx.db
        .select({ channelId: newsPosts.channelId })
        .from(newsPosts)
        .where(eq(newsPosts.id, input.post_id))
        .limit(1);

      if (!post) throw ectoError('NOT_FOUND', EctoErrorCode.NEWS_POST_NOT_FOUND, 'News post not found');

      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.SEND_MESSAGES, post.channelId);

      const id = generateUUIDv7();
      const now = new Date();

      await ctx.db.insert(newsComments).values({
        id,
        postId: input.post_id,
        authorId: ctx.user.id,
        content: input.content,
        createdAt: now,
      });

      // Increment comment count
      await ctx.db
        .update(newsPosts)
        .set({ commentCount: sql`${newsPosts.commentCount} + 1` })
        .where(eq(newsPosts.id, input.post_id));

      const author = await getAuthorInfo(ctx.db, ctx.serverId, ctx.user.id);

      const result = {
        id,
        post_id: input.post_id,
        author,
        content: input.content,
        created_at: now.toISOString(),
        edited_at: null,
      };

      eventDispatcher.dispatchToChannel(post.channelId, ServerWsEvents.NEWS_COMMENT_CREATE, result);

      return result;
    }),

  deleteComment: protectedProcedure
    .input(z.object({ comment_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [comment] = await ctx.db
        .select()
        .from(newsComments)
        .where(eq(newsComments.id, input.comment_id))
        .limit(1);

      if (!comment) throw ectoError('NOT_FOUND', EctoErrorCode.NEWS_COMMENT_NOT_FOUND, 'Comment not found');

      const [post] = await ctx.db
        .select({ channelId: newsPosts.channelId })
        .from(newsPosts)
        .where(eq(newsPosts.id, comment.postId))
        .limit(1);

      if (!post) throw ectoError('NOT_FOUND', EctoErrorCode.NEWS_POST_NOT_FOUND, 'News post not found');

      // Author can delete their own, or MANAGE_NEWS can delete any
      if (comment.authorId !== ctx.user.id) {
        await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_NEWS, post.channelId);
      }

      await ctx.db.delete(newsComments).where(eq(newsComments.id, input.comment_id));

      // Decrement comment count
      await ctx.db
        .update(newsPosts)
        .set({ commentCount: sql`GREATEST(${newsPosts.commentCount} - 1, 0)` })
        .where(eq(newsPosts.id, comment.postId));

      eventDispatcher.dispatchToChannel(post.channelId, ServerWsEvents.NEWS_COMMENT_DELETE, {
        id: input.comment_id,
        post_id: comment.postId,
      });

      return { success: true };
    }),
});
