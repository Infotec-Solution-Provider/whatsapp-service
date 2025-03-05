import instancesService from "../../instances.service";

interface InpulseUser {
	CODIGO: number;
	NOME: string;
}

async function fetchUsers(instance: string) {
	const usersMap = new Map<number, InpulseUser>();
	const result = await instancesService.executeQuery<Array<InpulseUser>>(
		instance,
		"SELECT CODIGO, NOME FROM operadores",
		[]
	);

	console.log(result);

	result.forEach((u) => usersMap.set(u.CODIGO, u));

	return usersMap;
}

export default fetchUsers;
