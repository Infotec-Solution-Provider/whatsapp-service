/**
 * Design System - Identidade Visual do Flow Manager
 * Paleta de cores, gradientes, efeitos e animações compartilhadas
 */

export const designSystem = {
	// Gradientes principais
	gradients: {
		primary: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
		primaryLight: "linear-gradient(135deg, #8a9ff5 0%, #8a6bb8 100%)",
		slate: "linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)",
		slateDisabled: "linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)",
		success: "linear-gradient(135deg, #34d399 0%, #059669 100%)",
		warning: "linear-gradient(135deg, #fbbf24 0%, #d97706 100%)",
		error: "linear-gradient(135deg, #f87171 0%, #dc2626 100%)",
		info: "linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%)",
	},

	// Animações
	animations: {
		smooth: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
		fast: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
		hover: "all 0.2s ease",
	},

	// Efeitos de sombra
	shadows: {
		sm: "0 4px 12px rgba(0, 0, 0, 0.05)",
		md: "0 10px 25px rgba(0, 0, 0, 0.08)",
		lg: "0 20px 40px rgba(102, 126, 234, 0.15)",
		lgInactive: "0 20px 40px rgba(0, 0, 0, 0.08)",
		elevation: "0 8px 30px rgba(0, 0, 0, 0.12)",
	},

	// Cores de borda
	borders: {
		light: "#e2e8f0", // grey.200
		medium: "#cbd5e1", // grey.300
		active: "#667eea", // primary
	},

	// Cores de fundo
	backgrounds: {
		main: "#f8fafc", // grey.50
		section: "#f1f5f9", // grey.100
		subsection: "#e2e8f0", // grey.200
		accent: "rgba(102, 126, 234, 0.02)",
		accentHover: "rgba(102, 126, 234, 0.05)",
	},

	// Efeitos de hover
	hoverEffects: {
		card: {
			transform: "translateY(-8px)",
			boxShadow: "0 20px 40px rgba(102, 126, 234, 0.15)",
		},
		cardInactive: {
			transform: "translateY(-8px)",
			boxShadow: "0 20px 40px rgba(0, 0, 0, 0.08)",
		},
		button: {
			transform: "scale(1.05)",
		},
		iconButton: {
			transform: "scale(1.15)",
		},
	},

	// Espaçamento padrão
	spacing: {
		xs: 0.5,
		sm: 1,
		md: 1.5,
		lg: 2,
		xl: 3,
	},

	// Bordas radius
	borderRadius: {
		sm: "0.375rem",
		md: "0.5rem",
		lg: "0.75rem",
		full: "9999px",
	},

	// Estados de componentes
	states: {
		active: {
			background: "linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)",
			border: "#667eea",
			opacity: 1,
		},
		inactive: {
			background: "linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)",
			border: "#cbd5e1",
			opacity: 0.7,
		},
		disabled: {
			background: "#e2e8f0",
			border: "#cbd5e1",
			opacity: 0.5,
		},
		hover: {
			transform: "translateY(-2px)",
		},
	},

	// Tipografia
	typography: {
		fontFamily: "'Inter', 'Segoe UI', 'Roboto', sans-serif",
		weights: {
			light: 300,
			normal: 400,
			medium: 500,
			semibold: 600,
			bold: 700,
			extrabold: 800,
		},
	},
};

export default designSystem;
