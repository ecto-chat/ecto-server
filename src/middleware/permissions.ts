import { computePermissions, type PermissionContext } from 'ecto-shared';

export function checkPermission(context: PermissionContext, permission: number): boolean {
  const effective = computePermissions(context);
  return (effective & permission) === permission;
}
