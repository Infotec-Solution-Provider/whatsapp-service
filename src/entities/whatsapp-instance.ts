import { SendMessageOptions } from "../types/whatsapp-instance.types";

// noinspection JSUnusedGlobalSymbols
abstract class WhatsappInstance {
	public abstract readonly phone: string;
	public abstract readonly instanceName: string;

	/**
	 * Fetch whatsapp profile picture by phone number
	 * @example
	 *		getProfilePictureUrl("123456789"); // "https://...url"
	 *
	 * @param {String} phone - Phone number.
	 * */
	public abstract getProfilePictureUrl(phone: string): Promise<string | null>;

	public abstract isValidWhatsapp(phone: string): Promise<boolean>;

	public abstract sendMessage(props: SendMessageOptions): Promise<void>;
}

export default WhatsappInstance;
