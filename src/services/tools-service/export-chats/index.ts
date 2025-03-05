import { ExportChatsProps } from "../../../types/export-chats.types";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import ChatToExportFactory from "../../../entities/chat-to-export/factory";
import FilesFactory from "../../../entities/file-factory/factory";
import ZipFactory from "../../../entities/file-factory/zip";
import fetchMessages from "./fetch-messages";
import TaskQueue from "../../../entities/task-queue";
import { saveExport } from "./fetch-exports";

async function exportChats(props: ExportChatsProps) {
	const { instance, format, userId, startDate, endDate } = props;

	if (!process.env["REPORTS_PATH"]) {
		throw new Error("Missing 'REPORTS_PATH' variable on .env");
	}

	const filesPath = path.resolve(process.env["REPORTS_PATH"]);
	const folderName = `chats_${Date.now()}`;
	const zipName = `${folderName}.zip`;
	const tmpFolder = `${filesPath}/temp/${folderName}`;
	await mkdir(tmpFolder, { recursive: true });

	const messages = await fetchMessages(instance, userId, startDate, endDate);
	const chats = ChatToExportFactory.buildChats(messages);
	const queue = new TaskQueue(format === "pdf" ? 2 : 100);
	const ff = FilesFactory.getFactory(format);

	chats.forEach((chat) => {
		queue.add(async () => {
			const content = chat.toFile(instance, format);
			const fileName = chat.phone + "." + format;

			await ff.createFile(tmpFolder, fileName, content);
		});
	});

	await queue.completion();
	const zipPath = path.resolve(filesPath, zipName);
	await new ZipFactory().createFile(tmpFolder, zipPath);
	rm(tmpFolder, { recursive: true, force: true }).catch();

	await saveExport(props, zipName);

	return zipName;
}

export default exportChats;
