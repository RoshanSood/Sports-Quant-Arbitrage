// Runs once when the Next.js server starts. The nested NEXT_RUNTIME === "nodejs"
// guard lets the bundler drop the Node-only module from the Edge runtime bundle,
// avoiding "Node.js module in Edge Runtime" warnings. Real work lives in
// instrumentation-node.ts.

export async function register() {
  // Next invokes instrumentation while producing a build as well as when a server starts.
  // Background sockets/schedulers are runtime side effects and must never run in build
  // workers (which can otherwise ingest markets or auto-execute with live credentials).
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
