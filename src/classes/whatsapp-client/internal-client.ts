import CreateInternalMessageDto from "../../dtos/create-internal-message.dto";
import { SendMessageOptions } from "../../types/whatsapp-instance.types";

/**
 * Abstract class representing a WhatsApp instance.
 * This class defines the structure for interacting with WhatsApp,
 */
abstract class InternalChatClient {
	/**
	 * The phone number associated with the WhatsApp instance.
	 */
	public abstract readonly name: string;

	/**
	 * The name of the WhatsApp instance.
	 */
	public abstract readonly instance: string;

	/**
	 * Represents the phone number associated with the WhatsApp client.
	 * This is an abstract property that must be implemented by subclasses.
	 *
	 * @readonly
	 */
	public abstract readonly phone: string;

	/**
	 * Fetches the WhatsApp profile picture URL by phone number.
	 *
	 * @example
	 * getProfilePictureUrl("123456789"); // "https://...url"
	 *
	 * @param phone - The phone number of the WhatsApp user.
	 * @returns - The profile picture URL or `null` if not available.
	 */
	public abstract getProfilePictureUrl(phone: string): Promise<string | null>;

	/**

	/**
	 * Sends a message formats a WhatsApp number.
	 *
	 * @example
	 * sendMessage({ phone: "123456789", message: "Hello!" });
	 *
	 * @param props - An object containing message details.
	 * @returns - A promise resolved when the message is sent.
	 */
	public abstract sendMessage(
		props: SendMessageOptions
	): Promise<CreateInternalMessageDto>;
}

export default InternalChatClient;
