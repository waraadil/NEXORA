import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
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
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Set the theme before paint to avoid a flash of the wrong mode. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var t = localStorage.getItem('nexora-theme');
                var d = t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
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
