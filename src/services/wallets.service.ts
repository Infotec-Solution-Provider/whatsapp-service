import { createHash } from "node:crypto";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "@rgranatodutra/http-errors";
import prismaService from "./prisma.service";
import instancesService from "./instances.service";
import type { SessionData } from "../sdk-local";
import positiveResourceId from "../utils/positive-resource-id";

type Tx = Omit<typeof prismaService, "$transaction" | "$connect" | "$disconnect">;
type WalletRow = { id: number; instance: string; name: string };
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
  const version = createHash("sha256").update(JSON.stringify([row.instance, row.id, row.name, members])).digest("hex");
  return { id: row.id, instance: row.instance, name: row.name, userIds: members, version };
}

export class WalletsService {
  constructor(private readonly database = prismaService, private readonly crm = instancesService) {}

  async getUserWallets(session: SessionData, rawUserId?: unknown) {
    const userId = positiveResourceId(rawUserId ?? session.userId);
    if (session.role !== "ADMIN" && userId !== session.userId) throw new UnauthorizedError("Você só pode consultar suas próprias carteiras.");
    return this.database.wppWallet.findMany({ where: { instance: session.instance, WppWalletUser: { some: { userId } } } });
  }

  async list(session: SessionData, rawCursor?: unknown) {
    admin(session);
    const cursor = rawCursor === undefined ? 0 : positiveResourceId(rawCursor);
    const rows = await this.database.wppWallet.findMany({ where: { instance: session.instance, id: { gt: cursor } }, orderBy: { id: "asc" }, take: 101, include: { WppWalletUser: true } });
    return { data: rows.slice(0, 100).map(row => snapshot(row, row.WppWalletUser.map(member => member.userId))), nextCursor: rows.length > 100 ? rows[99]!.id : null };
  }

  async get(session: SessionData, rawId: unknown) {
    admin(session);
    const id = positiveResourceId(rawId);
    const row = await this.database.wppWallet.findFirst({ where: { id, instance: session.instance }, include: { WppWalletUser: true } });
    if (!row) throw new NotFoundError("Carteira não encontrada nesta empresa.");
    return snapshot(row, row.WppWalletUser.map(member => member.userId));
  }

  async create(session: SessionData, input: unknown) {
    admin(session);
    const data = body(input, ["name"]);
    const row = await this.database.wppWallet.create({ data: { instance: session.instance, name: name(data["name"]) } });
    return snapshot(row, []);
  }

  // All mutations of a wallet acquire its parent row lock before reading a snapshot.
  // The tenant SQL router rewrites this fixed logical table to its physical table.
  private async locked<T>(session: SessionData, rawId: unknown, operation: (tx: Tx, row: ReturnType<typeof snapshot>) => Promise<T>) {
    admin(session);
    const id = positiveResourceId(rawId);
    return this.database.$transaction(async tx => {
      const rows = await tx.$queryRawUnsafe<WalletRow[]>("SELECT id, instance, name FROM wallets WHERE id=? AND instance=? FOR UPDATE", id, session.instance);
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
