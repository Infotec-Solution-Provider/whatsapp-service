import WAWebJS from "whatsapp-web.js";

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

async function executeWwebjsLoadMessagesRoutine(client: WAWebJS.Client) {
	try {
		console.log(`Executando rotina para o wwebjs`);

		const chats = await client.getChats();
		console.log(`${chats.length} chats encontrados!`);

		let totalMessages = 0;
		let minTimestamp: number | null = null;
		let maxTimestamp: number | null = null;

		for (const chat of chats) {
			const messages = await chat.fetchMessages({
				limit: 999,
				fromMe: false
			});

			const sevenDaysAgo = Date.now() - SEVEN_DAYS;
			const recentMessages = messages.filter(
				(m) => m.timestamp >= sevenDaysAgo
			);

			if (recentMessages.length === 0) continue;

			// Determina tipo de chat
			const isGroup = !!chat.isGroup;
			const sigla = isGroup ? "G" : "P";
			const chatName = chat.name || chat.id.user;

			// Período das mensagens
			const timestamps = recentMessages
				.map((m) => m.timestamp)
				.filter(Boolean)
				.sort();
			const chatMin = timestamps[0];
			const chatMax = timestamps[timestamps.length - 1];

			if (
				typeof chatMin === "number" &&
				(minTimestamp === null || chatMin < minTimestamp)
			)
				minTimestamp = chatMin;
			if (
				typeof chatMax === "number" &&
				(maxTimestamp === null || chatMax > maxTimestamp)
			)
				maxTimestamp = chatMax;

			totalMessages += recentMessages.length;

			const formatDate = (ts?: number) => {
				if (!ts) return "-";
				const d = new Date(ts);
				return d.toLocaleDateString("pt-BR");
			};

			console.log(`[${sigla}] ${chatName}`);
			console.log(`Mensagens recuperadas: ${recentMessages.length}`);
			console.log(
				`Período: ${formatDate(chatMin)} - ${formatDate(chatMax)}`
			);
			console.log(
				"---------------------------------------------------------------------"
			);
		}

		if (totalMessages > 0 && minTimestamp && maxTimestamp) {
			const formatDate = (ts: number) => {
				const d = new Date(ts);
				return d.toLocaleDateString("pt-BR");
			};
			console.log(`Resumo geral:`);
			console.log(`Total de mensagens recuperadas: ${totalMessages}`);
			console.log(
				`Período total: ${formatDate(minTimestamp)} - ${formatDate(maxTimestamp)}`
			);
		}
	} catch (err: any) {
		console.error(err);
	}
}

export default executeWwebjsLoadMessagesRoutine;
