import React, { useState, useEffect } from "react";
import { FlowList } from "./components/flow-list";
import { FlowEditor } from "./components/flow-editor";
import { instancesApiService, type Instance } from "./services/instances-api.service";
import type { Flow } from "./types/flow.types";
import {
	ThemeProvider,
	createTheme,
	CssBaseline,
	AppBar,
	Toolbar,
	Typography,
	Container,
	Box,
	Autocomplete,
	TextField,
	CircularProgress,
	Tooltip
} from "@mui/material";
import { Settings as SettingsIcon } from "@mui/icons-material";
import { designSystem } from "./styles/design-system";
import "./styles/app.css";

const theme = createTheme({
	palette: {
		mode: "light",
		primary: {
			main: "#667eea"
		},
		secondary: {
			main: "#764ba2"
		},
		background: {
			default: "#f8fafc", // slate-50
			paper: "#ffffff"
		},
		grey: {
			50: "#f8fafc", // slate-50
			100: "#f1f5f9", // slate-100
			200: "#e2e8f0", // slate-200
			300: "#cbd5e1", // slate-300
			400: "#94a3b8", // slate-400
			500: "#64748b", // slate-500
			600: "#475569", // slate-600
			700: "#334155", // slate-700
			800: "#1e293b", // slate-800
			900: "#0f172a" // slate-900
		}
	}
});

