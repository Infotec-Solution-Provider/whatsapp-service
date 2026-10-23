import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "@rgranatodutra/http-errors";
import type { SessionData } from "../sdk-local";
import positiveResourceId from "../utils/positive-resource-id";
import parseScheduleEdit from "./schedule-edit.contract";
import prismaService from "./prisma.service";
import instancesService from "./instances.service";

export class ScheduleCreationService {
  constructor(private readonly database = prismaService, private readonly crm = instancesService) {}

  async create(session: SessionData, input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["contactId", "date", "scheduledFor", "sectorId", "chatId"].includes(key))) throw new BadRequestError("Dados de agendamento inválidos.");
    const data = input as Record<string, unknown>;
    const contactId = positiveResourceId(data["contactId"]), sectorId = positiveResourceId(data["sectorId"]), scheduledFor = positiveResourceId(data["scheduledFor"]);
    const chatId = data["chatId"] === undefined ? undefined : positiveResourceId(data["chatId"]);
    if (session.role !== "ADMIN" && scheduledFor !== session.userId) throw new UnauthorizedError("Você só pode agendar retornos para si.");
    const rawDate = data["date"] instanceof Date && Number.isFinite(data["date"].getTime()) ? data["date"].toISOString() : data["date"];
    const date = parseScheduleEdit({ scheduleDate: rawDate }).scheduleDate!;
    const users = await this.crm.executeQuery<Array<{ CODIGO: number }>>(session.instance, "SELECT CODIGO FROM operadores WHERE CODIGO=? AND ATIVO='SIM' LIMIT 1", [scheduledFor]);
    if (!Array.isArray(users) || users.length !== 1 || Number(users[0]?.CODIGO) !== scheduledFor) throw new BadRequestError("Operador ativo não encontrado nesta empresa.");
    return this.database.$transaction(async tx => {
      if (!await tx.wppContact.findFirst({ where: { id: contactId, instance: session.instance, isDeleted: false, ...(session.role === "ADMIN" ? {} : { isOnlyAdmin: false }) } })) throw new NotFoundError("Contato ativo não encontrado nesta empresa.");
      if (!await tx.wppSector.findFirst({ where: { id: sectorId, instance: session.instance } })) throw new NotFoundError("Setor não encontrado nesta empresa.");
      const chats = await tx.wppChat.findMany({ where: { contactId, instance: session.instance, isFinished: false }, take: 2 });
      if (chats.length > 1) throw new ConflictError("Há mais de um atendimento aberto para este contato. Atualize a lista antes de agendar.");
      const chat = chats[0] ?? null;
      if (chatId !== undefined && chat?.id !== chatId) throw new ConflictError("O atendimento mudou. Atualize a lista antes de agendar.");
      if (chat) {
        if (chat.sectorId !== sectorId) throw new ConflictError("Use o setor atual do atendimento para agendar o retorno.");
        if (session.role !== "ADMIN" && chat.userId !== session.userId) throw new UnauthorizedError("Você só pode agendar o seu atendimento.");
      } else if (session.role !== "ADMIN" && sectorId !== session.sectorId) throw new UnauthorizedError("Use o seu setor para agendar sem atendimento aberto.");
      const schedule = await tx.wppSchedule.create({ data: { instance: session.instance, scheduledBy: session.userId, scheduledFor, scheduleDate: date, contactId, sectorId, scheduledAt: new Date() } });
      return { schedule, chat };
    });
  }
}

export default new ScheduleCreationService();
