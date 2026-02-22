import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyToken } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { sharedFiles, sharedFolders, serverConfig } from '../db/schema/index.js';
import { generateUUIDv7, Permissions, hasPermission } from 'ecto-shared';
import { eq, and, sql } from 'drizzle-orm';
import { requirePermission } from '../utils/permission-context.js';
import { resolveSharedItemAccess } from '../utils/shared-permissions.js';
import { parseMultipart } from './multipart.js';
import { checkStorageQuota } from '../services/storage-quota.js';
import { resolveServerId } from '../trpc/context.js';
import { formatSharedFile } from '../utils/format.js';
import { resolveUserProfiles } from '../utils/resolve-profile.js';
import { eventDispatcher } from '../ws/event-dispatcher.js';
import { fileStorage } from '../services/file-storage.js';

export async function handleSharedFileUpload(req: IncomingMessage, res: ServerResponse) {
  try {
    // Auth
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const user = await verifyToken(authHeader.slice(7));
    const d = db();
    const serverId = await resolveServerId(req);

    // Parse multipart
    const contentType = req.headers['content-type'] ?? '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
      return;
    }

    const { fields, file } = await parseMultipart(req, boundaryMatch[1]!);
    if (!file) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No file provided' }));
      return;
    }

    const folderId = fields['folder_id'] || null;

    // Validate folder if specified
    if (folderId) {
      const [folder] = await d
        .select({ id: sharedFolders.id })
        .from(sharedFolders)
        .where(and(eq(sharedFolders.id, folderId), eq(sharedFolders.serverId, serverId)))
        .limit(1);
      if (!folder) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Folder not found' }));
        return;
      }

      // Check UPLOAD_SHARED_FILES resolved through target folder chain
      const effective = await resolveSharedItemAccess(d, serverId, user.id, 'folder', folderId);
      if (!hasPermission(effective, Permissions.UPLOAD_SHARED_FILES)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Insufficient permissions' }));
        return;
      }
    } else {
      // Root-level upload — check base permission
      await requirePermission(d, serverId, user.id, Permissions.UPLOAD_SHARED_FILES);
    }

    // Check per-file size limit
    const [sConfig] = await d
      .select()
      .from(serverConfig)
      .where(eq(serverConfig.serverId, serverId))
      .limit(1);
    const maxFileSize = sConfig?.maxUploadSizeBytes ?? 5242880;
    if (file.data.length > maxFileSize) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File too large' }));
      return;
    }

    // Check quota
    const maxStorage = sConfig?.maxSharedStorageBytes ?? 104857600;
    const [usage] = await d
      .select({
        usedBytes: sql<number>`coalesce(sum(${sharedFiles.sizeBytes}), 0)::int`,
      })
      .from(sharedFiles)
      .where(eq(sharedFiles.serverId, serverId));

    if ((usage?.usedBytes ?? 0) + file.data.length > maxStorage) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Shared storage quota exceeded' }));
      return;
    }

    // Check global server-wide storage quota (images exempt)
    const quotaError = await checkStorageQuota(serverId, file.data.length, file.contentType);
    if (quotaError) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: quotaError }));
      return;
    }

    // Save via storage backend (local disk or S3)
    const fileId = generateUUIDv7();
    const folderPart = folderId ?? 'root';
    const storageKey = `${serverId}/shared/${folderPart}/${fileId}/${file.filename}`;
    const url = await fileStorage.save(storageKey, file.data, file.contentType);

    // Insert DB row
    const [row] = await d.insert(sharedFiles).values({
      id: fileId,
      serverId,
      folderId,
      filename: file.filename,
      url,
      contentType: file.contentType,
      sizeBytes: file.data.length,
      uploadedBy: user.id,
    }).returning();

    // Resolve uploader name
    const profiles = await resolveUserProfiles(d, [user.id]);
    const uploaderName = profiles.get(user.id)?.username ?? 'Unknown';

    const result = formatSharedFile(row!, uploaderName);
    eventDispatcher.dispatchToAll('shared_file.create', result);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('Shared file upload error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upload failed' }));
    }
  }
}
