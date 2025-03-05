import exportChats from "./export-chats";
import { getExports } from "./export-chats/fetch-exports";

class ToolsService {
	public exportChats = exportChats;
	public getExportedChats = getExports;
}

export default new ToolsService();
