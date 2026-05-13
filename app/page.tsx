export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-black px-6 text-zinc-100">
      <div className="flex flex-col items-center gap-6 text-center">
        <span className="rounded-full border border-white/10 px-3 py-1 text-xs uppercase tracking-widest text-zinc-400">
          Step 3 / 10 &mdash; tool router live at /api/tools/[server]/[tool]
        </span>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Kitchen Copilot
        </h1>
        <p className="max-w-xl text-balance text-zinc-400">
          A voice-first executive assistant for the kitchen.
          Built on Swiggy MCP &mdash; Food, Instamart, Dineout.
          Voice and UI come online in the next steps.
        </p>
        <code className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-zinc-300">
          SWIGGY_MODE=mock &nbsp;&middot;&nbsp; LIVE_MUTATIONS=false
        </code>
      </div>
    </main>
  );
}
