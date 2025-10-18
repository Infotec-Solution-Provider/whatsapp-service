import React from "react";
import { Box, Chip } from "@mui/material";
import type { FlowStep } from "../../types/flow.types";
import { designSystem } from "../../styles/design-system";

interface FlowEditorStatsProps {
	steps: FlowStep[];
}

export const FlowEditorStats: React.FC<FlowEditorStatsProps> = ({ steps }) => {
	const enabledCount = steps.filter((s) => s.enabled).length;
	const disabledCount = steps.filter((s) => !s.enabled).length;

	return (
		<Box sx={{ display: "flex", gap: 2, justifyContent: "center", flexWrap: "wrap" }}>
			<Chip
				label={`${steps.length} ${steps.length === 1 ? "passo configurado" : "passos configurados"}`}
				color="primary"
				variant="filled"
				sx={{
					fontWeight: 700,
					background: designSystem.gradients.primary,
					color: "white",
					transition: designSystem.animations.fast,
					"&:hover": {
						transform: "scale(1.05)",
						boxShadow: designSystem.shadows.md,
					},
				}}
			/>
			<Chip
				label={`${enabledCount} ${enabledCount === 1 ? "ativo" : "ativos"}`}
				color="success"
				variant="filled"
				sx={{
					fontWeight: 700,
					background: designSystem.gradients.success,
					color: "white",
					transition: designSystem.animations.fast,
					"&:hover": {
						transform: "scale(1.05)",
						boxShadow: designSystem.shadows.md,
					},
				}}
			/>
			<Chip
				label={`${disabledCount} ${disabledCount === 1 ? "desabilitado" : "desabilitados"}`}
				color="warning"
				variant="filled"
				sx={{
					fontWeight: 700,
					background: designSystem.gradients.warning,
					color: "white",
					transition: designSystem.animations.fast,
					"&:hover": {
						transform: "scale(1.05)",
						boxShadow: designSystem.shadows.md,
					},
				}}
			/>
		</Box>
	);
};
