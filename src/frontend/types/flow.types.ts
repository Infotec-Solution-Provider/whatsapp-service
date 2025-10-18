/**
 * Types for Message Flow Management Frontend
 */

export enum WppMessageFlowStepType {
	// Generic Steps
	QUERY = "QUERY",
	CONDITION = "CONDITION",
	ROUTER = "ROUTER",
	ASSIGN = "ASSIGN",

	// Specific Steps
	CHECK_ONLY_ADMIN = "CHECK_ONLY_ADMIN",
	CHECK_LOALTY = "CHECK_LOALTY",
	CHECK_AVAILABLE_USERS = "CHECK_AVAILABLE_USERS",
	SEND_TO_ADMIN = "SEND_TO_ADMIN"
}

export interface FlowStep {
	id: number;
	flowId: number;
	stepNumber: number;
	stepType: WppMessageFlowStepType;
	nextStepId: number | null;
	fallbackStepId: number | null;
	config: Record<string, any>;
	connections: StepConnections | null; // Conexões condicionais/dinâmicas separadas do config
	description: string | null;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

// Tipos de conexões para diferentes step types
export interface StepConnections {
	// CONDITION
	onTrue?: number; // ID do step para condição verdadeira
	onFalse?: number; // ID do step para condição falsa

	// ROUTER
	routes?: Record<string, number>; // Mapa de valor -> ID do step
	defaultRoute?: number; // Rota padrão se nenhum valor corresponder
}

export interface Flow {
	id: number;
	instance: string;
	sectorId: number | null;
	description: string | null;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	steps?: FlowStep[];
}

export interface CreateFlowDTO {
	instance: string;
	sectorId?: number;
	description?: string;
}

export interface UpdateFlowDTO {
	description?: string;
	enabled?: boolean;
}

export interface CreateStepDTO {
	stepNumber: number;
	stepType: WppMessageFlowStepType;
	nextStepId?: number;
	fallbackStepId?: number;
	config: Record<string, any>;
	connections?: StepConnections; // Conexões condicionais/dinâmicas
	description?: string;
	enabled?: boolean;
}

export interface UpdateStepDTO {
	stepNumber?: number;
	stepType?: WppMessageFlowStepType;
	nextStepId?: number;
	fallbackStepId?: number;
	config?: Record<string, any>;
	connections?: StepConnections; // Conexões condicionais/dinâmicas
	description?: string;
	enabled?: boolean;
}

export interface StepOrderDTO {
	stepId: number;
	stepNumber: number;
}

export interface ReorderStepsDTO {
	stepOrders: StepOrderDTO[];
}

export interface DuplicateFlowDTO {
	targetInstance: string;
	targetSectorId?: number;
}

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

export interface ApiResponse<T> {
	success: boolean;
	data?: T;
	error?: string;
	message?: string;
}
