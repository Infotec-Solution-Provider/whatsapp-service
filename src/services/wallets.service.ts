import { createHash } from "node:crypto";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "@rgranatodutra/http-errors";
import prismaService from "./prisma.service";
import instancesService from "./instances.service";
import type { SessionData } from "../sdk-local";
import positiveResourceId from "../utils/positive-resource-id";

import { memberPreview, parseRules, type DirectoryUser } from "./wallet-membership";

type Tx = Omit<typeof prismaService, "$transaction" | "$connect" | "$disconnect">;
type WalletRow = { id: number; instance: string; name: string; rules?: ReturnType<typeof parseRules>; memberRules?: string | null };
function admin(session: SessionData) {
  if (session.role !== "ADMIN") throw new UnauthorizedError("A manutenção de carteiras exige administrador.");
}
function body(input: unknown, keys: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new BadRequestError("Dados da carteira inválidos.");
  return input as Record<string, unknown>;
}
function name(input: unknown) {
  if (typeof input !== "string" || !input.trim() || [...input.trim()].length > 191 || /[\u0000-\u001f\u007f]/.test(input)) throw new BadRequestError("Informe um nome de carteira entre 1 e 191 caracteres.");
  return input.trim();
}
function snapshot(row: WalletRow, userIds: number[]) {
  const members = [...userIds].sort((a, b) => a - b);
  const rules = row.memberRules ? parseRules(JSON.parse(row.memberRules)) : row.rules ?? [];
  const version = createHash("sha256").update(JSON.stringify([row.instance, row.id, row.name, members, ...(rules.length ? [rules] : [])])).digest("hex");
  return { id: row.id, instance: row.instance, name: row.name, userIds: members, rules, version };
}

export class WalletsService {
  constructor(private readonly database = prismaService, private readonly crm = instancesService) {}

  async getUserWallets(session: SessionData, rawUserId?: unknown) {
    const userId = positiveResourceId(rawUserId ?? session.userId);
    if (session.role !== "ADMIN" && userId !== session.userId) throw new UnauthorizedError("Você só pode consultar suas próprias carteiras.");
    return this.effectiveWallets(session.instance, userId);
  }

  async effectiveWallets(instance: string, userId: number) {
    const rows = await this.database.wppWallet.findMany({
      where: { instance, OR: [{ memberRules: { not: null } }, { WppWalletUser: { some: { userId } } }] },
      include: { WppWalletUser: { where: { userId } } }
    });
    if (!rows.length) return [];
    const users = await this.directory(instance, userId);
    return rows.filter(row => memberPreview(users, row.WppWalletUser.map(m => m.userId), this.rules(row)).length)
      .map(({ id, instance, name }) => ({ id, instance, name }));
  }

  async hasMember(instance: string, walletId: number, userId: number) {
    const row = await this.database.wppWallet.findFirst({ where: { instance, id: walletId }, include: { WppWalletUser: { where: { userId } } } });
    if (!row || (!row.memberRules && !row.WppWalletUser.length)) return false;
    return memberPreview(await this.directory(instance, userId), row.WppWalletUser.map(member => member.userId), this.rules(row)).length > 0;
  }

  async assertChatMember(session: { instance: string; userId: number }, chat: { walletId?: number | null; userId?: number | null }) {
    if (chat.walletId && chat.userId !== session.userId && !(await this.hasMember(session.instance, chat.walletId, session.userId)))
      throw new NotFoundError("Atendimento indisponível.");
  }

  async eventRecipients(instance: string, kind: string, id: number) {
    let walletId = id;
    let assigned: number | null = null;
    if (kind === "chat") {
      const chat = await this.database.wppChat.findFirst({ where: { instance, id }, select: { walletId: true, userId: true } });
      if (!chat) return [];
      if (!chat.walletId) return null;
      walletId = chat.walletId;
      assigned = chat.userId;
    }
    const row = await this.database.wppWallet.findFirst({ where: { id: walletId, instance }, include: { WppWalletUser: true } });
    if (!row) return [];
    const ids = row.WppWalletUser.map(member => member.userId);
    if (assigned && assigned > 0) ids.push(assigned);
    if (!ids.length && !row.memberRules) return [];
    return memberPreview(await this.directory(instance), ids, this.rules(row)).map(member => member.id);
  }

  private rules(row: WalletRow) { return row.memberRules ? parseRules(JSON.parse(row.memberRules)) : []; }

