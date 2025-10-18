import { Add as AddIcon, CallSplit as CallSplitIcon, Delete as DeleteIcon } from "@mui/icons-material";
import {
	Alert,
	Box,
	Button,
	FormControl,
	FormControlLabel,
	IconButton,
	InputLabel,
	MenuItem,
	Select,
	Stack,
	Switch,
	TextField,
	Typography
} from "@mui/material";
import React from "react";
import { WppMessageFlowStepType } from "../../types/flow.types";
import { designSystem } from "../../styles/design-system";

interface ConfigEditorProps {
	stepType: WppMessageFlowStepType;
	config: Record<string, any>;
	onChange: (config: Record<string, any>) => void;
}

export const ConfigEditor: React.FC<ConfigEditorProps> = ({ stepType, config, onChange }) => {
	const updateField = (field: string, value: any) => {
		onChange({ ...config, [field]: value });
	};

	// QUERY - Executar SQL
	if (stepType === "QUERY") {
		const params = config.params || [];

		const addParam = () => {
			updateField("params", [...params, ""]);
		};

		const updateParam = (index: number, value: string) => {
			const newParams = [...params];
			newParams[index] = value;
			updateField("params", newParams);
		};

		const removeParam = (index: number) => {
			const newParams = params.filter((_: any, i: number) => i !== index);
			updateField("params", newParams);
		};

		return (
			<>
				<Stack spacing={2}>
					<TextField
						label="Query SQL"
						value={config.query || ""}
						onChange={(e) => updateField("query", e.target.value)}
						multiline
						rows={4}
						fullWidth
						required
						placeholder="SELECT * FROM users WHERE id = ?"
						helperText="Use ? para parâmetros. Exemplo: SELECT * FROM users WHERE id = ?"
					/>

					<TextField
						label="Armazenar Como (storeAs)"
						value={config.storeAs || ""}
						onChange={(e) => updateField("storeAs", e.target.value)}
						fullWidth
						placeholder="Ex: user, customer, availableUsers"
						helperText="Nome da variável no contexto onde o resultado será armazenado"
					/>

					<Box
						sx={{
							bgcolor: "grey.100",
							p: 2,
							borderRadius: 1,
							border: "1px solid",
							borderColor: "grey.200"
						}}
					>
						<Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
							<AddIcon fontSize="small" sx={{ color: "primary.main" }} />
							<Typography variant="subtitle2" sx={{ fontWeight: 600, color: "primary.main" }}>
								Parâmetros
							</Typography>
						</Box>
						{params.map((param: string, index: number) => (
							<Box key={index} sx={{ display: "flex", gap: 1, mb: 1 }}>
								<TextField
									value={param}
									onChange={(e) => updateParam(index, e.target.value)}
									fullWidth
									size="small"
									placeholder="${contact.userId} ou valor direto"
									helperText={index === 0 ? "Use ${variavel} para interpolação" : ""}
								/>
								<IconButton onClick={() => removeParam(index)} color="error" size="small">
									<DeleteIcon />
								</IconButton>
							</Box>
						))}
						<Button startIcon={<AddIcon />} onClick={addParam} variant="outlined" size="small">
							Adicionar Parâmetro
						</Button>
					</Box>

					<Box sx={{ display: "flex", gap: 2 }}>
						<FormControlLabel
							control={
								<Switch
									checked={config.single || false}
									onChange={(e) => updateField("single", e.target.checked)}
								/>
							}
							label="Retornar um único registro"
						/>
						<FormControlLabel
							control={
								<Switch
									checked={config.required || false}
									onChange={(e) => updateField("required", e.target.checked)}
								/>
							}
							label="Obrigatório (erro se vazio)"
						/>
					</Box>
				</Stack>
			</>
		);
	}

	// CONDITION - Avaliar condição
	if (stepType === "CONDITION") {
		const operators = [
			{ value: "equals", label: "Igual (=)" },
			{ value: "notEquals", label: "Diferente (≠)" },
			{ value: "contains", label: "Contém" },
			{ value: "in", label: "Está em (IN)" },
			{ value: "gt", label: "Maior que (>)" },
			{ value: "gte", label: "Maior ou igual (≥)" },
			{ value: "lt", label: "Menor que (<)" },
			{ value: "lte", label: "Menor ou igual (≤)" },
			{ value: "exists", label: "Existe (não null)" },
			{ value: "regex", label: "RegEx" }
		];

		return (
			<>
				<Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
					<CallSplitIcon fontSize="small" sx={{ color: "warning.main" }} />
					<Typography variant="subtitle2" sx={{ fontWeight: 600, color: "warning.main" }}>
						Configuração de Condição
					</Typography>
				</Box>
				<Stack spacing={2}>
					<TextField
						label="Campo a Avaliar"
						value={config.field || ""}
						onChange={(e) => updateField("field", e.target.value)}
						fullWidth
						required
						placeholder="contact.isOnlyAdmin, user.role, message.body"
						helperText="Campo do contexto a ser avaliado (ex: contact.isOnlyAdmin)"
					/>

					<FormControl fullWidth required>
						<InputLabel>Operador</InputLabel>
						<Select
							value={config.operator || "equals"}
							label="Operador"
							onChange={(e) => updateField("operator", e.target.value)}
						>
							{operators.map((op) => (
								<MenuItem key={op.value} value={op.value}>
									{op.label}
								</MenuItem>
							))}
						</Select>
					</FormControl>

					{config.operator !== "exists" && (
						<TextField
							label="Valor de Comparação"
							value={config.value ?? ""}
							onChange={(e) => {
								// Tenta converter para boolean/number se apropriado
								let value: any = e.target.value;
								if (value === "true") value = true;
								else if (value === "false") value = false;
								else if (!isNaN(Number(value)) && value !== "") value = Number(value);
								updateField("value", value);
							}}
							fullWidth
							placeholder="true, false, admin, 123, etc."
							helperText="Valor para comparar. Digite true/false para boolean, números serão convertidos automaticamente"
						/>
					)}
				</Stack>

				{/* Alertas informativos por operador */}
				{config.operator === "equals" && (
					<Alert severity="info" sx={{ mt: 2 }}>
						Verifica se o campo é exatamente igual ao valor de comparação.
					</Alert>
				)}

				{config.operator === "notEquals" && (
					<Alert severity="info" sx={{ mt: 2 }}>
						Verifica se o campo é diferente do valor de comparação.
					</Alert>
				)}

				{config.operator === "contains" && (
					<Alert severity="info" sx={{ mt: 2 }}>
						Verifica se o campo (texto) contém o valor de comparação como substring.
					</Alert>
				)}

				{config.operator === "in" && (
					<Alert severity="info" sx={{ mt: 2 }}>
						Verifica se o campo está dentro de uma lista de valores. Separe os valores com vírgula.
					</Alert>
				)}

				{config.operator === "gt" && (
					<Alert severity="info" sx={{ mt: 2 }}>
						Verifica se o campo é maior que o valor de comparação. Use números.
					</Alert>
				)}

				{config.operator === "gte" && (
					<Alert severity="info" sx={{ mt: 2 }}>
						Verifica se o campo é maior ou igual ao valor de comparação. Use números.
					</Alert>
				)}

				{config.operator === "lt" && (
					<Alert severity="info" sx={{ mt: 2 }}>
						Verifica se o campo é menor que o valor de comparação. Use números.
					</Alert>
				)}

				{config.operator === "lte" && (
					<Alert severity="info" sx={{ mt: 2 }}>
						Verifica se o campo é menor ou igual ao valor de comparação. Use números.
					</Alert>
				)}

				{config.operator === "exists" && (
					<Alert severity="info" sx={{ mt: 2 }}>
						Verifica se o campo existe e não é null/undefined. Não precisa de valor de comparação.
					</Alert>
				)}

				{config.operator === "regex" && (
					<Alert severity="info" sx={{ mt: 2 }}>
						Verifica se o campo corresponde a um padrão RegEx. Exemplo: <code>^[A-Z].*@gmail\\.com$</code>
					</Alert>
				)}
			</>
		);
	}

	// ROUTER - Roteamento por valor
	if (stepType === "ROUTER") {
		return (
			<>
				<TextField
					label="Campo a Avaliar"
					value={config.field || ""}
					onChange={(e) => updateField("field", e.target.value)}
					fullWidth
					required
					placeholder="message.body, user.department, contact.type"
					helperText="Campo cujo valor será usado para rotear (ex: message.body)"
				/>

				<Alert severity="info" sx={{ mt: 2 }}>
					As rotas são configuradas na seção "Conexões Condicionais" acima.
					<br />O valor do campo será comparado com as chaves das rotas.
				</Alert>
			</>
		);
	}

	// ASSIGN - Atribuir chat
	if (stepType === "ASSIGN") {
		return (
			<>
				<Stack spacing={2}>
					<TextField
						label="ID do Usuário"
						value={config.userId ?? ""}
						onChange={(e) => {
							let value: any = e.target.value;
							if (value === "-1") value = -1;
							else if (!isNaN(Number(value)) && value !== "") value = Number(value);
							updateField("userId", value);
						}}
						fullWidth
						placeholder="-1 para admin, ou ID específico"
						helperText="Use -1 para atribuir ao admin, ou ${user.id} para interpolação"
					/>

					<TextField
						label="ID da Carteira"
						value={config.walletId ?? ""}
						onChange={(e) => {
							const value = e.target.value === "" ? null : Number(e.target.value);
							updateField("walletId", value);
						}}
						fullWidth
						placeholder="Deixe vazio para null"
					/>

					<FormControl fullWidth>
						<InputLabel>Prioridade</InputLabel>
						<Select
							value={config.priority || "NORMAL"}
							label="Prioridade"
							onChange={(e) => updateField("priority", e.target.value)}
						>
							<MenuItem value="LOW">Baixa</MenuItem>
							<MenuItem value="NORMAL">Normal</MenuItem>
							<MenuItem value="HIGH">Alta</MenuItem>
							<MenuItem value="URGENT">Urgente</MenuItem>
						</Select>
					</FormControl>

					<FormControl fullWidth>
						<InputLabel>Tipo de Chat</InputLabel>
						<Select
							value={config.type || "RECEPTIVE"}
							label="Tipo de Chat"
							onChange={(e) => updateField("type", e.target.value)}
						>
							<MenuItem value="RECEPTIVE">Receptivo</MenuItem>
							<MenuItem value="ACTIVE">Ativo</MenuItem>
							<MenuItem value="INTERNAL">Interno</MenuItem>
						</Select>
					</FormControl>

					<TextField
						label="Mensagem do Sistema"
						value={config.systemMessage || ""}
						onChange={(e) => updateField("systemMessage", e.target.value)}
						fullWidth
						multiline
						rows={2}
						placeholder="Chat atribuído a ${user.name}"
						helperText="Mensagem exibida no sistema. Use ${variavel} para interpolação"
					/>
				</Stack>
			</>
		);
	}

	// Steps específicos que não precisam de configuração
	const noConfigSteps = [
		"SEND_TO_ADMIN",
		"CHECK_ONLY_ADMIN",
		"CHECK_LOALTY",
		"CHECK_AVAILABLE_USERS",
		"SELLER_MENU",
		"CHOOSE_SELLER",
		"CHECK_NEED_TRANSFER",
		"ADMIN_MENU",
		"CHOOSE_SECTOR",
		"CHOOSE_AGENT",
		"SATISFACTION"
	];

	if (noConfigSteps.includes(stepType)) {
		return (
			<Alert severity="info">
				Este tipo de step não requer configuração adicional. Deixe o config vazio ({"{}"}).
			</Alert>
		);
	}

	// Fallback: Editor JSON manual para tipos não mapeados
	return (
		<Alert severity="warning">
			Tipo de step "{stepType}" não tem editor visual. Configure manualmente o JSON abaixo.
		</Alert>
	);
};
