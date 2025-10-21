import React, { useState, useEffect } from "react";
import {
	Box,
	Typography,
	TextField,
	Button,
	Grid,
	CircularProgress,
	Alert,
	InputAdornment,
	Snackbar,
} from "@mui/material";
import { Add, Search } from "@mui/icons-material";
import { flowApiService } from "../../services/flow-api.service";
import type { Flow } from "../../types/flow.types";
import { FlowCard } from "./FlowCard";
import { CreateFlowDialog } from "./CreateFlowDialog";
import { designSystem } from "../../styles/design-system";

interface FlowListProps {
	instance: string;
	onSelectFlow: (flow: Flow) => void;
}

export const FlowList: React.FC<FlowListProps> = ({ instance, onSelectFlow }) => {
	const [flows, setFlows] = useState<Flow[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [searchTerm, setSearchTerm] = useState("");
	const [showCreateDialog, setShowCreateDialog] = useState(false);
	const [snackbar, setSnackbar] = useState<{
		open: boolean;
		message: string;
		severity: "success" | "error";
	}>({
		open: false,
		message: "",
		severity: "success",
	});

	useEffect(() => {
		loadFlows();
	}, [instance]);

	const loadFlows = async () => {
		try {
			setLoading(true);
			setError(null);
			const data = await flowApiService.listFlows(instance);
			setFlows(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Erro ao carregar fluxos");
		} finally {
			setLoading(false);
		}
	};

	const handleCreateFlow = async (data: { description: string; sectorId: string }) => {
		try {
			const flowData = {
				instance,
				description: data.description,
				...(data.sectorId && { sectorId: parseInt(data.sectorId) }),
			};

			const newFlow = await flowApiService.createFlow(flowData);
			setFlows([...flows, newFlow]);
			setShowCreateDialog(false);
			setSnackbar({
				open: true,
				message: "Fluxo criado com sucesso!",
				severity: "success",
			});
			onSelectFlow(newFlow);
		} catch (err) {
			setSnackbar({
				open: true,
				message: err instanceof Error ? err.message : "Erro ao criar fluxo",
				severity: "error",
			});
		}
	};

	const handleDeleteFlow = async (flowId: number, e: React.MouseEvent) => {
		e.stopPropagation();
		if (!confirm("Tem certeza que deseja deletar este fluxo?")) return;

		try {
			await flowApiService.deleteFlow(flowId);
			setFlows(flows.filter((f) => f.id !== flowId));
			setSnackbar({
				open: true,
				message: "Fluxo deletado com sucesso!",
				severity: "success",
			});
		} catch (err) {
			setSnackbar({
				open: true,
				message: err instanceof Error ? err.message : "Erro ao deletar fluxo",
				severity: "error",
			});
		}
	};



	const handleCloseSnackbar = () => {
		setSnackbar({ ...snackbar, open: false });
	};

	const filteredFlows = flows.filter(
		(flow) =>
			(flow.description?.toLowerCase() || "").includes(searchTerm.toLowerCase()) ||
			flow.id.toString().includes(searchTerm) ||
			(flow.sectorId?.toString() || "").includes(searchTerm)
	);

	if (loading) {
		return (
			<Box display="flex" flexDirection="column" alignItems="center" justifyContent="center" minHeight="400px">
				<CircularProgress size={60} />
				<Typography variant="body1" mt={2} color="text.secondary">
					Carregando fluxos...
				</Typography>
			</Box>
		);
	}

	if (error) {
		return (
			<Box display="flex" flexDirection="column" alignItems="center" justifyContent="center" minHeight="400px">
				<Alert severity="error" sx={{ mb: 2 }}>
					{error}
				</Alert>
				<Button variant="contained" onClick={loadFlows}>
					Tentar novamente
				</Button>
			</Box>
		);
	}

	return (
		<Box>
			<Box 
				display="flex" 
				justifyContent="space-between" 
				alignItems="center" 
				mb={3} 
				sx={{ 
					background: designSystem.gradients.slate,
					border: `1px solid ${designSystem.borders.light}`,
					p: 2, 
					borderRadius: 1.5,
					backdropFilter: "blur(10px)",
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
					},
				}}
			>
				<Typography 
					variant="h5" 
					component="h2"
					sx={{
						fontWeight: 700,
						background: designSystem.gradients.primary,
						backgroundClip: "text",
						WebkitBackgroundClip: "text",
						WebkitTextFillColor: "transparent",
					}}
				>
					Fluxos de Mensagem
				</Typography>
				<Box display="flex" gap={2} alignItems="center">
					<TextField
						size="small"
						placeholder="Buscar fluxos..."
						value={searchTerm}
						onChange={(e) => setSearchTerm(e.target.value)}
						InputProps={{
							startAdornment: (
								<InputAdornment position="start">
									<Search sx={{ color: "primary.main" }} />
								</InputAdornment>
							),
						}}
						sx={{
							width: 300,
							bgcolor: "white",
							borderRadius: 1.5,
							border: `1px solid ${designSystem.borders.light}`,
							transition: designSystem.animations.fast,
							"& .MuiOutlinedInput-root": {
								"&:hover": {
									borderColor: "primary.main",
									boxShadow: `0 0 0 3px rgba(102, 126, 234, 0.1)`,
								},
								"&.Mui-focused": {
									borderColor: "primary.main",
									boxShadow: `0 0 0 3px rgba(102, 126, 234, 0.15)`,
								},
							},
						}}
					/>
					<Button 
						variant="contained" 
						startIcon={<Add />} 
						onClick={() => setShowCreateDialog(true)}
						sx={{
							background: designSystem.gradients.primary,
							transition: designSystem.animations.fast,
							"&:hover": {
								transform: "translateY(-2px)",
								boxShadow: designSystem.shadows.lg,
								background: designSystem.gradients.primaryLight,
							},
						}}
					>
						Novo Fluxo
					</Button>
				</Box>
			</Box>

		{filteredFlows.length === 0 ? (
			<Box 
				display="flex" 
				flexDirection="column" 
				alignItems="center" 
				justifyContent="center" 
				minHeight="300px" 
				sx={{ 
					background: designSystem.gradients.slate,
					border: `2px dashed ${designSystem.borders.light}`,
					borderRadius: 2, 
					p: 3,
					transition: designSystem.animations.smooth,
				}}
			>
				<Typography variant="body1" color="text.secondary" mb={2}>
					{searchTerm ? "Nenhum fluxo encontrado" : "Nenhum fluxo criado ainda"}
				</Typography>
				{!searchTerm && (
					<Button 
						variant="outlined" 
						startIcon={<Add />} 
						onClick={() => setShowCreateDialog(true)}
						sx={{
							borderColor: "primary.main",
							color: "primary.main",
							fontWeight: 600,
							transition: designSystem.animations.fast,
							"&:hover": {
								background: "rgba(102, 126, 234, 0.08)",
								borderColor: "primary.dark",
							},
						}}
					>
						Criar primeiro fluxo
					</Button>
				)}
			</Box>
		) : (
			<Grid container spacing={3}>
				{filteredFlows.map((flow) => (
					<Grid size={{ xs: 12, sm: 6, md: 4 }} key={flow.id}>
						<FlowCard
							flow={flow}
							onSelect={onSelectFlow}
							onDelete={handleDeleteFlow}
						/>
					</Grid>
				))}
			</Grid>
		)}			<CreateFlowDialog
				open={showCreateDialog}
				onClose={() => setShowCreateDialog(false)}
				onCreate={handleCreateFlow}
			/>

			<Snackbar
				open={snackbar.open}
				autoHideDuration={4000}
				onClose={handleCloseSnackbar}
				anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
			>
				<Alert onClose={handleCloseSnackbar} severity={snackbar.severity} sx={{ width: "100%" }}>
					{snackbar.message}
				</Alert>
			</Snackbar>
		</Box>
	);
};
