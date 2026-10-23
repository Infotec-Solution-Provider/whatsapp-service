import { NotFoundError, UnauthorizedError } from "@rgranatodutra/http-errors";
import type { SessionData } from "../sdk-local";
import positiveResourceId from "../utils/positive-resource-id";
import prismaService from "./prisma.service";

export class SectorClientsService {
  constructor(private readonly database = prismaService) {}

  async list(session: SessionData, rawId: unknown) {
    const sectorId = rawId === "0" || rawId === 0 ? 0 : positiveResourceId(rawId);
    if (session.role !== "ADMIN" && sectorId !== session.sectorId) throw new UnauthorizedError("Você só pode consultar os canais do seu setor.");
    if (sectorId === 0) return [];
    const sector = await this.database.wppSector.findFirst({
      where: { id: sectorId, instance: session.instance },
      select: { clients: { where: { instance: session.instance }, select: { id: true, name: true, type: true } } }
    });
    if (!sector) throw new NotFoundError("Setor não encontrado nesta empresa.");
    return sector.clients;
  }
}

export default new SectorClientsService();
