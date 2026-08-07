// src/types/socket-rooms.types.ts
type ReportType = "chats";
type ChatId = number;
type InternalChatId = number;
type WalletId = number;
type UserId = number;
type SectorId = number;
type InstanceName = string;

/* 
    Salas de Socket do lado do cliente;
    Essas salas omitem o nome da instancia e/ou id do setor,
    pois isso é controlado pelo servidor;
*/
export type SocketClientChatRoom = `chat:${ChatId}`;
export type SocketClientAdminRoom = "admin";
export type SocketClientMonitorRoom = `monitor`;
export type SocketClientReportsRoom = `reports:${ReportType}`;
export type SocketClientWalletRoom = `wallet:${WalletId}`;
export type SocketClientUserRoom = `user:${UserId}`;
export type SocketClientInternalChatRoom = `internal-chat:${InternalChatId}`;
export type SocketClientRoom =
	| SocketClientChatRoom
	| SocketClientAdminRoom
	| SocketClientReportsRoom
	| SocketClientMonitorRoom
	| SocketClientWalletRoom
	| SocketClientUserRoom
	| SocketClientInternalChatRoom;

// Interface que incluí o nome da instancia na sala de socket;
type SocketRoomWithInstance<T extends string> = `${InstanceName}:${T}`;

// Interface que incluí o nome da instancia e o id do setor na sala de socket;
type SocketRoomWithSector<T extends string> =
	SocketRoomWithInstance<`${SectorId}:${T}`>;

/* 
    Salas de Socket do lado do servidor;
    Essas salas incluem o nome da instancia e o id do setor,
    Permitindo que cada instancia consiga ver apenas o que lhe
    pertence, e não as salas de outras instancias.
*/
export type SocketServerAdminRoom = SocketRoomWithSector<SocketClientAdminRoom>;
export type SocketServerMonitorRoom =
	SocketRoomWithSector<SocketClientMonitorRoom>;
export type SocketServerReportsRoom =
	SocketRoomWithSector<SocketClientReportsRoom>;
export type SocketServerChatRoom = SocketRoomWithInstance<SocketClientChatRoom>;
export type SocketServerWalletRoom =
	SocketRoomWithInstance<SocketClientWalletRoom>;
export type SocketServerUserRoom = SocketRoomWithInstance<SocketClientUserRoom>;
export type SocketServerInternalChatRoom =
	SocketRoomWithInstance<SocketClientInternalChatRoom>;
export type SocketServerRoom =
	| SocketServerChatRoom
	| SocketServerAdminRoom
	| SocketServerMonitorRoom
	| SocketServerReportsRoom
	| SocketServerWalletRoom
	| SocketServerUserRoom
	| SocketServerInternalChatRoom;

export interface JoinRoomFn {
	(room: SocketClientRoom): void;
}
