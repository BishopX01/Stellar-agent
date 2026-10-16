import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bear Protocol — Next.js Starter',
  description: 'Agent commerce on Stellar',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
