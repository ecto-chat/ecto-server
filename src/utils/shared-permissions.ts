import type { Db } from '../db/index.js';
import type { SharedItemOverrideLayer } from 'ecto-shared';
import { computePermissions, computeSharedItemPermissions, hasPermission, Permissions } from 'ecto-shared';
import {
  servers,
  members,
  roles,
  memberRoles,
  sharedFolders,
  sharedItemPermissionOverrides,
} from '../db/schema/index.js';
import { eq, and, inArray, sql } from 'drizzle-orm';

interface BasePermissionData {
  isOwner: boolean;
  everyonePermissions: number;
  rolePermissions: number[];
  everyoneRoleId: string | null;
  memberRoleIds: Set<string>;
  memberId: string | null;
}

async function getBasePermissionData(d: Db, serverId: string, userId: string): Promise<BasePermissionData> {
  const [server] = await d
    .select({ adminUserId: servers.adminUserId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  const isOwner = server?.adminUserId === userId;

  const [member] = await d
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.serverId, serverId), eq(members.userId, userId)))
    .limit(1);

  if (!member) {
    return {
      isOwner: false,
      everyonePermissions: 0,
      rolePermissions: [],
      everyoneRoleId: null,
      memberRoleIds: new Set(),
      memberId: null,
    };
  }

  const allRoles = await d.select().from(roles).where(eq(roles.serverId, serverId));
  const everyoneRole = allRoles.find((r) => r.isDefault);

  const memberRoleRows = await d
    .select({ roleId: memberRoles.roleId })
    .from(memberRoles)
    .where(eq(memberRoles.memberId, member.id));

  const memberRoleIdSet = new Set(memberRoleRows.map((r) => r.roleId));
  const rolePerms = allRoles
    .filter((r) => memberRoleIdSet.has(r.id) && !r.isDefault)
    .map((r) => r.permissions);

  return {
    isOwner,
    everyonePermissions: everyoneRole?.permissions ?? 0,
    rolePermissions: rolePerms,
    everyoneRoleId: everyoneRole?.id ?? null,
    memberRoleIds: memberRoleIdSet,
    memberId: member.id,
  };
}

function computeBasePermissions(data: BasePermissionData): number {
  if (data.isOwner) return 0x7FFFFFFF; // all bits
  let base = data.everyonePermissions;
  for (const rp of data.rolePermissions) base |= rp;
  return base;
}

type OverrideRow = typeof sharedItemPermissionOverrides.$inferSelect;

function buildLayer(
  overrides: OverrideRow[],
  everyoneRoleId: string | null,
  memberRoleIds: Set<string>,
): SharedItemOverrideLayer {
  const layer: SharedItemOverrideLayer = {};

  for (const o of overrides) {
    if (o.targetType === 'role') {
      if (everyoneRoleId && o.targetId === everyoneRoleId) {
        layer.everyoneOverride = { allow: o.allow, deny: o.deny };
      } else if (memberRoleIds.has(o.targetId)) {
        if (!layer.roleOverrides) layer.roleOverrides = [];
        layer.roleOverrides.push({ allow: o.allow, deny: o.deny });
      }
    }
  }

  return layer;
}

/**
 * Resolve the ancestor folder chain for a given item.
 * Returns folder IDs from root-most to the immediate parent.
 */
async function getAncestorChain(d: Db, itemType: 'folder' | 'file', itemId: string): Promise<string[]> {
  if (itemType === 'file') {
    // Get the file's folder_id, then walk ancestors of that folder
    const { sharedFiles } = await import('../db/schema/index.js');
    const [file] = await d
      .select({ folderId: sharedFiles.folderId })
      .from(sharedFiles)
      .where(eq(sharedFiles.id, itemId))
      .limit(1);
    if (!file?.folderId) return [];
    return getAncestorChainForFolder(d, file.folderId);
  }
  // For folders, walk ancestors of the folder itself (not including itself)
  const [folder] = await d
    .select({ parentId: sharedFolders.parentId })
    .from(sharedFolders)
    .where(eq(sharedFolders.id, itemId))
    .limit(1);
  if (!folder?.parentId) return [];
  return getAncestorChainForFolder(d, folder.parentId);
}

