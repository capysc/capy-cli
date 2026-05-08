// Server component — values read here at build time become string literals
// in the compiled output when next.config.ts inlines them via `env`.
// Mirrors ~/Dev/test-project/app/page.tsx — kept simple so the plugin test
// has stable selectors (data-capy-var) for HTML scraping.

const VARS = [
  "DATABASE_URL",
  "STRIPE_API_KEY",
  "OPENAI_API_KEY",
  "APP_ENV",
  "DEBUG",
];

export default function Home() {
  const rows = VARS.map((k) => ({
    name: k,
    value: process.env[k] ?? "(not set)",
  }));

  return (
    <main>
      <h1>Capy plugin test — vercel</h1>
      <table>
        <thead>
          <tr>
            <th>Env var</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ name, value }) => (
            <tr key={name} data-capy-var={name}>
              <td>{name}</td>
              <td data-capy-value={name}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
