import { WppChat, WppContact, WppMessage } from "@prisma/client";
import ProcessingLogger from "../../utils/processing-logger";

export interface StepContext {
	message: WppMessage;
	contact: WppContact;
	logger: ProcessingLogger;
}

export interface NextStep {
	isFinal: false;
	stepId: number;
}

export interface FinalStep {
	isFinal: true;
	chat: WppChat;
}

export default abstract class Step {
	public abstract id: number;
	public abstract run(
		context: StepContext
	): Promise<NextStep | FinalStep>;
}
