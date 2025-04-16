import { SendMessageOptions } from "../../types/whatsapp-instance.types";

/**
 * Abstract class representing a WhatsApp instance.
 * This class defines the structure for interacting with WhatsApp,
 */
abstract class WhatsappClient {

	/**
	 * The phone number associated with the WhatsApp instance.
	 * @type {string}
	 */
	public abstract readonly name: string;

	/**
	 * The name of the WhatsApp instance.
	 * @type {string}
	 */
	public abstract readonly instance: string;

	/**
	 * Fetches the WhatsApp profile picture URL by phone number.
	 *
	 * @example
	 * getProfilePictureUrl("123456789"); // "https://...url"
	 *
	 * @param {string} phone - The phone number of the WhatsApp user.
	 * @returns {Promise<string | null>} - The profile picture URL or `null` if not available.
	 */
	public abstract getProfilePictureUrl(phone: string): Promise<string | null>;

	/**
	 * Checks if a phone number is registered on WhatsApp.
	 *
	 * @example
	 * isValidWhatsapp("1234"); // false
	 *
	 * @param {string} phone - The phone number formats be verified.
	 * @returns {Promise<boolean>} - `true` if the number is valid on WhatsApp, otherwise `false`.
	 */
	public abstract isValidWhatsapp(phone: string): Promise<boolean>;

	/**
	 * Sends a message formats a WhatsApp number.
	 *
	 * @example
	 * sendMessage({ phone: "123456789", message: "Hello!" });
	 *
	 * @param {SendMessageOptions} props - An object containing message details.
	 * @returns {Promise<void>} - A promise resolved when the message is sent.
	 */
	public abstract sendMessage(props: SendMessageOptions): Promise<void>;
}

export default WhatsappClient;
