import { EmitSocketEventFn } from "./types/socket-events.types";
import ApiClient from "./api-client";
import { MessageResponse } from "./types/response.types";

/**
 * A client for interacting with a socket server API.
 * Extends the `ApiClient` class to provide http functionality
 * for emitting events to specific rooms on the server.
 */
export default class SocketServerApi extends ApiClient {
	/**
	 * Creates an instance of the SocketServerApiClient.
	 *
	 * @param baseUrl - The base URL for the socket server API.
	 */
	constructor(baseUrl: string) {
		super(baseUrl);
	}

	/**
	 * Emits a socket event to a specified room with a given event name and value.
	 *
	 * @param event - The name of the event to emit.
	 * @param room - The name of the room to which the event should be emitted.
	 * @param value - The payload or data to send with the event.
	 * @returns A promise that resolves with the response from the API call.
	 */
	public emit: EmitSocketEventFn = (event, room, value) => {
		return this.ax
			.post<MessageResponse>(`/api/ws/emit/${room}/${event}`, value)
			.then((res) => res.data);
	};
}
