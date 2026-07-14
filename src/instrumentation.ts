// Runs once when the Next.js server starts. The nested NEXT_RUNTIME === "nodejs"
// guard lets the bundler drop the Node-only module from the Edge runtime bundle,
// avoiding "Node.js module in Edge Runtime" warnings. Real work lives in
// instrumentation-node.ts.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
