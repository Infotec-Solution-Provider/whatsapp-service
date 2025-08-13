import WAWebJS from "whatsapp-web.js";

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

async function executeWwebjsLoadMessagesRoutine(client: WAWebJS.Client) {
	try {
		console.log(`Executando rotina para o wwebjs`);

		const chats = await client.getChats();
		console.log(`${chats.length} chats encontrados!`);

		for (const chat of chats) {
			const messages = await chat.fetchMessages({
				limit: 999,
				fromMe: false
			});

			const sevenDaysAgo = Date.now() - SEVEN_DAYS;
			const recentMessages = messages.filter(
				(m) => m.timestamp >= sevenDaysAgo
			);

			console.log(`Chat: ${chat.id.user} | ${chat.name}`);
			console.log(recentMessages);
			console.log(
				"---------------------------------------------------------------------"
			);
		}
	} catch (err: any) {
		console.error(err);
	}
}

export default executeWwebjsLoadMessagesRoutine;
