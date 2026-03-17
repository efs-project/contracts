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
          primary: "#0f766e",
          "primary-content": "#f0fdfa",
          secondary: "#0d9488",
          "secondary-content": "#f0fdfa",
          accent: "#14b8a6",
          "accent-content": "#042f2e",
          neutral: "#1e293b",
          "neutral-content": "#f0fdfa",
          "base-100": "#f8fafc",
          "base-200": "#f1f5f9",
          "base-300": "#e2e8f0",
          "base-content": "#0f172a",
          info: "#0d9488",
          success: "#10b981",
          warning: "#f59e0b",
          error: "#ef4444",
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
          secondary: "#0d9488",
          "secondary-content": "#00FF41",
          accent: "#14b8a6",
          "accent-content": "#020a04",
          neutral: "#00FF41",
          "neutral-content": "#020a04",
          "base-100": "#0c0c14",
          "base-200": "#12121c",
          "base-300": "#1a1a28",
          "base-content": "#00FF41",
          info: "#0d9488",
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
