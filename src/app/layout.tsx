import type { Metadata, Viewport } from 'next';
import { Inter, Sora } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

// Display face for headings and the oversized section numerals.
const sora = Sora({
  subsets: ['latin'],
  variable: '--font-sora',
  display: 'swap',
  weight: ['400', '500', '600', '700', '800'],
});

export const metadata: Metadata = {
  title: {
    default: 'NEXORA — Your conversations. Your intelligence. Your AI.',
    template: '%s · NEXORA',
  },
  description:
    'A personal conversation intelligence platform that learns how you communicate, remembers what matters, and helps you reply naturally.',
  applicationName: 'NEXORA',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FAF5FF' },
    { media: '(prefers-color-scheme: dark)', color: '#0B0A14' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${sora.variable}`} suppressHydrationWarning>
      <head>
        {/* Set the theme before paint to avoid a flash of the wrong mode. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                // NEXORA is dark-first: an explicit choice always wins, and a
                // visitor who has not chosen gets dark regardless of OS theme,
                // because the product is designed around the dark surfaces.
                var t = localStorage.getItem('nexora-theme');
                var d = t ? t === 'dark' : true;
                if (d) document.documentElement.classList.add('dark');
              } catch (e) {}
            `,
          }}
        />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
