import React from "react";
import { Alert } from "@mui/material";
import { designSystem } from "../../styles/design-system";

interface FlowEditorAlertsProps {
	error: string | null;
	successMessage: string | null;
	onClearError: () => void;
	onClearSuccess: () => void;
}

export const FlowEditorAlerts: React.FC<FlowEditorAlertsProps> = ({
	error,
	successMessage,
	onClearError,
	onClearSuccess
}) => {
	return (
		<>
			{error && (
				<Alert 
					severity="error" 
					sx={{ 
						mb: 2,
						background: "linear-gradient(135deg, rgba(248,113,113,0.1) 0%, rgba(220,38,38,0.1) 100%)",
						border: "1px solid rgba(220,38,38,0.3)",
						borderRadius: 1.5,
						fontWeight: 600,
					}} 
					onClose={onClearError}
				>
					{error}
				</Alert>
			)}

			{successMessage && (
				<Alert 
					severity="success" 
					sx={{ 
						mb: 2,
						background: "linear-gradient(135deg, rgba(52,211,153,0.1) 0%, rgba(5,150,105,0.1) 100%)",
						border: "1px solid rgba(5,150,105,0.3)",
						borderRadius: 1.5,
						fontWeight: 600,
					}} 
					onClose={onClearSuccess}
				>
					{successMessage}
				</Alert>
			)}
		</>
	);
};