export const App: React.FC = () => {
	const [currentView, setCurrentView] = useState<"list" | "editor">("list");
	const [selectedFlow, setSelectedFlow] = useState<Flow | null>(null);
	const [instance, setInstance] = useState<string>("vollo");
	const [instances, setInstances] = useState<Instance[]>([]);
	const [loadingInstances, setLoadingInstances] = useState(true);

	useEffect(() => {
		loadInstances();
	}, []);

	const loadInstances = async () => {
		try {
			setLoadingInstances(true);
			const data = await instancesApiService.getAll();
			setInstances(data);
			// Define a primeira instância como padrão se existir
			if (data.length > 0 && !instance) {
				setInstance(data[0].clientName);
			}
		} catch (error) {
			console.error("Erro ao carregar instâncias:", error);
		} finally {
			setLoadingInstances(false);
		}
	};

	const handleSelectFlow = (flow: Flow) => {
		setSelectedFlow(flow);
		setCurrentView("editor");
	};

	const handleBackToList = () => {
		setCurrentView("list");
		setSelectedFlow(null);
	};

	const handleFlowUpdated = (flow: Flow) => {
		setSelectedFlow(flow);
	};

	const selectedInstance = instances.find((i) => i.clientName === instance);

	return (
		<ThemeProvider theme={theme}>
			<CssBaseline />
			<Box sx={{ 
				display: "flex", 
				flexDirection: "column",
				minHeight: "100vh", 
				bgcolor: "grey.50"
			}}>
				{/* AppBar Header */}
				<AppBar position="static" elevation={0} sx={{ 
					bgcolor: "primary.main",
					borderBottom: "1px solid",
					borderColor: "divider"
				}}>
					<Toolbar sx={{ 
						display: "flex", 
						justifyContent: "space-between",
						alignItems: "center",
						px: { xs: 2, sm: 3 },
						gap: 2,
						maxWidth: "1280px",
						width: "100%",
						mx: "auto"
					}}>
						{/* Logo e Título */}
						<Box sx={{ 
							display: "flex", 
							alignItems: "center", 
							gap: 1.5,
							flex: 1
						}}>
							<Box sx={{
								width: 40,
								height: 40,
								borderRadius: "8px",
								bgcolor: "rgba(255,255,255,0.15)",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								backdropFilter: "blur(10px)"
							}}>
								<SettingsIcon sx={{ color: "white", fontSize: 24 }} />
							</Box>
							<Box>
								<Typography 
									variant="h6" 
									component="h1" 
									sx={{ 
										fontWeight: 700,
										color: "white",
										lineHeight: 1.2
									}}
								>
									Flow Manager
								</Typography>
								<Typography 
									variant="caption" 
									sx={{ 
										color: "rgba(255,255,255,0.7)",
										display: "block"
									}}
								>
									WhatsApp Message Flow
								</Typography>
							</Box>
						</Box>

						{/* Instância Selector */}
						<Box sx={{ 
							minWidth: 280,
							flexShrink: 0
						}}>
							<Tooltip title="Selecione a instância para gerenciar">
								<Autocomplete
									value={selectedInstance || undefined}
									onChange={(_, newValue) => {
										if (newValue) {
											setInstance(newValue.name);
											setCurrentView("list");
											setSelectedFlow(null);
										}
									}}
									options={instances}
									getOptionLabel={(option) => option.name}
									loading={loadingInstances}
									renderInput={(params) => (
										<TextField
											{...params}
											label="Instância"
											size="small"
											placeholder="Selecione..."
											sx={{
												bgcolor: "rgba(255,255,255,0.15)",
												borderRadius: 1,
												"& .MuiOutlinedInput-root": {
													color: "white",
													"& fieldset": {
														borderColor: "rgba(255,255,255,0.3)"
													},
													"&:hover fieldset": {
														borderColor: "rgba(255,255,255,0.5)"
													},
													"&.Mui-focused fieldset": {
														borderColor: "white",
														borderWidth: 2
													}
												},
												"& .MuiInputLabel-root": {
													color: "rgba(255,255,255,0.7)"
												},
												"& .MuiInputLabel-root.Mui-focused": {
													color: "white"
												},
												"& .MuiOutlinedInput-notchedOutline": {
													borderColor: "rgba(255,255,255,0.3)"
												}
											}}
											InputProps={{
												...params.InputProps,
												endAdornment: (
													<>
														{loadingInstances ? (
															<CircularProgress color="inherit" size={18} />
														) : null}
														{params.InputProps.endAdornment}
													</>
												)
											}}
										/>
									)}
									disableClearable
									noOptionsText="Nenhuma instância disponível"
									loadingText="Carregando..."
								/>
							</Tooltip>
						</Box>
					</Toolbar>
				</AppBar>

				{/* Main Content - Cresce para preencher espaço */}
				<Container 
					maxWidth={false}
					sx={{ 
						flex: 1,
						mt: 4, 
						mb: 4,
						display: "flex",
						flexDirection: "column",
						maxWidth: "1280px",
						mx: "auto",
						width: "100%",
						px: { xs: 2, sm: 3 }
					}}
				>
					{currentView === "list" ? (
						<FlowList instance={instance} onSelectFlow={handleSelectFlow} />
					) : selectedFlow ? (
						<FlowEditor flow={selectedFlow} onBack={handleBackToList} onFlowUpdated={handleFlowUpdated} />
					) : null}
				</Container>

				{/* Footer Fixo */}
				<Box
					component="footer"
					sx={{
						mt: "auto",
						py: 2.5,
						px: { xs: 2, sm: 3 },
						backgroundColor: "grey.200",
						borderTop: "1px solid",
						borderColor: "grey.300",
						textAlign: "center",
						backdropFilter: "blur(8px)",
						background: "linear-gradient(135deg, #e2e8f0 0%, #cbd5e1 100%)",
						display: "flex",
						flexDirection: "column",
						alignItems: "center"
					}}
				>
					<Box sx={{ maxWidth: "1280px", width: "100%" }}>
						<Typography 
							variant="body2" 
							sx={{ 
								color: "grey.700",
								fontWeight: 500,
								letterSpacing: 0.3
							}}
						>
							🤖 WhatsApp Service — Message Flow Management System
						</Typography>
						<Typography 
							variant="caption" 
							sx={{ 
								display: "block",
								color: "grey.600",
								mt: 0.5
							}}
						>
							© 2025 Infotec Solution Provider. Todos os direitos reservados.
						</Typography>
					</Box>
				</Box>
			</Box>
		</ThemeProvider>
	);
};
