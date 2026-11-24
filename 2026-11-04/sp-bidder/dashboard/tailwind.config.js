/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        elevated: 'hsl(var(--elevated))',
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        warn: { DEFAULT: 'hsl(var(--warn))', foreground: 'hsl(var(--warn-foreground))' },
        danger: { DEFAULT: 'hsl(var(--danger))', foreground: 'hsl(var(--danger-foreground))' },
        success: { DEFAULT: 'hsl(var(--success))', foreground: 'hsl(var(--success-foreground))' },
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
      fontFamily: { sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'] },
      transitionTimingFunction: {
        enter: 'cubic-bezier(0, 0, 0.2, 1)',
        standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      // no boxShadow.elevated: it collides with the `elevated` color (opaque halo)
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 200ms cubic-bezier(0, 0, 0.2, 1) both',
      },
    },
  },
  plugins: [],
};
