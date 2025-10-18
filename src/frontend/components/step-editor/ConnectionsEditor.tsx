import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import {
	Alert,
	Box,
	Button,
	Divider,
	FormControl,
	IconButton,
	InputLabel,
	MenuItem,
	Select,
	Stack,
	TextField,
	Typography
} from "@mui/material";
import React from "react";
import { FlowStep, StepConnections, WppMessageFlowStepType } from "../../types/flow.types";
import { getStepTypeLabel } from "./StepEditorFormBasic";
import { designSystem } from "../../styles/design-system";

interface ConnectionsEditorProps {
	stepType: WppMessageFlowStepType;
	connections: StepConnections | null;
	availableSteps: FlowStep[];
	currentStepId?: number; // Para evitar auto-referência
	onChange: (connections: StepConnections | null) => void;
}

export const ConnectionsEditor: React.FC<ConnectionsEditorProps> = ({
	stepType,
	connections,
	availableSteps,
	currentStepId,
	onChange
}) => {
	// Filtrar steps disponíveis (excluir o step atual)
	const selectableSteps = availableSteps.filter((step) => step.id !== currentStepId);

	// CONDITION: onTrue / onFalse
	if (stepType === "CONDITION") {
		return (
			<Box sx={{ 
				background: designSystem.gradients.slate,
				border: `1px solid ${designSystem.borders.light}`,
				p: 2.5, 
				borderRadius: 1.5,
				position: "relative",
				overflow: "hidden",
				"&::before": {
					content: '""',
					position: "absolute",
					top: 0,
					left: 0,
					width: "4px",
					height: "100%",
					background: designSystem.gradients.primary,
				},
			}}>
				<Typography 
					variant="subtitle2" 
					gutterBottom 
					sx={{ 
						fontWeight: 700, 
						mb: 2,
						color: "grey.800",
						pl: 1,
					}}
				>
					Conexões Condicionais
				</Typography>

				<Stack spacing={2}>
					{/* OnTrue */}
					<FormControl fullWidth>
						<InputLabel>Se Verdadeiro (onTrue)</InputLabel>
						<Select
							value={connections?.onTrue || ""}
							onChange={(e) =>
								onChange({
									...connections,
									onTrue: e.target.value ? Number(e.target.value) : undefined
								})
							}
							label="Se Verdadeiro (onTrue)"
							sx={{
								transition: designSystem.animations.fast,
								"& .MuiOutlinedInput-root": {
									"&:hover": {
										borderColor: "primary.main",
									},
									"&.Mui-focused": {
										"& fieldset": {
											borderColor: "primary.main",
											borderWidth: 2,
										},
										boxShadow: "0 0 0 3px rgba(102, 126, 234, 0.1)",
									},
								},
							}}
						>
							<MenuItem value="">
								<em>Nenhum</em>
							</MenuItem>
							{selectableSteps.map((step) => (
								<MenuItem key={step.id} value={step.id}>
									Passo {step.stepNumber}: {getStepTypeLabel(step.stepType)}
									{step.description && ` - ${step.description}`}
								</MenuItem>
							))}
						</Select>
					</FormControl>

					{/* OnFalse */}
					<FormControl fullWidth>
						<InputLabel>Se Falso (onFalse)</InputLabel>
						<Select
							value={connections?.onFalse || ""}
							onChange={(e) =>
								onChange({
									...connections,
									onFalse: e.target.value ? Number(e.target.value) : undefined
								})
							}
							label="Se Falso (onFalse)"
						>
							<MenuItem value="">
								<em>Nenhum</em>
							</MenuItem>
							{selectableSteps.map((step) => (
								<MenuItem key={step.id} value={step.id}>
									Passo {step.stepNumber}: {getStepTypeLabel(step.stepType)}
									{step.description && ` - ${step.description}`}
								</MenuItem>
							))}
						</Select>
					</FormControl>
				</Stack>

				{!connections?.onTrue && !connections?.onFalse && (
					<Alert severity="warning" sx={{ mt: 2 }}>
						Configure ao menos uma conexão (onTrue ou onFalse)
					</Alert>
				)}
			</Box>
		);
	}

	// ROUTER: routes + defaultRoute
	if (stepType === "ROUTER") {
		const routes = connections?.routes || {};
		const routeEntries = Object.entries(routes);

		const addRoute = () => {
			const newKey = `route_${routeEntries.length + 1}`;
			onChange({
				...connections,
				routes: {
					...routes,
					[newKey]: 0
				}
			});
		};

		const updateRouteKey = (oldKey: string, newKey: string) => {
			const newRoutes = { ...routes };
			const value = newRoutes[oldKey];
			delete newRoutes[oldKey];
			newRoutes[newKey] = value;
			onChange({
				...connections,
				routes: newRoutes
			});
		};

		const updateRouteValue = (key: string, stepId: number) => {
			onChange({
				...connections,
				routes: {
					...routes,
					[key]: stepId
				}
			});
		};

		const deleteRoute = (key: string) => {
			const newRoutes = { ...routes };
			delete newRoutes[key];
			onChange({
				...connections,
				routes: newRoutes
			});
		};

		return (
			<Box sx={{ bgcolor: "grey.100", p: 2.5, borderRadius: 1, border: "1px solid", borderColor: "grey.300" }}>
				<Typography variant="subtitle2" gutterBottom sx={{ fontWeight: 600, mb: 2 }}>
					Rotas de Roteamento
				</Typography>

				<Stack spacing={2}>
					{routeEntries.map(([key, stepId]) => (
						<Box key={key} sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
							<TextField
								label="Valor/Chave"
								value={key}
								onChange={(e) => updateRouteKey(key, e.target.value)}
								size="small"
								sx={{ flex: 1 }}
								placeholder="Ex: vendas, suporte, financeiro"
							/>
							<FormControl size="small" sx={{ flex: 2 }}>
								<InputLabel>Passo Destino</InputLabel>
								<Select
									value={stepId || ""}
									onChange={(e) => updateRouteValue(key, Number(e.target.value))}
									label="Passo Destino"
								>
									<MenuItem value="">
										<em>Selecione um passo</em>
									</MenuItem>
									{selectableSteps.map((step) => (
										<MenuItem key={step.id} value={step.id}>
											Passo {step.stepNumber}: {getStepTypeLabel(step.stepType)}
											{step.description && ` - ${step.description}`}
										</MenuItem>
									))}
								</Select>
							</FormControl>
							<IconButton onClick={() => deleteRoute(key)} color="error" size="small">
								<DeleteIcon />
							</IconButton>
						</Box>
					))}

					<Button startIcon={<AddIcon />} onClick={addRoute} variant="outlined" size="small">
						Adicionar Rota
					</Button>

					<Divider />

					{/* Rota Padrão */}
					<FormControl fullWidth>
						<InputLabel>Rota Padrão (opcional)</InputLabel>
						<Select
							value={connections?.defaultRoute || ""}
							onChange={(e) =>
								onChange({
									...connections,
									defaultRoute: e.target.value ? Number(e.target.value) : undefined
								})
							}
							label="Rota Padrão (opcional)"
						>
							<MenuItem value="">
								<em>Nenhuma</em>
							</MenuItem>
							{selectableSteps.map((step) => (
								<MenuItem key={step.id} value={step.id}>
									Passo {step.stepNumber}: {getStepTypeLabel(step.stepType)}
									{step.description && ` - ${step.description}`}
								</MenuItem>
							))}
						</Select>
					</FormControl>
				</Stack>

				{routeEntries.length === 0 && (
					<Alert severity="warning" sx={{ mt: 2 }}>
						Adicione ao menos uma rota
					</Alert>
				)}
			</Box>
		);
	}

	// Outros tipos não precisam de ConnectionsEditor
	return (
		<Alert severity="info">
			Este tipo de step não utiliza conexões condicionais. Use "Próximo Step" e "Fallback Step" para definir o
			fluxo.
		</Alert>
	);
};
