import { randomBytes } from 'node:crypto';
import { MANAGER_PERMISSIONS, type AdminRole, type ManagerPermission } from '@open-signal/shared';
import { AppError } from '../lib/errors.ts';
import { safeEqual, sha256Hex } from '../lib/crypto.ts';
import { newId } from '../lib/ids.ts';
import { C } from '../storage/collections.ts';
import { increment, type DocumentStore } from '../storage/types.ts';
import { writeAudit } from '../domain/audit.ts';
import { MIN_PASSWORD_LENGTH, burnPasswordCheck, hashPassword, verifyPassword } from './passwords.ts';

export interface AdminUserRecord {
  [k: string]: unknown;
  uid: string;
  email: string;
  role: AdminRole;
  active: boolean;
  passwordHash: string | null;
  botPermissions: Record<string, ManagerPermission[]>;
  createdAt: string;
  lastLoginAt: string | null;
  failedLogins: number;
  lockedUntil: string | null;
}

export interface AdminActor {
  uid: string;
  email: string;
  role: AdminRole;
  botPermissions: Record<string, ManagerPermission[]>;
}

export const ADMIN_COOKIE = 'os_admin';
const MAX_FAILED = 8;
const LOCK_MINUTES = 15;
const INVITE_TTL_MS = 72 * 3600_000;

const emailKey = (email: string) => sha256Hex(email.trim().toLowerCase()).slice(0, 40);
const normEmail = (email: string) => email.trim().toLowerCase();

function validEmail(email: string): boolean {
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

function checkPassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH || pw.length > 200) {
    throw new AppError('VALIDATION_FAILED', `password must be ${MIN_PASSWORD_LENGTH}–200 characters`);
  }
  return pw;
}

export function toActor(u: AdminUserRecord): AdminActor {
  return { uid: u.uid, email: u.email, role: u.role, botPermissions: u.botPermissions ?? {} };
}

/** Owner can do everything; a manager only what is granted for that bot. */
export function can(actor: AdminActor, botId: string, permission: ManagerPermission): boolean {
  return actor.role === 'owner' || Boolean(actor.botPermissions[botId]?.includes(permission));
}

export function requirePermission(actor: AdminActor, botId: string, permission: ManagerPermission): void {
  if (!can(actor, botId, permission)) throw new AppError('FORBIDDEN', 'missing permission');
}

export function requireOwner(actor: AdminActor): void {
  if (actor.role !== 'owner') throw new AppError('FORBIDDEN', 'owner only');
}

export function canSeeBot(actor: AdminActor, botId: string): boolean {
  return actor.role === 'owner' || (actor.botPermissions[botId]?.length ?? 0) > 0;
}

/**
 * Admin accounts, sessions and invitations.
 * Sessions are random 256-bit tokens in an HttpOnly cookie; only their SHA-256
 * is stored, so a database leak does not leak usable sessions.
 */
export class AdminAuthService {
  private readonly store: DocumentStore;
  private readonly setupToken: string | undefined;
  private readonly sessionTtlSec: number;
  private readonly now: () => Date;
  private readonly cache = new Map<string, { at: number; actor: AdminActor; expiresAt: number }>();

  constructor(deps: { store: DocumentStore; setupToken: string | undefined; sessionTtlSec: number; now: () => Date }) {
    this.store = deps.store;
    this.setupToken = deps.setupToken;
    this.sessionTtlSec = deps.sessionTtlSec;
    this.now = deps.now;
  }

  async needsSetup(): Promise<boolean> {
    return !(await this.store.get(C.adminMeta, 'owner'));
  }

  /** Creates the first owner. Requires ADMIN_SETUP_TOKEN; works exactly once. */
  async setupOwner(input: { setupToken: unknown; email: unknown; password: unknown }, ip: string): Promise<{ token: string; actor: AdminActor }> {
    if (!this.setupToken) throw new AppError('FORBIDDEN', 'ADMIN_SETUP_TOKEN is not configured');
    if (typeof input.setupToken !== 'string' || !safeEqual(sha256Hex(input.setupToken.trim()), sha256Hex(this.setupToken))) {
      throw new AppError('INVALID_CREDENTIALS', 'setup token mismatch');
    }
    const email = typeof input.email === 'string' ? normEmail(input.email) : '';
    if (!validEmail(email)) throw new AppError('VALIDATION_FAILED', 'invalid email');
    const passwordHash = await hashPassword(checkPassword(input.password));
    const uid = newId();
    const nowIso = this.now().toISOString();
    await this.store.runTransaction(async (tx) => {
      const meta = await tx.get(C.adminMeta, 'owner');
      if (meta) throw new AppError('SETUP_ALREADY_DONE');
      const user: AdminUserRecord = {
        uid, email, role: 'owner', active: true, passwordHash, botPermissions: {}, createdAt: nowIso, lastLoginAt: nowIso, failedLogins: 0, lockedUntil: null,
      };
      tx.create(C.adminMeta, 'owner', { uid, createdAt: nowIso });
      tx.create(C.adminEmails, emailKey(email), { uid });
      tx.create(C.adminUsers, uid, user);
      writeAudit(tx, { botId: null, actor: { type: 'admin', id: uid }, action: 'admin.owner_created', target: uid }, this.now());
    });
    const user = (await this.store.get<AdminUserRecord>(C.adminUsers, uid))!;
    return { token: await this.createSession(uid, ip), actor: toActor(user) };
  }