async function getAncestorChainForFolder(d: Db, folderId: string): Promise<string[]> {
  const result = await d.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id, 0 as depth FROM shared_folders WHERE id = ${folderId}
      UNION ALL
      SELECT sf.id, sf.parent_id, a.depth + 1
      FROM shared_folders sf
      INNER JOIN ancestors a ON sf.id = a.parent_id
    )
    SELECT id FROM ancestors ORDER BY depth DESC
  `) as { rows: { id: string }[] };
  return result.rows.map((r) => r.id);
}

/**
 * Resolve effective permissions for a user on a single shared item.
 */
export async function resolveSharedItemAccess(
  d: Db,
  serverId: string,
  userId: string,
  itemType: 'folder' | 'file',
  itemId: string,
): Promise<number> {
  const baseData = await getBasePermissionData(d, serverId, userId);
  if (!baseData.memberId) return 0;

  const base = computeBasePermissions(baseData);
  if (baseData.isOwner || hasPermission(base, Permissions.ADMINISTRATOR)) return base;

  // Build ancestor chain
  const ancestorFolderIds = await getAncestorChain(d, itemType, itemId);

  // Collect all item IDs we need overrides for
  const lookupItems: { type: string; id: string }[] = [];
  for (const fId of ancestorFolderIds) {
    lookupItems.push({ type: 'folder', id: fId });
  }
  lookupItems.push({ type: itemType, id: itemId });

  const allIds = lookupItems.map((i) => i.id);
  const overrides = allIds.length > 0
    ? await d
        .select()
        .from(sharedItemPermissionOverrides)
        .where(inArray(sharedItemPermissionOverrides.itemId, allIds))
    : [];

  // Group overrides by (itemType, itemId)
  const overrideMap = new Map<string, OverrideRow[]>();
  for (const o of overrides) {
    const key = `${o.itemType}:${o.itemId}`;
    const arr = overrideMap.get(key) ?? [];
    arr.push(o);
    overrideMap.set(key, arr);
  }

  // Build layers in order
  const layers: SharedItemOverrideLayer[] = [];
  for (const item of lookupItems) {
    const itemOverrides = overrideMap.get(`${item.type}:${item.id}`);
    if (itemOverrides && itemOverrides.length > 0) {
      layers.push(buildLayer(itemOverrides, baseData.everyoneRoleId, baseData.memberRoleIds));
    }
  }

  return computeSharedItemPermissions(base, layers);
}

/**
 * Batch-filter shared items by BROWSE_FILES permission.
 * Returns only items where the user has effective BROWSE_FILES.
 */
export async function batchFilterByBrowseFiles<T extends { id: string }>(
  d: Db,
  serverId: string,
  userId: string,
  items: T[],
  itemType: 'folder' | 'file',
): Promise<{ items: T[]; overrideItemIds: Set<string> }> {
  if (items.length === 0) return { items: [], overrideItemIds: new Set() };

  const baseData = await getBasePermissionData(d, serverId, userId);
  if (!baseData.memberId) return { items: [], overrideItemIds: new Set() };

  const base = computeBasePermissions(baseData);

  // Owner/admin sees everything
  if (baseData.isOwner || hasPermission(base, Permissions.ADMINISTRATOR)) {
    // Still need to find which items have overrides
    const allOverrides = await d
      .select()
      .from(sharedItemPermissionOverrides)
      .where(inArray(sharedItemPermissionOverrides.itemId, items.map((i) => i.id)));
    const overrideItemIds = new Set(allOverrides.map((o) => o.itemId));
    return { items, overrideItemIds };
  }

  // Fetch ALL shared_item_permission_overrides for the server
  // (join via item IDs linked to server's folders/files)
  const allFolders = await d
    .select({ id: sharedFolders.id, parentId: sharedFolders.parentId })
    .from(sharedFolders)
    .where(eq(sharedFolders.serverId, serverId));

  const folderParentMap = new Map<string, string | null>();
  for (const f of allFolders) {
    folderParentMap.set(f.id, f.parentId);
  }

  // Fetch all overrides for folders and files in this server
  const allFolderIds = allFolders.map((f) => f.id);
  const itemIds = items.map((i) => i.id);
  const allRelevantIds = [...new Set([...allFolderIds, ...itemIds])];

  const allOverrides = allRelevantIds.length > 0
    ? await d
        .select()
        .from(sharedItemPermissionOverrides)
        .where(inArray(sharedItemPermissionOverrides.itemId, allRelevantIds))
    : [];

  // Group overrides by (itemType, itemId)
  const overrideMap = new Map<string, OverrideRow[]>();
  const overrideItemIds = new Set<string>();
  for (const o of allOverrides) {
    const key = `${o.itemType}:${o.itemId}`;
    const arr = overrideMap.get(key) ?? [];
    arr.push(o);
    overrideMap.set(key, arr);
    overrideItemIds.add(o.itemId);
  }

  // Helper: walk ancestor chain in memory
  function getAncestorsInMemory(folderId: string): string[] {
    const ancestors: string[] = [];
    let current: string | null = folderId;
    while (current) {
      ancestors.unshift(current);
      current = folderParentMap.get(current) ?? null;
    }
    return ancestors;
  }

  // Filter items
  const result: T[] = [];
  for (const item of items) {
    let ancestorFolderIds: string[];
    if (itemType === 'folder') {
      // For a folder, ancestors are its parent chain (not including itself)
      const parentId = folderParentMap.get(item.id);
      ancestorFolderIds = parentId ? getAncestorsInMemory(parentId) : [];
    } else {
      // For a file, we need its folder_id — stored in the item if available
      const fileItem = item as unknown as { folder_id?: string | null };
      ancestorFolderIds = fileItem.folder_id ? getAncestorsInMemory(fileItem.folder_id) : [];
    }

    // Build layers
    const layers: SharedItemOverrideLayer[] = [];
    for (const fId of ancestorFolderIds) {
      const folderOverrides = overrideMap.get(`folder:${fId}`);
      if (folderOverrides && folderOverrides.length > 0) {
        layers.push(buildLayer(folderOverrides, baseData.everyoneRoleId, baseData.memberRoleIds));
      }
    }
    // Item-level overrides
    const itemOverrides = overrideMap.get(`${itemType}:${item.id}`);
    if (itemOverrides && itemOverrides.length > 0) {
      layers.push(buildLayer(itemOverrides, baseData.everyoneRoleId, baseData.memberRoleIds));
    }

    const effective = layers.length > 0
      ? computeSharedItemPermissions(base, layers)
      : base;

    if (hasPermission(effective, Permissions.BROWSE_FILES)) {
      result.push(item);
    }
  }

  return { items: result, overrideItemIds };
}
