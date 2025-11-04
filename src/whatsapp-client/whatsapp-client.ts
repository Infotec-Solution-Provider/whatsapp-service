import { TemplateMessage } from "../adapters/template.adapter";
import CreateMessageDto from "../dtos/create-message.dto";
import { EditMessageOptions, SendMessageOptions, SendTemplateOptions } from "../types/whatsapp-instance.types";

/**
 * Abstract class representing a WhatsApp instance.
 * This class defines the structure for interacting with WhatsApp,
 */
abstract class WhatsappClient {
	public abstract readonly id: number;
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
	 * Checks if a phone number is registered on WhatsApp.
	 *
	 * @example
	 * isValidWhatsapp("1234"); // false
	 *
	 * @param phone - The phone number formats be verified.
	 * @returns - `true` if the number is valid on WhatsApp, otherwise `false`.
	 */
	public abstract isValidWhatsapp(phone: string): Promise<boolean>;

	/**
	 * Sends a message formats a WhatsApp number.
	 *
	 * @example
	 * sendMessage({ phone: "123456789", message: "Hello!" });
	 *
	 * @param props - An object containing message details.
	 * @returns - A promise resolved when the message is sent.
	 */
	public abstract sendMessage(props: SendMessageOptions, isGroup?: boolean): Promise<CreateMessageDto>;

	/**
	 * Edits a previously sent message.
	 * @example
	 * editMessage({ messageId: "msg123", newContent: "Updated message" });
	 *
	 * @param props - An object containing edit message details.
	 * @returns - A promise resolved when the message is edited.
	 */
	public abstract editMessage(props: EditMessageOptions): Promise<void>;

	public abstract getTemplates(): Promise<TemplateMessage[]>;

	public abstract sendTemplate(
		props: SendTemplateOptions,
		chatId: number,
		contactId: number
	): Promise<CreateMessageDto>;

	public abstract forwardMessage(to: string, messageId: string, isGroup: boolean): Promise<void>;
}

export default WhatsappClient;
