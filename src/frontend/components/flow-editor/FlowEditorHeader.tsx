import React from "react";
import { ArrowBack as ArrowBackIcon, Add as AddIcon, Workspaces as WorkspacesIcon } from "@mui/icons-material";
import { Box, Button, Typography, TextField, Stack, Divider } from "@mui/material";
import type { Flow } from "../../types/flow.types";
import { designSystem } from "../../styles/design-system";

interface FlowEditorHeaderProps {
	flow: Flow;
	loading: boolean;
	onBack: () => void;
	onCreateStep: () => void;
	onUpdateDescription: (description: string) => void;
}

export const FlowEditorHeader: React.FC<FlowEditorHeaderProps> = ({
	flow,
	loading,
	onBack,
	onCreateStep,
	onUpdateDescription
}) => {
	return (
		<Box sx={{ display: "flex", flexDirection: "column", gap: 2.5 }}>
			{/* Top Bar - Botões de Ação */}
			<Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2 }}>
				<Button
					variant="outlined"
					startIcon={<ArrowBackIcon />}
					onClick={onBack}
					disabled={loading}
					sx={{
						textTransform: "none",
						fontWeight: 600,
						borderColor: designSystem.borders.light,
						color: "text.primary",
						transition: designSystem.animations.fast,
						"&:hover": {
							borderColor: "primary.main",
							bgcolor: "rgba(102, 126, 234, 0.08)",
						},
					}}
				>
					Voltar
				</Button>
				<Button
					variant="contained"
					startIcon={<AddIcon />}
					onClick={onCreateStep}
					disabled={loading}
					sx={{
						textTransform: "none",
						fontWeight: 600,
						background: designSystem.gradients.primary,
						transition: designSystem.animations.fast,
						"&:hover": {
							transform: "translateY(-2px)",
							boxShadow: designSystem.shadows.lg,
							background: designSystem.gradients.primaryLight,
						},
					}}
				>
					Novo Passo
				</Button>
			</Box>

			{/* Título e Informações do Fluxo */}
			<Stack spacing={1.5}>
				<Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
					<WorkspacesIcon sx={{ fontSize: 32, color: "primary.main", fontWeight: 700 }} />
					<Box sx={{ flex: 1 }}>
						<Typography
							variant="h5"
							component="h2"
							sx={{
								fontWeight: 800,
								background: designSystem.gradients.primary,
								backgroundClip: "text",
								WebkitBackgroundClip: "text",
								WebkitTextFillColor: "transparent",
								lineHeight: 1.3,
								fontSize: "1.4rem",
							}}
						>
							{flow.instance}
							{flow.sectorId && (
								<Typography
									component="span"
									sx={{
										ml: 1,
										color: "primary.main",
										fontWeight: 600,
										fontSize: "0.85em"
									}}
								>
									• Setor {flow.sectorId}
								</Typography>
							)}
						</Typography>
					</Box>
				</Box>

				{/* Divider */}
				<Divider sx={{ my: 0.5, borderColor: designSystem.borders.light }} />

				{/* Campo de Descrição */}
				<Box>
					<Typography
						variant="caption"
						sx={{
							display: "block",
							mb: 0.8,
							color: "grey.600",
							fontWeight: 600,
							textTransform: "uppercase",
							letterSpacing: 0.5
						}}
					>
						Descrição do Fluxo
					</Typography>
					<TextField
						value={flow.description || ""}
						onChange={(e) => onUpdateDescription(e.target.value)}
						disabled={loading}
						size="small"
						fullWidth
						multiline
						maxRows={2}
                        placeholder="Adicionar descrição"
						slotProps={{
							input: {
								sx: {
									bgcolor: "white",
									"&.Mui-disabled": {
										bgcolor: "grey.100"
									}
								}
							}
						}}
						sx={{
							maxWidth: "100%"
						}}
					/>
				</Box>
			</Stack>
		</Box>
	);
};
