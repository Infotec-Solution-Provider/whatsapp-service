/** Template authorship comes from the authenticated action, never the chat owner or provider. */
export function getTemplateAttribution(userId: number, agentId?: number | null) {
	if (Number.isSafeInteger(agentId) && agentId! > 0) {
		return { userId: null, agentId: agentId! };
	}
	return {
		userId: Number.isSafeInteger(userId) && userId > 0 ? userId : null,
		agentId: null
	};
}
