/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}", "./utils/**/*.{js,ts,jsx,tsx}"],
  plugins: [require("daisyui")],
  darkTheme: "dark",
  darkMode: ["selector", "[data-theme='dark']"],
  daisyui: {
    themes: [
      {
        light: {
          primary: "#065f46",
          "primary-content": "#f0fdf4",
          secondary: "#047857",
          "secondary-content": "#f0fdf4",
          accent: "#059669",
          "accent-content": "#f0fdf4",
          neutral: "#1a1a2e",
          "neutral-content": "#f0fdf4",
          "base-100": "#f8faf5",
          "base-200": "#eef2e8",
          "base-300": "#dfe6d6",
          "base-content": "#1a1a2e",
          info: "#047857",
          success: "#059669",
          warning: "#d97706",
          error: "#dc2626",
          "--rounded-btn": "0.125rem",
          ".tooltip": { "--tooltip-tail": "6px" },
          ".link": { textUnderlineOffset: "2px" },
          ".link:hover": { opacity: "80%" },
        },
      },
      {
        dark: {
          primary: "#00FF41",
          "primary-content": "#020a04",
          secondary: "#059669",
          "secondary-content": "#00FF41",
          accent: "#10b981",
          "accent-content": "#020a04",
          neutral: "#00FF41",
          "neutral-content": "#020a04",
          "base-100": "#030712",
          "base-200": "#0a0f0d",
          "base-300": "#111916",
          "base-content": "#00FF41",
          info: "#059669",
          success: "#00FF41",
          warning: "#fbbf24",
          error: "#ef4444",
          "--rounded-btn": "0.125rem",
          ".tooltip": { "--tooltip-tail": "6px", "--tooltip-color": "oklch(var(--p))" },
          ".link": { textUnderlineOffset: "2px" },
          ".link:hover": { opacity: "80%" },
        },
      },
    ],
  },
  theme: {
    extend: {
      boxShadow: {
        center: "0 0 12px -2px rgb(0 0 0 / 0.05)",
        neon: "0 0 12px rgba(0, 255, 65, 0.25), 0 0 30px rgba(0, 255, 65, 0.1)",
        "neon-strong": "0 0 15px rgba(0, 255, 65, 0.4), 0 0 45px rgba(0, 255, 65, 0.15)",
        "neon-inset": "inset 0 0 20px rgba(0, 255, 65, 0.06)",
      },
      animation: {
        "pulse-fast": "pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "cursor-blink": "blink 1.2s step-end infinite",
        "glow-pulse": "glow-pulse 3s ease-in-out infinite",
      },
      keyframes: {
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        "glow-pulse": {
          "0%, 100%": { opacity: "0.4" },
          "50%": { opacity: "0.8" },
        },
      },
    },
  },
};
