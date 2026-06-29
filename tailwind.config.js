/** @type {import('tailwindcss').Config} */
export default {
  future: {
    hoverOnlyWhenSupported: true,
  },
  darkMode: ['class', '[data-theme="dark"]'],
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      screens: {
        'phone-landscape': { raw: '(max-width: 969px) and (orientation: landscape)' },
      },
    },
  },
  plugins: [],
}

