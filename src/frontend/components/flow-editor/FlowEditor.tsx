import React, { useEffect, useState } from "react";
import { Box, CircularProgress, Divider, Paper, Typography } from "@mui/material";
import { flowApiService } from "../../services/flow-api.service";
import type { Flow, FlowStep } from "../../types/flow.types";
import { designSystem } from "../../styles/design-system";

import { FlowEditorHeader } from "./FlowEditorHeader";
import { FlowEditorAlerts } from "./FlowEditorAlerts";
import { FlowEditorStats } from "./FlowEditorStats";
import { FlowDiagram } from "../flow-diagram";
import { StepEditor } from "../step-editor";

interface FlowEditorProps {
	flow: Flow;
	onBack: () => void;
	onFlowUpdated: (flow: Flow) => void;
}

export const FlowEditor: React.FC<FlowEditorProps> = ({ flow: initialFlow, onBack, onFlowUpdated }) => {
	const [flow, setFlow] = useState<Flow>(initialFlow);
	const [steps, setSteps] = useState<FlowStep[]>([]);
	const [selectedStep, setSelectedStep] = useState<FlowStep | null>(null);
	const [isCreatingStep, setIsCreatingStep] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [successMessage, setSuccessMessage] = useState<string | null>(null);

	// Carregar steps do flow
	useEffect(() => {
		loadSteps();
	}, [flow.id]);

	const loadSteps = async () => {
		try {
			setLoading(true);
			setError(null);

			// Verifica se os steps já vieram no objeto flow
			if (initialFlow && (initialFlow as any).WppMessageFlowStep) {
				const mappedSteps = (initialFlow as any).WppMessageFlowStep.map((step: any) => ({
					id: step.id,
					flowId: step.messageFlowId,
					stepNumber: step.stepNumber,
					stepType: step.type,
					nextStepId: step.nextStepId,
					fallbackStepId: step.fallbackStepId,
					config: step.config || {},
					connections: step.connections || null,
					description: step.description,
					enabled: step.enabled,
					createdAt: step.createdAt,
					updatedAt: step.updatedAt
				}));
				setSteps(mappedSteps);
			} else {
				// Busca do backend
				const fetchedSteps = await flowApiService.listSteps(flow.id);
				setSteps(fetchedSteps);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Erro ao carregar passos");
		} finally {
			setLoading(false);
		}
	};

	const handleStepSelect = (step: FlowStep) => {
		setSelectedStep(step);
		setIsCreatingStep(false);
	};

	const handleCreateStep = () => {
		setSelectedStep(null);
		setIsCreatingStep(true);
	};

	const handleStepSaved = async (savedStep: FlowStep) => {
		console.log("[FlowEditor] handleStepSaved chamado");
		console.log("  savedStep.id:", savedStep.id);
		console.log("  savedStep.stepType:", savedStep.stepType);
		console.log("  savedStep.stepNumber:", savedStep.stepNumber);
		console.log("  savedStep.description:", savedStep.description || "(vazio)");
		console.log("  savedStep.config keys:", Object.keys(savedStep.config || {}).join(", ") || "(vazio)");
		console.log("  savedStep.connections:", savedStep.connections ? "present" : "null");

		setSuccessMessage("Passo salvo com sucesso!");
		setTimeout(() => setSuccessMessage(null), 3000);

		// Atualiza lista de steps
		setSteps((prevSteps) => {
			const existingIndex = prevSteps.findIndex((s) => s.id === savedStep.id);
			if (existingIndex >= 0) {
				// Atualiza step existente
				console.log("[FlowEditor] Atualizando step existente no index:", existingIndex);
				const newSteps = [...prevSteps];
				newSteps[existingIndex] = savedStep;
				return newSteps;
			} else {
				// Adiciona novo step
				console.log("[FlowEditor] Adicionando novo step ao array");
				return [...prevSteps, savedStep].sort((a, b) => a.stepNumber - b.stepNumber);
			}
		});

		setSelectedStep(null);
		setIsCreatingStep(false);
	};

	const handleStepDeleted = async (stepId: number) => {
		try {
			await flowApiService.deleteStep(stepId);
			setSuccessMessage("Passo deletado com sucesso!");
			setTimeout(() => setSuccessMessage(null), 3000);

			// Remove o step da lista
			setSteps((prevSteps) => prevSteps.filter((s) => s.id !== stepId));
			setSelectedStep(null);
			setIsCreatingStep(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Erro ao deletar passo");
			setTimeout(() => setError(null), 4000);
		}
	};

	const handleFlowUpdate = async (updates: { description?: string; enabled?: boolean }) => {
		try {
			setLoading(true);
			setError(null);

			const updated = await flowApiService.updateFlow(flow.id, updates);

			// Mapeia os steps se vieram do backend
			if ((updated as any).WppMessageFlowStep) {
				(updated as any).steps = (updated as any).WppMessageFlowStep.map((step: any) => ({
					id: step.id,
					flowId: step.messageFlowId,
					stepNumber: step.stepNumber,
					stepType: step.type,
					nextStepId: step.nextStepId,
					fallbackStepId: step.fallbackStepId,
					config: step.config || {},
					connections: step.connections || null,
					description: step.description,
					enabled: step.enabled,
					createdAt: step.createdAt,
					updatedAt: step.updatedAt
				}));
			}

			setFlow(updated);
			onFlowUpdated(updated);
			setSuccessMessage("Fluxo atualizado com sucesso!");
			setTimeout(() => setSuccessMessage(null), 3000);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Erro ao atualizar fluxo");
		} finally {
			setLoading(false);
		}
	};

	const handleCancel = () => {
		setSelectedStep(null);
		setIsCreatingStep(false);
	};

	return (
		<Box className="flow-editor">
			{/* Header com informações e ações principais */}
			<Paper 
				elevation={0}
				sx={{ 
					background: designSystem.gradients.slate,
					border: `1px solid ${designSystem.borders.light}`,
					p: 3, 
					mb: 3,
					position: "relative",
					overflow: "hidden",
					"&::before": {
						content: '""',
						position: "absolute",
						top: 0,
						left: 0,
						right: 0,
						height: "4px",
						background: designSystem.gradients.primary,
					},
				}}
			>
				<FlowEditorHeader
					flow={flow}
					loading={loading}
					onBack={onBack}
					onCreateStep={handleCreateStep}
					onUpdateDescription={(description) => handleFlowUpdate({ description })}
				/>

				<FlowEditorAlerts
					error={error}
					successMessage={successMessage}
					onClearError={() => setError(null)}
					onClearSuccess={() => setSuccessMessage(null)}
				/>
			</Paper>

			{/* Diagrama do fluxo */}
			<Paper 
				elevation={0}
				sx={{ 
					background: "white",
					border: `1px solid ${designSystem.borders.light}`,
					p: 3, 
					mb: 3,
					position: "relative",
					overflow: "hidden",
					"&::before": {
						content: '""',
						position: "absolute",
						top: 0,
						left: 0,
						right: 0,
						height: "2px",
						background: designSystem.gradients.primary,
						opacity: 0.5,
					},
				}}
			>
				<Typography 
					variant="h6" 
					gutterBottom
					sx={{
						fontWeight: 700,
						background: designSystem.gradients.primary,
						backgroundClip: "text",
						WebkitBackgroundClip: "text",
						WebkitTextFillColor: "transparent",
					}}
				>
					📊 Diagrama do Fluxo
				</Typography>
				<Divider sx={{ mb: 2, borderColor: designSystem.borders.light }} />
				{loading ? (
					<Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
						<CircularProgress />
					</Box>
				) : (
					<FlowDiagram steps={steps} onStepSelect={handleStepSelect} selectedStepId={selectedStep?.id} />
				)}
			</Paper>

			{/* Editor de passo (modal) */}
			{(isCreatingStep || selectedStep) && (
				<StepEditor
					flowId={flow.id}
					step={selectedStep}
					steps={steps}
					onSave={handleStepSaved}
					onDelete={selectedStep ? handleStepDeleted : undefined}
					onCancel={handleCancel}
				/>
			)}

			{/* Estatísticas do fluxo */}
			<Paper elevation={1} sx={{ p: 2, mt: 3, bgcolor: "grey.100" }}>
				<FlowEditorStats steps={steps} />
			</Paper>
		</Box>
	);
};
