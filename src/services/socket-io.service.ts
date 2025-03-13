import { Server } from "socket.io";
import httpServer from "../server";

import {
	ChatFinishedEventProps,
	QrCodeEventProps,
	SocketEventType,
	SocketEventValue
} from "../types/socket-io.types";
import Logger from "../entities/logger";

class SocketIoService {
	private readonly server: Server;

	constructor() {
		this.server = new Server(httpServer, {
			cors: {
				origin:
					process.env["SOCKET_ALLOWED_ORIGIN"] ||
					"http://localhost:3000"
			}
		});

		this.server.on("connection", (socket) => {
			Logger.debug("New connection:", socket.conn.remoteAddress);
		});

		this.server.listen(3000)
	}

	public emit(
		instanceName: string,
		room: string,
		event: SocketEventType.CHAT_FINISHED,
		value: ChatFinishedEventProps
	): boolean;

	public emit(
		instanceName: string,
		room: string,
		event: SocketEventType.QR_CODE,
		value: QrCodeEventProps
	): boolean;

	public emit(
		instanceName: string,
		room: string,
		event: SocketEventType,
		value: SocketEventValue
	) {
		return this.server.to(`${instanceName}:${room}`).emit(event, value);
	}
}

export default new SocketIoService();