  private directory(instance: string, userId?: number) {
    return this.crm.executeQuery<DirectoryUser[]>(instance,
      "SELECT CODIGO,NOME,SETOR,NIVEL FROM operadores WHERE ATIVO='SIM'" + (userId ? " AND CODIGO=?" : " ORDER BY NOME,CODIGO"), userId ? [userId] : []);
  }

  private definition(input: unknown, keys: string[]) {
    const data = body(input, keys);
    const ids = data["userIds"] ?? [];
    if (!Array.isArray(ids)) throw new BadRequestError("Informe uma lista de usuários.");
    return { userIds: [...new Set(ids.map(id => positiveResourceId(id)))], rules: parseRules(data["rules"] ?? []) };
  }

  async preview(session: SessionData, input: unknown) {
    admin(session);
    const { userIds, rules } = this.definition(input, ["userIds", "rules"]);
    return memberPreview(await this.directory(session.instance), userIds, rules);
  }

  async choices(session: SessionData) {
    admin(session);
    const [users, catalog] = await Promise.all([this.directory(session.instance),
      this.crm.executeQuery<{ id: number; name: string }[]>(session.instance, "SELECT CODIGO AS id,NOME AS name FROM w_setores ORDER BY NOME,CODIGO", [])]);
    const sectors = new Map(catalog.map(row => [row.id, row.name]));
    for (const user of users) if (user.SETOR && !sectors.has(user.SETOR)) sectors.set(user.SETOR, `Setor #${user.SETOR}`);
    return { users: users.map(row => ({ id: row.CODIGO, name: row.NOME })), sectors: [...sectors].map(([id, name]) => ({ id, name })),
      roles: [...new Set(["ADMIN", "ATIVO", "RECEP", "AMBOS", "EXTERNO", ...users.flatMap(row => row.NIVEL ? [row.NIVEL] : [])])].sort() };
  }

  async list(session: SessionData, rawCursor?: unknown) {
    admin(session);
    const cursor = rawCursor === undefined ? 0 : positiveResourceId(rawCursor);
    const rows = await this.database.wppWallet.findMany({ where: { instance: session.instance, id: { gt: cursor } }, orderBy: { id: "asc" }, take: 101, include: { WppWalletUser: true } });
    const directory = rows.length ? await this.directory(session.instance) : [];
    return { data: rows.slice(0, 100).map(row => {
      const wallet = snapshot(row, row.WppWalletUser.map(member => member.userId));
      return { ...wallet, memberCount: memberPreview(directory, wallet.userIds, wallet.rules).length };
    }), nextCursor: rows.length > 100 ? rows[99]!.id : null };
  }

  async get(session: SessionData, rawId: unknown) {
    admin(session);
    const id = positiveResourceId(rawId);
    const row = await this.database.wppWallet.findFirst({ where: { id, instance: session.instance }, include: { WppWalletUser: true } });
    if (!row) throw new NotFoundError("Carteira não encontrada nesta empresa.");
    return snapshot(row, row.WppWalletUser.map(member => member.userId));
  }

  async create(session: SessionData, input: unknown) {
    return this.save(session, null, input);
  }

  async save(session: SessionData, rawId: unknown, input: unknown) {
    admin(session);
    const keys = ["name", "rules", "userIds", ...(rawId === null ? [] : ["version"])];
    const data = body(input, keys), walletName = name(data["name"]);
    const { userIds, rules } = this.definition(data, keys);
    const users = await this.directory(session.instance);
    const active = new Set(users.map(row => row.CODIGO));
    const memberRules = rules.length ? JSON.stringify(rules) : null;
    const persist = async (tx: Tx, current?: ReturnType<typeof snapshot>) => {
      if (current && data["version"] !== current.version) throw new ConflictError("A carteira mudou. Reabra o cadastro antes de salvar.");
      if (userIds.some(id => !active.has(id) && !current?.userIds.includes(id))) throw new BadRequestError("Selecione usuários ativos desta empresa.");
      let id: number;
      if (current) {
        id = current.id;
        await tx.wppWallet.updateMany({ where: { id, instance: session.instance }, data: { name: walletName, memberRules } });
        await tx.wppWalletUser.deleteMany({ where: { walletId: id } });
      } else {
        const row = await tx.wppWallet.create({ data: { instance: session.instance, name: walletName, memberRules } });
        id = row.id;
      }
      if (userIds.length) await tx.wppWalletUser.createMany({ data: userIds.map(userId => ({ walletId: id, userId })) });
      return { ...snapshot({ id, instance: session.instance, name: walletName, memberRules }, userIds),
        memberCount: memberPreview(users, userIds, rules).length };
    };
    return rawId === null ? this.database.$transaction(tx => persist(tx)) : this.locked(session, rawId, persist);
  }

