function parseVCard(vCardText: string) {
	if (!vCardText || typeof vCardText !== "string") {
		return "";
	}
	const lines = vCardText.split("\n");
	let phoneNumber = "";

	let parsedData: any = {};
	lines.forEach((line) => {
		line = line.trim();
		if (line.length > 0) {
			line = line.trim();
			if ((line.startsWith("TEL;") || line.startsWith("item1.TEL;")) && line.includes("waid=")) {
				// Verifica se a linha contém "TEL;" e "waid="
				const phoneNumberIndex = line.indexOf("waid=") + 5; // Obtém o índice do início do número de telefone
				phoneNumber = line.substring(phoneNumberIndex).trim(); // Extrai o número de telefone
			}
			const firstColonIndex = line.indexOf(":");
			if (firstColonIndex !== -1) {
				// Verifica se há pelo menos um ":" na linha
				const key = line.substring(0, firstColonIndex).trim();
				const value = line.substring(firstColonIndex + 1).trim();
				parsedData[key] = value;
			}
		}
	});
	let parsedDatas: string = `--- Anexo de Contato ---\n${parsedData.FN}\n${phoneNumber.split(":")[1] || ""}\n--------------------------`;
	return parsedDatas.trim();
}

export default parseVCard;
