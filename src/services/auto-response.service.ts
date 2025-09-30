import prismaService from "./prisma.service";
import { Prisma, Frequency } from "@prisma/client";

interface CreateRuleDto {
  instance: string;
  name: string;
  message: string;
  isEnabled: boolean;
  isGlobal: boolean;
  cooldownSeconds: number;
  fileId?: number | null;
  userIds?: number[];
  schedules: {
    frequency?: Frequency;
    daysOfWeek?: number[] | null;
    dayOfMonth?: number | null;
    month?: number | null;
    timezone?: string | null;
    startDate?: string | Date | null;
    endDate?: string | Date | null;
    startTime: string;
    endTime: string;

    dayOfWeek?: number | null;
  }[];
}

type UpdateRuleDto = Omit<CreateRuleDto, "instance">;


function toDateOrNull(v?: string | Date | null): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  return new Date(v);
}

function normalizeSchedulesForCreate(
  schedules: CreateRuleDto["schedules"]
): Prisma.AutomaticResponseScheduleCreateWithoutRuleInput[] {
  return schedules.map((s) => {
    const frequency: Frequency = (s.frequency ?? "WEEKLY") as Frequency;

    const base: Prisma.AutomaticResponseScheduleCreateWithoutRuleInput = {
      frequency,
      startTime: s.startTime,
      endTime: s.endTime,
      timezone: s.timezone || "America/Fortaleza",
      startDate: toDateOrNull(s.startDate),
      endDate: toDateOrNull(s.endDate),

      dayOfMonth: s.dayOfMonth ?? null,
      month: s.month ?? null,

      dayOfWeek: s.dayOfWeek ?? null,
    };

    if (Array.isArray(s.daysOfWeek) && s.daysOfWeek.length) {
      (base as any).daysOfWeek = s.daysOfWeek as unknown as Prisma.InputJsonValue;
    } else if (s.dayOfWeek !== undefined && s.dayOfWeek !== null) {
      (base as any).daysOfWeek = [s.dayOfWeek] as unknown as Prisma.InputJsonValue;
    }

    return base;
  });
}

function normalizeSchedulesForCreateMany(
  ruleId: number,
  schedules: CreateRuleDto["schedules"]
): Prisma.AutomaticResponseScheduleCreateManyInput[] {
  return schedules.map((s) => {
    const frequency: Frequency = (s.frequency ?? "WEEKLY") as Frequency;

    const base: Prisma.AutomaticResponseScheduleCreateManyInput = {
      ruleId,
      frequency,
      startTime: s.startTime,
      endTime: s.endTime,
      timezone: s.timezone || "America/Fortaleza",
      startDate: toDateOrNull(s.startDate),
      endDate: toDateOrNull(s.endDate),

      dayOfMonth: s.dayOfMonth ?? null,
      month: s.month ?? null,
      dayOfWeek: s.dayOfWeek ?? null,
    };

    if (Array.isArray(s.daysOfWeek) && s.daysOfWeek.length) {
      (base as any).daysOfWeek = s.daysOfWeek as unknown as Prisma.InputJsonValue;
    } else if (s.dayOfWeek !== undefined && s.dayOfWeek !== null) {
      (base as any).daysOfWeek = [s.dayOfWeek] as unknown as Prisma.InputJsonValue;
    }

    return base;
  });
}


class AutoResponseService {
  public async getRules(instance: string) {
    return await prismaService.automaticResponseRule.findMany({
      where: { instance },
      include: {
        schedules: true,
        userAssignments: { select: { userId: true } },
      },
      orderBy: [{ id: "desc" }],
    });
  }

  public async getRuleById(id: number) {
    return await prismaService.automaticResponseRule.findUnique({
      where: { id },
      include: {
        schedules: true,
        userAssignments: { select: { userId: true } },
      },
    });
  }

  public async createRule(data: CreateRuleDto) {
    const {
      instance,
      name,
      message,
      isEnabled,
      isGlobal,
      cooldownSeconds,
      fileId,
      userIds,
      schedules,
    } = data;

    const schedulesData = normalizeSchedulesForCreate(schedules);

    return await prismaService.automaticResponseRule.create({
      data: {
        instance,
        name,
        message,
        isEnabled,
        isGlobal,
        cooldownSeconds,
        fileId: fileId ?? null,
        schedules: {
          create: schedulesData,
        },
        userAssignments: {
          create: (userIds ?? []).map((id) => ({ userId: id })),
        },
      },
      include: {
        schedules: true,
        userAssignments: { select: { userId: true } },
      },
    });
  }

  public async updateRule(ruleId: number, data: UpdateRuleDto) {
    const {
      name,
      message,
      isEnabled,
      isGlobal,
      cooldownSeconds,
      fileId,
      userIds,
      schedules,
    } = data;

    return await prismaService.$transaction(async (prisma) => {
      const updatedRule = await prisma.automaticResponseRule.update({
        where: { id: ruleId },
        data: {
          name,
          message,
          isEnabled,
          isGlobal,
          cooldownSeconds,
          fileId: fileId ?? null,
        },
      });

      await prisma.automaticResponseSchedule.deleteMany({
        where: { ruleId },
      });

      const rows = normalizeSchedulesForCreateMany(ruleId, schedules);
      if (rows.length) {
        await prisma.automaticResponseSchedule.createMany({
          data: rows,
        });
      }

      await prisma.automaticResponseRuleUser.deleteMany({
        where: { ruleId },
      });
      if (userIds && userIds.length > 0) {
        await prisma.automaticResponseRuleUser.createMany({
          data: userIds.map((id) => ({ ruleId, userId: id })),
        });
      }

      return updatedRule;
    });
  }

  public async deleteRule(ruleId: number) {
    return await prismaService.automaticResponseRule.delete({
      where: { id: ruleId },
    });
  }
}

export default new AutoResponseService();
