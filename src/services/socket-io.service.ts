import { Server } from "socket.io";
import {
	ChatFinishedEventProps,
	QrCodeEventProps,
	SocketEventType,
	SocketEventValue
} from "../types/socket-io.types";

class SocketIoService {
	private readonly server: Server;

	constructor() {
		const listenPort = Number(process.env["SOCKET_LISTEN_PORT"]) || 5001;

		this.server = new Server(listenPort, {
			cors: {
				origin: process.env["SOCKET_ALLOWED_ORIGIN"] || "http://localhost:3000"
			}
		});

		this.server.on("connection", (socket) => {
			console.log("Received a new connection:", socket.conn.remoteAddress);
		});
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

	public emit(instanceName: string, room: string, event: SocketEventType, value: SocketEventValue) {
		return this.server.to(`${instanceName}:${room}`).emit(event, value);
	}
}

export default new SocketIoService();
