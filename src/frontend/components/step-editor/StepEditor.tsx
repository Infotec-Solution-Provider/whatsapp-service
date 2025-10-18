import {
	Add as AddIcon,
	Close as CloseIcon,
	Delete as DeleteIcon,
	Edit as EditIcon,
	ExpandMore as ExpandMoreIcon,
	MenuBook as MenuBookIcon,
	Save as SaveIcon,
	Settings as SettingsIcon
} from "@mui/icons-material";
import {
	Accordion,
	AccordionDetails,
	AccordionSummary,
	Box,
	Button,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	TextField,
	Typography
} from "@mui/material";
import React, { useEffect, useState } from "react";
import { flowApiService } from "../../services/flow-api.service";
import type { FlowStep, WppMessageFlowStepType } from "../../types/flow.types";
import { designSystem } from "../../styles/design-system";
import { ConfigEditor } from "./ConfigEditor";
import { ConnectionsEditor } from "./ConnectionsEditor";
import { StepEditorExamples } from "./StepEditorExamples";
import { StepEditorFormBasic } from "./StepEditorFormBasic";

interface StepEditorProps {
	flowId: number;
	step: FlowStep | null;
	steps: FlowStep[];
	onSave: (step: FlowStep) => void;
	onDelete?: (stepId: number) => void;
	onCancel: () => void;
}

