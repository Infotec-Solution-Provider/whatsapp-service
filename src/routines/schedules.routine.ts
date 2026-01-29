import prismaService from "../services/prisma.service";
import ProcessingLogger from "../utils/processing-logger";
import chatsService from "../services/chats.service";
import { WppContact, WppSchedule } from "@prisma/client";

export default async function runSchedulesJob() {
	const process = new ProcessingLogger("system", "schedules-job", Date.now().toString(), null);
	try {
		const schedules = await getPendingSchedules(process);

		for (const schedule of schedules) {
			try {
				const chat = await getChatForSchedule(process, schedule, schedule.contact as WppContact);
				console.log(schedule.id);
				await updateScheduleWithChatId(process, schedule.id, chat.id);
			} catch (err: any) {
				process.log(`Erro ao processar agendamento id: ${schedule.id}: ` + err.message);
			}
		}
	} catch (err: any) {
		process.log("Erro ao executar rotina de agendamentos: " + err.message);
		process.failed(err);
	}
}

async function getPendingSchedules(process: ProcessingLogger) {
	try {
		process.log("Fetching pending schedules...");
		const schedules = await prismaService.wppSchedule.findMany({
			where: {
				chatId: null,
				scheduleDate: {
					lte: new Date()
				}
			},
			include: {
				contact: true
			}
		});
		process.log(`Found ${schedules.length} pending schedules.`);

		return schedules;
	} catch (err: any) {
		throw new Error("Erro ao buscar agendamentos pendentes: " + err.message, { cause: err });
	}
}

async function getChatForSchedule(process: ProcessingLogger, schedule: WppSchedule, contact: WppContact) {
	try {
		process.log(
			`Getting chat for schedule id: ${schedule.id}, contactId: ${schedule.contactId}, instance: ${schedule.instance}`
		);
		const ongoingChat = await prismaService.wppChat.findFirst({
			where: {
				contactId: schedule.contactId,
				instance: schedule.instance,
				isFinished: false
			}
		});

		if (ongoingChat) {
			process.log(`Chat already open with id: ${ongoingChat.id}`);
			return ongoingChat;
		}
		process.log("Not any chat open, creating a new one.");
		const newChat = await chatsService.systemStartNewChat({
			instance: schedule.instance,
			sectorId: schedule.sectorId!,
			userId: schedule.scheduledFor || schedule.scheduledBy,
			contact,
			systemMessage: `Atendimento iniciado por um agendamento.`
		});
		process.log(`New chat created with id: ${newChat.id}`, newChat);

		return newChat;
	} catch (err: any) {
		throw new Error("Erro ao obter chat para o agendamento: " + err.message, { cause: err });
	}
}

async function updateScheduleWithChatId(process: ProcessingLogger, scheduleId: number, chatId: number) {
	try {
		process.log(`Updating schedule id: ${scheduleId} with chatId: ${chatId}`);
		await prismaService.wppSchedule.update({
			where: { id: scheduleId },
			data: { chatId }
		});
		process.log(`Schedule id: ${scheduleId} updated successfully.`);
	} catch (err: any) {
		throw new Error("Erro ao atualizar agendamento com chatId: " + err.message, { cause: err });
	}
}
