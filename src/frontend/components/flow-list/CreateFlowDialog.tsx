import React, { useState } from "react";
import {
	Dialog,
	DialogTitle,
	DialogContent,
	DialogActions,
	TextField,
	Button,
	Box,
} from "@mui/material";
import { designSystem } from "../../styles/design-system";

interface CreateFlowDialogProps {
	open: boolean;
	onClose: () => void;
	onCreate: (data: { description: string; sectorId: string }) => void;
}

export const CreateFlowDialog: React.FC<CreateFlowDialogProps> = ({
	open,
	onClose,
	onCreate,
}) => {
	const [description, setDescription] = useState("");
	const [sectorId, setSectorId] = useState("");

	const handleCreate = () => {
		onCreate({ description, sectorId });
		setDescription("");
		setSectorId("");
	};

	const handleClose = () => {
		onClose();
		setDescription("");
		setSectorId("");
	};

	return (
		<Dialog 
			open={open} 
			onClose={handleClose} 
			maxWidth="sm" 
			fullWidth
			PaperProps={{
				sx: {
					background: designSystem.gradients.slate,
					border: `1px solid ${designSystem.borders.light}`,
					boxShadow: designSystem.shadows.lg,
					backdropFilter: "blur(10px)",
				},
			}}
		>
			<DialogTitle 
				sx={{
					background: designSystem.gradients.primary,
					color: "white",
					fontWeight: 700,
					fontSize: "1.3rem",
					padding: 2.5,
					borderBottom: `2px solid ${designSystem.borders.active}`,
				}}
			>
				🚀 Criar Novo Fluxo
			</DialogTitle>
			<DialogContent sx={{ pt: 3 }}>
				<TextField
					autoFocus
					margin="dense"
					label="Descrição"
					placeholder="Ex: Fluxo de Atendimento Padrão"
					fullWidth
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					sx={{ 
						mb: 2,
						"& .MuiOutlinedInput-root": {
							transition: designSystem.animations.fast,
							"&:hover": {
								borderColor: "primary.main",
							},
							"&.Mui-focused": {
								"& fieldset": {
									borderColor: "primary.main",
									borderWidth: 2,
								},
								boxShadow: `0 0 0 3px rgba(102, 126, 234, 0.1)`,
							},
						},
						"& .MuiOutlinedInput-root fieldset": {
							borderColor: designSystem.borders.light,
						},
					}}
				/>
				<TextField
					margin="dense"
					label="ID do Setor (opcional)"
					placeholder="Deixe vazio para fluxo geral"
					fullWidth
					type="number"
					value={sectorId}
					onChange={(e) => setSectorId(e.target.value)}
					sx={{
						"& .MuiOutlinedInput-root": {
							transition: designSystem.animations.fast,
							"&:hover": {
								borderColor: "primary.main",
							},
							"&.Mui-focused": {
								"& fieldset": {
									borderColor: "primary.main",
									borderWidth: 2,
								},
								boxShadow: `0 0 0 3px rgba(102, 126, 234, 0.1)`,
							},
						},
						"& .MuiOutlinedInput-root fieldset": {
							borderColor: designSystem.borders.light,
						},
					}}
				/>
			</DialogContent>
			<DialogActions 
				sx={{
					background: designSystem.backgrounds.section,
					borderTop: `1px solid ${designSystem.borders.light}`,
					padding: 2,
					gap: 1,
				}}
			>
				<Button 
					onClick={handleClose}
					sx={{
						color: "text.secondary",
						transition: designSystem.animations.fast,
						"&:hover": {
							bgcolor: "grey.200",
						},
					}}
				>
					Cancelar
				</Button>
				<Button 
					onClick={handleCreate} 
					variant="contained"
					sx={{
						background: designSystem.gradients.primary,
						color: "white",
						fontWeight: 600,
						transition: designSystem.animations.fast,
						"&:hover": {
							transform: "translateY(-2px)",
							boxShadow: designSystem.shadows.lg,
							background: designSystem.gradients.primaryLight,
						},
					}}
				>
					Criar Fluxo
				</Button>
			</DialogActions>
		</Dialog>
	);
};