  // All mutations of a wallet acquire its parent row lock before reading a snapshot.
  // The tenant SQL router rewrites this fixed logical table to its physical table.
  private async locked<T>(session: SessionData, rawId: unknown, operation: (tx: Tx, row: ReturnType<typeof snapshot>) => Promise<T>) {
    admin(session);
    const id = positiveResourceId(rawId);
    return this.database.$transaction(async tx => {
      const rows = await tx.$queryRawUnsafe<WalletRow[]>("SELECT id, instance, name, member_rules AS memberRules FROM wallets WHERE id=? AND instance=? FOR UPDATE", id, session.instance);
      const row = rows[0];
      if (!row) throw new NotFoundError("Carteira não encontrada nesta empresa.");
      const members = await tx.wppWalletUser.findMany({ where: { walletId: id, WppWallet: { instance: session.instance } } });
      return operation(tx, snapshot(row, members.map(member => member.userId)));
    });
  }

  async rename(session: SessionData, rawId: unknown, input: unknown) {
    admin(session);
    const data = body(input, ["newName", "version"]), newName = name(data["newName"]);
    return this.locked(session, rawId, async (tx, row) => {
      if (data["version"] !== row.version) throw new ConflictError("A carteira mudou. Atualize a lista antes de editar.");
      await tx.wppWallet.updateMany({ where: { id: row.id, instance: session.instance }, data: { name: newName } });
      return snapshot({ ...row, name: newName }, row.userIds);
    });
  }

  async remove(session: SessionData, rawId: unknown, input: unknown) {
    admin(session);
    const data = body(input, ["version"]);
    return this.locked(session, rawId, async (tx, row) => {
      if (data["version"] !== row.version) throw new ConflictError("A carteira mudou. Atualize a lista antes de excluir.");
      if (row.userIds.length || await tx.wppChat.count({ where: { walletId: row.id, instance: session.instance } })) throw new ConflictError("A carteira possui usuários ou atendimentos vinculados e não pode ser excluída.");
      const assignments = await tx.wppMessageFlowStep.findMany({ where: { type: "ASSIGN", WppMessageFlow: { instance: session.instance } }, select: { config: true } });
      if (assignments.some(({ config }) => config && typeof config === "object" && !Array.isArray(config) && Number(config["walletId"]) === row.id))
        throw new ConflictError("A carteira é destino de um fluxo publicado.");
      const result = await tx.wppWallet.deleteMany({ where: { id: row.id, instance: session.instance, WppWalletUser: { none: {} }, WppChat: { none: {} } } });
      if (result.count !== 1) throw new ConflictError("A carteira recebeu novos vínculos. Atualize a lista.");
      return row;
    });
  }

  async addUser(session: SessionData, rawId: unknown, input: unknown) {
    admin(session);
    const data = body(input, ["userId"]), userId = positiveResourceId(data["userId"]);
    const users = await this.crm.executeQuery<Array<{ CODIGO: number }>>(session.instance, "SELECT CODIGO FROM operadores WHERE CODIGO=? AND ATIVO='SIM' LIMIT 1", [userId]);
    if (!Array.isArray(users) || users.length !== 1 || Number(users[0]?.CODIGO) !== userId) throw new BadRequestError("Operador ativo não encontrado nesta empresa.");
    return this.locked(session, rawId, async (tx, row) => {
      if (row.userIds.includes(userId)) return row;
      await tx.wppWalletUser.create({ data: { walletId: row.id, userId } });
      return snapshot(row, [...row.userIds, userId]);
    });
  }

  async removeUser(session: SessionData, rawId: unknown, rawUserId: unknown) {
    admin(session);
    const userId = positiveResourceId(rawUserId);
    return this.locked(session, rawId, async (tx, row) => {
      await tx.wppWalletUser.deleteMany({ where: { walletId: row.id, userId, WppWallet: { instance: session.instance } } });
      return snapshot(row, row.userIds.filter(id => id !== userId));
    });
  }
}

export default new WalletsService();
