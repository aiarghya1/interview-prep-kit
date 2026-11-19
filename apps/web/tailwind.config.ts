import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#eef4ff', 100: '#dbe6ff', 500: '#3b6cf6', 600: '#2c55db', 700: '#2444b0' },
      },
      keyframes: { pulseSoft: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.55' } } },
      animation: { pulseSoft: 'pulseSoft 1.6s ease-in-out infinite' },
    },
  },
  plugins: [],
} satisfies Config;
