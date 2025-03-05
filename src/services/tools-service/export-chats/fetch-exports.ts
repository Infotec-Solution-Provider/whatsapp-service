import {
	DBExportedChat,
	ExportChatsProps,
	ExportedChatInfo
} from "../../../types/export-chats.types";
import instancesService from "../../instances.service";
import fetchUsers from "./fetch-users";

export async function saveExport(
	exportData: ExportChatsProps,
	filePath: string
) {
	try {
		const { instance, userId, format, startDate, endDate } = exportData;

		await instancesService.executeQuery(
			instance,
			"insert into w_chats_exports (instance, user_id, format, start_date, end_date, file_name) values (?, ?, ?, ?, ?, ?)",
			[instance, userId, format, startDate, endDate, filePath]
		);
	} catch (cause) {
		throw new Error("Failed to save export on database", { cause });
	}
}

export async function getExports(instance: string) {
	const result = await instancesService.executeQuery<Array<DBExportedChat>>(
		instance,
		"select * from w_chats_exports",
		[]
	);

	const parsedExports: Array<ExportedChatInfo> = [];
	const users = await fetchUsers(instance);

	result.forEach((e) => {
		const userId: number | null =
			e.user_id !== "*" ? Number(e.user_id) : null;
		const user = userId
			? users.get(userId) || { NOME: "Usuário removido" }
			: null;
		const userName = user ? user.NOME : "TODOS";

		parsedExports.push({
			instance: e.instance,
			format: e.format,
			startDate: e.start_date,
			endDate: e.end_date,
			fileName: e.file_name,
			userName
		});
	});

	return parsedExports;
}
