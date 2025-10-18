import {
	ArrowForward as ArrowForwardIcon,
	CallSplit as CallSplitIcon,
	CheckCircle as CheckCircleIcon,
	HighlightOff as HighlightOffIcon,
	Person as PersonIcon,
	RadioButtonChecked as RadioButtonCheckedIcon,
	Send as SendIcon,
	Settings as SettingsIcon,
	Storage as StorageIcon,
	SwapHoriz as SwapHorizIcon
} from "@mui/icons-material";
import { Box, Card, CardContent, Chip, Divider, Stack, Typography } from "@mui/material";
import React from "react";
import { FlowStep, WppMessageFlowStepType } from "../../types/flow.types";
import { getStepTypeLabel } from "../step-editor/StepEditorFormBasic";
import { designSystem } from "../../styles/design-system";

interface FlowDiagramProps {
	steps: FlowStep[];
	onStepSelect: (step: FlowStep) => void;
	selectedStepId?: number;
}

// Cores e ícones para cada tipo de step
const getStepTypeColor = (
	stepType: WppMessageFlowStepType
): { bgColor: string; textColor: string; icon?: React.ReactNode } => {
	const iconProps = { fontSize: "small" as const, sx: { mr: 0.5 } };

	const typeMap: Record<WppMessageFlowStepType, { bgColor: string; textColor: string; icon: React.ReactNode }> = {
		// Cores baseadas em tipos
		QUERY: { bgColor: "#e3f2fd", textColor: "#1565c0", icon: <StorageIcon {...iconProps} /> },
		SEND_TO_ADMIN: { bgColor: "#fce4ec", textColor: "#c2185b", icon: <SendIcon {...iconProps} /> },
		CHECK_ONLY_ADMIN: { bgColor: "#f3e5f5", textColor: "#6a1b9a", icon: <PersonIcon {...iconProps} /> },
		CHECK_LOALTY: { bgColor: "#e8f5e9", textColor: "#2e7d32", icon: <CheckCircleIcon {...iconProps} /> },
		CHECK_AVAILABLE_USERS: { bgColor: "#fff3e0", textColor: "#e65100", icon: <PersonIcon {...iconProps} /> },
		CONDITION: { bgColor: "#fff8e1", textColor: "#f57f17", icon: <CheckCircleIcon {...iconProps} /> },
		ROUTER: { bgColor: "#f3e5f5", textColor: "#6a1b9a", icon: <CallSplitIcon {...iconProps} /> },
		ASSIGN: { bgColor: "#e1f5fe", textColor: "#0277bd", icon: <PersonIcon {...iconProps} /> }
	};

	return typeMap[stepType] || { bgColor: "#eeeeee", textColor: "#424242", icon: <SettingsIcon {...iconProps} /> };
};

