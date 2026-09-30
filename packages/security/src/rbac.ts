import { AppError, type UserRole } from "@reelflow/types";

/**
 * Permission matrix. OWNER is the operator; MANAGER is the client/employer.
 * Source approval and policy changes are OWNER-only by design.
 */
export const PERMISSIONS = {
  "dashboard:read": ["OWNER", "MANAGER", "VIEWER"],
  "sources:read": ["OWNER", "MANAGER", "VIEWER"],
  "sources:propose": ["OWNER", "MANAGER"],
  "sources:edit": ["OWNER", "MANAGER"],
  "sources:review": ["OWNER"],
  "sources:delete": ["OWNER"],
  "content:read": ["OWNER", "MANAGER", "VIEWER"],
  "content:write": ["OWNER", "MANAGER"],
  "content:approve": ["OWNER", "MANAGER"],
  "content:upload": ["OWNER", "MANAGER"],
  "schedule:write": ["OWNER", "MANAGER"],
  "queue:control": ["OWNER", "MANAGER"],
  "accounts:read": ["OWNER", "MANAGER", "VIEWER"],
  "accounts:write": ["OWNER", "MANAGER"],
  "settings:read": ["OWNER", "MANAGER", "VIEWER"],
  "settings:write": ["OWNER", "MANAGER"],
  "network:control": ["OWNER"],
  "users:manage": ["OWNER"],
  "logs:read": ["OWNER", "MANAGER", "VIEWER"],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: UserRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly UserRole[]).includes(role);
}

export function assertCan(role: UserRole | undefined, permission: Permission): void {
  if (!role) throw new AppError("UNAUTHENTICATED", "Sign in required");
  if (!can(role, permission)) throw new AppError("FORBIDDEN", `Your role (${role}) cannot perform ${permission}`);
}
