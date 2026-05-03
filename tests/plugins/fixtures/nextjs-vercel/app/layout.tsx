export const metadata = {
  title: "Capy plugin test — vercel",
  description: "Hermetic + live Vercel build test",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