export const FlowDiagram: React.FC<FlowDiagramProps> = ({ steps, onStepSelect, selectedStepId }) => {
	// Helper para buscar step pelo ID
	const getStepName = (stepId: number): string => {
		const step = steps.find((s) => s.id === stepId);
		const stepDescription = step?.description ? ` - ${step.description}` : "";

		return step ? `Passo ${step.stepNumber}: ${getStepTypeLabel(step.stepType)}${stepDescription}` : `Passo #${stepId}`;
	};

	if (steps.length === 0) {
		return (
			<Box sx={{ textAlign: "center", py: 6, color: "text.secondary" }}>
				<Typography variant="body1" gutterBottom>
					Nenhum step configurado ainda.
				</Typography>
				<Typography variant="body2">Clique em "Novo Step" para começar.</Typography>
			</Box>
		);
	}

	return (
		<Stack spacing={2}>
			{steps.map((step) => (
				<Card
					key={`${step.id}-${step.stepNumber}`}
					onClick={() => onStepSelect(step)}
					sx={{
						cursor: "pointer",
						transition: designSystem.animations.smooth,
						border: selectedStepId === step.id ? "2px solid" : "1px solid",
						borderColor: selectedStepId === step.id ? "primary.main" : designSystem.borders.light,
						background: step.enabled 
							? "linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)"
							: designSystem.gradients.slateDisabled,
						position: "relative",
						overflow: "hidden",
						"&::before": step.enabled ? {
							content: '""',
							position: "absolute",
							top: 0,
							left: 0,
							right: 0,
							height: "3px",
							background: designSystem.gradients.primary,
						} : {},
						"&:hover": {
							transform: "translateY(-4px)",
							boxShadow: step.enabled ? designSystem.shadows.lg : designSystem.shadows.md,
							borderColor: "primary.main",
							"& .step-badge": {
								transform: "scale(1.05)",
							},
						}
					}}
				>
					<CardContent
						sx={{ pb: 1.5, "&:last-child": { pb: 1.5 }, bgcolor: "transparent" }}
					>
						{/* Header */}
						<Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "start", mb: 2 }}>
							<Box sx={{ flex: 1 }}>
								<Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.5, flexWrap: "wrap" }}>
									<Chip
										label={`Passo ${step.stepNumber}`}
										size="small"
										color="primary"
										variant={selectedStepId === step.id ? "filled" : "outlined"}
										className="step-badge"
										sx={{
											fontWeight: 700,
											transition: designSystem.animations.fast,
											background: selectedStepId === step.id ? designSystem.gradients.primary : "transparent",
										}}
									/>
									{(() => {
										const typeColor = getStepTypeColor(step.stepType);
										return (
											<Box
												sx={{
													display: "flex",
													alignItems: "center",
													gap: 0.5,
													px: 1.5,
													py: 0.5,
													borderRadius: "16px",
													backgroundColor: typeColor.bgColor,
													color: typeColor.textColor,
													fontWeight: 600,
													fontSize: "0.8rem",
													border: "none"
												}}
											>
												{typeColor.icon}
												<span>{getStepTypeLabel(step.stepType)}</span>
											</Box>
										);
									})()}
									{!step.enabled && (
										<Chip label="Desabilitado" size="small" color="default" variant="outlined" />
									)}
								</Box>
								{step.description && (
									<Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
										{step.description}
									</Typography>
								)}
							</Box>
						</Box>

						{/* Conexões */}
						{(step.nextStepId || step.fallbackStepId || step.connections) && (
							<>
								<Divider sx={{ my: 1.5 }} />

								<Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
									{/* Próximo Step */}
									{step.nextStepId && (
										<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
											<ArrowForwardIcon sx={{ fontSize: 18, color: "primary.main" }} />
											<Typography
												variant="caption"
												sx={{ color: "primary.main", fontWeight: 500 }}
											>
												Próximo: {getStepName(step.nextStepId)}
											</Typography>
										</Box>
									)}

									{/* Fallback Step */}
									{step.fallbackStepId && (
										<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
											<SwapHorizIcon sx={{ fontSize: 18, color: "warning.main" }} />
											<Typography
												variant="caption"
												sx={{ color: "warning.main", fontWeight: 500 }}
											>
												Erro: {getStepName(step.fallbackStepId)}
											</Typography>
										</Box>
									)}

									{/* CONDITION Connections */}
									{step.stepType === "CONDITION" && step.connections && (
										<Box
											sx={{
												display: "flex",
												flexDirection: "column",
												gap: 0.5,
												pl: 0.5,
												borderLeft: "2px solid",
												borderColor: "warning.light"
											}}
										>
											{step.connections.onTrue && (
												<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
													<CheckCircleIcon sx={{ fontSize: 16, color: "success.main" }} />
													<Typography variant="caption" sx={{ color: "success.main" }}>
														✓ Verdadeiro → {getStepName(step.connections.onTrue)}
													</Typography>
												</Box>
											)}
											{step.connections.onFalse && (
												<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
													<HighlightOffIcon sx={{ fontSize: 16, color: "error.main" }} />
													<Typography variant="caption" sx={{ color: "error.main" }}>
														✗ Falso → {getStepName(step.connections.onFalse)}
													</Typography>
												</Box>
											)}
										</Box>
									)}

									{/* ROUTER Connections */}
									{step.stepType === "ROUTER" && step.connections && (
										<Box
											sx={{
												display: "flex",
												flexDirection: "column",
												gap: 0.5,
												pl: 0.5,
												borderLeft: "2px solid",
												borderColor: "warning.light"
											}}
										>
											{step.connections.routes &&
												Object.entries(step.connections.routes).map(
													([key, targetStepId]) =>
														targetStepId && (
															<Box
																key={key}
																sx={{ display: "flex", alignItems: "center", gap: 1 }}
															>
																<RadioButtonCheckedIcon
																	sx={{ fontSize: 14, color: "info.main" }}
																/>
																<Typography
																	variant="caption"
																	sx={{ color: "info.main" }}
																>
																	{key} → {getStepName(targetStepId)}
																</Typography>
															</Box>
														)
												)}
											{step.connections.defaultRoute && (
												<Box
													sx={{
														display: "flex",
														alignItems: "center",
														gap: 1,
														fontStyle: "italic"
													}}
												>
													<SwapHorizIcon sx={{ fontSize: 16, color: "text.secondary" }} />
													<Typography variant="caption" sx={{ color: "text.secondary" }}>
														Padrão → {getStepName(step.connections.defaultRoute)}
													</Typography>
												</Box>
											)}
										</Box>
									)}
								</Box>
							</>
						)}
					</CardContent>
				</Card>
			))}
		</Stack>
	);
};