export const StepEditor: React.FC<StepEditorProps> = ({ flowId, step, steps, onSave, onDelete, onCancel }) => {
	const [stepTypes, setStepTypes] = useState<WppMessageFlowStepType[]>([]);
	const [formData, setFormData] = useState({
		stepNumber: step?.stepNumber || Math.max(0, ...steps.map((s) => s.stepNumber)) + 1,
		stepType: (step?.stepType || "QUERY") as WppMessageFlowStepType | "",
		nextStepId: step?.nextStepId?.toString() || "",
		fallbackStepId: step?.fallbackStepId?.toString() || "",
		description: step?.description || "",
		enabled: step?.enabled ?? true,
		config: step?.config || {},
		connections: step?.connections || null
	});

	const [configJson, setConfigJson] = useState(JSON.stringify(step?.config || {}, null, 2));

	useEffect(() => {
		loadStepTypes();
	}, []);

	// Sincroniza formData quando o step prop muda (após update)
	useEffect(() => {
		console.log("[StepEditor] useEffect [step, steps] acionado");
		if (step) {
			console.log("[StepEditor] Step prop mudou, sincronizando formData:");
			console.log("  step.id:", step.id);
			console.log("  step.stepType:", step.stepType);
			console.log("  step.stepNumber:", step.stepNumber);
			console.log("  step.description:", step.description || "(vazio)");
			console.log("  step.enabled:", step.enabled);
			console.log("  step.config keys:", Object.keys(step.config || {}).join(", ") || "(vazio)");
		} else {
			console.log("[StepEditor] Criando novo step");
		}
		setFormData({
			stepNumber: step?.stepNumber || Math.max(0, ...steps.map((s) => s.stepNumber)) + 1,
			stepType: (step?.stepType || "QUERY") as WppMessageFlowStepType | "",
			nextStepId: step?.nextStepId?.toString() || "",
			fallbackStepId: step?.fallbackStepId?.toString() || "",
			description: step?.description || "",
			enabled: step?.enabled ?? true,
			config: step?.config || {},
			connections: step?.connections || null
		});
		setConfigJson(JSON.stringify(step?.config || {}, null, 2));
	}, [step, steps]);

	const loadStepTypes = async () => {
		try {
			const types = await flowApiService.getAvailableStepTypes();
			setStepTypes(types);
		} catch (err) {
			console.error("Erro ao carregar tipos de passo:", err);
		}
	};

	const handleSubmit = async () => {
		try {
			// Parse config JSON
			const config = JSON.parse(configJson);

			const stepData: any = {
				type: formData.stepType,
				stepNumber: formData.stepNumber,
				config,
				connections: formData.connections,
				enabled: formData.enabled
			};

			// Add description if provided
			if (formData.description) {
				stepData.description = formData.description;
			}

			// Add nextStepId if provided
			if (formData.nextStepId && formData.nextStepId !== "new") {
				stepData.nextStepId = parseInt(formData.nextStepId);
			}

			// Add fallbackStepId if provided
			if (formData.fallbackStepId && formData.fallbackStepId !== "new") {
				stepData.fallbackStepId = parseInt(formData.fallbackStepId);
			}

			console.log("[StepEditor] Enviando dados do step:");
			console.log("  step.id (se update):", step?.id || "N/A");
			console.log("  type:", stepData.type);
			console.log("  stepNumber:", stepData.stepNumber);
			console.log("  description:", stepData.description || "(vazio)");
			console.log("  enabled:", stepData.enabled);
			console.log("  nextStepId:", stepData.nextStepId || "(vazio)");
			console.log("  fallbackStepId:", stepData.fallbackStepId || "(vazio)");
			console.log("  config keys:", Object.keys(stepData.config).join(", ") || "(vazio)");
			console.log("  connections:", stepData.connections ? "present" : "null");

			let savedStep: FlowStep;

			if (step) {
				// Update existing step
				console.log("[StepEditor] Atualizando step existente:", step.id);
				savedStep = await flowApiService.updateStep(step.id, stepData);
				console.log("[StepEditor] Resposta do update:", {
					id: savedStep.id,
					type: savedStep.stepType,
					stepNumber: savedStep.stepNumber,
					description: savedStep.description || "(vazio)",
					enabled: savedStep.enabled,
					config_keys: Object.keys(savedStep.config || {}).join(", "),
					connections: savedStep.connections ? "present" : "null"
				});
			} else {
				// Create new step
				console.log("[StepEditor] Criando novo step no flow:", flowId);
				savedStep = await flowApiService.createStep(flowId, stepData);
				console.log("[StepEditor] Resposta do create:", {
					id: savedStep.id,
					type: savedStep.stepType,
					stepNumber: savedStep.stepNumber,
					description: savedStep.description || "(vazio)",
					enabled: savedStep.enabled,
					config_keys: Object.keys(savedStep.config || {}).join(", "),
					connections: savedStep.connections ? "present" : "null"
				});
			}

			console.log("[StepEditor] Chamando onSave com step salvo");
			onSave(savedStep);
		} catch (err) {
			console.error("Erro ao salvar passo:", err);
			if (err instanceof SyntaxError) {
				alert("Erro no JSON de configuração: " + err.message);
			} else {
				alert(err instanceof Error ? err.message : "Erro ao salvar passo");
			}
		}
	};

	const handleConfigChange = (value: string) => {
		setConfigJson(value);
		try {
			const parsed = JSON.parse(value);
			setFormData({ ...formData, config: parsed });
		} catch {
			// Invalid JSON, keep old config
		}
	};

	const handleConfigEditorChange = (config: Record<string, any>) => {
		setFormData({ ...formData, config });
		setConfigJson(JSON.stringify(config, null, 2));
	};

	return (
		<Dialog 
			open={true} 
			onClose={onCancel} 
			maxWidth="md" 
			fullWidth 
			PaperProps={{
				sx: { 
					minHeight: "80vh", 
					background: designSystem.gradients.slate,
					border: `1px solid ${designSystem.borders.light}`,
					boxShadow: designSystem.shadows.lg,
				}
			}}
		>
			<DialogTitle
				sx={{
					background: designSystem.gradients.primary,
					color: "white",
					fontWeight: 700,
					fontSize: "1.3rem",
					borderBottom: `2px solid ${designSystem.borders.active}`,
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					p: 2.5
				}}
			>
			<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
				{step ? <EditIcon /> : <AddIcon />}
				<Typography variant="h6">{step ? "Editar Passo" : "Novo Passo"}</Typography>
			</Box>
				<Button
					size="small"
					color="inherit"
					onClick={onCancel}
					sx={{ minWidth: 0, p: 0.5 }}
					title="Fechar (Esc)"
				>
					<CloseIcon />
				</Button>
			</DialogTitle>

			<DialogContent dividers sx={{ bgcolor: "grey.50" }}>
				<Box component="form" sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
					{/* Formulário Básico */}
					<StepEditorFormBasic
						stepNumber={formData.stepNumber}
						enabled={formData.enabled}
						stepType={formData.stepType}
						description={formData.description}
						nextStepId={formData.nextStepId}
						fallbackStepId={formData.fallbackStepId}
						stepTypes={stepTypes}
						steps={steps}
						currentStepId={step?.id}
						onStepNumberChange={(val) => setFormData({ ...formData, stepNumber: val })}
						onEnabledChange={(val) => setFormData({ ...formData, enabled: val })}
						onStepTypeChange={(val) => setFormData({ ...formData, stepType: val })}
						onDescriptionChange={(val) => setFormData({ ...formData, description: val })}
						onNextStepIdChange={(val) => setFormData({ ...formData, nextStepId: val })}
						onFallbackStepIdChange={(val) => setFormData({ ...formData, fallbackStepId: val })}
					/>

					{/* Conexões Condicionais (CONDITION e ROUTER) */}
					{(formData.stepType === "CONDITION" || formData.stepType === "ROUTER") && (
						<Box
							sx={{
								bgcolor: "rgba(220, 215, 255, 0.05)",
								border: "1px solid",
								borderColor: "info.main",
								borderRadius: 1,
								p: 2
							}}
						>
							<Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
								<MenuBookIcon fontSize="small" sx={{ color: "info.main" }} />
								<Typography variant="subtitle2" sx={{ fontWeight: 600, color: "info.main" }}>
									Conexões Condicionais
								</Typography>
							</Box>
							<ConnectionsEditor
								stepType={formData.stepType}
								connections={formData.connections}
								availableSteps={steps}
								currentStepId={step?.id}
								onChange={(connections) => setFormData({ ...formData, connections })}
							/>
						</Box>
					)}

					<Box
						sx={{
							bgcolor: "grey.100",
							border: "1px solid",
							borderColor: "grey.300",
							borderRadius: 1,
							p: 2
						}}
					>
						<ConfigEditor
							stepType={formData.stepType as WppMessageFlowStepType}
							config={formData.config}
							onChange={handleConfigEditorChange}
						/>
					</Box>

					{/* JSON de Configuração (Visualização/Edição Manual) */}
{/* 					<Accordion sx={{ bgcolor: "white", border: "1px solid", borderColor: "grey.200" }}>
						<AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ bgcolor: "grey.100" }}>
							<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
								<SettingsIcon fontSize="small" sx={{ color: "grey.600" }} />
								<Typography sx={{ fontWeight: 600, color: "grey.700" }}>
									Configuração JSON (Avançado)
								</Typography>
							</Box>
						</AccordionSummary>
						<AccordionDetails sx={{ bgcolor: "grey.50" }}>
							<TextField
								label="Configuração (JSON)"
								value={configJson}
								onChange={(e) => handleConfigChange(e.target.value)}
								multiline
								rows={12}
								fullWidth
								helperText="Edição manual do JSON. Use o editor visual acima para facilitar."
								InputProps={{
									sx: {
										fontFamily: "Monaco, Menlo, monospace",
										fontSize: "0.875rem"
									}
								}}
							/>
						</AccordionDetails>
					</Accordion> */}

					{/* Exemplos de Configuração */}
					{/* <StepEditorExamples /> */}
				</Box>
			</DialogContent>

			<DialogActions 
				sx={{ 
					px: 3, 
					py: 2, 
					background: designSystem.backgrounds.section,
					borderTop: `1px solid ${designSystem.borders.light}`,
					gap: 1,
				}}
			>
				<Button 
					onClick={onCancel} 
					startIcon={<CloseIcon />} 
					color="inherit"
					sx={{
						transition: designSystem.animations.fast,
						"&:hover": {
							bgcolor: "grey.200",
						},
					}}
				>
					Cancelar
				</Button>

				<Box sx={{ flex: 1 }} />

				{step && onDelete && (
					<Button
						onClick={() => {
							if (confirm("Tem certeza que deseja deletar este passo?")) {
								onDelete(step.id);
								// Fechar o modal após deletar
								onCancel();
							}
						}}
						startIcon={<DeleteIcon />}
						color="error"
						variant="outlined"
					>
						Deletar
					</Button>
				)}

				<Button onClick={handleSubmit} startIcon={<SaveIcon />} variant="contained" color="primary">
					{step ? "Salvar Alterações" : "Criar Passo"}
				</Button>
			</DialogActions>
		</Dialog>
	);
};
