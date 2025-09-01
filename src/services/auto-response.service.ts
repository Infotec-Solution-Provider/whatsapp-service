import prismaService from "./prisma.service";

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
        dayOfWeek: number;
        startTime: string;
        endTime: string;
    }[];
}

type UpdateRuleDto = Omit<CreateRuleDto, 'instance'>;

class AutoResponseService {


    public async getRules(instance: string) {
        return await prismaService.automaticResponseRule.findMany({
            where: { instance },
            include: {
                schedules: true,
                userAssignments: {
                    select: { userId: true }
                }
            }
        });
    }


    public async getRuleById(id: number) {
        return await prismaService.automaticResponseRule.findUnique({
            where: { id },
            include: {
                schedules: true,
                userAssignments: {
                    select: { userId: true }
                }
            }
        });
    }

    public async createRule(data: CreateRuleDto) {
        const { instance, name, message, isEnabled, isGlobal, cooldownSeconds, fileId, userIds, schedules } = data;

        return await prismaService.automaticResponseRule.create({
            data: {
                instance,
                name,
                message,
                isEnabled,
                isGlobal,
                cooldownSeconds,
                fileId: fileId || null,
                schedules: {
                    create: schedules
                },
                userAssignments: {
                    create: userIds?.map(id => ({ userId: id })) || []
                }
            }
        });
    }


    public async updateRule(ruleId: number, data: UpdateRuleDto) {
        const { name, message, isEnabled, isGlobal, cooldownSeconds, fileId, userIds, schedules } = data;

        return await prismaService.$transaction(async (prisma) => {
            const updatedRule = await prisma.automaticResponseRule.update({
                where: { id: ruleId },
                data: {
                    name,
                    message,
                    isEnabled,
                    isGlobal,
                    cooldownSeconds,
                    fileId: fileId || null,
                }
            });

            await prisma.automaticResponseSchedule.deleteMany({
                where: { ruleId: ruleId }
            });

            await prisma.automaticResponseSchedule.createMany({
                data: schedules.map(s => ({ ...s, ruleId: ruleId }))
            });

            await prisma.automaticResponseRuleUser.deleteMany({
                where: { ruleId: ruleId }
            });

            if (userIds && userIds.length > 0) {
                await prisma.automaticResponseRuleUser.createMany({
                    data: userIds.map(id => ({ ruleId: ruleId, userId: id }))
                });
            }

            return updatedRule;
        });
    }


    public async deleteRule(ruleId: number) {
               return await prismaService.automaticResponseRule.delete({
            where: { id: ruleId }
        });
    }
}

export default new AutoResponseService();