  async login(emailRaw: unknown, password: unknown, ip: string): Promise<{ token: string; actor: AdminActor }> {
    const email = typeof emailRaw === 'string' ? normEmail(emailRaw) : '';
    const pw = typeof password === 'string' ? password.slice(0, 200) : '';
    const lock = email ? await this.store.get<{ uid: string }>(C.adminEmails, emailKey(email)) : null;
    const user = lock ? await this.store.get<AdminUserRecord>(C.adminUsers, lock.uid) : null;
    if (!user || !user.passwordHash || !user.active) {
      await burnPasswordCheck(pw);
      throw new AppError('INVALID_CREDENTIALS');
    }
    const now = this.now();
    if (user.lockedUntil && Date.parse(user.lockedUntil) > now.getTime()) throw new AppError('ACCOUNT_LOCKED');
    if (!(await verifyPassword(pw, user.passwordHash))) {
      const failed = (user.failedLogins ?? 0) + 1;
      await this.store.update(C.adminUsers, user.uid, {
        failedLogins: failed >= MAX_FAILED ? 0 : increment(1),
        lockedUntil: failed >= MAX_FAILED ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null,
      });
      throw new AppError(failed >= MAX_FAILED ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS');
    }
    await this.store.update(C.adminUsers, user.uid, { failedLogins: 0, lockedUntil: null, lastLoginAt: now.toISOString() });
    return { token: await this.createSession(user.uid, ip), actor: toActor(user) };
  }

  async logout(token: string | null): Promise<void> {
    if (!token) return;
    const id = sha256Hex(token);
    this.cache.delete(id);
    await this.store.delete(C.adminSessions, id);
  }

  /** Resolves the cookie to an active admin, or throws UNAUTHORIZED. */
  async authenticate(token: string | null): Promise<AdminActor> {
    if (!token || token.length < 30 || token.length > 100) throw new AppError('UNAUTHORIZED');
    const id = sha256Hex(token);
    const now = this.now().getTime();
    const hit = this.cache.get(id);
    if (hit && now - hit.at < 15_000 && hit.expiresAt > now) return hit.actor;
    const session = await this.store.get<{ uid: string; expiresAt: string }>(C.adminSessions, id);
    if (!session || Date.parse(session.expiresAt) <= now) throw new AppError('UNAUTHORIZED');
    const user = await this.store.get<AdminUserRecord>(C.adminUsers, session.uid);
    if (!user || !user.active) throw new AppError('UNAUTHORIZED');
    const actor = toActor(user);
    this.cache.set(id, { at: now, actor, expiresAt: Date.parse(session.expiresAt) });
    return actor;
  }

  async changePassword(actor: AdminActor, current: unknown, next: unknown): Promise<void> {
    const user = await this.store.get<AdminUserRecord>(C.adminUsers, actor.uid);
    if (!user?.passwordHash || typeof current !== 'string' || !(await verifyPassword(current, user.passwordHash))) {
      throw new AppError('INVALID_CREDENTIALS');
    }
    await this.store.update(C.adminUsers, actor.uid, { passwordHash: await hashPassword(checkPassword(next)) });
  }

  // ───────── managers (owner only) ─────────

  async listManagers(actor: AdminActor): Promise<Omit<AdminUserRecord, 'passwordHash'>[]> {
    requireOwner(actor);
    const docs = await this.store.query<AdminUserRecord>(C.adminUsers, { where: [{ field: 'role', op: '==', value: 'manager' }] });
    return docs.map(({ data: { passwordHash: _ph, ...rest } }) => ({ ...rest, invitePending: !_ph }));
  }

  async createManager(actor: AdminActor, input: { email: unknown; botPermissions: unknown }): Promise<{ uid: string; inviteToken: string }> {
    requireOwner(actor);
    const email = typeof input.email === 'string' ? normEmail(input.email) : '';
    if (!validEmail(email)) throw new AppError('VALIDATION_FAILED', 'invalid email');
    const perms = parsePermissions(input.botPermissions);
    const uid = newId();
    const nowIso = this.now().toISOString();
    const inviteToken = randomBytes(32).toString('base64url');
    await this.store.runTransaction(async (tx) => {
      const exists = await tx.get(C.adminEmails, emailKey(email));
      if (exists) throw new AppError('ALREADY_EXISTS', 'email already registered');
      tx.create(C.adminEmails, emailKey(email), { uid });
      tx.create(C.adminUsers, uid, {
        uid, email, role: 'manager', active: true, passwordHash: null, botPermissions: perms, createdAt: nowIso, lastLoginAt: null, failedLogins: 0, lockedUntil: null,
      } satisfies AdminUserRecord);
      tx.create(C.adminInvites, sha256Hex(inviteToken), { uid, expiresAt: new Date(this.now().getTime() + INVITE_TTL_MS).toISOString(), usedAt: null });
      writeAudit(tx, { botId: null, actor: { type: 'admin', id: actor.uid }, action: 'admin.manager_created', target: uid, after: { email, botPermissions: perms } }, this.now());
    });
    return { uid, inviteToken };
  }

  async updateManager(actor: AdminActor, uid: string, input: { botPermissions?: unknown; active?: unknown }): Promise<void> {
    requireOwner(actor);
    await this.store.runTransaction(async (tx) => {
      const u = await tx.get<AdminUserRecord>(C.adminUsers, uid);
      if (!u || u.role !== 'manager') throw new AppError('NOT_FOUND');
      const patch: Record<string, unknown> = {};
      if (input.botPermissions !== undefined) patch['botPermissions'] = parsePermissions(input.botPermissions);
      if (input.active !== undefined) patch['active'] = Boolean(input.active);
      tx.update(C.adminUsers, uid, patch);
      writeAudit(tx, { botId: null, actor: { type: 'admin', id: actor.uid }, action: 'admin.manager_updated', target: uid, before: { botPermissions: u.botPermissions, active: u.active }, after: patch }, this.now());
    });
    for (const [k, v] of this.cache) if (v.actor.uid === uid) this.cache.delete(k);
  }

  async reissueInvite(actor: AdminActor, uid: string): Promise<string> {
    requireOwner(actor);
    const u = await this.store.get<AdminUserRecord>(C.adminUsers, uid);
    if (!u || u.role !== 'manager') throw new AppError('NOT_FOUND');
    const inviteToken = randomBytes(32).toString('base64url');
    await this.store.create(C.adminInvites, sha256Hex(inviteToken), { uid, expiresAt: new Date(this.now().getTime() + INVITE_TTL_MS).toISOString(), usedAt: null });
    return inviteToken;
  }

  /** Manager opens the one-time invite link and sets a password. */
  async acceptInvite(input: { token: unknown; password: unknown }, ip: string): Promise<{ token: string; actor: AdminActor }> {
    if (typeof input.token !== 'string') throw new AppError('INVALID_CREDENTIALS');
    const passwordHash = await hashPassword(checkPassword(input.password));
    const inviteId = sha256Hex(input.token);
    const uid = await this.store.runTransaction(async (tx) => {
      const inv = await tx.get<{ uid: string; expiresAt: string; usedAt: string | null }>(C.adminInvites, inviteId);
      if (!inv || inv.usedAt || Date.parse(inv.expiresAt) <= this.now().getTime()) throw new AppError('INVALID_CREDENTIALS', 'invite invalid or expired');
      const u = await tx.get<AdminUserRecord>(C.adminUsers, inv.uid);
      if (!u || !u.active) throw new AppError('INVALID_CREDENTIALS');
      tx.update(C.adminInvites, inviteId, { usedAt: this.now().toISOString() });
      tx.update(C.adminUsers, inv.uid, { passwordHash, failedLogins: 0, lockedUntil: null, lastLoginAt: this.now().toISOString() });
      return inv.uid;
    });
    const user = (await this.store.get<AdminUserRecord>(C.adminUsers, uid))!;
    return { token: await this.createSession(uid, ip), actor: toActor(user) };
  }

  private async createSession(uid: string, ip: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    await this.store.create(C.adminSessions, sha256Hex(token), {
      uid,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.sessionTtlSec * 1000).toISOString(),
      ip: ip.slice(0, 64),
    });
    return token;
  }
}

function parsePermissions(raw: unknown): Record<string, ManagerPermission[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('VALIDATION_FAILED', 'botPermissions must be an object');
  const out: Record<string, ManagerPermission[]> = {};
  for (const [botId, perms] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(botId) || !Array.isArray(perms)) throw new AppError('VALIDATION_FAILED', 'invalid botPermissions');
    const valid = perms.filter((p): p is ManagerPermission => (MANAGER_PERMISSIONS as readonly string[]).includes(String(p)));
    if (valid.length) out[botId] = [...new Set(valid)];
  }
  return out;
}
