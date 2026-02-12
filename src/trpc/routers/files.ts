import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { attachments } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { generateUUIDv7, Permissions } from 'ecto-shared';
import { requirePermission } from '../../utils/permission-context.js';
import { ectoError } from '../../utils/errors.js';
import { formatAttachment } from '../../utils/format.js';

export const filesRouter = router({
  upload: protectedProcedure
    .input(
      z.object({
        channel_id: z.string().uuid(),
        filename: z.string().min(1).max(255),
        content_type: z.string().min(1).max(100),
        size_bytes: z.number().int().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.ATTACH_FILES, input.channel_id);

      const id = generateUUIDv7();
      const url = `/files/${id}/${encodeURIComponent(input.filename)}`;

      await ctx.db.insert(attachments).values({
        id,
        messageId: null,
        filename: input.filename,
        url,
        contentType: input.content_type,
        sizeBytes: input.size_bytes,
      });

      return formatAttachment({ id, filename: input.filename, url, contentType: input.content_type, sizeBytes: input.size_bytes });
    }),

  getUrl: protectedProcedure
    .input(z.object({ attachment_id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [att] = await ctx.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, input.attachment_id))
        .limit(1);

      if (!att) throw ectoError('NOT_FOUND', 4002, 'Attachment not found');

      return {
        url: att.url,
        filename: att.filename,
        content_type: att.contentType,
        size_bytes: att.sizeBytes,
      };
    }),
});
