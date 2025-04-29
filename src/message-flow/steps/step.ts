import { WppChatType, WppContact } from "@prisma/client";
import ProcessingLogger from "../../utils/processing-logger";

export interface StepContext {
	contact: WppContact;
	logger: ProcessingLogger;
}

export interface NextStep {
	isFinal: false;
	stepId: number;
}

export interface FinalStep {
	isFinal: true;
	chatData: ChatPayload;
}

export interface ChatPayload {
	instance: string;
	type: WppChatType;
	userId?: number | null;
	walletId?: number | null;
	sectorId: number;
	contactId: number;
}

export default abstract class Step {
	public abstract id: number;
	public abstract run(context: StepContext): Promise<NextStep | FinalStep>;
}
