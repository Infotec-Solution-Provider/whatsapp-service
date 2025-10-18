import React from "react";
import {
	Card,
	CardContent,
	CardActions,
	Typography,
	IconButton,
	Chip,
	Box,
	Tooltip,
	Stack,
	LinearProgress
} from "@mui/material";
import {
	Delete as DeleteIcon,
	Edit as EditIcon,
	Workspaces as WorkspacesIcon,
	Schedule as ScheduleIcon,
	Layers as LayersIcon,
	CheckCircle as CheckCircleIcon,
	RadioButtonUnchecked as RadioButtonUncheckedIcon
} from "@mui/icons-material";
import type { Flow } from "../../types/flow.types";

interface FlowCardProps {
	flow: Flow;
	onSelect: (flow: Flow) => void;
	onDelete: (flowId: number, e: React.MouseEvent) => void;
}

export const FlowCard: React.FC<FlowCardProps> = ({ flow, onSelect, onDelete }) => {
	// Calcula o número de steps (pode vir de diferentes formatos)
	const stepsCount = flow.steps?.length || (flow as any).WppMessageFlowStep?.length || 0;

	return (
		<Card
			sx={{
				cursor: "pointer",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
				background: flow.enabled
					? "linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)"
					: "linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)",
				border: "1px solid",
				borderColor: flow.enabled ? "primary.light" : "grey.300",
				position: "relative",
				overflow: "hidden",
				"&::before": {
					content: '""',
					position: "absolute",
					top: 0,
					left: 0,
					right: 0,
					height: "4px",
					background: flow.enabled
						? "linear-gradient(90deg, #667eea 0%, #764ba2 100%)"
						: "linear-gradient(90deg, #cbd5e1 0%, #94a3b8 100%)"
				},
				"&:hover": {
					transform: "translateY(-8px)",
					boxShadow: flow.enabled
						? "0 20px 40px rgba(102, 126, 234, 0.15)"
						: "0 20px 40px rgba(0, 0, 0, 0.08)",
					borderColor: flow.enabled ? "primary.main" : "grey.400",
					"& .card-header-icon": {
						transform: "scale(1.1) rotate(10deg)"
					},
					"& .card-actions": {
						opacity: 1
					}
				}
			}}
			onClick={() => onSelect(flow)}
		>
			{/* Barra de progresso sutil */}
			<LinearProgress
				variant="determinate"
				value={(stepsCount / 20) * 100}
				sx={{
					height: 3,
					background: "transparent",
					"& .MuiLinearProgress-bar": {
						background: flow.enabled
							? "linear-gradient(90deg, #667eea 0%, #764ba2 100%)"
							: "linear-gradient(90deg, #cbd5e1 0%, #94a3b8 100%)"
					}
				}}
			/>

			<CardContent sx={{ flex: 1, pb: 1, position: "relative" }}>
				{/* Header com ícone decorativo */}
				<Box display="flex" justifyContent="space-between" alignItems="flex-start" mb={2}>
					<Box flex={1} display="flex" gap={1.5} alignItems="flex-start">
						<Box
							className="card-header-icon"
							sx={{
								mt: 0.5,
								transition: "all 0.3s ease",
								color: flow.enabled ? "primary.main" : "grey.400",
								display: "flex",
								alignItems: "center",
								justifyContent: "center"
							}}
						>
							<WorkspacesIcon sx={{ fontSize: "1.8rem" }} />
						</Box>
						<Box flex={1}>
							<Typography
								variant="body1"
								component="h3"
								gutterBottom
								sx={{
									fontWeight: 700,
									fontSize: "1.1rem",
									color: "grey.900",
									lineHeight: 1.3,
									maxLines: 2,
									overflow: "hidden",
									textOverflow: "ellipsis"
								}}
							>
								{flow.description || `Fluxo #${flow.id}`}
							</Typography>
							<Box display="flex" gap={1} mt={0.5}>
								<Chip
									size="small"
									icon={flow.enabled ? <CheckCircleIcon /> : <RadioButtonUncheckedIcon />}
									label={flow.enabled ? "Ativo" : "Inativo"}
									color={flow.enabled ? "success" : "default"}
									variant="outlined"
									sx={{
										fontWeight: 600,
										fontSize: "0.75rem",
										"& .MuiChip-icon": {
											fontSize: "1rem !important"
										}
									}}
								/>
							</Box>
						</Box>
					</Box>
				</Box>

				{/* Info Grid com ícones */}
				<Stack spacing={1.2}>
					{/* ID e Setor */}
					<Box display="flex" justifyContent="space-between" gap={2}>
						<Box flex={1}>
							<Typography
								variant="caption"
								sx={{ color: "text.secondary", fontWeight: 500, display: "block", mb: 0.5 }}
							>
								ID
							</Typography>
							<Box display="flex" alignItems="center" gap={0.5}>
								<Typography
									variant="body2"
									sx={{ fontWeight: 600, color: "grey.800", fontFamily: "monospace" }}
								>
									#{flow.id}
								</Typography>
							</Box>
						</Box>
						<Box flex={1}>
							<Typography
								variant="caption"
								sx={{ color: "text.secondary", fontWeight: 500, display: "block", mb: 0.5 }}
							>
								Setor
							</Typography>
							<Typography variant="body2" sx={{ fontWeight: 600, color: "grey.800" }}>
								{flow.sectorId ? `Setor ${flow.sectorId}` : "Geral"}
							</Typography>
						</Box>
					</Box>

					{/* Divider sutil */}
					<Box sx={{ height: 1, bgcolor: "grey.200", opacity: 0.5, borderRadius: 1 }} />

					{/* Steps com ícone */}
					<Box display="flex" alignItems="center" justifyContent="space-between">
						<Box display="flex" alignItems="center" gap={0.8}>
							<LayersIcon sx={{ fontSize: "1.2rem", color: "primary.main" }} />
							<Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 500 }}>
								Steps
							</Typography>
						</Box>
						<Chip
							label={stepsCount}
							size="small"
							color="primary"
							variant="filled"
							sx={{
								fontWeight: 700,
								fontSize: "0.85rem",
								minWidth: 36,
								height: 28,
								background: flow.enabled
									? "linear-gradient(135deg, #667eea 0%, #764ba2 100%)"
									: "linear-gradient(135deg, #cbd5e1 0%, #94a3b8 100%)",
								color: "white",
								"& .MuiChip-label": {
									px: 1.5
								}
							}}
						/>
					</Box>

					{/* Data de criação com ícone */}
					<Box display="flex" alignItems="center" justifyContent="space-between">
						<Box display="flex" alignItems="center" gap={0.8}>
							<ScheduleIcon sx={{ fontSize: "1.2rem", color: "grey.500" }} />
							<Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 500 }}>
								Criado
							</Typography>
						</Box>
						<Typography variant="caption" sx={{ fontWeight: 600, color: "grey.700" }}>
							{new Date(flow.createdAt).toLocaleDateString("pt-BR", {
								year: "numeric",
								month: "short",
								day: "numeric"
							})}
						</Typography>
					</Box>
				</Stack>
			</CardContent>

			{/* Ações */}
			<CardActions
				className="card-actions"
				sx={{
					justifyContent: "flex-end",
					pt: 1,
					pb: 1.5,
					gap: 0.5,
					borderTop: "1px solid",
					borderColor: "grey.200",
					bgcolor: flow.enabled ? "rgba(102, 126, 234, 0.02)" : "rgba(0, 0, 0, 0.01)"
				}}
			>
				<Tooltip title="Editar fluxo" arrow>
					<IconButton
						size="small"
						onClick={(e) => {
							e.stopPropagation();
							onSelect(flow);
						}}
						color="primary"
						sx={{
							transition: "all 0.2s",
							"&:hover": {
								transform: "scale(1.15)",
								bgcolor: "primary.lighter"
							}
						}}
					>
						<EditIcon sx={{ fontSize: "1.2rem" }} />
					</IconButton>
				</Tooltip>

				<Tooltip title="Deletar fluxo" arrow>
					<IconButton
						size="small"
						onClick={(e) => onDelete(flow.id, e)}
						color="error"
						sx={{
							transition: "all 0.2s",
							"&:hover": {
								transform: "scale(1.15)",
								bgcolor: "error.lighter"
							}
						}}
					>
						<DeleteIcon sx={{ fontSize: "1.2rem" }} />
					</IconButton>
				</Tooltip>
			</CardActions>
		</Card>
	);
};
