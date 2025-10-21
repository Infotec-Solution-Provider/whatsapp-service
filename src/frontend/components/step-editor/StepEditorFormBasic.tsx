import {
	FormControl,
	FormControlLabel,
	FormHelperText,
	Grid,
	InputLabel,
	MenuItem,
	Select,
	Switch,
	TextField
} from "@mui/material";
import React from "react";
import type { FlowStep, WppMessageFlowStepType } from "../../types/flow.types";

// Traduz tipos de step para português
export const getStepTypeLabel = (stepType: WppMessageFlowStepType): string => {
	const labelMap: Record<WppMessageFlowStepType, string> = {
		SEND_TO_ADMIN: "Enviar Admin",
		CHECK_ONLY_ADMIN: "Verificar Admin",
		CHECK_LOALTY: "Verificar Lealdade",
		CHECK_AVAILABLE_USERS: "Verificar Usuários",

		QUERY: "Consulta",
		CONDITION: "Condição",
		ROUTER: "Roteador",
		ASSIGN: "Atribuir"
	};

	return labelMap[stepType] || stepType;
};

interface StepEditorFormBasicProps {
	stepNumber: number;
	enabled: boolean;
	stepType: WppMessageFlowStepType | "";
	description: string;
	nextStepId: string;
	fallbackStepId: string;
	stepTypes: WppMessageFlowStepType[];
	steps: FlowStep[];
	currentStepId?: number;
	onStepNumberChange: (value: number) => void;
	onEnabledChange: (value: boolean) => void;
	onStepTypeChange: (value: WppMessageFlowStepType) => void;
	onDescriptionChange: (value: string) => void;
	onNextStepIdChange: (value: string) => void;
	onFallbackStepIdChange: (value: string) => void;
}

export const StepEditorFormBasic: React.FC<StepEditorFormBasicProps> = ({
	stepNumber,
	enabled,
	stepType,
	description,
	nextStepId,
	fallbackStepId,
	stepTypes,
	steps,
	currentStepId,
	onStepNumberChange,
	onEnabledChange,
	onStepTypeChange,
	onDescriptionChange,
	onNextStepIdChange,
	onFallbackStepIdChange
}) => {
	// Determina se deve mostrar o campo nextStepId
	const showNextStepId = stepType !== "CONDITION" && stepType !== "ROUTER";

	// Determina se deve mostrar o campo fallbackStepId
	const showFallbackStepId =
		stepType === "QUERY" ||
		stepType === "ASSIGN" ||
		stepType === "CHECK_LOALTY" ||
		stepType === "CHECK_AVAILABLE_USERS";

	return (
		<>
			{/* Descrição - Primeiro campo (mais importante) */}
			<TextField
				label="Descrição"
				value={description}
				onChange={(e) => onDescriptionChange(e.target.value)}
				placeholder="Ex: Mensagem de boas-vindas"
				fullWidth
				helperText="Descrição clara do que este passo faz"
			/>

			{/* Número do Passo e Status (Habilitado) */}
			<Grid container spacing={2}>
				<Grid size={{ xs: 8 }}>
					<TextField
						label="Número do Passo"
						type="number"
						value={stepNumber}
						onChange={(e) => onStepNumberChange(parseInt(e.target.value))}
						required
						fullWidth
						helperText="Ordem de execução do passo no fluxo"
						slotProps={{ htmlInput: { min: 1 } }}
					/>
				</Grid>
				<Grid size={{ xs: 4 }}>
					<FormControlLabel
						control={<Switch checked={enabled} onChange={(e) => onEnabledChange(e.target.checked)} />}
						label="Habilitado"
						sx={{ 
							display: "flex",
							justifyContent: "center",
							height: "100%",
							m: 0
						}}
					/>
				</Grid>
			</Grid>

			{/* Tipo do Passo */}
			<FormControl fullWidth required>
				<InputLabel>Tipo do Passo</InputLabel>
				<Select
					value={stepType}
					label="Tipo do Passo"
					onChange={(e) => onStepTypeChange(e.target.value as WppMessageFlowStepType)}
				>
					{stepTypes.map((type) => (
						<MenuItem key={type} value={type}>
							{getStepTypeLabel(type)}
						</MenuItem>
					))}
				</Select>
			</FormControl>

			{/* Próximo Passo - Não mostrar para CONDITION e ROUTER */}
			{showNextStepId && (
				<FormControl fullWidth>
					<InputLabel>Próximo Passo</InputLabel>
					<Select
						value={nextStepId}
						label="Próximo Passo"
						onChange={(e) => onNextStepIdChange(e.target.value)}
					>
						<MenuItem value="">Nenhum (fim do fluxo)</MenuItem>
						{steps
							.filter((s) => s.id !== currentStepId)
							.map((s) => (
								<MenuItem key={s.id} value={s.id}>
									Passo #{s.stepNumber} - {getStepTypeLabel(s.stepType)}{" "}
									{s.description && `(${s.description})`}
								</MenuItem>
							))}
						<MenuItem value="new">Será criado depois</MenuItem>
					</Select>
					<FormHelperText>Passo que será executado em sequência após este</FormHelperText>
				</FormControl>
			)}

			{/* Fallback Step - Mostrar para steps que podem falhar */}
			{showFallbackStepId && (
				<FormControl fullWidth>
					<InputLabel>Passo Alternativo (Fallback)</InputLabel>
					<Select
						value={fallbackStepId}
						label="Passo Alternativo (Fallback)"
						onChange={(e) => onFallbackStepIdChange(e.target.value)}
					>
						<MenuItem value="">Nenhum</MenuItem>
						{steps
							.filter((s) => s.id !== currentStepId)
							.map((s) => (
								<MenuItem key={s.id} value={s.id}>
									Passo #{s.stepNumber} - {getStepTypeLabel(s.stepType)}{" "}
									{s.description && `(${s.description})`}
								</MenuItem>
							))}
						<MenuItem value="new">Será criado depois</MenuItem>
					</Select>
					<FormHelperText>
						Passo executado em caso de erro, falha na consulta ou condição não atendida
					</FormHelperText>
				</FormControl>
			)}
		</>
	);
};
